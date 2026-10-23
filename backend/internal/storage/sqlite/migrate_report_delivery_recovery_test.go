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
