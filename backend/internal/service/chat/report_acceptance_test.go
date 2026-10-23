package chat_test

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type reportPreservingConversation struct{ *fakeConversation }

func (*reportPreservingConversation) PreservesProviderOnClose() bool { return true }

type reportReconnectedConversation struct{ *reportPreservingConversation }

func (*reportReconnectedConversation) ReconnectedLive() bool { return true }

type reportChatDelivery struct {
	h     *harness
	calls int
}

func (d *reportChatDelivery) Submit(ctx context.Context, id domain.SessionID, text string, batch reportsvc.PreparedBatch) (domain.ReportDeliveryReceipt, error) {
	d.calls++
	if id != testSession {
		return domain.ReportDeliveryReceipt{State: domain.ReportReceiptPromptSubmitted}, nil
	}
	_, err := d.h.svc.Send(ctx, id, ports.ChatUserMessage{Text: text, Origin: domain.MessageOriginAutomation,
		ClientMessageID: batch.IdempotencyKey(), ReportBatchID: batch.ID, ReportClaimToken: batch.Token})
	if err != nil {
		return domain.ReportDeliveryReceipt{}, err
	}
	receipt, _, err := d.h.st.ReportChatReceipt(ctx, batch.ID)
	return receipt, err
}

func (*reportChatDelivery) Interrupt(context.Context, domain.SessionID) error { return nil }

func seedChatReport(t *testing.T, h *harness, id string) {
	t.Helper()
	ctx := context.Background()
	worker, err := h.st.CreateSession(ctx, domain.SessionRecord{ProjectID: testProject, Kind: domain.KindWorker,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: h.now(), UpdatedAt: h.now()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.st.CreateReport(ctx, domain.ReportRecord{ID: id, SessionID: worker.ID, ProjectID: testProject,
		State: domain.ReportNeedsInput, Note: "retained decision", Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "result"}},
		CreatedAt: h.now(), AvailableAt: h.now(), DeliveryState: domain.ReportPending, RepeatCount: 1})
	if err != nil {
		t.Fatal(err)
	}
}

func assertReportState(t *testing.T, st *sqlite.Store, id string, want domain.ReportDeliveryState) domain.ReportRecord {
	t.Helper()
	rec, found, err := st.GetReport(context.Background(), id)
	if err != nil || !found || rec.DeliveryState != want {
		t.Fatalf("report %s = %+v found=%v err=%v; want %s", id, rec, found, err, want)
	}
	if rec.Note != "retained decision" || len(rec.Outputs) != 1 || rec.Outputs[0].Reference != "result" {
		t.Fatalf("lost evidence: %+v", rec)
	}
	return rec
}

