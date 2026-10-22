package chat

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type libraryAdmissionStub struct {
	denied bool
	held   int
}

func (s *libraryAdmissionStub) AcquireChatInput(context.Context, domain.SessionID, string) (func(), error) {
	if s.denied {
		return nil, errors.New("revoked")
	}
	s.held++
	return func() { s.held-- }, nil
}
func TestLibraryControlledChatChecksEveryDispatchAndReplacement(t *testing.T) {
	admission := &libraryAdmissionStub{}
	svc := &Service{log: slog.New(slog.DiscardHandler), newID: func() string { return "id" }, now: func() time.Time { return time.Unix(0, 0) }}
	svc.SetLibraryAdmission(admission)
	provider := &fakeSender{}
	controller := newController("session", domain.SessionConversationOwner("session"), domain.ConversationRecord{}, "generation", domain.HarnessCodex, provider, noopSettingsStore{}, nil, svc.log, svc.newID, svc.now, nil, nil, nil)
	controller.libraryInput = svc.acquireLibraryInput
	if _, err := controller.sendTurn(context.Background(), ports.ChatUserMessage{Text: "ordinary message"}); err != nil {
		t.Fatal(err)
	}
	if len(provider.modes) != 1 || admission.held != 0 {
		t.Fatal("lease not released")
	}
	admission.denied = true
	for _, text := range []string{"$review", "/review", "please review this", "continue"} {
		if _, err := controller.sendTurn(context.Background(), ports.ChatUserMessage{Text: text}); err == nil {
			t.Fatalf("revoked dispatch accepted: %s", text)
		}
	}
	replacement := svc.newReplacementController("session", controller, domain.ConversationRecord{}, "next", provider)
	if _, err := replacement.sendTurn(context.Background(), ports.ChatUserMessage{Text: "continue"}); err == nil || len(provider.modes) != 1 {
		t.Fatal("replacement bypassed revocation")
	}
}
