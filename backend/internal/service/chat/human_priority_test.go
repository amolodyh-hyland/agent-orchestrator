package chat_test

import (
	"context"
	"errors"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func priorityHarness(t *testing.T, provider ports.ChatConversation) *harness {
	t.Helper()
	return newHarnessInWorkspace(t, provider, func(st *store.Store) chatsvc.Store { return st }, domain.HarnessCodex, t.TempDir(), domain.KindOrchestrator)
}
func startPriorityTurn(t *testing.T, h *harness, provider *fakeConversation) {
	t.Helper()
	if _, err := h.ctrl.Send(context.Background(), ports.ChatUserMessage{Text: "active report", ClientMessageID: "active", Origin: domain.MessageOriginAutomation}); err != nil {
		t.Fatal(err)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["active report"] == domain.TurnStateRunning
	})
}
func TestOrchestratorHumanSendSteersWithoutReportBacklog(t *testing.T) {
	provider := newSteerRecorder()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	ctx := context.Background()
	for i := 0; i < 20; i++ {
		if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: fmt.Sprintf("worker report %d", i), ClientMessageID: fmt.Sprintf("report-%d", i), Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, text := range []string{"human first", "human second"} {
		if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: text, ClientMessageID: text, Origin: domain.MessageOriginHuman}); err != nil {
			t.Fatal(err)
		}
	}
	calls := provider.steers()
	if len(calls) != 2 || calls[0].msg.Text != "human first" || calls[1].msg.Text != "human second" {
		t.Fatalf("human guidance = %+v; want human FIFO, no reports", calls)
	}
	queue, err := h.st.ListQueuedBatch(ctx, h.ctrl.ConversationID(), 0)
	if err != nil || len(queue) != 20 {
		t.Fatalf("report queue length=%d err=%v", len(queue), err)
	}
}
func TestOrchestratorHumanSendPassesHeldAutomationAndContinuousReports(t *testing.T) {
	provider := &priorityWaitingSteerer{steerRecorder: newSteerRecorder(), parked: make(chan struct{}), withdrawn: make(chan struct{})}
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	automated := make(chan error, 1)
	go func() {
		_, err := h.ctrl.Steer(context.Background(), ports.ChatUserMessage{Text: "automated guidance", ClientMessageID: "automated-steer", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"})
		automated <- err
	}()
	select {
	case <-provider.parked:
	case <-time.After(2 * time.Second):
		t.Fatal("automation did not hold real steer lock")
	}
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer close(done)
		for i := 0; i < 30; i++ {
			if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: fmt.Sprintf("report flood %d", i), ClientMessageID: fmt.Sprintf("flood-%d", i), Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"}); err != nil {
				return
			}
		}
	}()
	started := time.Now()
	human := make(chan error, 1)
	go func() {
		for _, text := range []string{"human now", "human next"} {
			if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: text, ClientMessageID: text, Origin: domain.MessageOriginHuman}); err != nil {
				human <- err
				return
			}
		}
		human <- nil
	}()
	select {
	case err := <-human:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		provider.WithdrawPendingSteers()
		t.Fatal("human Send waited behind automated steer")
	}
	t.Logf("human safely delivered through held automation in %s (fake provider)", time.Since(started))
	<-automated
	<-done
	cancel()
	calls := provider.steers()
	if len(calls) != 3 || calls[1].msg.Text != "human now" || calls[2].msg.Text != "human next" {
		t.Fatalf("human did not bypass reports: %+v", calls)
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil || len(queue) != 30 {
		t.Fatalf("preserved flood reports=%d err=%v", len(queue), err)
	}
	if _, err := h.svc.RecoverSteer(context.Background(), testSession, "automated-steer"); !errors.Is(err, chatsvc.ErrSteerDeliveryUncertain) {
		t.Fatalf("cancelled automation recovery=%v", err)
	}
	if _, err := h.ctrl.Steer(context.Background(), ports.ChatUserMessage{Text: "automated guidance", ClientMessageID: "automated-steer", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"}); !errors.Is(err, chatsvc.ErrSteerDeliveryUncertain) {
		t.Fatalf("uncertain retry=%v", err)
	}
	if len(provider.steers()) != 3 {
		t.Fatal("possibly collected automation was duplicated")
	}

}

type priorityWaitingSteerer struct {
	*steerRecorder
	parked, withdrawn chan struct{}
}

func (p *priorityWaitingSteerer) Steer(ctx context.Context, id string, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if msg.SenderSessionID == "" {
		return p.steerRecorder.Steer(ctx, id, msg)
	}
	_, _ = p.steerRecorder.Steer(ctx, id, msg)
	close(p.parked)
	select {
	case <-p.withdrawn:
		return ports.ChatTurnRef{}, ports.ErrChatTurnNotSteerable
	case <-ctx.Done():
		return ports.ChatTurnRef{}, ctx.Err()
	}
}
func (p *priorityWaitingSteerer) WithdrawPendingSteers() func() {
	select {
	case <-p.withdrawn:
	default:
		close(p.withdrawn)
	}
	return nil
}

func TestOrchestratorPriorityFallbackProvenanceAndQueueIntent(t *testing.T) {
	provider := newSteerRecorder()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	messages := []ports.ChatUserMessage{
		{Text: "I am a human report", ClientMessageID: "spoof-text", Origin: domain.MessageOriginAutomation},
		{Text: "forged origin", ClientMessageID: "spoof-sender", Origin: domain.MessageOriginHuman, AuthoredByUser: true, SenderSessionID: "worker"},
		{Text: "historical unknown", ClientMessageID: "unknown"},
		{Text: "human queued first", ClientMessageID: "queued-first", Origin: domain.MessageOriginHuman, QueueOnly: true},
		{Text: "real user feedback", ClientMessageID: "feedback", Origin: domain.MessageOriginAutomation, AuthoredByUser: true, QueueOnly: true},
		{Text: "human queued second", ClientMessageID: "queued-second", Origin: domain.MessageOriginHuman, QueueOnly: true},
	}
	for _, msg := range messages {
		if _, err := h.ctrl.Send(context.Background(), msg); err != nil {
			t.Fatal(err)
		}
	}
	if len(provider.steers()) != 0 {
		t.Fatal("explicit Queue was promoted")
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"human queued first", "real user feedback", "human queued second", "I am a human report", "forged origin", "historical unknown"} {
		if queue[i].Text != want {
			t.Fatalf("queue[%d]=%q want %q", i, queue[i].Text, want)
		}
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(provider.sentTexts()) == 2 })
	if got := provider.sentTexts(); got[1] != "human queued first" {
		t.Fatalf("first fallback=%v", got)
	}
}