func TestReportChatBusyQueueExpiryRestartAndNativeAcceptance(t *testing.T) {
	for _, piggyback := range []bool{false, true} {
		name := "scheduled"
		if piggyback {
			name = "piggyback"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			provider := &reportPreservingConversation{newFakeConversation()}
			h := newHarnessWithConversation(t, provider)
			h.conv = provider.fakeConversation
			project, _, err := h.st.GetProject(ctx, string(testProject))
			if err != nil {
				t.Fatal(err)
			}
			first, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"})
			if err != nil {
				t.Fatal(err)
			}
			seedChatReport(t, h, "report")
			delivery := &reportChatDelivery{h: h}
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
			h.svc.SetReportCoordinator(coordinator)
			if piggyback {
				queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "human", ClientMessageID: "human-1", Origin: domain.MessageOriginHuman})
				if err != nil || queued.State != domain.TurnStateQueued {
					t.Fatalf("piggyback=%+v err=%v", queued, err)
				}
				if duplicate, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "human", ClientMessageID: "human-1", Origin: domain.MessageOriginHuman}); err != nil || duplicate.ID != "" {
					t.Fatalf("duplicate=%+v err=%v", duplicate, err)
				}
			} else if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			rec := assertReportState(t, h.st, "report", domain.ReportPending)
			receipt, linked, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
			if err != nil || !linked || receipt.State != domain.ReportReceiptQueued || receipt.TurnID == "" || receipt.MessageID == "" {
				t.Fatalf("receipt=%+v linked=%v err=%v", receipt, linked, err)
			}
			if h.conv.sendCallCount() != 1 {
				t.Fatal("busy enqueue called provider")
			}
			// Expired scheduling deadlines and process-local claims cannot authorize another send.
			h.advance(24 * time.Hour)
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			if h.conv.sendCallCount() != 1 {
				t.Fatal("elapsed time resent queued work")
			}
			if err := h.ctrl.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if err := h.st.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := sqlite.Open(project.Path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.Close() })
			if _, err := reopened.RequeueClaimedReports(ctx); err != nil {
				t.Fatal(err)
			}
			recovered := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: reopened, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
			if _, err := recovered.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			stillQueued, _, err := reopened.ReportChatReceipt(ctx, rec.DeliveryBatchID)
			if err != nil || stillQueued != receipt {
				t.Fatalf("receipt changed after restart: %+v err=%v", stillQueued, err)
			}
			if h.conv.sendCallCount() != 1 {
				t.Fatal("restart recovery submitted work")
			}
			restoredProvider := &reportReconnectedConversation{&reportPreservingConversation{newFakeConversation()}}
			restoredProvider.turnSeq = 1
			restored := chatsvc.New(chatsvc.Options{Store: reopened, Sessions: reopened, Reader: fullSnapshotReader(reopened),
				Drivers: fakeRegistry{driver: fakeDriver{conv: restoredProvider}}, Now: h.now, NewID: uuid.NewString, Log: slog.New(slog.DiscardHandler), DataDir: t.TempDir()})
			controller, err := restored.Start(ctx, chatsvc.StartConfig{SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex, WorkspacePath: t.TempDir(), ProviderConversationID: provider.ProviderConversationID()})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = restored.Stop(ctx, testSession) })
			if err := restored.DrainQueued(ctx, testSession); err != nil {
				t.Fatal(err)
			}
			if restoredProvider.sendCallCount() != 0 {
				t.Fatal("reconnect overtook the still-active turn")
			}
			restoredProvider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
			deadline := time.Now().Add(5 * time.Second)
			for {
				drained, _, err := reopened.ReportChatReceipt(ctx, rec.DeliveryBatchID)
				if err != nil {
					t.Fatal(err)
				}
				if drained.State != domain.ReportReceiptQueued && drained.ProviderTurnID != "" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("queue did not drain after reconnect")
				}
				time.Sleep(time.Millisecond)
			}
			if restoredProvider.sendCallCount() != 1 {
				t.Fatalf("dequeue provider calls=%d", restoredProvider.sendCallCount())
			}
			submitted, _, err := reopened.ReportChatReceipt(ctx, rec.DeliveryBatchID)
			if err != nil || submitted.State != domain.ReportReceiptUnknown || submitted.TurnID != receipt.TurnID || submitted.MessageID != receipt.MessageID {
				t.Fatalf("dequeued receipt=%+v err=%v", submitted, err)
			}
			assertReportState(t, reopened, "report", domain.ReportPending)
			restoredProvider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: submitted.ProviderTurnID, ProviderEventID: "report-native-start"})
			deadline = time.Now().Add(5 * time.Second)
			for {
				accepted, _, err := reopened.ReportChatReceipt(ctx, rec.DeliveryBatchID)
				if err != nil {
					t.Fatal(err)
				}
				if accepted.State == domain.ReportReceiptNativeAccepted {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("native acceptance not persisted")
				}
				time.Sleep(time.Millisecond)
			}
			// Simulate a crash with native acceptance committed but the batch still unacknowledged.
			assertReportState(t, reopened, "report", domain.ReportPending)
			if err := controller.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if err := reopened.Close(); err != nil {
				t.Fatal(err)
			}
			finalStore, err := sqlite.Open(project.Path)
			if err != nil {
				t.Fatal(err)
			}
			defer finalStore.Close()
			if _, err := finalStore.RequeueClaimedReports(ctx); err != nil {
				t.Fatal(err)
			}
			finalCoordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: finalStore, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
			for range 2 {
				h.advance(time.Hour)
				if _, err := finalCoordinator.RunDue(ctx); err != nil {
					t.Fatal(err)
				}
			}
			acknowledged := assertReportState(t, finalStore, "report", domain.ReportAcknowledged)
			if acknowledged.DeliveryBatchID != rec.DeliveryBatchID {
				t.Fatal("batch identity changed")
			}
			wantCalls := 1
			if piggyback {
				wantCalls = 0
			}
			if delivery.calls != wantCalls {
				t.Fatalf("delivery calls=%d want %d", delivery.calls, wantCalls)
			}
			if restoredProvider.sendCallCount() != 1 {
				t.Fatal("acceptance recovery resent message")
			}

		})
	}
}

