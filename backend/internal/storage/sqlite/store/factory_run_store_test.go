package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestFactoryRunFailedAppendRollsBackAndEvidenceIsImmutable(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: dir, RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	run := domain.FactoryRun{ID: "r", ProjectID: "p", SessionID: session.ID, Stage: "design", Version: 0, CreatedAt: now}
	event := domain.RunEvidence{ID: "ev", RunID: "r", Version: 0, Kind: "created", Actor: "human", Decision: "approve", Stage: "design", RecordedAt: now, Blockers: []string{}}
	if err := store.SaveFactoryRun(ctx, run, event, true); err != nil {
		t.Fatal(err)
	}
	run.Version = 1
	run.Stage = "implementation"
	event.Version = 1
	event.Kind = "advance"
	if err := store.SaveFactoryRun(ctx, run, event, false); err == nil {
		t.Fatal("duplicate evidence id must abort append")
	}
	restored, err := store.GetFactoryRun(ctx, "r")
	if err != nil || restored.Version != 0 || restored.Stage != "design" {
		t.Fatalf("header survived aborted append: %+v %v", restored, err)
	}
	history, err := store.ListRunEvidence(ctx, "r")
	if err != nil || len(history) != 1 {
		t.Fatalf("history %+v %v", history, err)
	}
	event.ID = "ev-2"
	run.TaskID = "changed intent"
	if err := store.SaveFactoryRun(ctx, run, event, false); !errors.Is(err, domain.ErrRunConflict) {
		t.Fatalf("intent mutation: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{"UPDATE factory_run_evidence SET document='{}'", "DELETE FROM factory_run_evidence"} {
		if _, err := db.ExecContext(ctx, statement); err == nil {
			t.Fatal("evidence is mutable")
		}
	}
}

func TestFactoryRunConcurrentStoresCompareAndSwap(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	first, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	seedProject(t, first, "p")
	session, err := first.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	run := domain.FactoryRun{ID: "r", ProjectID: "p", SessionID: session.ID, Stage: "design", CreatedAt: time.Now().UTC()}
	event := domain.RunEvidence{ID: "create", RunID: "r", Kind: "created", Stage: "design", Actor: "human", Decision: "approve", RecordedAt: time.Now().UTC()}
	if err := first.SaveFactoryRun(ctx, run, event, true); err != nil {
		t.Fatal(err)
	}
	run.Version = 1
	run.Stage = "implementation"
	event.Version = 1
	event.Kind = "advance"
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, store := range []*sqlite.Store{first, second} {
		go func(index int, store *sqlite.Store) {
			receipt := event
			receipt.ID = fmt.Sprintf("event-%d", index)
			<-start
			results <- store.SaveFactoryRun(ctx, run, receipt, false)
		}(i, store)
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else if errors.Is(err, domain.ErrRunConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	history, err := first.ListRunEvidence(ctx, "r")
	if err != nil || len(history) != 2 || history[1].Version != 1 {
		t.Fatalf("history: %+v %v", history, err)
	}
}

func TestFactoryRunLedgerAdmissionAndBoundedProjection(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sqlitetest.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seedProject(t, db, "p")
	session, err := db.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	run := domain.FactoryRun{ID: "bounded", ProjectID: "p", SessionID: session.ID, Stage: "design", CreatedAt: time.Now().UTC()}
	event := domain.RunEvidence{ID: "event-0", RunID: run.ID, Kind: "created", RecordedAt: time.Now().UTC()}
	if err := db.SaveFactoryRun(ctx, run, event, true); err != nil {
		t.Fatal(err)
	}
	for v := int64(1); v <= 110; v++ {
		run.Version = v
		event.ID = fmt.Sprintf("event-%d", v)
		event.Version = v
		event.Kind = "completion"
		event.Completion = &domain.RunCompletion{RepoName: "root"}
		if err := db.SaveFactoryRun(ctx, run, event, false); err != nil {
			t.Fatal(err)
		}
	}
	page, err := db.PageRunEvidence(ctx, run.ID, -1, 100)
	if err != nil || len(page) != 100 || page[0].Version != 0 || page[99].Version != 99 {
		t.Fatalf("first page %d %v", len(page), err)
	}
	page, err = db.PageRunEvidence(ctx, run.ID, 99, 100)
	if err != nil || len(page) != 11 || page[0].Version != 100 {
		t.Fatalf("exclusive page %d %v", len(page), err)
	}
	recent, err := db.ListRunEvidence(ctx, run.ID)
	if err != nil || len(recent) != 100 || recent[0].Version != 11 {
		t.Fatalf("recent page %d %v", len(recent), err)
	}
	current, err := db.CurrentRunEvidence(ctx, run.ID, 110)
	if err != nil || len(current) != 2 || current[1].Version != 110 {
		t.Fatalf("projection %+v %v", current, err)
	}
	run.Version = 111
	event.Version = 111
	event.ID = "oversized"
	event.Decision = strings.Repeat("x", 256<<10)
	if err := db.SaveFactoryRun(ctx, run, event, false); err == nil {
		t.Fatal("oversized evidence admitted")
	}
	restored, err := db.GetFactoryRun(ctx, run.ID)
	if err != nil || restored.Version != 110 {
		t.Fatal("oversized append changed header", err)
	}
	raw, err := sql.Open("sqlite", filepath.Join(dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.ExecContext(ctx, "INSERT INTO factory_run_evidence(id,run_id,version,document) VALUES('over-limit',?,512,'{}')", run.ID); err == nil {
		t.Fatal("migration did not enforce history bound")
	}
	if _, err := raw.ExecContext(ctx, "INSERT INTO factory_run_evidence(id,run_id,version,document) VALUES('over-size',?,111,?)", run.ID, `{"value":"`+strings.Repeat("x", 256<<10)+`"}`); err == nil {
		t.Fatal("migration did not enforce byte bound")
	}
}
