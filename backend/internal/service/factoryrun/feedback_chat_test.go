package factoryrun_test

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type receiptChatDriver struct{ conv ports.ChatConversation }

func (d receiptChatDriver) Harness() domain.AgentHarness                          { return domain.HarnessCodex }
func (d receiptChatDriver) Probe(context.Context) (ports.ChatCapabilities, error) { return nil, nil }
func (d receiptChatDriver) Start(context.Context, ports.ChatStartConfig) (ports.ChatConversation, error) {
	return d.conv, nil
}
func (d receiptChatDriver) Resume(context.Context, ports.ChatResumeConfig) (ports.ChatConversation, error) {
	return d.conv, nil
}

type receiptChatRegistry struct{ driver ports.ChatDriver }

func (r receiptChatRegistry) Driver(domain.AgentHarness) (ports.ChatDriver, error) {
	return r.driver, nil
}
func (r receiptChatRegistry) SupportsChat(domain.AgentHarness) bool { return true }

type receiptChat struct {
	mu     sync.Mutex
	once   sync.Once
	events chan ports.ChatEvent
	sends  int
}

func (*receiptChat) ProviderConversationID() string { return "native-1" }
func (*receiptChat) Capabilities() ports.ChatCapabilities {
	return ports.ChatCapabilities{ports.ChatCapabilityStreaming: true, ports.ChatCapabilityApprovals: true, ports.ChatCapabilityInterrupt: true, ports.ChatCapabilityResume: true}
}
func (c *receiptChat) SendTurn(context.Context, ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sends++
	return ports.ChatTurnRef{ProviderTurnID: "native-fix-1", ProviderSubmitted: true}, nil
}
func (*receiptChat) Interrupt(context.Context, string) error                          { return nil }
func (*receiptChat) ResolveRequest(context.Context, string, ports.ChatDecision) error { return nil }
func (c *receiptChat) Events() <-chan ports.ChatEvent                                 { return c.events }
func (c *receiptChat) Close() error                                                   { c.once.Do(func() { close(c.events) }); return nil }
func (c *receiptChat) count() int                                                     { c.mu.Lock(); defer c.mu.Unlock(); return c.sends }

type deferredReceiptChat struct {
	*receiptChat
	acquire func(context.Context) (func(), error)
}

func (*deferredReceiptChat) StartDeferredTurn(string) error {
	return errors.New("unguarded native submission")
}
func (*deferredReceiptChat) DiscardDeferredTurn(string) {}
func (c *deferredReceiptChat) StartDeferredTurnWithAdmission(_ string, a func(context.Context) (func(), error)) error {
	c.acquire = a
	return nil
}

func TestFactoryFeedbackApprovedChatComposesWithPassiveHold(t *testing.T) {
	for _, mode := range []string{"eager", "deferred", "expired_before_submission"} {
		t.Run(mode, func(t *testing.T) {
			f, q, d, fixtureNow := feedbackFixture(t)
			var clockMu sync.Mutex
			currentTime := *fixtureNow
			clockNow := func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return currentTime }
			f.svc = factoryrun.New(f.db, q.reader, f.dir, factoryrun.WithClock(clockNow))
			native := &receiptChat{events: make(chan ports.ChatEvent, 4)}
			var provider ports.ChatConversation = native
			var deferred *deferredReceiptChat
			if mode != "eager" {
				deferred = &deferredReceiptChat{receiptChat: native}
				provider = deferred
			}
			reader := chatsvc.SnapshotReaderFunc(func(ctx context.Context, id string) (chatsvc.ConversationRows, error) {
				rows, err := f.db.LoadConversationSnapshot(ctx, id)
				return chatsvc.ConversationRows{Conversation: rows.Conversation, ActiveBranch: rows.ActiveBranch, Turns: rows.Turns, Messages: rows.Messages, Activities: rows.Activities}, err
			})
			chat := chatsvc.New(chatsvc.Options{Store: f.db, Sessions: f.db, Reader: reader, Drivers: receiptChatRegistry{driver: receiptChatDriver{conv: provider}}, Now: clockNow, NewID: uuid.NewString, Log: slog.New(slog.DiscardHandler)})
			chat.SetFeedbackAdmission(f.svc)
			f.svc.SetFeedbackTransport(chat)
			if _, err := chat.Start(f.ctx, chatsvc.StartConfig{SessionID: f.session.ID, ProjectID: "p", Harness: domain.HarnessCodex, WorkspacePath: f.worktree, ProviderConversationID: "native-1", ControllerGeneration: "controller-1"}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { chat.StopAll(context.Background()) })
			if err := domain.CheckFactoryFeedback(f.ctx, f.db, f.session.ID); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
				t.Fatalf("participant not held: %v", err)
			}
			if err := chat.DeliverFactoryFeedback(f.ctx, f.session.ID, "unapproved findings", "forged"); err == nil || native.count() != 0 {
				t.Fatalf("forged continuation reached native submission: %v", err)
			}
			result := f.confirm(d, "feedback")
			if len(result.Feedback) != 1 {
				t.Fatalf("missing binding: %+v", result.Feedback)
			}
			b := result.Feedback[0].Binding
			receipt, err := f.db.GetFactoryFeedback(f.ctx, b.ID)
			if err != nil || native.count() != 1 || (mode == "eager" && receipt.SubmittedAt.IsZero()) || !receipt.AcceptedAt.IsZero() {
				t.Fatalf("approved delivery: %+v sends=%d err=%v", receipt, native.count(), err)
			}
			if deferred != nil {
				if deferred.acquire == nil || !receipt.AttemptedAt.IsZero() {
					t.Fatal("preparation consumed native authority")
				}
				if mode == "expired_before_submission" {
					clockMu.Lock()
					currentTime = currentTime.Add(3 * time.Minute)
					clockMu.Unlock()
				}
				release, err := deferred.acquire(f.ctx)
				if mode == "expired_before_submission" {
					if err == nil {
						release()
						t.Fatal("expired approval crossed native submission")
					}
					receipt, _ = f.db.GetFactoryFeedback(f.ctx, b.ID)
					if !receipt.AttemptedAt.IsZero() || !receipt.AcceptedAt.IsZero() {
						t.Fatal("expired preparation recorded native execution")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				release()
			}
			receipt, err = f.db.GetFactoryFeedback(f.ctx, b.ID)
			if err != nil || receipt.AttemptedAt.IsZero() {
				t.Fatalf("missing one-use submission fence: %+v %v", receipt, err)
			}
			native.events <- ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: "native-fix-1", ProviderEventID: "accepted-fix-1"}
			deadline := time.Now().Add(3 * time.Second)
			for {
				receipt, err = f.db.GetFactoryFeedback(f.ctx, b.ID)
				if err != nil {
					t.Fatal(err)
				}
				if receipt.State == "native_accepted" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("missing native acknowledgement: %+v", receipt)
				}
				time.Sleep(time.Millisecond)
			}
			if err := chat.DeliverFactoryFeedback(f.ctx, f.session.ID, b.Payload, b.ID); err != nil {
				t.Fatal(err)
			}
			if native.count() != 1 {
				t.Fatal("duplicate delivery submitted a second fix")
			}
			if err := chat.DeliverFactoryFeedback(f.ctx, f.session.ID, b.Payload+" changed", b.ID+" copied"); err == nil {
				t.Fatal("changed payload reused authority")
			}
			if err := domain.CheckFactoryFeedback(f.ctx, f.db, f.session.ID); !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
				t.Fatal("approved continuation lifted passive hold")
			}
		})
	}
}