func TestReportChatUnknownCancellationAndUnsupportedEvidenceNeverResend(t *testing.T) {
	for _, mode := range []string{"cancelled", "unknown", "unsupported"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			h := newHarness(t)
			first, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"})
			if err != nil {
				t.Fatal(err)
			}
			seedChatReport(t, h, "report")
			delivery := &reportChatDelivery{h: h}
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			rec := assertReportState(t, h.st, "report", domain.ReportPending)
			receipt, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "cancelled" {
				if err := h.st.CancelQueuedTurnByID(ctx, h.ctrl.ConversationID(), receipt.TurnID, h.now()); err != nil {
					t.Fatal(err)
				}
			} else {
				if mode == "unknown" {
					h.conv.mu.Lock()
					h.conv.sendErr = errors.New("ambiguous transport result")
					h.conv.mu.Unlock()
				}
				h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
				h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
					for _, turn := range s.Turns {
						if turn.ID == receipt.TurnID {
							return turn.State != domain.TurnStateQueued
						}
					}
					return false
				})
			}
			if mode == "unsupported" {
				current, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
				if err != nil {
					t.Fatal(err)
				}
				h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: current.ProviderTurnID})
				h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: current.ProviderTurnID, ProviderItemID: "synthetic-barrier", Delta: "synthetic"})
				h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
					for _, m := range s.Messages {
						if m.Text == "synthetic" {
							return true
						}
					}
					return false
				})
			}
			for range 3 {
				h.advance(time.Hour)
				if _, err := coordinator.RunDue(ctx); err != nil {
					t.Fatal(err)
				}
			}
			assertReportState(t, h.st, "report", domain.ReportPending)
			if delivery.calls != 1 {
				t.Fatalf("recovery resubmitted %d times", delivery.calls)
			}
			want := 2
			if mode == "cancelled" {
				want = 1
			}
			if h.conv.sendCallCount() != want {
				t.Fatalf("provider calls=%d want %d", h.conv.sendCallCount(), want)
			}
		})
	}
}

func TestReportChatNativeStartMustMatchExactTurnAndRoot(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	seedChatReport(t, h, "report")
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	rec := assertReportState(t, h.st, "report", domain.ReportPending)
	receipt, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil {
		t.Fatal(err)
	}
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: "foreign", ProviderConversationID: "child"})
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: receipt.ProviderTurnID, ProviderItemID: "barrier", Delta: "barrier"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, m := range s.Messages {
			if m.Text == "barrier" {
				return true
			}
		}
		return false
	})
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: receipt.ProviderTurnID, ProviderEventID: "native-start"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		r, _, _ := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
		return r.State == domain.ReportReceiptNativeAccepted
	})
	for range 2 {
		h.advance(time.Second)
		if _, err := coordinator.RunDue(ctx); err != nil {
			t.Fatal(err)
		}
	}
	assertReportState(t, h.st, "report", domain.ReportAcknowledged)
	if delivery.calls != 1 {
		t.Fatal("accepted report resubmitted")
	}
	if !strings.Contains(h.conv.sentTexts()[0], "retained decision") {
		t.Fatal("provider payload lost report")
	}
}

