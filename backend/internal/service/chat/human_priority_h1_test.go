package chat_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type h1PreservingSteerer struct{ *priorityWaitingSteerer }

func (*h1PreservingSteerer) PreservesProviderOnClose() bool { return true }

func TestH1ProductionHumanSendWithPendingReports(t *testing.T) {
	for _, held := range []bool{false, true} {
		t.Run(map[bool]string{false: "busy", true: "held_automation"}[held], func(t *testing.T) {
			ctx := context.Background()
			provider := &h1PreservingSteerer{&priorityWaitingSteerer{steerRecorder: newSteerRecorder(), parked: make(chan struct{}), withdrawn: make(chan struct{})}}
			h := priorityHarness(t, provider)
			startPriorityTurn(t, h, provider.fakeConversation)
			for _, id := range []string{"h1-report-a", "h1-report-b", "h1-report-c"} {
				seedChatReport(t, h, id)
			}
			delivery := &reportChatDelivery{h: h}
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: delivery, Now: h.now, RetryDelay: time.Second})
			h.svc.SetReportCoordinator(coordinator)
			if held {
				autoCtx, cancel := context.WithCancel(ctx)
				t.Cleanup(cancel)
				go func() {
					_, _ = h.ctrl.Steer(autoCtx, ports.ChatUserMessage{Text: "held worker guidance", ClientMessageID: "h1-held", Origin: domain.MessageOriginAutomation, SenderSessionID: "worker"})
				}()
				select {
				case <-provider.parked:
				case <-time.After(time.Second):
					t.Fatal("automation did not hold dispatch lock")
				}
			}
			for _, text := range []string{"h1 human first", "h1 human second"} {
				sendCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
				_, err := h.svc.Send(sendCtx, testSession, ports.ChatUserMessage{Text: text, ClientMessageID: text, Origin: domain.MessageOriginHuman})
				cancel()
				if err != nil {
					t.Fatalf("production Send blocked behind reports/automation: %v", err)
				}
				message, found, err := h.st.ConversationMessageByClientID(ctx, h.ctrl.ConversationID(), text)
				if err != nil || !found {
					t.Fatalf("human durable row: found=%v err=%v", found, err)
				}
				if !message.AuthoredByUser || message.Text != text {
					t.Errorf("human classified as combined report automation: authored=%v text=%q", message.AuthoredByUser, message.Text)
				}
			}
			calls := provider.steers()
			offset := 0
			if held {
				offset = 1
			}
			if len(calls) != offset+2 || calls[offset].msg.Text != "h1 human first" || calls[offset+1].msg.Text != "h1 human second" {
				t.Errorf("production priority/FIFO lost: %+v", calls)
			}
			for _, id := range []string{"h1-report-a", "h1-report-b", "h1-report-c"} {
				rec := assertReportState(t, h.st, id, domain.ReportPending)
				if rec.DeliveryBatchID != "" {
					t.Errorf("human Send claimed report batch %s", rec.DeliveryBatchID)
				}
			}
			if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "h1 human first", ClientMessageID: "h1 human first", Origin: domain.MessageOriginHuman}); err != nil {
				t.Fatal(err)
			}
			if len(provider.steers()) != offset+2 {
				t.Fatal("human retry duplicated steering")
			}
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			report := assertReportState(t, h.st, "h1-report-a", domain.ReportPending)
			if report.DeliveryBatchID == "" {
				t.Fatal("normal scheduled report delivery was removed")
			}
			receipt, found, err := h.st.ReportChatReceipt(ctx, report.DeliveryBatchID)
			if err != nil || !found || receipt.State != domain.ReportReceiptQueued {
				t.Fatalf("report receipt=%+v found=%v err=%v", receipt, found, err)
			}
			for _, id := range []string{"h1-report-b", "h1-report-c"} {
				if rec := assertReportState(t, h.st, id, domain.ReportPending); rec.DeliveryBatchID != report.DeliveryBatchID {
					t.Fatal("report batch split or lost")
				}
			}
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			if delivery.calls != 1 {
				t.Fatalf("queued reports submitted %d times", delivery.calls)
			}
			provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted})
			h.awaitSnapshot(t, func(_ store.ConversationSnapshot) bool {
				r, _, _ := h.st.ReportChatReceipt(ctx, report.DeliveryBatchID)
				return r.State == domain.ReportReceiptUnknown && r.ProviderTurnID != ""
			})
			submitted, _, err := h.st.ReportChatReceipt(ctx, report.DeliveryBatchID)
			if err != nil {
				t.Fatal(err)
			}
			assertReportState(t, h.st, "h1-report-a", domain.ReportPending)
			provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: submitted.ProviderTurnID, NativeAcceptance: true, ProviderEventID: "h1-report-native"})
			h.awaitSnapshot(t, func(_ store.ConversationSnapshot) bool {
				r, _, _ := h.st.ReportChatReceipt(ctx, report.DeliveryBatchID)
				return r.State == domain.ReportReceiptNativeAccepted
			})
			project, found, err := h.st.GetProject(ctx, string(testProject))
			if err != nil || !found {
				t.Fatalf("project=%v err=%v", found, err)
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
			durable, found, err := reopened.ReportChatReceipt(ctx, report.DeliveryBatchID)
			if err != nil || !found || durable.State != domain.ReportReceiptNativeAccepted || durable.TurnID != receipt.TurnID || durable.MessageID != receipt.MessageID {
				t.Fatalf("reopened native receipt=%+v found=%v err=%v", durable, found, err)
			}
			if _, err := reopened.RequeueClaimedReports(ctx); err != nil {
				t.Fatal(err)
			}
			coordinator = reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: reopened, Delivery: delivery, Now: h.now, RetryDelay: time.Second})

			for i := 0; i < 2; i++ {
				h.advance(time.Second)
				if _, err := coordinator.RunDue(ctx); err != nil {
					t.Fatal(err)
				}
			}
			for _, id := range []string{"h1-report-a", "h1-report-b", "h1-report-c"} {
				if rec := assertReportState(t, reopened, id, domain.ReportAcknowledged); rec.DeliveryBatchID != report.DeliveryBatchID {
					t.Fatal("acknowledgement changed report identity")
				}
			}
			if provider.sendCallCount() != 2 || delivery.calls != 1 {
				t.Fatalf("reports duplicated: provider starts=%d submissions=%d", provider.sendCallCount(), delivery.calls)
			}

		})
	}
}

