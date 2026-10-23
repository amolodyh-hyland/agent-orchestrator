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

type feedbackAdmissionStub struct {
	denied  bool
	actions []string
}

func (s *feedbackAdmissionStub) HoldUnapprovedContinuation(context.Context, domain.SessionID) error {
	if s.denied {
		return errors.New("native approval required")
	}
	return nil
}

func (s *feedbackAdmissionStub) AcquireFeedbackInput(_ context.Context, _ domain.SessionID, _ ports.ChatUserMessage, action string) (func(), error) {
	s.actions = append(s.actions, action)
	if s.denied {
		return nil, errors.New("expired")
	}
	return func() {}, nil
}

func TestFactoryFeedbackDispatchAndReplacementAreGuarded(t *testing.T) {
	ctx := context.Background()
	a := &feedbackAdmissionStub{}
	svc := &Service{log: slog.New(slog.DiscardHandler), newID: func() string { return "id" }, now: time.Now}
	svc.SetFeedbackAdmission(a)
	provider := &fakeSender{}
	c := newController("session", domain.SessionConversationOwner("session"), domain.ConversationRecord{}, "generation", domain.HarnessCodex, provider, noopSettingsStore{}, nil, svc.log, svc.newID, svc.now, nil, nil, nil)
	c.feedbackInput = svc.acquireFeedbackInput
	if _, err := c.sendTurn(ctx, ports.ChatUserMessage{Text: "findings", Origin: domain.MessageOriginAutomation}); err != nil {
		t.Fatal(err)
	}
	a.denied = true
	if _, err := c.sendTurn(ctx, ports.ChatUserMessage{Text: "findings", Origin: domain.MessageOriginAutomation}); err == nil {
		t.Fatal("expired turn dispatched")
	}
	replacement := svc.newReplacementController("session", c, domain.ConversationRecord{}, "next", provider)
	if _, err := replacement.sendTurn(ctx, ports.ChatUserMessage{Text: "findings", Origin: domain.MessageOriginAutomation}); err == nil {
		t.Fatal("replacement bypassed confirmation")
	}
	if len(provider.modes) != 1 {
		t.Fatal("invalid approval reached provider")
	}
}

func TestFactoryFeedbackDoesNotWakeMissingController(t *testing.T) {
	svc := &Service{controllers: map[domain.SessionID]*Controller{}}
	if err := svc.DeliverFactoryFeedback(context.Background(), "missing", "findings", "key"); err == nil {
		t.Fatal("missing target accepted")
	}
}

func TestFactoryFeedbackDeferredTransportChecksAfterPreparation(t *testing.T) {
	ctx := context.Background()
	admission := &feedbackAdmissionStub{}
	provider := &guardedLibraryDeferredConversation{}
	st := &libraryDispatchStore{}
	svc := &Service{log: slog.New(slog.DiscardHandler)}
	svc.SetFeedbackAdmission(admission)
	c := newController("session", domain.SessionConversationOwner("session"), domain.ConversationRecord{}, "generation", domain.HarnessCodex, provider, st, nil, svc.log, func() string { return "id" }, time.Now, nil, nil, nil)
	c.feedbackInput = svc.acquireFeedbackInput
	if _, err := c.dispatch(ctx, "turn", ports.ChatUserMessage{Text: "approved findings", Origin: domain.MessageOriginAutomation}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if provider.acquire == nil || len(admission.actions) != 1 || admission.actions[0] != "prepare" {
		t.Fatal("preparation consumed submission authority")
	}
	admission.denied = true
	if release, err := provider.acquire(ctx); err == nil {
		release()
		t.Fatal("expired approval crossed asynchronous transport boundary")
	}
	if provider.starts.Load() != 0 {
		t.Fatal("expired deferred turn started")
	}
}

func TestFactoryFeedbackLegacyRoutesHoldBeforeControllerWake(t *testing.T) {
	svc := &Service{}
	svc.SetFeedbackAdmission(&feedbackAdmissionStub{denied: true})
	ctx := context.Background()
	if _, err := svc.Send(ctx, "session", ports.ChatUserMessage{Text: "forwarded findings"}); err == nil {
		t.Fatal("legacy send bypassed confirmation")
	}
	if _, err := svc.RelayChatTurn(ctx, "session", "forwarded findings"); err == nil {
		t.Fatal("relay bypassed confirmation")
	}
	if _, err := svc.Steer(ctx, "session", ports.ChatUserMessage{Text: "findings"}); err == nil {
		t.Fatal("steer bypassed confirmation")
	}
}
