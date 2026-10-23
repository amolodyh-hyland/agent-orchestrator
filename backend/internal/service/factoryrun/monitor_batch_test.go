package factoryrun

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func monitorBatchFixture(t *testing.T, count int) (*sqlite.Store, domain.SessionRecord, time.Time) {
	t.Helper()
	ctx := context.Background()
	db := sqlitetest.MustOpen(t)
	start := time.Now().UTC().Add(-time.Hour)
	if err := db.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: t.TempDir(), RegisteredAt: start}); err != nil {
		t.Fatal(err)
	}
	worker, err := db.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, CreatedAt: start, UpdatedAt: start, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: start}, Metadata: domain.SessionMetadata{WorkspacePath: "/owned", Branch: "work", DiffBaseSHA: "base"}})
	if err != nil {
		t.Fatal(err)
	}
	for i := range count {
		id := fmt.Sprintf("run-%03d", i)
		run := domain.FactoryRun{ID: id, ProjectID: "p", SessionID: worker.ID, TaskID: id, Stage: "implementation", CreatedAt: start, Repositories: []domain.RunRepoBinding{{RepoName: domain.RootWorkspaceRepoName, WorktreePath: "/owned", Branch: "work", BaseSHA: "base"}}}
		event := domain.RunEvidence{ID: "approved-" + id, RunID: id, Kind: "created", Confirmed: true, Stage: run.Stage, RecordedAt: start}
		if err := db.SaveFactoryRun(ctx, run, event, true); err != nil {
			t.Fatal(err)
		}
	}
	return db, worker, start
}

type blockedObservationStore struct {
	MonitorStore
	entered chan struct{}
}

func (s *blockedObservationStore) CurrentRunEvidence(ctx context.Context, id string, version int64) ([]domain.RunEvidence, error) {
	if id == "run-000" {
		close(s.entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.MonitorStore.CurrentRunEvidence(ctx, id, version)
}
func TestMonitorSweepCursorSurvivesTimeoutAndDoesNotBlockAvailablePages(t *testing.T) {
	db, _, _ := monitorBatchFixture(t, 80)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	blocked := &blockedObservationStore{MonitorStore: db, entered: make(chan struct{})}
	monitor := NewMonitor(blocked)
	result := make(chan error, 1)
	go func() { _, err := monitor.Scan(ctx, ""); result <- err }()
	select {
	case <-blocked.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("sweep did not enter first observation")
	}
	readCtx, readCancel := context.WithTimeout(context.Background(), time.Second)
	defer readCancel()
	rows, next, err := monitor.List(readCtx, "p", "", 25)
	if err != nil || len(rows) != 25 || next != "run-024" || rows[0].Freshness != "unobserved" {
		t.Fatalf("list waited for sweep: %d %q %v", len(rows), next, err)
	}
	if _, err := monitor.Get(readCtx, "run-079"); err != nil {
		t.Fatalf("one run blocked another status request: %v", err)
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected interruption: %v", err)
	}
	cursor, err := db.GetFactoryMonitorCursor(context.Background(), "")
	if err != nil || cursor != "run-000" {
		t.Fatalf("cursor lost interrupted progress: %q %v", cursor, err)
	}
	seen := map[string]bool{}
	for range 4 {
		batch, err := NewMonitor(db).Scan(context.Background(), "")
		if err != nil {
			t.Fatal(err)
		}
		if len(batch) > 25 {
			t.Fatalf("unbounded batch: %d", len(batch))
		}
		for _, row := range batch {
			seen[row.RunID] = true
		}
	}
	if len(seen) != 79 || !seen["run-078"] {
		t.Fatalf("later runs starved: observed %d", len(seen))
	}
	var total int
	after := ""
	for {
		rows, next, err := monitor.List(context.Background(), "p", after, 17)
		if err != nil {
			t.Fatal(err)
		}
		total += len(rows)
		if next == "" {
			break
		}
		after = next
	}
	if total != 80 {
		t.Fatalf("available pages lost references: %d", total)
	}
}
func TestMonitorReportMetadataIsLimitedBeforeHydration(t *testing.T) {
	db, worker, start := monitorBatchFixture(t, 1)
	ctx := context.Background()
	for i := range 150 {
		at := start.Add(time.Duration(i) * time.Second)
		_, err := db.CreateReport(ctx, domain.ReportRecord{ID: fmt.Sprintf("report-%03d", i), SessionID: worker.ID, ProjectID: "p", State: domain.ReportCheckpoint, Note: "retained body", CreatedAt: at, AvailableAt: at, RepeatCount: 1, DeliveryState: domain.ReportPending, Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "not hydrated"}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	reports, err := db.FactoryMonitorReports(ctx, worker.ID, start)
	if err != nil || len(reports) != 100 || reports[0].ID != "report-149" || reports[99].ID != "report-050" {
		t.Fatalf("unbounded metadata: %d %v", len(reports), err)
	}
	for _, report := range reports {
		if report.Note != "" || len(report.Outputs) != 0 {
			t.Fatal("monitor hydrated report content")
		}
	}
	observation, err := NewMonitor(db).Get(ctx, "run-000")
	if err != nil || len(observation.Reports) != 100 || !observation.LastActivityAt.Equal(start.Add(149*time.Second)) {
		t.Fatalf("bounded freshness lost latest report: %+v %v", observation, err)
	}
}