func TestReportChatHeldBatchDoesNotBlockOtherProject(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"}); err != nil {
		t.Fatal(err)
	}
	seedChatReport(t, h, "report")
	if err := h.st.UpsertProject(ctx, domain.ProjectRecord{ID: "other", Path: t.TempDir(), RegisteredAt: h.now()}); err != nil {
		t.Fatal(err)
	}
	worker, err := h.st.CreateSession(ctx, domain.SessionRecord{ProjectID: "other", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeTUI, CreatedAt: h.now(), UpdatedAt: h.now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.CreateSession(ctx, domain.SessionRecord{ProjectID: "other", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeTUI, CreatedAt: h.now(), UpdatedAt: h.now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.CreateReport(ctx, domain.ReportRecord{ID: "other-report", ProjectID: "other", SessionID: worker.ID, State: domain.ReportNeedsInput, Note: "decision", CreatedAt: h.now(), AvailableAt: h.now(), DeliveryState: domain.ReportPending, RepeatCount: 1}); err != nil {
		t.Fatal(err)
	}
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if delay, err := coordinator.RunDue(ctx); err != nil || delay != time.Second {
		t.Fatalf("delay=%v err=%v", delay, err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
	other, _, err := h.st.GetReport(ctx, "other-report")
	if err != nil || other.DeliveryState != domain.ReportAcknowledged {
		t.Fatalf("other=%+v err=%v", other, err)
	}
	if delivery.calls != 2 || h.conv.sendCallCount() != 1 {
		t.Fatalf("delivery=%d provider=%d", delivery.calls, h.conv.sendCallCount())
	}
}

type reportDeferredConversation struct {
	*fakeConversation
	starts atomic.Int32
}

func (c *reportDeferredConversation) StartDeferredTurn(string) error { c.starts.Add(1); return nil }
func (*reportDeferredConversation) DiscardDeferredTurn(string)       {}

func TestReportChatDeferredPreparationAndSyntheticStartAreNotAcceptance(t *testing.T) {
	ctx := context.Background()
	provider := &reportDeferredConversation{fakeConversation: newFakeConversation()}
	h := newHarnessWithConversation(t, provider)
	h.conv = provider.fakeConversation
	seedChatReport(t, h, "report")
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	rec := assertReportState(t, h.st, "report", domain.ReportPending)
	receipt, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil {
		t.Fatal(err)
	}
	if provider.starts.Load() != 1 || receipt.State != domain.ReportReceiptUnknown || receipt.ProviderTurnID == "" {
		t.Fatalf("prepared receipt=%+v starts=%d", receipt, provider.starts.Load())
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: receipt.ProviderTurnID},
		ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: receipt.ProviderTurnID, ProviderItemID: "synthetic", Delta: "still pending"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, m := range s.Messages {
			if m.Text == "still pending" {
				return true
			}
		}
		return false
	})
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
	if delivery.calls != 1 {
		t.Fatal("deferred delivery resubmitted")
	}
}

func TestReportChatBindingFencesClaimsAndQueuedEdits(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	seedChatReport(t, h, "report")
	if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"}); err != nil {
		t.Fatal(err)
	}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Now: h.now})
	batch, err := coordinator.PreparePiggyback(ctx, testSession)
	if err != nil {
		t.Fatal(err)
	}
	message := ports.ChatUserMessage{Text: batch.AppendToUserMessage("human"), Origin: domain.MessageOriginHuman, ClientMessageID: "fenced", ReportBatchID: batch.ID, ReportClaimToken: "stale"}
	if _, err := h.ctrl.Send(ctx, message); !errors.Is(err, domain.ErrInvalidReport) {
		t.Fatalf("stale claim=%v", err)
	}
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil || len(snapshot.Messages) != 1 {
		t.Fatalf("failed link left a message: %+v err=%v", snapshot, err)
	}
	message.ReportClaimToken = batch.Token
	queued, err := h.ctrl.Send(ctx, message)
	if err != nil {
		t.Fatal(err)
	}
	queuedMessage, err := h.st.QueuedTurnMessage(ctx, h.ctrl.ConversationID(), queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.st.UpdateQueuedTurnMessage(ctx, h.ctrl.ConversationID(), queued.ID, "edited", "", queuedMessage.Revision, h.now(), domain.ConversationQueuedEditDelivery{}); !errors.Is(err, store.ErrQueuedTurnNotAvailable) {
		t.Fatalf("edited a bound report: %v", err)
	}
	if err := coordinator.AcceptPiggyback(ctx, batch); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
}

type reportSubmittedConversation struct{ *fakeConversation }

func (c *reportSubmittedConversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	ref, err := c.fakeConversation.SendTurn(ctx, msg)
	ref.ProviderSubmitted = err == nil
	return ref, err
}

func TestReportChatProviderSubmissionIsNotNativeAcceptance(t *testing.T) {
	ctx := context.Background()
	provider := &reportSubmittedConversation{newFakeConversation()}
	h := newHarnessWithConversation(t, provider)
	h.conv = provider.fakeConversation
	seedChatReport(t, h, "report")
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	rec := assertReportState(t, h.st, "report", domain.ReportPending)
	submitted, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil || submitted.State != domain.ReportReceiptProviderSubmitted || submitted.SubmittedAt.IsZero() || !submitted.AcceptedAt.IsZero() {
		t.Fatalf("submitted=%+v err=%v", submitted, err)
	}
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: submitted.ProviderTurnID, ProviderEventID: "native-start"})
	h.awaitSnapshot(t, func(store.ConversationSnapshot) bool {
		r, _, _ := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
		return r.State == domain.ReportReceiptNativeAccepted
	})
	accepted, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil || !accepted.SubmittedAt.Equal(submitted.SubmittedAt) || !accepted.AcceptedAt.After(accepted.SubmittedAt) || accepted.ProviderConversationID != provider.ProviderConversationID() {
		t.Fatalf("accepted=%+v err=%v", accepted, err)
	}
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	acknowledged := assertReportState(t, h.st, "report", domain.ReportAcknowledged)
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: submitted.ProviderTurnID, ProviderEventID: "native-start"})
	h.advance(time.Hour)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	again := assertReportState(t, h.st, "report", domain.ReportAcknowledged)
	if delivery.calls != 1 || !again.AcknowledgedAt.Equal(acknowledged.AcknowledgedAt) {
		t.Fatal("duplicate native evidence changed acknowledgement")
	}
}