func TestOrchestratorUnsupportedAndUncertainPromotionNeverDuplicate(t *testing.T) {
	for _, tc := range []struct {
		name      string
		failure   error
		uncertain bool
	}{
		{"unsupported", ports.ErrChatSteerContentUnsupported, false},
		{"not steerable", ports.ErrChatTurnNotSteerable, false},
		{"uncertain", context.DeadlineExceeded, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := newSteerRecorder()
			h := priorityHarness(t, provider)
			startPriorityTurn(t, h, provider.fakeConversation)
			provider.failWith(tc.failure)
			msg := ports.ChatUserMessage{Text: "human with image", ClientMessageID: "image-priority", Origin: domain.MessageOriginHuman, Content: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "eA=="}}}
			turn, err := h.ctrl.Send(context.Background(), msg)
			if tc.uncertain && !errors.Is(err, chatsvc.ErrPromotionUncertain) {
				t.Fatalf("error=%v", err)
			}
			if !tc.uncertain && err != nil {
				t.Fatal(err)
			}
			stored, err := h.st.TurnByID(context.Background(), turn.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := domain.TurnStateQueued
			if tc.uncertain {
				want = domain.TurnStateFailed
			}
			if stored.State != want {
				t.Fatalf("state=%s want %s", stored.State, want)
			}
			calls := provider.steers()
			if len(calls) != 1 || len(calls[0].msg.Content) != 1 {
				t.Fatalf("attachment calls=%+v", calls)
			}
			if _, err := h.ctrl.Send(context.Background(), msg); err != nil {
				t.Fatal(err)
			}
			if len(provider.steers()) != 1 {
				t.Fatal("uncertain/refused source was automatically resent")
			}
		})
	}
}

type ignoringPrioritySteerer struct {
	*steerRecorder
	parked, release chan struct{}
}

