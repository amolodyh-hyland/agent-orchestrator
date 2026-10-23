package chat_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
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