type failingReportAcceptanceStore struct {
	chatsvc.Store
	fail atomic.Bool
}

func (s *failingReportAcceptanceStore) RecordReportChatAcceptance(ctx context.Context, conversationID, nativeConversationID, turnID string, at time.Time) error {
	if err := s.Store.RecordReportChatAcceptance(ctx, conversationID, nativeConversationID, turnID, at); err != nil {
		return err
	}
	if s.fail.Swap(false) {
		return errors.New("injected acceptance transaction rollback")
	}
	return nil
}

func TestReportChatAcceptanceCommitsWithNativeEvent(t *testing.T) {
	ctx := context.Background()
	var wrapped *failingReportAcceptanceStore
	h := newHarnessWithConversationAndStore(t, nil, func(st *sqlite.Store) chatsvc.Store {
		wrapped = &failingReportAcceptanceStore{Store: st}
		return wrapped
	})
	seedChatReport(t, h, "report")
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	rec := assertReportState(t, h.st, "report", domain.ReportPending)
	receipt, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil {
		t.Fatal(err)
	}
	wrapped.fail.Store(true)
	event := ports.ChatEvent{Kind: ports.ChatEventTurnStarted, NativeAcceptance: true, ProviderTurnID: receipt.ProviderTurnID, ProviderEventID: "rollback-start"}
	h.conv.emit(event, ports.ChatEvent{Kind: ports.ChatEventMessageDelta, ProviderTurnID: receipt.ProviderTurnID, ProviderItemID: "barrier", Delta: "after rollback"})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, m := range s.Messages {
			if m.Text == "after rollback" {
				return true
			}
		}
		return false
	})
	afterRollback, _, err := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
	if err != nil || afterRollback.State != domain.ReportReceiptUnknown {
		t.Fatalf("rolled back receipt=%+v err=%v", afterRollback, err)
	}
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
	h.conv.emit(event)
	h.awaitSnapshot(t, func(store.ConversationSnapshot) bool {
		r, _, _ := h.st.ReportChatReceipt(ctx, rec.DeliveryBatchID)
		return r.State == domain.ReportReceiptNativeAccepted
	})
	h.advance(time.Second)
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	assertReportState(t, h.st, "report", domain.ReportAcknowledged)
	if delivery.calls != 1 {
		t.Fatal("projection recovery resent work")
	}
}

func TestReportPiggybackPromotionIsFencedBeforeProvider(t *testing.T) {
	ctx := context.Background()
	h, provider := steerHarness(t)
	seedChatReport(t, h, "report")
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Now: h.now, RetryDelay: time.Second})
	h.svc.SetReportCoordinator(coordinator)
	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "human piggyback", ClientMessageID: "piggyback", Origin: domain.MessageOriginHuman})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.PromoteQueuedTurn(ctx, testSession, queued.ID); !errors.Is(err, chatsvc.ErrTurnNotQueued) {
		t.Fatalf("promotion error=%v", err)
	}
	if len(provider.steers()) != 0 {
		t.Fatal("report-bearing promotion contacted provider")
	}
	source, err := h.st.TurnByID(ctx, queued.ID)
	if err != nil || source.State != domain.TurnStateQueued {
		t.Fatalf("source=%+v err=%v", source, err)
	}
	assertReportState(t, h.st, "report", domain.ReportPending)
}