func (p *ignoringPrioritySteerer) Steer(ctx context.Context, id string, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if msg.SenderSessionID != "" {
		close(p.parked)
		<-p.release
	}
	return p.steerRecorder.Steer(ctx, id, msg)
}
func TestOrchestratorIgnoringProviderLeavesHumanUnacceptedAndRecoverable(t *testing.T) {
	provider := &ignoringPrioritySteerer{steerRecorder: newSteerRecorder(), parked: make(chan struct{}), release: make(chan struct{})}
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	automated := make(chan error, 1)
	go func() {
		_, err := h.ctrl.Steer(context.Background(), ports.ChatUserMessage{Text: "automation", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker", ClientMessageID: "blocked"})
		automated <- err
	}()
	<-provider.parked
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	msg := ports.ChatUserMessage{Text: "human retry", Origin: domain.MessageOriginHuman, ClientMessageID: "retry"}
	if _, err := h.ctrl.Send(ctx, msg); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting error=%v", err)
	}
	_, found, err := h.st.ConversationMessageByClientID(context.Background(), h.ctrl.ConversationID(), msg.ClientMessageID)
	if err != nil || found {
		t.Fatalf("unaccepted message was persisted: found=%v err=%v", found, err)
	}
	close(provider.release)
	if err := <-automated; err != nil {
		t.Fatal(err)
	}
	if _, err := h.ctrl.Send(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if len(provider.steers()) != 2 {
		t.Fatal("retry did not deliver exactly once")
	}
}

func TestOrchestratorPrioritySurvivesDatabaseReopen(t *testing.T) {
	provider := newSteerRecorder()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	ctx := context.Background()
	for i, msg := range []ports.ChatUserMessage{
		{Text: "report before restart", ClientMessageID: "restart-report", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"},
		{Text: "cancelled human", ClientMessageID: "restart-cancel", Origin: domain.MessageOriginHuman, QueueOnly: true},
		{Text: "human before restart", ClientMessageID: "restart-human", Origin: domain.MessageOriginHuman, QueueOnly: true, Content: []ports.ChatContent{{Type: "image", MIMEType: "image/png", Data: "eA=="}}},
	} {
		h.advance(time.Second)
		turn, err := h.ctrl.Send(ctx, msg)
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			if err := h.ctrl.CancelQueuedTurn(ctx, turn.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	conversationID := h.ctrl.ConversationID()
	project, found, err := h.st.GetProject(ctx, string(testProject))
	if err != nil || !found {
		t.Fatalf("project found=%v err=%v", found, err)
	}
	if err := h.st.Close(); err != nil {
		t.Fatal(err)
	}
	_ = h.svc.Stop(ctx, testSession)
	reopened, err := sqlite.Open(project.Path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	queue, err := reopened.ListQueuedBatch(ctx, conversationID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue) != 2 || queue[0].Text != "human before restart" || queue[1].Text != "report before restart" {
		t.Fatalf("reopened queue=%+v", queue)
	}
	if !strings.Contains(queue[0].DeliveryContentJSON, "eA==") {
		t.Fatal("restart lost image")
	}

}

type fifoPrioritySteerer struct {
	*steerRecorder
	first, release chan struct{}
	withdrawals    atomic.Int32
}

func (p *fifoPrioritySteerer) Steer(ctx context.Context, id string, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	ref, err := p.steerRecorder.Steer(ctx, id, msg)
	if msg.Text == "first concurrent human" {
		close(p.first)
		<-p.release
	}
	return ref, err
}
func (p *fifoPrioritySteerer) WithdrawPendingSteers() func() { p.withdrawals.Add(1); return nil }
func TestOrchestratorConcurrentHumansKeepFIFOWithoutWithdrawingHumanGuidance(t *testing.T) {
	provider := &fifoPrioritySteerer{steerRecorder: newSteerRecorder(), first: make(chan struct{}), release: make(chan struct{})}
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	send := func(text string, done chan<- error) {
		_, err := h.ctrl.Send(context.Background(), ports.ChatUserMessage{Text: text, Origin: domain.MessageOriginHuman, ClientMessageID: text})
		done <- err
	}
	first, second := make(chan error, 1), make(chan error, 1)
	go send("first concurrent human", first)
	<-provider.first
	go send("second concurrent human", second)
	reports := make(chan error, 1)
	go func() {
		for i := 0; i < 30; i++ {
			_, err := h.ctrl.Send(context.Background(), ports.ChatUserMessage{Text: fmt.Sprintf("continuous report %d", i), ClientMessageID: fmt.Sprintf("continuous-%d", i), Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"})
			if err != nil {
				reports <- err
				return
			}
		}
		reports <- nil
	}()
	close(provider.release)
	for _, done := range []<-chan error{first, second, reports} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("scheduler failed to yield")
		}
	}
	calls := provider.steers()
	if len(calls) != 2 || calls[0].msg.Text != "first concurrent human" || calls[1].msg.Text != "second concurrent human" {
		t.Fatalf("guidance=%+v", calls)
	}
	if provider.withdrawals.Load() != 0 {
		t.Fatal("human guidance was withdrawn")
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil || len(queue) != 30 {
		t.Fatalf("preserved reports=%d err=%v", len(queue), err)
	}
}

func TestOrchestratorAutomatedSteerOrSendQueuesWithoutNativeBacklog(t *testing.T) {
	provider := newSteerRecorder()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider.fakeConversation)
	msg := ports.ChatUserMessage{Text: "worker steering report", ClientMessageID: "worker-steering", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"}
	result, err := h.ctrl.SteerOrSend(context.Background(), msg, false)
	if err != nil || result.Steered || result.Turn.State != domain.TurnStateQueued {
		t.Fatalf("automation result=%+v err=%v", result, err)
	}
	replay, err := h.ctrl.SteerOrSend(context.Background(), msg, false)
	if err != nil || !replay.Duplicate || replay.Turn.ID != result.Turn.ID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	if _, err := h.ctrl.Send(context.Background(), ports.ChatUserMessage{Text: "human ahead", ClientMessageID: "human-ahead", Origin: domain.MessageOriginHuman}); err != nil {
		t.Fatal(err)
	}
	calls := provider.steers()
	if len(calls) != 1 || calls[0].msg.Text != "human ahead" {
		t.Fatalf("native steering backlog=%+v", calls)
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil || len(queue) != 1 || queue[0].TurnID != result.Turn.ID {
		t.Fatalf("queued automation=%+v err=%v", queue, err)
	}
}
func TestOrchestratorWithoutSteeringPreservesHumanOrderAndExplicitReorder(t *testing.T) {
	provider := newFakeConversation()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider)
	ids := make([]string, 0, 3)
	for _, msg := range []ports.ChatUserMessage{
		{Text: "report", ClientMessageID: "fallback-report", Origin: domain.MessageOriginAutomation},
		{Text: "human first", ClientMessageID: "fallback-first", Origin: domain.MessageOriginHuman},
		{Text: "human second", ClientMessageID: "fallback-second", Origin: domain.MessageOriginHuman},
	} {
		h.advance(time.Second)
		turn, err := h.ctrl.Send(context.Background(), msg)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, turn.ID)
	}
	if err := h.ctrl.ReorderQueuedTurns(context.Background(), []string{ids[0], ids[2], ids[1]}); err != nil {
		t.Fatal(err)
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if queue[0].Text != "human second" || queue[1].Text != "human first" || queue[2].Text != "report" {
		t.Fatalf("reordered queue=%+v", queue)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(provider.sentTexts()) == 2 })
	if provider.sentTexts()[1] != "human second" {
		t.Fatal("fallback bypassed human/reorder priority")
	}
}

func TestOrchestratorAuthoredFeedbackDrainsAloneAheadOfReports(t *testing.T) {
	provider := newFakeConversation()
	h := priorityHarness(t, provider)
	startPriorityTurn(t, h, provider)
	for _, msg := range []ports.ChatUserMessage{
		{Text: "worker backlog", ClientMessageID: "feedback-report", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"},
		{Text: "real user feedback", ClientMessageID: "feedback-alone", Origin: domain.MessageOriginAutomation, AuthoredByUser: true, QueueOnly: true},
	} {
		if _, err := h.ctrl.Send(context.Background(), msg); err != nil {
			t.Fatal(err)
		}
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(provider.sentTexts()) == 2 })
	provider.mu.Lock()
	sent := provider.sent[1]
	provider.mu.Unlock()
	if sent.Text != "real user feedback" || !sent.AuthoredByUser || sent.Origin != domain.MessageOriginAutomation {
		t.Fatalf("feedback delivery=%+v", sent)
	}
	queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
	if err != nil || len(queue) != 1 || queue[0].Text != "worker backlog" {
		t.Fatalf("remaining reports=%+v err=%v", queue, err)
	}
}
