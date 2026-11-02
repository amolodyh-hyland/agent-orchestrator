package chat_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
)

func TestOuterM3ReviewerWithoutLaunchCredentialHoldsNotify(t *testing.T) {
	f, launcher, spec := m3ReviewFixture(t)
	ctx := context.Background()
	if _, err := f.st.SetSessionReviewerConfig(ctx, spec.SessionID, domain.ReviewerCodex, spec.Config, time.Now()); err != nil {
		t.Fatal(err)
	}
	engine := reviewcore.New(reviewcore.Deps{Store: f.st, Sessions: f.st, PRs: f.st, Projects: f.st, Launcher: launcher})
	svc := reviewsvc.New(engine, f.st)
	f.outer.SetReviews(svc)
	// An ordinary existing reviewer has never received M3's launch credential.
	// Give it normal native trigger authority before participant enrollment.
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "review.trigger", ProjectID: "a", SessionID: spec.SessionID})
	if _, err := engine.TriggerWithOptions(native, spec.SessionID, reviewcore.TriggerOptions{Harness: domain.ReviewerCodex, Config: spec.Config, InterfaceMode: domain.ReviewerInterfaceChat, PRURL: spec.Review.PRURL, Source: domain.ReviewTriggerManual}); err != nil {
		t.Fatal(err)
	}
	runs, err := f.st.ListReviewRunsBySession(ctx, spec.SessionID)
	if err != nil || len(runs) != 1 {
		t.Fatal("missing ordinary reviewer run", err)
	}
	initial := runs[0]
	p := f.providers[domain.SessionID("review-"+initial.ReviewID)]
	for _, start := range f.starts {
		if start.SessionID == domain.SessionID("review-"+initial.ReviewID) && start.Env["AO_SCOPE_CREDENTIAL"] != "" {
			t.Fatal("ordinary reviewer unexpectedly received an M3 credential")
		}
	}
	conversation, _ := f.st.ConversationForReview(ctx, initial.ReviewID)
	messages, _ := f.st.ConversationMessages(ctx, conversation.ID)
	if len(messages) == 0 {
		t.Fatal("ordinary review did not dispatch")
	}
	turnID := messages[0].TurnID
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", NativeAcceptance: true})
	if _, err := svc.Submit(ctx, spec.SessionID, initial.ID, domain.VerdictApproved, "ordinary review", ""); err != nil {
		t.Fatal(err)
	}
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted, NativeSettlement: true})
	waitM2(t, func() bool { turn, _ := f.st.TurnByID(ctx, turnID); return turn.State == domain.TurnStateCompleted })
	before, _, _ := f.st.GetReviewByID(ctx, initial.ReviewID)
	if _, err := f.st.IssueOuterReviewSessionGeneration(ctx, before.ID, before.ControllerGeneration); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("unapproved caller minted a reviewer session credential", err)
	}
	if err := f.st.BindOuterReviewResult(ctx, before.ID, before.ControllerGeneration); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("unapproved caller bound reviewer result authority", err)
	}
	if _, err := f.st.UpdateReviewActivity(ctx, before.ID, domain.ActivityIdle, "", before.ReviewerLaunchID); err != nil {
		t.Fatal(err)
	}
	pr, _, _ := f.st.GetPR(ctx, spec.Review.PRURL)
	pr.HeadSHA = strings.Repeat("b", 40)
	if err := f.st.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	spec.Review.HeadSHA = pr.HeadSHA
	plan := f.propose(spec)
	approved := f.approve(plan)
	if launcher.starts != 1 || launcher.notifies != 0 || p.sendCallCount() != 1 || approved.Actions[0].State != "not_started" {
		t.Fatal("credentialless reuse dispatched work or restored a reviewer", approved.Actions)
	}
	if _, err := f.st.GetOuterRequest(ctx, plan.Plan.Actions[0].ID); err == nil {
		t.Fatal("held reuse created an executable request")
	}
	capacity, err := f.st.OuterCapacity(ctx)
	if err != nil || len(capacity) != 0 {
		t.Fatal("definitive no-start did not release its unused station", err)
	}
	after, _, _ := f.st.GetReviewByID(ctx, initial.ReviewID)
	observed, err := f.st.ObserveOuterCapacity(ctx)
	if err != nil || observed.Stations != 0 || observed.Unknown != 0 || after.ReviewerActivityState != domain.ActivityIdle {
		t.Fatal("held legacy reviewer changed activity/capacity accounting", observed, err)
	}
	if after.ControllerGeneration != before.ControllerGeneration || after.ProviderConversationID != before.ProviderConversationID {
		t.Fatal("held reuse replaced the reviewer identity")
	}
}
