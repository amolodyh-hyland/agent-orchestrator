package factoryrun_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runrepo"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type feedbackReader struct{ facts domain.RunRepoFacts }

func (r *feedbackReader) Inspect(context.Context, string, string, string) (domain.RunRepoFacts, error) {
	return r.facts, nil
}
func (*feedbackReader) VerifyArtifact(ctx context.Context, root string, a domain.RunArtifact) error {
	return (runrepo.Reader{}).VerifyArtifact(ctx, root, a)
}

type feedbackQueue struct {
	calls     int
	text, key string
	reader    *feedbackReader
}

func (q *feedbackQueue) DeliverFactoryFeedback(_ context.Context, _ domain.SessionID, text, key string) error {
	q.calls++
	q.text = text
	q.key = key
	return errors.New("lost enqueue response")
}

func feedbackFixture(t *testing.T) (*fixture, *feedbackQueue, domain.RunDetail, *time.Time) {
	t.Helper()
	f := setupMode(t, domain.SessionModeChat)
	f.session.Mode = domain.SessionModeChat
	f.session.AutoReviewEnabled = false
	f.session.AutoInjectReview = false
	f.session.AutoInjectCI = false
	f.session.Metadata.ControllerGeneration = "controller-1"
	f.session.Metadata.ProviderConversationID = "native-1"
	if err := f.db.UpdateSession(f.ctx, f.session); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.CreateConversation(f.ctx, "conversation-1", domain.ConversationScopeSession, "p", f.session.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	claim := f.claim()
	reader := &feedbackReader{facts: claim.Facts}
	f.svc = factoryrun.New(f.db, reader, f.dir, factoryrun.WithClock(func() time.Time { return now }))
	queue := &feedbackQueue{reader: reader}
	f.svc.SetFeedbackTransport(queue)
	d := f.create()
	d = f.record(d, claim)
	review := &domain.RunReviewReceipt{RepoName: claim.RepoName, ReviewerID: "read-only-reviewer", Independent: true, ReadOnly: true, SHA: claim.Facts.HeadSHA, BeforeFingerprint: claim.Facts.Fingerprint, AfterFingerprint: claim.Facts.Fingerprint, Verdict: "changes_requested", Round: 1, Findings: []domain.RunFinding{{ID: "P2-1", Severity: "P2", Description: "Return an error when the source is stale"}}, Artifact: f.artifact}
	d, err := f.recordInput(f.ctx, d.Run.ID, factoryrun.RecordInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "record review", Review: review})
	if err != nil {
		t.Fatal(err)
	}
	return f, queue, d, &now
}

func feedbackMessage(q *feedbackQueue) ports.ChatUserMessage {
	return ports.ChatUserMessage{FeedbackControllerGeneration: "controller-1", FeedbackConversationID: "conversation-1", Text: q.text, ClientMessageID: q.key, Origin: domain.MessageOriginAutomation}
}

