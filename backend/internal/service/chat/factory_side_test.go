package chat

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type factorySidePolicy struct {
	Store
	held atomic.Bool
}

func (s *factorySidePolicy) FactoryFeedbackHeld(context.Context, domain.SessionID) (bool, error) {
	return s.held.Load(), nil
}

func factorySideFixture(t *testing.T) (*Service, *factorySidePolicy, domain.SideConversation, domain.SideTurn) {
	t.Helper()
	ctx := context.Background()
	svc := New(Options{AppRunID: "launch-1", Sessions: sideSessionReader{}})
	policy := &factorySidePolicy{}
	svc.store = policy
	t.Cleanup(func() { svc.sides.cancel() })
	now := time.Now().UTC()
	if _, err := svc.sides.store.ClaimSideLaunch(ctx, "launch-1", now); err != nil {
		t.Fatal(err)
	}
	side := domain.SideConversation{PolicyVersion: sidePolicyVersion, ID: "side-1", SessionID: "session-1", MainConversationID: "main-1", AppRunID: "launch-1", Generation: "g", State: "opening"}
	if _, _, err := svc.sides.store.CreateSideConversation(ctx, side); err != nil {
		t.Fatal(err)
	}
	if err := svc.sides.store.SetSideReady(ctx, side.ID, side.Generation, "provider-side-1", now); err != nil {
		t.Fatal(err)
	}
	side.State = "ready"
	side.ProviderForkID = "provider-side-1"
	if _, _, err := svc.sides.store.ReserveSideTurn(ctx, domain.SideTurn{ID: "turn-1", SideID: side.ID, ClientMessageID: "client-1", Text: "findings", CreatedAt: now}, "launch-1"); err != nil {
		t.Fatal(err)
	}
	turn, _, found, err := svc.sides.store.ClaimNextSideTurn(ctx, "launch-1", nil, now)
	if err != nil || !found {
		t.Fatalf("claim: %v %v", found, err)
	}
	return svc, policy, side, turn
}

func TestFactorySideEntryPointsHoldBeforeExecution(t *testing.T) {
	svc, p, side, _ := factorySideFixture(t)
	p.held.Store(true)
	ctx := context.Background()
	checks := map[string]func() error{
		"create": func() error {
			_, err := svc.CreateIndependentSideChat(ctx, side.SessionID, SideCreateRequest{IdempotencyKey: "new"})
			return err
		},
		"send": func() error {
			_, err := svc.SendSideQuestion(ctx, side.SessionID, side.ID, ports.ChatUserMessage{Text: "findings", ClientMessageID: "next"})
			return err
		},
		"retry connection": func() error { return svc.RetrySideConnection(ctx, side.SessionID, side.ID) },
		"retry turn":       func() error { return svc.RetrySideQuestion(ctx, side.SessionID, side.ID, "turn-1") },
		"restore":          func() error { return svc.sides.ensureRestore(side) },
		"fork source":      func() error { _, _, err := svc.lockCurrentSide(ctx, side); return err },
		"compact":          func() error { _, err := svc.CompactSideChat(ctx, side.SessionID, side.ID); return err },
		"approval":         func() error { return svc.ResolveSideApproval(ctx, side.SessionID, side.ID, "request", "decision") },
		"input": func() error {
			return svc.ResolveSideInput(ctx, side.SessionID, side.ID, "request", ports.ChatInputResponse{})
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
				t.Fatalf("held entry: %v", err)
			}
		})
	}
	// These asynchronous boundaries can have been scheduled before enrollment.
	svc.sides.open(side, StartConfig{}, nil)
	svc.sides.restore(ctx, side)
	if len(svc.sides.restoring) != 0 || len(svc.sides.runtimes) != 0 {
		t.Fatal("held side was opened or restored")
	}
}

func TestFactoryQueuedSideTurnHeldAfterEnrollment(t *testing.T) {
	svc, p, side, turn := factorySideFixture(t)
	p.held.Store(true)
	conv := &deferredSideTestConversation{}
	runtime := &sideRuntime{side: side, conv: conv}
	svc.sides.runTurn(runtime, side, turn)
	row, err := svc.sides.store.SideTurn(context.Background(), side.ID, turn.ID)
	if err != nil || row.State != "failed" || conv.sent != 0 {
		t.Fatalf("queued side crossed enrollment: %+v sent=%d err=%v", row, conv.sent, err)
	}
}

type enrollingSideLibrary struct {
	LibraryAdmission
	enroll   func()
	released bool
}

func (a *enrollingSideLibrary) AcquireChatInput(context.Context, domain.SessionID, string) (func(), error) {
	a.enroll()
	return func() { a.released = true }, nil
}

func TestFactorySideRechecksEnrollmentAfterLibraryWait(t *testing.T) {
	svc, p, side, turn := factorySideFixture(t)
	admission := &enrollingSideLibrary{enroll: func() { p.held.Store(true) }}
	svc.SetLibraryAdmission(admission)
	conv := &deferredSideTestConversation{}
	svc.sides.runTurn(&sideRuntime{side: side, conv: conv}, side, turn)
	if conv.sent != 0 || !admission.released {
		t.Fatal("side crossed enrollment during admission or leaked its lease")
	}
}

type guardedFactorySide struct {
	deferredSideTestConversation
	admission chan func(context.Context) (func(), error)
}

func (c *guardedFactorySide) StartDeferredTurnWithAdmission(_ string, a func(context.Context) (func(), error)) error {
	c.admission <- a
	return nil
}

func TestFactoryDeferredSideTransportRechecksEnrollment(t *testing.T) {
	svc, p, side, turn := factorySideFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	provider := &guardedFactorySide{admission: make(chan func(context.Context) (func(), error), 1)}
	runtime := &sideRuntime{ctx: ctx, side: side, conv: provider, done: ctx.Done(), completed: make(chan ports.ChatEvent)}
	done := make(chan struct{})
	go func() { svc.sides.runTurn(runtime, side, turn); close(done) }()
	var acquire func(context.Context) (func(), error)
	select {
	case acquire = <-provider.admission:
	case <-time.After(3 * time.Second):
		t.Fatal("side never prepared deferred request")
	}
	p.held.Store(true)
	if release, err := acquire(ctx); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
		if release != nil {
			release()
		}
		t.Fatalf("deferred side bypassed hold: %v", err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("side did not release queued execution")
	}
}