func TestReportHeldDeliveryExplicitResolutionNeverResends(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	seedChatReport(t, h, "report")
	if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"}); err != nil {
		t.Fatal(err)
	}
	delivery := &reportChatDelivery{h: h}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	record := assertReportState(t, h.st, "report", domain.ReportPending)
	receipt, _, err := h.st.ReportChatReceipt(ctx, record.DeliveryBatchID)
	if err != nil {
		t.Fatal(err)
	}
	service := reportsvc.New(reportsvc.Deps{Store: h.st, Now: h.now})
	if err := service.ResolveDelivery(ctx, "report", "delivered_elsewhere", "read manually"); err == nil {
		t.Fatal("resolved a still-queued report")
	}
	if err := h.st.CancelQueuedTurnByID(ctx, h.ctrl.ConversationID(), receipt.TurnID, h.now()); err != nil {
		t.Fatal(err)
	}
	reports, err := service.ListProject(ctx, testProject)
	if err != nil || len(reports) != 1 || reports[0].DeliveryStatus != "held" || reports[0].LastError == "" {
		t.Fatalf("reports=%+v err=%v", reports, err)
	}
	if err := service.ResolveDelivery(ctx, "report", "resend", "retry automatically"); err == nil {
		t.Fatal("accepted an unsupported resolution")
	}
	if err := service.ResolveDelivery(ctx, "report", "delivered_elsewhere", ""); err == nil {
		t.Fatal("accepted empty reason")
	}
	for range 2 {
		if err := service.ResolveDelivery(ctx, "report", "delivered_elsewhere", "read manually"); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.ResolveDelivery(ctx, "report", "delivered_elsewhere", "changed reason"); err == nil {
		t.Fatal("overwrote durable resolution")
	}
	resolved, _, err := h.st.GetReport(ctx, "report")
	if err != nil || resolved.DeliveryStatus != "delivered_elsewhere" || resolved.ResolutionNote != "read manually" || !resolved.AcknowledgedAt.IsZero() {
		t.Fatalf("resolved=%+v err=%v", resolved, err)
	}
	for range 3 {
		h.advance(time.Hour)
		if _, err := coordinator.RunDue(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, claimed, err := h.st.ClaimReport(ctx, "report", "new-token", h.now()); err != nil || claimed {
		t.Fatalf("resolved report was reclaimable: claimed=%v err=%v", claimed, err)
	}
	if delivery.calls != 1 || h.conv.sendCallCount() != 1 {
		t.Fatal("resolution resubmitted work")
	}
	seedChatReport(t, h, "new-report")
	if _, err := coordinator.RunDue(ctx); err != nil {
		t.Fatal(err)
	}
	if delivery.calls != 2 {
		t.Fatal("resolved batch blocked newer reports")
	}
}

func TestReportExistingClientMessageAcquiresReceiptOnDuplicate(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	seedChatReport(t, h, "report")
	if _, err := h.ctrl.Send(ctx, ports.ChatUserMessage{Text: "busy"}); err != nil {
		t.Fatal(err)
	}
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Now: h.now})
	batch, err := coordinator.PreparePiggyback(ctx, testSession)
	if err != nil {
		t.Fatal(err)
	}
	message := ports.ChatUserMessage{Text: batch.Render(), ClientMessageID: batch.ID, Origin: domain.MessageOriginAutomation}
	original, err := h.ctrl.Send(ctx, message)
	if err != nil {
		t.Fatal(err)
	}
	message.ReportBatchID = batch.ID
	message.ReportClaimToken = batch.Token
	duplicate, err := h.ctrl.Send(ctx, message)
	if err != nil || duplicate.ID != "" {
		t.Fatalf("duplicate=%+v err=%v", duplicate, err)
	}
	receipt, found, err := h.st.ReportChatReceipt(ctx, batch.ID)
	if err != nil || !found || receipt.TurnID != original.ID || receipt.State != domain.ReportReceiptQueued || h.conv.sendCallCount() != 1 {
		t.Fatalf("receipt=%+v found=%v err=%v", receipt, found, err)
	}
}