func TestFactoryFeedbackRequiresNativeConfirmationAndNeverResends(t *testing.T) {
	f, q, d, _ := feedbackFixture(t)
	p, err := f.svc.Preview(f.ctx, d.Run.ID, "feedback")
	if err != nil {
		t.Fatal(err)
	}
	if q.calls != 0 || p.Feedback == nil || !strings.Contains(p.Feedback.Payload, "P2-1") || !strings.Contains(p.Feedback.Payload, p.Feedback.SHA) {
		t.Fatal("preview dispatched or omitted finding identity")
	}
	if _, err := f.svc.Confirm(f.ctx, d.Run.ID, "feedback", d.Run.Version, strings.Repeat("f", 64)); err == nil {
		t.Fatal("forged approval")
	}
	if _, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, ports.ChatUserMessage{Text: p.Feedback.Payload, Origin: domain.MessageOriginAutomation}, "next_turn"); err == nil {
		t.Fatal("unapproved continuation")
	}
	result := f.confirm(d, "feedback")
	if q.calls != 1 || len(result.Feedback) != 1 || !result.Feedback[0].AcceptedAt.IsZero() {
		t.Fatal("lost response was treated as acceptance")
	}
	if _, err := f.svc.Confirm(f.ctx, d.Run.ID, "feedback", d.Run.Version, p.Digest); err == nil {
		t.Fatal("duplicate native approval reused")
	}
	if q.calls != 1 {
		t.Fatal("duplicate delivery")
	}
	msg := feedbackMessage(q)
	if release, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, msg, "prepare"); err != nil {
		t.Fatal(err)
	} else {
		release()
	}
	if release, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, msg, "next_turn"); err != nil {
		t.Fatal(err)
	} else {
		release()
	}
	if _, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, msg, "next_turn"); err == nil {
		t.Fatal("uncertain submission retried")
	}
	restored := factoryrun.New(f.db, q.reader, f.dir)
	restored.SetFeedbackTransport(q)
	if _, err := restored.AcquireFeedbackInput(f.ctx, f.session.ID, msg, "next_turn"); err == nil {
		t.Fatal("restart revived authority")
	}
	if q.calls != 1 {
		t.Fatal("recovery submitted again")
	}
}

func TestFactoryFeedbackFinalBoundaryRejectsDrift(t *testing.T) {
	for _, mode := range []string{"expiry", "pause", "unpause", "settings", "generation", "payload", "source", "artifact", "run", "restart", "steer", "authorship"} {
		t.Run(mode, func(t *testing.T) {
			f, q, d, now := feedbackFixture(t)
			d = f.confirm(d, "feedback")
			msg := feedbackMessage(q)
			switch mode {
			case "expiry":
				*now = now.Add(3 * time.Minute)
			case "pause":
				d = f.confirm(d, "pause_feedback")
			case "unpause":
				d = f.confirm(d, "pause_feedback")
				d = f.confirm(d, "resume_feedback")
			case "settings":
				f.session.Metadata.Model = "different"
				if err := f.db.UpdateSession(f.ctx, f.session); err != nil {
					t.Fatal(err)
				}
			case "generation":
				f.session.Metadata.ControllerGeneration = "next"
				if err := f.db.UpdateSession(f.ctx, f.session); err != nil {
					t.Fatal(err)
				}
			case "authorship":
				msg.Origin = domain.MessageOriginHuman
				msg.ClientMessageID = "forged-human"
			case "payload":
				msg.Text += " changed"
			case "source":
				git(t, f.worktree, "commit", "--allow-empty", "-m", "new head")
				q.reader.facts.HeadSHA = git(t, f.worktree, "rev-parse", "HEAD")
				q.reader.facts.Fingerprint = strings.Repeat("c", 64)
			case "artifact":
				if err := os.WriteFile(filepath.Join(f.dir, "artifacts", string(f.session.ID), "checks.txt"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "run":
				_, err := f.svc.Advance(f.ctx, d.Run.ID, factoryrun.AdvanceInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "changed decision"})
				if err != nil {
					t.Fatal(err)
				}
			case "restart":
				f.svc = factoryrun.New(f.db, q.reader, f.dir)
			}
			action := "next_turn"
			if mode == "steer" {
				action = "active_steer"
			}
			if _, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, msg, action); err == nil {
				t.Fatalf("%s crossed submission gate", mode)
			}
			receipt, err := f.db.GetFactoryFeedback(f.ctx, q.key)
			if err != nil || !receipt.AttemptedAt.IsZero() {
				t.Fatalf("invalid approval attempted: %+v %v", receipt, err)
			}
		})
	}
}

