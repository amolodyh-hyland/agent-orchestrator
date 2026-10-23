package chat_test

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func enrollFactory(t *testing.T, h *harness) {
	t.Helper()
	run := domain.FactoryRun{ID: "factory", ProjectID: string(testProject), SessionID: testSession, Stage: "implementation", CreatedAt: h.now()}
	evidence := domain.RunEvidence{ID: "approval", RunID: run.ID, Kind: "created", Confirmed: true, Stage: run.Stage, RecordedAt: h.now()}
	if err := h.st.SaveFactoryRun(context.Background(), run, evidence, true); err != nil {
		t.Fatal(err)
	}
}
func TestFactoryDelayedQueuedFeedbackNeverReachesProvider(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	first, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "delayed feedback", Origin: domain.MessageOriginAutomation, ClientMessageID: "queued-feedback"})
	if err != nil || queued.State != domain.TurnStateQueued {
		t.Fatalf("queue: %+v %v", queued, err)
	}
	enrollFactory(t, h)
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
	held := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		current, err := h.st.TurnByID(ctx, queued.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.State == domain.TurnStateFailed {
			held = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !held {
		t.Fatal("queued feedback did not drain to a held outcome")
	}
	if h.conv.sendCallCount() != 1 {
		t.Fatal("held queue submitted a provider turn")
	}
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "feedback", Origin: domain.MessageOriginAutomation}); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
		t.Fatalf("automation not held: %v", err)
	}
}

func TestFactoryQueuedDaemonReviewerHeldAfterEnrollment(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	owner := domain.ReviewConversationOwner("factory-review")
	if err := h.st.UpsertReview(ctx, domain.Review{ID: owner.ID, SessionID: testSession, ProjectID: testProject, Harness: domain.ReviewerCodex, InterfaceMode: domain.ReviewerInterfaceChat, CreatedAt: h.now(), UpdatedAt: h.now()}); err != nil {
		t.Fatal(err)
	}
	reviewer := newFakeConversation()
	svc := chatsvc.New(chatsvc.Options{Store: h.st, Sessions: h.st, Reader: fullSnapshotReader(h.st), Drivers: fakeRegistry{driver: fakeDriver{conv: reviewer}}, Now: h.now, NewID: uuid.NewString, Log: slog.New(slog.DiscardHandler)})
	t.Cleanup(func() { svc.StopAll(context.Background()) })
	if _, err := svc.Start(ctx, chatsvc.StartConfig{Owner: owner, SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex, WorkspacePath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	first, err := svc.SendForOwner(ctx, owner, ports.ChatUserMessage{Text: "busy reviewer", Origin: domain.MessageOriginDaemon})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := svc.SendForOwner(ctx, owner, ports.ChatUserMessage{Text: "next review", Origin: domain.MessageOriginDaemon, ClientMessageID: "next-review"})
	if err != nil || queued.State != domain.TurnStateQueued {
		t.Fatalf("queue: %+v %v", queued, err)
	}
	enrollFactory(t, h)
	reviewer.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
	controller, err := svc.ControllerForOwner(owner)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := awaitStoreSnapshot(t, h.st, controller.ConversationID(), func(s store.ConversationSnapshot) bool {
		for _, turn := range s.Turns {
			if turn.ID == queued.ID {
				return turn.State == domain.TurnStateFailed
			}
		}
		return false
	})
	if reviewer.sendCallCount() != 1 {
		t.Fatalf("enrolled reviewer submitted queued turn: %+v", snapshot.Turns)
	}
	if _, err := svc.SendForOwner(ctx, owner, ports.ChatUserMessage{Text: "another review", Origin: domain.MessageOriginDaemon}); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
		t.Fatalf("daemon reviewer bypass: %v", err)
	}
}

type factoryDeferredReviewer struct {
	*fakeConversation
	admission func(context.Context) (func(), error)
}

func (*factoryDeferredReviewer) StartDeferredTurn(string) error {
	return errors.New("unguarded deferred start")
}
func (*factoryDeferredReviewer) DiscardDeferredTurn(string) {}
func (p *factoryDeferredReviewer) StartDeferredTurnWithAdmission(_ string, admission func(context.Context) (func(), error)) error {
	p.admission = admission
	return nil
}

type factoryReviewerAdmission struct {
	calls     atomic.Int32
	afterWait func()
}

func (a *factoryReviewerAdmission) AcquireChatInput(context.Context, domain.SessionID, string) (func(), error) {
	if a.calls.Add(1) == 2 && a.afterWait != nil {
		a.afterWait()
	}
	return func() {}, nil
}

func TestFactoryDaemonReviewerDeferredTransportRechecksEnrollment(t *testing.T) {
	for _, when := range []string{"before_transport", "during_admission"} {
		t.Run(when, func(t *testing.T) {
			h := newHarness(t)
			ctx := context.Background()
			owner := domain.ReviewConversationOwner("deferred-review")
			if err := h.st.UpsertReview(ctx, domain.Review{ID: owner.ID, SessionID: testSession, ProjectID: testProject, Harness: domain.ReviewerCodex, InterfaceMode: domain.ReviewerInterfaceChat, CreatedAt: h.now(), UpdatedAt: h.now()}); err != nil {
				t.Fatal(err)
			}
			provider := &factoryDeferredReviewer{fakeConversation: newFakeConversation()}
			svc := chatsvc.New(chatsvc.Options{Store: h.st, Sessions: h.st, Reader: fullSnapshotReader(h.st), Drivers: fakeRegistry{driver: fakeDriver{conv: provider}}, Now: h.now, NewID: uuid.NewString, Log: slog.New(slog.DiscardHandler)})
			admission := &factoryReviewerAdmission{}
			if when == "during_admission" {
				admission.afterWait = func() { enrollFactory(t, h) }
			}
			svc.SetLibraryAdmission(admission)
			t.Cleanup(func() { svc.StopAll(context.Background()) })
			if _, err := svc.Start(ctx, chatsvc.StartConfig{Owner: owner, SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex, WorkspacePath: t.TempDir()}); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.SendForOwner(ctx, owner, ports.ChatUserMessage{Text: "review", Origin: domain.MessageOriginDaemon}); err != nil {
				t.Fatal(err)
			}
			if provider.admission == nil {
				t.Fatal("missing final transport admission")
			}
			if when == "before_transport" {
				enrollFactory(t, h)
			}
			release, err := provider.admission(ctx)
			if release != nil {
				release()
			}
			if !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
				t.Fatalf("deferred reviewer bypass: %v", err)
			}
		})
	}
}
