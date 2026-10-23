package chat_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestFactoryFeedbackAcknowledgesOnlyNativeAcceptance(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	run := domain.FactoryRun{ID: "review-run", ProjectID: string(testProject), SessionID: testSession, Stage: "review", CreatedAt: h.now()}
	if err := h.st.SaveFactoryRun(ctx, run, domain.RunEvidence{ID: "create", RunID: run.ID, Kind: "created"}, true); err != nil {
		t.Fatal(err)
	}
	conversation, err := h.st.ConversationForSession(ctx, testSession)
	if err != nil {
		t.Fatal(err)
	}
	b := domain.RunFeedbackBinding{ConversationID: conversation.ID, ID: "feedback-1", RunID: run.ID, RepoName: "__root__", Round: 1, SessionID: testSession, Payload: "exact findings", ExpiresAt: h.now().Add(2 * time.Minute)}
	if err := h.st.ReserveFactoryFeedback(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := h.st.AttemptFactoryFeedback(ctx, b.ID, h.now()); err != nil {
		t.Fatal(err)
	}
	turn, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: b.Payload, ClientMessageID: b.ID, Origin: domain.MessageOriginAutomation})
	if err != nil {
		t.Fatal(err)
	}
	r, err := h.st.GetFactoryFeedback(ctx, b.ID)
	if err != nil || !r.AcceptedAt.IsZero() {
		t.Fatalf("send implied acceptance: %+v %v", r, err)
	}

	foreign, err := h.st.CreateSession(ctx, domain.SessionRecord{ProjectID: testProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: h.now(), UpdatedAt: h.now(), Metadata: domain.SessionMetadata{ControllerGeneration: "foreign-generation"}})
	if err != nil {
		t.Fatal(err)
	}
	foreignConversation, err := h.st.CreateConversation(ctx, "foreign-conversation", domain.ConversationScopeSession, testProject, foreign.ID, h.now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.AppendUserMessage(ctx, foreignConversation.ID, foreign.ID, "foreign-generation", domain.ConversationMessage{ID: "foreign-message", ClientMessageID: b.ID, Text: b.Payload, Role: domain.MessageRoleUser, Origin: domain.MessageOriginAutomation}, "foreign-turn", h.now()); err != nil {
		t.Fatal(err)
	}
	if err := h.st.BindTurnToProvider(ctx, "foreign-turn", "foreign-native-turn", h.now()); err != nil {
		t.Fatal(err)
	}
	if err := h.st.RecordReportChatAcceptance(ctx, foreignConversation.ID, "foreign-native-conversation", "foreign-native-turn", h.now()); err != nil {
		t.Fatal(err)
	}
	r, err = h.st.GetFactoryFeedback(ctx, b.ID)
	if err != nil || !r.AcceptedAt.IsZero() || r.TurnID != turn.ID {
		t.Fatalf("another session acknowledged copied delivery identity: %+v %v", r, err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turn.ProviderTurnID})
	time.Sleep(10 * time.Millisecond)
	r, _ = h.st.GetFactoryFeedback(ctx, b.ID)
	if !r.AcceptedAt.IsZero() {
		t.Fatal("synthetic start acknowledged findings")
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: turn.ProviderTurnID, ProviderEventID: "native-feedback-start"})
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, err = h.st.GetFactoryFeedback(ctx, b.ID)
		if err != nil {
			t.Fatal(err)
		}
		if r.State == "native_accepted" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native acceptance receipt missing")
		}
		time.Sleep(time.Millisecond)
	}
	first := r.AcceptedAt
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: turn.ProviderTurnID, ProviderEventID: "native-feedback-start"})
	if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: b.Payload, ClientMessageID: b.ID, Origin: domain.MessageOriginAutomation}); err != nil {
		t.Fatal(err)
	}
	r, _ = h.st.GetFactoryFeedback(ctx, b.ID)
	if !r.AcceptedAt.Equal(first) || h.conv.sendCallCount() != 1 {
		t.Fatal("duplicate delivery consumed another turn")
	}
}