func TestFactoryReviewRoundsImmutableAndBounded(t *testing.T) {
	f, _, d, _ := feedbackFixture(t)
	current := d.Evidence[len(d.Evidence)-1].Review
	original := *current
	duplicate, err := f.svc.Record(f.ctx, d.Run.ID, factoryrun.RecordInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "duplicate", Review: &original})
	if err != nil || duplicate.Run.Version != d.Run.Version {
		t.Fatalf("duplicate changed round: %v", err)
	}
	changed := original
	changed.Verdict = "approved"
	if _, err := f.svc.Record(f.ctx, d.Run.ID, factoryrun.RecordInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "replace", Review: &changed}); err == nil {
		t.Fatal("round overwritten")
	}
	for round := 2; round <= 3; round++ {
		next := original
		next.Round = round
		d, err = f.recordInput(f.ctx, d.Run.ID, factoryrun.RecordInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "new human-started pass", Review: &next})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Preview(f.ctx, d.Run.ID, "feedback"); err == nil {
		t.Fatal("third fix authorized")
	}
	fourth := original
	fourth.Round = 4
	if _, err := f.svc.Record(f.ctx, d.Run.ID, factoryrun.RecordInput{ExpectedVersion: d.Run.Version, Actor: "human", Decision: "fourth pass", Review: &fourth}); err == nil {
		t.Fatal("fourth pass admitted")
	}
}

func TestFactoryFeedbackExpiredApprovalNeedsFreshNativeDecision(t *testing.T) {
	f, q, d, now := feedbackFixture(t)
	d = f.confirm(d, "feedback")
	old := feedbackMessage(q)
	*now = now.Add(3 * time.Minute)
	if _, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, old, "next_turn"); err == nil {
		t.Fatal("expired authority submitted")
	}
	d = f.confirm(d, "feedback")
	fresh := feedbackMessage(q)
	if fresh.ClientMessageID == old.ClientMessageID || q.calls != 2 {
		t.Fatal("fresh native decision did not fence the previous queue identity")
	}
	if _, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, old, "next_turn"); err == nil {
		t.Fatal("superseded queue submitted")
	}
	if release, err := f.svc.AcquireFeedbackInput(f.ctx, f.session.ID, fresh, "next_turn"); err != nil {
		t.Fatal(err)
	} else {
		release()
	}
	if len(d.Feedback) != 2 || !d.Feedback[0].AcceptedAt.IsZero() || !d.Feedback[1].AcceptedAt.IsZero() {
		t.Fatal("approval counted as native acceptance")
	}
}

func TestFactoryFeedbackEnrollmentNeedsNativeCreationConfirmation(t *testing.T) {
	f := setup(t)
	claim := f.claim()
	f.svc = factoryrun.New(f.db, &feedbackReader{facts: claim.Facts}, f.dir)
	d, err := f.svc.Create(f.ctx, factoryrun.CreateInput{ID: "unconfirmed", ProjectID: "p", TaskID: "task", SessionID: f.session.ID, DesignDigest: strings.Repeat("a", 64), PolicyDecision: "per-turn", RequiredChecks: []string{"focused"}, Actor: "claimant", Decision: "claim"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.HoldUnapprovedContinuation(f.ctx, f.session.ID); err != nil {
		t.Fatal("unconfirmed claim changed an unrelated execution")
	}
	f.confirm(d, "evidence")
	if err := f.svc.HoldUnapprovedContinuation(f.ctx, f.session.ID); err == nil {
		t.Fatal("confirmed participant bypassed continuation gate")
	}
	if err := f.svc.HoldUnapprovedContinuation(f.ctx, "unrelated"); err != nil {
		t.Fatal("unrelated participant changed")
	}
}

func TestFactoryFeedbackRejectsTheImplementerNativeConversationAsReviewer(t *testing.T) {
	f, q, d, _ := feedbackFixture(t)
	f.session.Metadata.ProviderConversationID = "read-only-reviewer"
	if err := f.db.UpdateSession(f.ctx, f.session); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Preview(f.ctx, d.Run.ID, "feedback"); err == nil {
		t.Fatal("native self review was treated as independent")
	}
	if q.calls != 0 {
		t.Fatal("self review findings delivered")
	}
}
