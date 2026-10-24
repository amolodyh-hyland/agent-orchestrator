package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func planJournal(t *testing.T) (outerJournal, domain.OuterActionPlan, domain.SessionRecord, domain.ConversationRecord) {
	t.Helper()
	f := newOuterJournal(t)
	f.now = time.Now().UTC()
	r := f.request(t, "human-request-for-plan")
	ctx := context.Background()
	target := sampleRecord("a")
	target.Kind = domain.KindOrchestrator
	target.Mode = domain.SessionModeChat
	target.Harness = domain.HarnessCodex
	target.Activity.State = domain.ActivityIdle
	target.Metadata.ControllerGeneration = "coordinator-generation"
	target.Metadata.ProviderConversationID = "coordinator-native"
	target, err := f.st.CreateSession(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.st.CreateConversation(ctx, "target-conversation", domain.ConversationScopeSession, "a", target.ID, f.now)
	if err != nil {
		t.Fatal(err)
	}
	p, _, err := f.st.GetProject(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	plan := domain.OuterActionPlan{ID: "sealed-plan", Request: r, Epoch: "boot-1", CreatedAt: f.now, Sources: []domain.OuterSource{{ProjectID: "b", Label: "B", Sources: []string{"b"}}}, Actions: []domain.OuterPlannedAction{{ID: "exact-action", Spec: domain.OuterActionSpec{Operation: "send", ProjectID: "a", SessionID: target.ID, Text: "exact outgoing text"}, ProjectLabel: "A", ProjectRevision: p.Revision, TargetDigest: domain.OuterSettingsDigest(target, c, p), ControllerGeneration: target.Metadata.ControllerGeneration, ProviderConversationID: target.Metadata.ProviderConversationID, ConversationID: c.ID}}}
	if err := f.st.CreateOuterPlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	return f, plan, target, c
}

func approvePlanContext(id string) context.Context {
	return domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: id})
}

func TestOuterPlanSingleNativeApprovalAndSealedInstances(t *testing.T) {
	f, p, _, _ := planJournal(t)
	for _, ctx := range []context.Context{context.Background(), domain.WithOuterCaller(context.Background(), domain.OuterCaller{Outer: true, SessionID: f.session.ID})} {
		if err := f.st.ApproveOuterPlan(ctx, p.ID, domain.OuterDigest(p), p.Epoch, f.now); err == nil {
			t.Fatal("untrusted issuer approved a plan")
		}
	}
	tampered := p
	tampered.Actions = append([]domain.OuterPlannedAction{}, p.Actions...)
	tampered.Actions[0].Spec.Text = "different"
	if err := f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(tampered), p.Epoch, f.now); err == nil {
		t.Fatal("changed manifest approved")
	}
	var wg sync.WaitGroup
	successes := 0
	var mu sync.Mutex
	for range 8 {
		wg.Go(func() {
			if f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(p), p.Epoch, f.now) == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if successes != 1 {
		t.Fatalf("approval successes=%d", successes)
	}
	if err := f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(p), p.Epoch, f.now); err == nil {
		t.Fatal("approval replay")
	}
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{`UPDATE outer_action_plans SET document='{}'`, `DELETE FROM outer_action_plans`, `DELETE FROM outer_plan_actions`} {
		if _, err := db.Exec(query); err == nil {
			t.Fatalf("journal mutation accepted: %s", query)
		}
	}
	if err := f.st.AttemptOuterPlanAction(context.Background(), p.ID, "*", p.Epoch, f.now); err == nil {
		t.Fatal("wildcard action")
	}
	if err := f.st.AttemptOuterPlanAction(context.Background(), p.ID, p.Actions[0].ID, p.Epoch, f.now.Add(2*time.Minute)); err == nil {
		t.Fatal("expired action")
	}
}

