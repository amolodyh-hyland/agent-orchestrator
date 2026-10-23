package chat

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReportNativeAcceptanceRequiresExactHistoryTurnIdentity(t *testing.T) {
	for _, nativeID := range []string{"original-native-turn", "remapped-native-turn"} {
		t.Run(nativeID, func(t *testing.T) {
			events := reconcileNativeHistory([]ports.ChatEvent{
				{Kind: ports.ChatEventTurnStarted, ProviderTurnID: nativeID, NativeAcceptance: true},
				{Kind: ports.ChatEventUserMessageCompleted, ProviderTurnID: nativeID, ClientMessageID: "client", Text: "same text"},
			}, []domain.ConversationTurn{{ID: "turn", ProviderTurnID: "original-native-turn", State: domain.TurnStateRunning}},
				[]domain.ConversationMessage{{ID: "message", TurnID: "turn", Role: domain.MessageRoleUser, Text: "same text", ClientMessageID: "client"}}, nil)
			if len(events) == 0 || events[0].Kind != ports.ChatEventTurnStarted {
				t.Fatalf("reconciled events=%+v", events)
			}
			if events[0].ProviderTurnID != "original-native-turn" || events[0].NativeAcceptance != (nativeID == "original-native-turn") {
				t.Fatalf("native receipt inferred from remapping: %+v", events[0])
			}
		})
	}
}
