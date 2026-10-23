package sqlite

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type noUpgradeResend struct{ calls int }

func (d *noUpgradeResend) Submit(context.Context, domain.SessionID, string, reportsvc.PreparedBatch) (domain.ReportDeliveryReceipt, error) {
	d.calls++
	return domain.ReportDeliveryReceipt{}, fmt.Errorf("unexpected resend")
}
func (*noUpgradeResend) Interrupt(context.Context, domain.SessionID) error {
	return fmt.Errorf("unexpected interrupt")
}

func TestReportUpgradeRecoversPreMigrationChatDelivery(t *testing.T) {
	for _, mode := range []string{"queued", "accepted", "unidentified"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			db := openMigratedDatabaseCopyAt(t, dir, 221, pragmas)
			st := sqlitestore.NewStore(db, db)
			now := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "upgrade", Path: dir, RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			worker, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "upgrade", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			orch, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "upgrade", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			conversation, err := st.CreateConversation(ctx, "legacy-conversation", domain.ConversationScopeProject, "upgrade", orch.ID, now)
			if err != nil {
				t.Fatal(err)
			}
			_, err = st.CreateReport(ctx, domain.ReportRecord{ID: "legacy-report", SessionID: worker.ID, ProjectID: "upgrade", State: domain.ReportNeedsInput, Note: "retained report", Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "result"}}, CreatedAt: now, AvailableAt: now, DeliveryState: domain.ReportPending, RepeatCount: 1})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE reports SET delivery_batch_id='report-batch:legacy-report',delivery_state='claimed',claim_token='old-daemon',claimed_at=?`, now); err != nil {
				t.Fatal(err)
			}
			if mode != "unidentified" {
				if created, err := st.AppendUserMessage(ctx, conversation.ID, orch.ID, "old-generation", domain.ConversationMessage{ID: "legacy-message", ClientMessageID: "report-batch:legacy-report", Origin: domain.MessageOriginAutomation, Text: "retained report"}, "legacy-turn", now); err != nil || !created {
					t.Fatalf("legacy append=%v err=%v", created, err)
				}
				if mode == "accepted" {
					if _, err := db.Exec(`UPDATE sessions SET controller_generation='old-generation',provider_conversation_id='native-conversation' WHERE id=?`, orch.ID); err != nil {
						t.Fatal(err)
					}
					if err := st.BindTurnToProvider(ctx, "legacy-turn", "native-turn", now); err != nil {
						t.Fatal(err)
					}
					if _, err := st.ProjectProviderEvent(ctx, conversation.ID, orch.ID, "old-generation", "old-start", "turn.started", `{"kind":"turn.started","providerTurnId":"native-turn","providerConversationId":"native-conversation"}`, now, func(context.Context) error { return nil }); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if _, err := reopened.RequeueClaimedReports(ctx); err != nil {
				t.Fatal(err)
			}
			delivery := &noUpgradeResend{}
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: reopened, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Second})
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			if mode == "queued" {
				if err := reopened.BindTurnToProvider(ctx, "legacy-turn", "native-turn", now); err != nil {
					t.Fatal(err)
				}
				if err := reopened.RecordReportChatAcceptance(ctx, conversation.ID, "native-conversation", "native-turn", now); err != nil {
					t.Fatal(err)
				}
				now = now.Add(time.Second)
				if _, err := coordinator.RunDue(ctx); err != nil {
					t.Fatal(err)
				}
			}
			report, _, err := reopened.GetReport(ctx, "legacy-report")
			if err != nil {
				t.Fatal(err)
			}
			if mode == "unidentified" {
				if report.DeliveryStatus != "held" || report.LastError == "" {
					t.Fatalf("unidentified=%+v", report)
				}
			} else if report.DeliveryState != domain.ReportAcknowledged {
				t.Fatalf("upgraded report=%+v", report)
			}
			if mode == "unidentified" {
				service := reportsvc.New(reportsvc.Deps{Store: reopened, Now: func() time.Time { return now }})
				if err := service.ResolveDelivery(ctx, "legacy-report", "delivered_elsewhere", "verified old transcript"); err != nil {
					t.Fatal(err)
				}
				if _, err := coordinator.RunDue(ctx); err != nil {
					t.Fatal(err)
				}
				resolved, _, err := reopened.GetReport(ctx, "legacy-report")
				if err != nil || resolved.DeliveryStatus != "delivered_elsewhere" || !resolved.AcknowledgedAt.IsZero() {
					t.Fatalf("upgrade resolution=%+v err=%v", resolved, err)
				}
			}
			if report.DeliveryBatchID != "report-batch:legacy-report" || len(report.Outputs) != 1 || report.Note != "retained report" || delivery.calls != 0 {
				t.Fatalf("lost identity, evidence, or resent: %+v calls=%d", report, delivery.calls)
			}
		})
	}
}

func TestReportUpgradeHoldsReleasedPendingPiggyback(t *testing.T) {
	for _, mode := range []string{"chat", "tui"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			db := openMigratedDatabaseCopyAt(t, dir, 221, pragmas)
			st := sqlitestore.NewStore(db, db)
			now := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "upgrade", Path: dir, RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			worker, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "upgrade", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			orch, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "upgrade", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			conversation, err := st.CreateConversation(ctx, "piggyback-conversation", domain.ConversationScopeProject, "upgrade", orch.ID, now)
			if err != nil {
				t.Fatal(err)
			}
			var reports []domain.ReportRecord
			for i, id := range []string{"piggyback-report", "piggyback-report-2", "unattempted-report"} {
				at := now.Add(time.Duration(i) * time.Second)
				availableAt := at
				if id == "unattempted-report" {
					availableAt = now.Add(time.Hour)
				}
				report, err := st.CreateReport(ctx, domain.ReportRecord{ID: id, SessionID: worker.ID, ProjectID: "upgrade", State: domain.ReportNeedsInput, Note: "retained " + id, CreatedAt: at, AvailableAt: availableAt, DeliveryState: domain.ReportPending, RepeatCount: 1})
				if err != nil {
					t.Fatal(err)
				}
				if id != "unattempted-report" {
					reports = append(reports, report)
				}
			}
			if _, err := db.Exec(`UPDATE reports SET delivery_batch_id='report-batch:piggyback-report',delivery_state='claimed',claim_token='old-daemon',claimed_at=?,delivery_attempts=1 WHERE id<>'unattempted-report'`, now); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE reports SET delivery_batch_id='report-batch:unattempted-report' WHERE id='unattempted-report'`); err != nil {
				t.Fatal(err)
			}
			now = now.Add(3 * time.Second)
			piggyback := reportsvc.PreparedBatch{Reports: reports}
			if created, err := st.AppendUserMessage(ctx, conversation.ID, orch.ID, "old-generation", domain.ConversationMessage{ID: "human-message", ClientMessageID: "human-client-id", Origin: domain.MessageOriginHuman, Text: piggyback.AppendToUserMessage("human prompt")}, "human-turn", now); err != nil || !created {
				t.Fatalf("legacy piggyback append=%v err=%v", created, err)
			}
			if err := st.BindTurnToProvider(ctx, "human-turn", "possibly-started-native-turn", now); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE reports SET delivery_state='pending',claim_token='',claimed_at=NULL,last_error='ambiguous provider response' WHERE claim_token='old-daemon'`); err != nil {
				t.Fatal(err)
			}
			if mode == "tui" {
				if err := st.SettleTurn(ctx, conversation.ID, "possibly-started-native-turn", domain.TurnStateFailed, "ambiguous provider response", now); err != nil {
					t.Fatal(err)
				}
				transition, created, err := st.CreateSessionInterfaceTransition(ctx, domain.SessionInterfaceTransition{
					ID: "chat-to-tui", SessionID: orch.ID, SourceMode: domain.SessionModeChat, TargetMode: domain.SessionModeTUI,
					Policy: domain.SessionInterfaceTransitionDrain, HistoryPolicy: domain.SessionInterfaceTransitionHistoryStrict,
					Phase: domain.SessionInterfaceTransitionActivating, NativeConversationID: "native-conversation", CreatedAt: now, UpdatedAt: now,
				})
				if err != nil || !created {
					t.Fatalf("transition=%+v created=%v err=%v", transition, created, err)
				}
				if changed, err := st.CommitSessionControllerEpoch(ctx, orch.ID, domain.SessionModeChat, domain.SessionModeTUI, "native-conversation", now); err != nil || !changed {
					t.Fatalf("commit Chat-to-TUI switch=%v err=%v", changed, err)
				}
				if changed, err := st.AdvanceSessionInterfaceTransition(ctx, transition.ID, domain.SessionInterfaceTransitionActivating, domain.SessionInterfaceTransitionCompleted, "native-conversation", "", "", now); err != nil || !changed {
					t.Fatalf("complete Chat-to-TUI switch=%v err=%v", changed, err)
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if mode == "tui" {
				session, found, err := reopened.GetSession(ctx, orch.ID)
				if err != nil || !found || session.Mode != domain.SessionModeTUI {
					t.Fatalf("switched session=%+v found=%v err=%v", session, found, err)
				}
				transition, found, err := reopened.GetSessionInterfaceTransition(ctx, "chat-to-tui")
				if err != nil || !found || transition.Phase != domain.SessionInterfaceTransitionCompleted {
					t.Fatalf("completed transition=%+v found=%v err=%v", transition, found, err)
				}
			}

			if _, err := reopened.RequeueClaimedReports(ctx); err != nil {
				t.Fatal(err)
			}
			if _, linked, err := reopened.ReportChatReceipt(ctx, "report-batch:piggyback-report"); err != nil || linked {
				t.Fatalf("human client identity must remain uncorrelated: linked=%v err=%v", linked, err)
			}
			for _, id := range []string{"piggyback-report", "piggyback-report-2"} {
				report, _, err := reopened.GetReport(ctx, id)
				if err != nil || report.DeliveryState != domain.ReportPending || report.DeliveryStatus != "held" || report.LastError == "" || report.DeliveryAttempts != 1 || !report.ClaimedAt.IsZero() {
					t.Fatalf("released pending report=%+v err=%v", report, err)
				}
			}
			pending, err := reopened.ListPendingReportSchedule(ctx, 10)
			if err != nil || len(pending) != 1 || pending[0].ID != "unattempted-report" {
				t.Fatalf("only unattempted report should remain eligible: %+v err=%v", pending, err)
			}
			delivery := &noUpgradeResend{}
			coordinator := reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{Store: reopened, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Second})
			if _, err := coordinator.RunDue(ctx); err != nil {
				t.Fatal(err)
			}
			service := reportsvc.New(reportsvc.Deps{Store: reopened, Now: func() time.Time { return now }})
			if err := service.ResolveDelivery(ctx, "piggyback-report", "delivered_elsewhere", "verified human transcript"); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"piggyback-report", "piggyback-report-2"} {
				report, _, err := reopened.GetReport(ctx, id)
				if err != nil || report.DeliveryStatus != "delivered_elsewhere" || report.ResolutionNote != "verified human transcript" || !report.AcknowledgedAt.IsZero() {
					t.Fatalf("resolved pending piggyback=%+v err=%v", report, err)
				}
			}
			if _, err := coordinator.RunDue(ctx); err != nil || delivery.calls != 0 {
				t.Fatalf("ambiguous piggyback resent: calls=%d err=%v", delivery.calls, err)
			}
		})
	}
}

func TestReportUpgradeKeepsTUIAttemptEligibleWithOtherChatHistory(t *testing.T) {
	for _, history := range []string{"older", "unrelated"} {
		t.Run(history, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			db := openMigratedDatabaseCopyAt(t, dir, 223, pragmas)
			st := sqlitestore.NewStore(db, db)
			now := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "upgrade", Path: dir, RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			orch, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "upgrade", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			conversation, err := st.CreateConversation(ctx, "old-chat", domain.ConversationScopeProject, "upgrade", orch.ID, now)
			if err != nil {
				t.Fatal(err)
			}
			if created, err := st.AppendUserMessage(ctx, conversation.ID, orch.ID, "old-generation", domain.ConversationMessage{ID: "old-message", ClientMessageID: "old-human-client", Origin: domain.MessageOriginHuman, Text: "old prompt\n<ao-worker-reports>\nolder reports\n</ao-worker-reports>"}, "old-turn", now); err != nil || !created {
				t.Fatalf("old Chat message=%v err=%v", created, err)
			}
			if changed, err := st.CommitSessionControllerEpoch(ctx, orch.ID, domain.SessionModeChat, domain.SessionModeTUI, "native-conversation", now); err != nil || !changed {
				t.Fatalf("switch=%v err=%v", changed, err)
			}
			now = now.Add(time.Hour)
			reportAt := now
			if history == "unrelated" {
				reportAt = now.Add(-2 * time.Hour)
			}
			if _, err := st.CreateReport(ctx, domain.ReportRecord{ID: "tui-report", SessionID: orch.ID, ProjectID: "upgrade", State: domain.ReportNeedsInput, Note: "new TUI report", CreatedAt: reportAt, AvailableAt: reportAt, DeliveryState: domain.ReportPending, RepeatCount: 1}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE reports SET delivery_batch_id='report-batch:tui-report',delivery_attempts=1,last_error='TUI prompt submission timeout' WHERE id='tui-report'`); err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			report, _, err := reopened.GetReport(ctx, "tui-report")
			if err != nil || report.DeliveryStatus != "pending" || report.LastError != "TUI prompt submission timeout" {
				t.Fatalf("TUI delivery changed by Chat recovery=%+v err=%v", report, err)
			}
			pending, err := reopened.ClaimPendingReportBatch(ctx, "upgrade", "tui-retry", now)
			if err != nil || len(pending) != 1 || pending[0].ID != "tui-report" {
				t.Fatalf("TUI attempt should retain existing retry semantics: %+v err=%v", pending, err)
			}
		})
	}
}
