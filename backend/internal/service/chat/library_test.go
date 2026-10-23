package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
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

// The second acquisition occurs after SendTurn prepared ACP's prompt and after
// its provider ID is durable. Pause there while revocation completes.
type deferredLibraryAdmission struct {
	mu       sync.RWMutex
	revoked  bool
	calls    atomic.Int32
	prepared chan struct{}
	resume   chan struct{}
}

func (a *deferredLibraryAdmission) AcquireChatInput(ctx context.Context, _ domain.SessionID, _ string) (func(), error) {
	if a.calls.Add(1) == 2 && a.prepared != nil {
		close(a.prepared)
		select {
		case <-a.resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	a.mu.RLock()
	if a.revoked {
		a.mu.RUnlock()
		return nil, errors.New("revoked")
	}
	return a.mu.RUnlock, nil
}
func (a *deferredLibraryAdmission) revoke() { a.mu.Lock(); a.revoked = true; a.mu.Unlock() }

type libraryDeferredConversation struct {
	deferredSideTestConversation
	starts    atomic.Int32
	discarded atomic.Bool
	start     func()
}

func (c *libraryDeferredConversation) StartDeferredTurn(string) error {
	c.starts.Add(1)
	if c.start != nil {
		c.start()
	}
	return nil
}
func (c *libraryDeferredConversation) DiscardDeferredTurn(string) { c.discarded.Store(true) }

type libraryDispatchStore struct {
	noopSettingsStore
	failed bool
}

func (*libraryDispatchStore) BindTurnToProvider(context.Context, string, string, time.Time) error {
	return nil
}
func (s *libraryDispatchStore) SettleTurnByID(_ context.Context, _ string, state domain.TurnState, _ string, _ time.Time) error {
	s.failed = state == domain.TurnStateFailed
	return nil
}

func TestLibraryDeferredMainDispatchRejectsCompletedRevocation(t *testing.T) {
	admission := &deferredLibraryAdmission{prepared: make(chan struct{}), resume: make(chan struct{})}
	provider := &libraryDeferredConversation{}
	store := &libraryDispatchStore{}
	svc := &Service{log: slog.New(slog.DiscardHandler)}
	svc.SetLibraryAdmission(admission)
	controller := newController("session", domain.SessionConversationOwner("session"), domain.ConversationRecord{}, "generation", domain.HarnessCodex, provider, store, nil, svc.log, func() string { return "id" }, time.Now, nil, nil, nil)
	controller.libraryInput = svc.acquireLibraryInput
	done := make(chan error, 1)
	go func() {
		_, err := controller.dispatch(context.Background(), "turn", ports.ChatUserMessage{Text: "continue"}, time.Now())
		done <- err
	}()
	select {
	case <-admission.prepared:
	case <-time.After(5 * time.Second):
		t.Fatal("prepared turn never reached start admission")
	}
	admission.revoke()
	close(admission.resume)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("revoked turn dispatched")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch stuck")
	}
	if provider.starts.Load() != 0 || !provider.discarded.Load() || !store.failed {
		t.Fatal("prepared main prompt was not discarded and settled")
	}
}

func TestLibraryDeferredSideDispatchRejectsCompletedRevocation(t *testing.T) {
	ctx := context.Background()
	admission := &deferredLibraryAdmission{prepared: make(chan struct{}), resume: make(chan struct{})}
	svc := New(Options{AppRunID: "launch-1", Sessions: sideSessionReader{}})
	svc.SetLibraryAdmission(admission)
	manager := svc.sides
	now := time.Now().UTC()
	if _, err := manager.store.ClaimSideLaunch(ctx, "launch-1", now); err != nil {
		t.Fatal(err)
	}
	side := domain.SideConversation{PolicyVersion: 1, ID: "side-1", SessionID: "session-1", MainConversationID: "main-1", AppRunID: "launch-1", Generation: "g", State: "opening"}
	if _, _, err := manager.store.CreateSideConversation(ctx, side); err != nil {
		t.Fatal(err)
	}
	if err := manager.store.SetSideReady(ctx, side.ID, side.Generation, "provider", now); err != nil {
		t.Fatal(err)
	}
	side.State = "ready"
	if _, _, err := manager.store.ReserveSideTurn(ctx, domain.SideTurn{ID: "turn-1", SideID: side.ID, ClientMessageID: "client-1", Text: "continue", CreatedAt: now}, "launch-1"); err != nil {
		t.Fatal(err)
	}
	turn, _, found, err := manager.store.ClaimNextSideTurn(ctx, "launch-1", nil, now)
	if err != nil || !found {
		t.Fatalf("claim: %v %v", found, err)
	}
	provider := &libraryDeferredConversation{}
	runtime := &sideRuntime{side: side, conv: provider, done: ctx.Done(), completed: make(chan ports.ChatEvent, 1)}
	done := make(chan struct{})
	go func() { manager.runTurn(runtime, side, turn); close(done) }()
	select {
	case <-admission.prepared:
	case <-time.After(5 * time.Second):
		t.Fatal("side never reached start admission")
	}
	admission.revoke()
	close(admission.resume)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("side dispatch stuck")
	}
	settled, err := manager.store.SideTurn(ctx, side.ID, turn.ID)
	if err != nil || settled.State != "failed" || provider.starts.Load() != 0 || !provider.discarded.Load() {
		t.Fatalf("revoked side prompt not discarded: %+v %v", settled, err)
	}
}

func TestLibraryDeferredStartHoldsAdmissionUntilProviderDispatch(t *testing.T) {
	admission := &deferredLibraryAdmission{}
	started, finish := make(chan struct{}), make(chan struct{})
	provider := &libraryDeferredConversation{start: func() { close(started); <-finish }}
	done := make(chan error, 1)
	go func() {
		done <- startLibraryDeferredTurn(context.Background(), provider, "prepared", "continue", func(ctx context.Context, text string) (func(), error) {
			return admission.AcquireChatInput(ctx, "session", text)
		})
	}()
	<-started
	if admission.mu.TryLock() {
		admission.mu.Unlock()
		t.Fatal("provider dispatch has no admission lease")
	}
	close(finish)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	admission.revoke()
}
