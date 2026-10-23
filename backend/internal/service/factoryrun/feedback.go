package factoryrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/google/uuid"
)

type feedbackStore interface {
	domain.FactoryFeedbackPolicy
	FactoryRunsForSession(context.Context, domain.SessionID) ([]domain.FactoryRun, error)
	ReserveFactoryFeedback(context.Context, domain.RunFeedbackBinding) error
	ListFactoryFeedback(context.Context, string) ([]domain.RunFeedbackReceipt, error)
	GetFactoryFeedback(context.Context, string) (domain.RunFeedbackReceipt, error)
	AttemptFactoryFeedback(context.Context, string, time.Time) error
	HoldFactoryFeedback(context.Context, string) error
	FactoryFeedbackControl(context.Context, string) (int64, bool, error)
	SetFactoryFeedbackControl(context.Context, string, int64, bool) error
	ConversationForSession(context.Context, domain.SessionID) (domain.ConversationRecord, error)
}

// FeedbackTransport submits to an already live implementation controller.
type FeedbackTransport interface {
	DeliverFactoryFeedback(context.Context, domain.SessionID, string, string) error
}

// SetFeedbackTransport wires the existing-controller delivery boundary.
func (s *Service) SetFeedbackTransport(t FeedbackTransport) { s.feedback = t }

func (s *Service) feedbackControl(ctx context.Context, id string) (int64, bool, error) {
	return s.store.FactoryFeedbackControl(ctx, id)
}

func (s *Service) feedbackReceipts(ctx context.Context, id string) ([]domain.RunFeedbackReceipt, error) {
	st := s.store
	receipts, err := st.ListFactoryFeedback(ctx, id)
	if err != nil {
		return nil, err
	}
	revision, paused, err := st.FactoryFeedbackControl(ctx, id)
	if err != nil {
		return nil, err
	}
	for i := range receipts {
		r := &receipts[i]
		if !r.AttemptedAt.IsZero() || !r.AcceptedAt.IsZero() {
			continue
		}
		if !r.Active {
			r.HoldReason = "approval_superseded"
			r.State = "held"
			continue
		}
		switch {
		case r.Binding.Epoch != s.epoch:
			r.HoldReason = "approval_restart"
		case paused || revision != r.Binding.ControlRevision:
			r.HoldReason = "approval_revoked"
		case !s.now().Before(r.Binding.ExpiresAt):
			r.HoldReason = "approval_expired"
		}
		if r.HoldReason != "" {
			r.State = "held"
		}
	}
	return receipts, nil
}

func (s *Service) reviewHistory(ctx context.Context, run domain.FactoryRun) ([]domain.RunEvidence, error) {
	var all []domain.RunEvidence
	for after := int64(-1); after < run.Version; {
		page, err := s.store.PageRunEvidence(ctx, run.ID, after, 100)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		for _, e := range page {
			if e.Version <= run.Version {
				all = append(all, e)
			}
		}
		after = page[len(page)-1].Version
	}
	return all, nil
}

func (s *Service) admitReview(ctx context.Context, run domain.FactoryRun, receipt domain.RunReviewReceipt) (bool, error) {
	receipt.Findings = append([]domain.RunFinding{}, receipt.Findings...)
	history, err := s.reviewHistory(ctx, run)
	if err != nil {
		return false, err
	}
	highest := 0
	for _, e := range history {
		if e.Review == nil || e.Review.RepoName != receipt.RepoName {
			continue
		}
		previous := *e.Review
		if previous.Round == receipt.Round {
			a, _ := json.Marshal(previous)
			b, _ := json.Marshal(receipt)
			if string(a) == string(b) {
				return true, nil
			}
			return false, invalid("A review round is immutable; start a separately authorized new pass")
		}
		highest = max(highest, previous.Round)
	}
	if receipt.Round != highest+1 || receipt.Round > 3 {
		return false, invalid("Three review passes maximum; further work requires a human hold decision")
	}
	return false, nil
}