func TestOuterPlanExactTurnReceiptRecoveryAndProvenance(t *testing.T) {
	f, p, target, c := planJournal(t)
	ctx := context.Background()
	if err := f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(p), p.Epoch, f.now); err != nil {
		t.Fatal(err)
	}
	a := p.Actions[0]
	if err := f.st.AttemptOuterPlanAction(ctx, p.ID, a.ID, p.Epoch, f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.st.AttemptOuterPlanAction(ctx, p.ID, a.ID, p.Epoch, f.now); err == nil {
		t.Fatal("action replayed")
	}
	if err := f.st.EnrollOuterParticipant(ctx, p.ID, a.ID, target.ID, f.now); err != nil {
		t.Fatal(err)
	}
	request := domain.OuterRequest{ID: a.ID, PlanID: p.ID, OwnerSessionID: f.session.ID, HumanMessage: p.Request.HumanMessage, Payload: a.Spec.Text, PayloadDigest: domain.OuterDigest(a.Spec.Text), SessionID: target.ID, ConversationID: c.ID, ProviderConversationID: a.ProviderConversationID, ControllerGeneration: a.ControllerGeneration, BindingRevision: f.binding.Revision, ScopeRevision: f.binding.ScopeRevision, SettingsDigest: a.TargetDigest, Epoch: p.Epoch, IssuedAt: f.now, ExpiresAt: f.now.Add(2 * time.Minute), Sources: p.Sources}
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.send", RequestID: a.ID, SessionID: target.ID})
	if err := f.st.CreateOuterRequest(native, request); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.AppendUserMessage(native, c.ID, target.ID, a.ControllerGeneration, domain.ConversationMessage{ID: "m2-message", ClientMessageID: a.ID, Text: a.Spec.Text, Origin: domain.MessageOriginAutomation}, "m2-turn", f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.st.AttemptOuterRequest(ctx, a.ID, p.Epoch, f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.st.AttemptOuterRequest(ctx, a.ID, p.Epoch, f.now); err == nil {
		t.Fatal("turn authority reused")
	}
	r, err := f.st.GetOuterRequest(ctx, a.ID)
	if err != nil || r.State != "unknown" {
		t.Fatal(r, err)
	}
	if err := f.st.Close(); err != nil {
		t.Fatal(err)
	}
	f.st, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.st.Close() })
	if recovered, err := f.st.GetOuterRequest(ctx, a.ID); err != nil || recovered.State != "unknown" || recovered.TurnID != r.TurnID {
		t.Fatal("restart lost original receipt", recovered, err)
	}
	if err := f.st.AttemptOuterRequest(ctx, a.ID, "new-boot", f.now); err == nil {
		t.Fatal("restart replayed old turn")
	}
	reservations, err := f.st.OuterCapacity(ctx)
	if err != nil || len(reservations) != 1 || reservations[0].Foreground {
		t.Fatal(reservations, err)
	}
	if err := f.st.RecordOuterSettlement(ctx, c.ID, "native-target-turn", a.ControllerGeneration, f.now); err != nil {
		t.Fatal(err)
	}
	reservations, _ = f.st.OuterCapacity(ctx)
	if len(reservations) != 1 {
		t.Fatal("unknown freed capacity")
	}
	if err := f.st.BindTurnToProvider(ctx, "m2-turn", "native-target-turn", f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.st.RecordReportChatAcceptance(ctx, c.ID, a.ProviderConversationID, "native-target-turn", f.now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	r, err = f.st.GetOuterRequest(ctx, a.ID)
	if err != nil || r.State != "native_accepted" {
		t.Fatal(r, err)
	}
	if err := f.st.RecordOuterSettlement(ctx, c.ID, "native-target-turn", a.ControllerGeneration, f.now.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	reservations, _ = f.st.OuterCapacity(ctx)
	if len(reservations) != 0 {
		t.Fatal("settled capacity retained", reservations)
	}
	if err := f.st.CheckOuterOperation(native, "spawn", target.ProjectID, ""); err == nil {
		t.Fatal("turn approval became spawn authority")
	}
	if held, err := f.st.FactoryFeedbackHeld(ctx, target.ID); err != nil || !held {
		t.Fatal("participant feedback active", held, err)
	}
	facts, err := f.st.OuterFacts(ctx, "a", "sessions", 20)
	if err != nil {
		t.Fatal(err)
	}
	newScope := f.binding
	newScope.ProjectIDs = []string{"a"}
	newScope.Revision++
	newScope.ScopeRevision++
	if err := f.st.SaveOuterBinding(ctx, newScope, f.binding.Revision, domain.OuterAudit{Operation: "scope"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.LabelOuterFacts(ctx, newScope, "replacement-native", facts); err == nil {
		t.Fatal("B-derived content reimported via A after removal")
	}
}

func TestOuterPlanCannotWaiveExistingExactHeadReviewGate(t *testing.T) {
	f, p, target, _ := planJournal(t)
	run := domain.FactoryRun{ID: "independent-review-run", ProjectID: "a", SessionID: target.ID, Stage: "implementation", CreatedAt: f.now}
	if err := f.st.SaveFactoryRun(context.Background(), run, domain.RunEvidence{ID: "run-approval", RunID: run.ID, Kind: "created", Confirmed: true}, true); err != nil {
		t.Fatal(err)
	}
	if err := f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(p), p.Epoch, f.now); err == nil {
		t.Fatal("generic plan waived existing run review controls")
	}
}

func TestOuterPlanPauseRevocationAndCancellation(t *testing.T) {
	for _, change := range []string{"pause", "scope", "generation", "settings", "restart", "cancel"} {
		t.Run(change, func(t *testing.T) {
			f, p, target, _ := planJournal(t)
			ctx := context.Background()
			switch change {
			case "pause", "scope":
				b := f.binding
				b.Revision++
				if change == "pause" {
					b.Paused = true
				} else {
					b.ProjectIDs = []string{"a"}
					b.ScopeRevision++
				}
				if err := f.st.SaveOuterBinding(ctx, b, f.binding.Revision, domain.OuterAudit{Operation: change}); err != nil {
					t.Fatal(err)
				}
			case "generation":
				target.Metadata.ControllerGeneration = "replacement"
				if err := f.st.UpdateSession(ctx, target); err != nil {
					t.Fatal(err)
				}
			case "settings":
				if err := f.st.SetConversationSettings(ctx, p.Actions[0].ConversationID, domain.ConversationSettings{Model: "changed-model"}, f.now); err != nil {
					t.Fatal(err)
				}
			case "restart":
				p.Epoch = "new-boot"
			case "cancel":
				c := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.plan.cancel", RequestID: p.ID})
				if err := f.st.CancelOuterPlan(c, p.ID, domain.OuterDigest(p), f.now); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.st.ApproveOuterPlan(approvePlanContext(p.ID), p.ID, domain.OuterDigest(p), p.Epoch, f.now); err == nil {
				t.Fatal("changed plan approved")
			}
		})
	}
}