func TestH1ExplicitQueueAndWorkersKeepExistingReportSemantics(t *testing.T) {
	for _, kind := range []domain.SessionKind{domain.KindOrchestrator, domain.KindWorker} {
		t.Run(string(kind), func(t *testing.T) {
			provider := newSteerRecorder()
			h := newHarnessInWorkspace(t, provider, func(st *store.Store) chatsvc.Store { return st }, domain.HarnessCodex, t.TempDir(), kind)
			startPriorityTurn(t, h, provider.fakeConversation)
			seedChatReport(t, h, "h1-queued-report")
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: &reportChatDelivery{h: h}, Now: h.now})
			h.svc.SetReportCoordinator(coordinator)
			msg := ports.ChatUserMessage{Text: "deliberately queued", ClientMessageID: "h1-queued-human", Origin: domain.MessageOriginHuman, QueueOnly: kind == domain.KindOrchestrator}
			turn, err := h.svc.Send(context.Background(), testSession, msg)
			if err != nil || turn.State != domain.TurnStateQueued {
				t.Fatalf("queued=%+v err=%v", turn, err)
			}
			if len(provider.steers()) != 0 {
				t.Fatal("explicit Queue or ordinary worker was steered")
			}
			report := assertReportState(t, h.st, "h1-queued-report", domain.ReportPending)
			if report.DeliveryBatchID != "" {
				t.Fatal("human Queue or worker claimed report batch")
			}
			row, found, err := h.st.ConversationMessageByClientID(context.Background(), h.ctrl.ConversationID(), msg.ClientMessageID)
			if err != nil || !found || row.Text != msg.Text {
				t.Fatalf("queued human row=%+v found=%v err=%v", row, found, err)
			}
			if kind == domain.KindOrchestrator {
				if !row.AuthoredByUser {
					t.Fatal("genuine explicit Queue lost durable authorship")
				}
				h.advance(time.Second)
				second := msg
				second.Text = "second queued human"
				second.ClientMessageID = "second-queued-human"
				next, err := h.svc.Send(context.Background(), testSession, second)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := coordinator.RunDue(context.Background()); err != nil {
					t.Fatal(err)
				}
				report = assertReportState(t, h.st, "h1-queued-report", domain.ReportPending)
				receipt, found, err := h.st.ReportChatReceipt(context.Background(), report.DeliveryBatchID)
				if err != nil || !found || receipt.State != domain.ReportReceiptQueued || receipt.TurnID == turn.ID || receipt.TurnID == next.ID {
					t.Fatalf("separate report receipt=%+v found=%v err=%v", receipt, found, err)
				}
				queue, err := h.st.ListQueuedBatch(context.Background(), h.ctrl.ConversationID(), 0)
				if err != nil || len(queue) != 3 || queue[0].TurnID != turn.ID || queue[1].TurnID != next.ID || queue[2].TurnID != receipt.TurnID {
					t.Fatalf("human Queue FIFO=%+v err=%v", queue, err)
				}
			}

			if _, err := h.svc.Send(context.Background(), testSession, msg); err != nil {
				t.Fatal(err)
			}
			if provider.sendCallCount() != 1 {
				t.Fatal("queue retry reached provider")
			}
		})
	}
}
func TestH1ProvisioningHumanSendKeepsReportsSeparate(t *testing.T) {
	h := &harness{st: openStoreWithKind(t, domain.KindOrchestrator), clock: time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)}
	h.svc = provisioningService(t, h.st)
	if changed, err := h.st.SetSessionProvisionState(context.Background(), testSession, domain.SessionProvisionProvisioning, "", h.now()); err != nil || !changed {
		t.Fatalf("provisioning=%v err=%v", changed, err)
	}
	seedChatReport(t, h, "h1-provision-report")
	coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: h.st, Delivery: &reportChatDelivery{h: h}, Now: h.now})
	h.svc.SetReportCoordinator(coordinator)
	msg := ports.ChatUserMessage{Text: "human while provisioning", ClientMessageID: "h1-provision-human", Origin: domain.MessageOriginHuman}
	if _, err := h.svc.Send(context.Background(), testSession, msg); err != nil {
		t.Fatal(err)
	}
	conversation, err := h.st.ConversationForSession(context.Background(), testSession)
	if err != nil {
		t.Fatal(err)
	}
	row, found, err := h.st.ConversationMessageByClientID(context.Background(), conversation.ID, msg.ClientMessageID)
	if err != nil || !found || !row.AuthoredByUser || row.Text != msg.Text || strings.Contains(row.Text, "ao-worker-reports") {
		t.Fatalf("provisioned row=%+v found=%v err=%v", row, found, err)
	}
	if report := assertReportState(t, h.st, "h1-provision-report", domain.ReportPending); report.DeliveryBatchID != "" {
		t.Fatal("provisioning human Send consumed reports")
	}
}