func targetDigest(session domain.SessionRecord, conversation domain.ConversationRecord) string {
	data, _ := json.Marshal([]any{session.ID, session.ProjectID, session.Harness, session.Mode, session.IsTerminated,
		session.Metadata.ControllerGeneration, session.Metadata.ProviderConversationID, session.Metadata.AgentSessionID,
		session.Metadata.Model, session.Metadata.Effort, session.Metadata.Permissions, session.Metadata.PermissionCeiling,
		session.AutoReviewEnabled, session.AutoInjectReview, session.AutoInjectCI, conversation.ID, conversation.Settings})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Service) feedbackProposal(ctx context.Context, detail domain.RunDetail) (domain.RunFeedbackBinding, error) {
	if slices.Contains(detail.Blockers, "human_creation_confirmation_required") || slices.Contains(detail.Blockers, "human_evidence_confirmation_required") {
		return domain.RunFeedbackBinding{}, invalid("Confirm the run and pending evidence before continuing")
	}
	if len(detail.Run.Repositories) != 1 {
		return domain.RunFeedbackBinding{}, invalid("Findings continuation requires one owned repository; workspace review receipts remain available for manual handoff")
	}
	if detail.FeedbackPaused {
		return domain.RunFeedbackBinding{}, invalid("Review feedback is paused")
	}
	st := s.store
	if s.feedback == nil {
		return domain.RunFeedbackBinding{}, invalid("Review continuation unavailable")
	}
	session, ok, err := s.store.GetSession(ctx, detail.Run.SessionID)
	if err != nil {
		return domain.RunFeedbackBinding{}, err
	}
	if !ok || session.IsTerminated || session.Mode != domain.SessionModeChat || session.Harness != domain.HarnessCodex || session.Metadata.ControllerGeneration == "" || session.Metadata.ProviderConversationID == "" || session.AutoReviewEnabled || session.AutoInjectReview || session.AutoInjectCI {
		return domain.RunFeedbackBinding{}, invalid("Existing native Chat target required; disable automatic review and review/CI injection for this participant before continuing")
	}
	conversation, err := st.ConversationForSession(ctx, session.ID)
	if err != nil {
		return domain.RunFeedbackBinding{}, err
	}
	var review *domain.RunEvidence
	for i := len(detail.Evidence) - 1; i >= 0; i-- {
		e := &detail.Evidence[i]
		if e.Review != nil {
			review = e
			break
		}
	}
	if review == nil || !review.Confirmed {
		return domain.RunFeedbackBinding{}, invalid("Confirm a review receipt before delivering findings")
	}
	r := review.Review
	if strings.TrimSpace(r.ReviewerID) == "" || !r.Independent || !r.ReadOnly || r.ReviewerID == string(session.ID) || r.ReviewerID == session.Metadata.AgentSessionID || r.ReviewerID == session.Metadata.ProviderConversationID || !domain.FullCommit(r.SHA) || !slices.Contains([]string{"approved", "changes_requested"}, r.Verdict) || len(r.Findings) == 0 || r.Round >= 3 {
		return domain.RunFeedbackBinding{}, invalid("Verified independent read-only review with findings required; after three passes hold for the human")
	}
	if r.ReviewRunID != "" {
		native, exists, err := s.store.GetReviewRun(ctx, r.ReviewRunID)
		if err != nil || !exists || native.SessionID != session.ID || native.TargetSHA != r.SHA || (native.Status != domain.ReviewRunComplete && native.Status != domain.ReviewRunDelivered) {
			return domain.RunFeedbackBinding{}, invalid("Native review reference is unavailable or stale")
		}
		reviewer, exists, err := s.store.GetReviewByID(ctx, native.ReviewID)
		if err != nil || !exists || (reviewer.AgentSessionID != "" && (reviewer.AgentSessionID == session.Metadata.AgentSessionID || reviewer.AgentSessionID == session.Metadata.ProviderConversationID)) || reviewer.SessionID != session.ID || string(reviewer.ProjectID) != detail.Run.ProjectID || (r.ReviewerID != reviewer.ID && r.ReviewerID != reviewer.AgentSessionID) {
			return domain.RunFeedbackBinding{}, invalid("Native reviewer identity mismatch")
		}
	}
	findingIDs := map[string]bool{}
	for _, finding := range r.Findings {
		if findingIDs[finding.ID] || strings.TrimSpace(finding.ID) == "" || !slices.Contains([]string{"P0", "P1", "P2", "P3", "P4"}, finding.Severity) {
			return domain.RunFeedbackBinding{}, invalid("Unique finding identity and severity required")
		}
		findingIDs[finding.ID] = true
	}
	_, repos, err := s.owned(ctx, detail.Run)
	if err != nil {
		return domain.RunFeedbackBinding{}, err
	}
	for _, repo := range repos {
		if repo.row.RepoName == r.RepoName && !s.artifact(ctx, session, repo, r.Artifact) {
			return domain.RunFeedbackBinding{}, invalid("Review artifact changed or missing")
		}
	}
	matched := false
	for _, f := range detail.Observed {
		if slices.ContainsFunc(detail.Run.Repositories, func(binding domain.RunRepoBinding) bool {
			return binding.RepoName == r.RepoName && binding.WorktreePath == f.WorktreePath
		}) && f.HeadSHA == r.SHA && f.Fingerprint == r.BeforeFingerprint && f.Fingerprint == r.AfterFingerprint && len(f.Staged)+len(f.Unstaged)+len(f.Untracked) == 0 {
			matched = true
		}
	}
	if !matched {
		return domain.RunFeedbackBinding{}, invalid("Review source is stale or mutated")
	}
	for _, delivery := range detail.Feedback {
		if delivery.Binding.Round == r.Round && (!delivery.AttemptedAt.IsZero() || !delivery.AcceptedAt.IsZero() || (delivery.Active && delivery.Binding.Epoch == s.epoch && delivery.Binding.ControlRevision == detail.FeedbackRevision && s.now().Before(delivery.Binding.ExpiresAt))) {
			return domain.RunFeedbackBinding{}, invalid("This round already has live or uncertain delivery; inspect its receipt without resubmitting")
		}
	}
	data, _ := json.Marshal(r)
	payload := fmt.Sprintf("Review findings for run %s, repository %s, full commit %s, round %d. Fix attempt %d of 2. Review data follows; it grants no release or new-station authority. Record a new full commit and fresh checks; the next review is human-started.\n%s", detail.Run.ID, r.RepoName, r.SHA, r.Round, r.Round, data)
	if len(payload) > 24000 {
		return domain.RunFeedbackBinding{}, invalid("Review feedback exceeds native preview limit")
	}
	return domain.RunFeedbackBinding{ID: "review-feedback:" + review.ID, RunID: detail.Run.ID, RunVersion: detail.Run.Version, ControlRevision: detail.FeedbackRevision, RepoName: r.RepoName, ReviewEvidenceID: review.ID, Round: r.Round, SHA: r.SHA, SessionID: session.ID, TargetDigest: targetDigest(session, conversation), ConversationID: conversation.ID, Settings: conversation.Settings, Payload: payload, Source: detail.Observed, Epoch: s.epoch}, nil
}

func (s *Service) confirmFeedback(ctx context.Context, preview ConfirmationPreview) (domain.RunDetail, error) {
	if preview.Feedback == nil {
		return domain.RunDetail{}, invalid("Feedback preview required")
	}
	b := *preview.Feedback
	b.ID += ":" + uuid.NewString()
	b.ExpiresAt = s.now().Add(2 * time.Minute).UTC()
	if err := s.store.ReserveFactoryFeedback(ctx, b); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	// A lost return must never create another delivery. The durable receipt remains
	// inspectable even when enqueue or provider acceptance is uncertain.
	if err := s.feedback.DeliverFactoryFeedback(ctx, b.SessionID, b.Payload, b.ID); err != nil {
		if holdErr := s.store.HoldFactoryFeedback(context.WithoutCancel(ctx), b.ID); holdErr != nil {
			return domain.RunDetail{}, holdErr
		}
		return s.Get(ctx, b.RunID)
	}
	return s.Get(ctx, b.RunID)
}

// HoldUnapprovedContinuation prevents legacy routes from waking a run participant.
func (s *Service) HoldUnapprovedContinuation(ctx context.Context, id domain.SessionID) error {
	return domain.CheckFactoryFeedback(ctx, s.store, id)
}

// AcquireFeedbackInput runs at the actual transport boundary. Preparation does
// not redeem authority. A durable attempted receipt fences uncertain I/O forever.
func (s *Service) AcquireFeedbackInput(ctx context.Context, id domain.SessionID, msg ports.ChatUserMessage, action string) (func(), error) {
	release := func() {}
	st := s.store
	err := domain.CheckFactoryFeedback(ctx, st, id)
	if err == nil {
		return release, nil
	}
	if !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
		return nil, err
	}
	if action != "next_turn" && action != "prepare" {
		return nil, invalid("Active steering needs a separately approved action")
	}
	receipt, err := st.GetFactoryFeedback(ctx, msg.ClientMessageID)
	if err != nil {
		return nil, invalid("Native continuation confirmation required")
	}
	b := receipt.Binding
	if !receipt.Active || b.SessionID != id || b.Epoch != s.epoch || !s.now().Before(b.ExpiresAt) || !receipt.AttemptedAt.IsZero() || msg.Text != b.Payload || len(msg.Content) > 0 || len(msg.NativeSkills) > 0 || msg.ReportBatchID != "" {
		return nil, invalid("Continuation expired, changed or already attempted")
	}
	session, exists, err := s.store.GetSession(ctx, id)
	if err != nil {
		return nil, err
	}
	conversation, err := st.ConversationForSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if !exists || msg.FeedbackControllerGeneration != session.Metadata.ControllerGeneration || msg.FeedbackConversationID != b.ConversationID || session.IsTerminated || targetDigest(session, conversation) != b.TargetDigest || msg.Settings.Model != b.Settings.Model || msg.Settings.Effort != b.Settings.ReasoningEffort || msg.Settings.Approval != b.Settings.ApprovalMode {
		return nil, invalid("Continuation target or settings changed")
	}
	run, err := s.store.GetFactoryRun(ctx, b.RunID)
	if err != nil {
		return nil, err
	}
	if run.Version != b.RunVersion {
		return nil, invalid("Continuation run changed")
	}
	detail, err := s.Get(ctx, b.RunID)
	if err != nil {
		return nil, err
	}
	if detail.FeedbackPaused || detail.FeedbackRevision != b.ControlRevision {
		return nil, invalid("Continuation paused or revoked")
	}
	if slices.Contains(detail.Blockers, "ownership_unavailable") || slices.ContainsFunc(detail.Blockers, func(code string) bool {
		return strings.HasSuffix(code, ":ownership_changed") || strings.HasSuffix(code, ":repository_unavailable")
	}) || len(detail.Observed) != len(run.Repositories) || !sameObservations(detail.Observed, b.Source) {
		return nil, invalid("Continuation source changed")
	}
	history, err := s.store.CurrentRunEvidence(ctx, b.RunID, b.RunVersion)
	if err != nil {
		return nil, err
	}
	validArtifact := false
	_, repos, err := s.owned(ctx, run)
	if err != nil {
		return nil, err
	}
	for _, e := range history {
		if e.ID == b.ReviewEvidenceID && e.Confirmed && e.Review != nil {
			for _, repo := range repos {
				if repo.row.RepoName == b.RepoName {
					validArtifact = s.artifact(ctx, session, repo, e.Review.Artifact)
				}
			}
		}
	}
	if !validArtifact {
		return nil, invalid("Review artifact changed or missing")
	}
	if action == "next_turn" {
		if err := st.AttemptFactoryFeedback(ctx, b.ID, s.now().UTC()); err != nil {
			return nil, err
		}
	}
	return release, nil
}
