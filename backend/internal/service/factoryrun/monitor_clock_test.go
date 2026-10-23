package factoryrun

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestMonitorFiveMinuteSilenceBuildDeadlineAndFreshness(t *testing.T) {
	ctx := context.Background()
	db, err := sqlitetest.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	start := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	now := start
	if err := db.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: t.TempDir(), RegisteredAt: start}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: start}, CreatedAt: start, UpdatedAt: start, Metadata: domain.SessionMetadata{WorkspacePath: "/owned", Branch: "work", DiffBaseSHA: "base"}})
	if err != nil {
		t.Fatal(err)
	}
	run := domain.FactoryRun{ID: "r", ProjectID: "p", TaskID: "t", SessionID: session.ID, Stage: "implementation", CreatedAt: start, Repositories: []domain.RunRepoBinding{{RepoName: domain.RootWorkspaceRepoName, WorktreePath: "/owned", Branch: "work", BaseSHA: "base"}}}
	e := domain.RunEvidence{ID: "created", RunID: "r", Kind: "created", Confirmed: true, Stage: run.Stage, RecordedAt: start}
	if err := db.SaveFactoryRun(ctx, run, e, true); err != nil {
		t.Fatal(err)
	}
	m := NewMonitor(db)
	m.now = func() time.Time { return now }
	now = start.Add(5*time.Minute - time.Millisecond)
	state, err := m.Get(ctx, "r")
	if err != nil || state.Attention != nil {
		t.Fatalf("early attention: %+v %v", state, err)
	}
	now = start.Add(5 * time.Minute)
	state, err = m.Get(ctx, "r")
	if err != nil || state.Attention == nil || state.Attention.Condition != "silence" {
		t.Fatalf("missed silence: %+v %v", state, err)
	}
	if _, err = m.Configure(ctx, "r", domain.RunMonitorConfig{SilenceSeconds: 300, BuildSeconds: 1800, Heavy: true, NextOwner: "builder"}); err != nil {
		t.Fatal(err)
	}
	state, err = m.Get(ctx, "r")
	if err != nil || state.Attention != nil || !state.Deadline.Equal(start.Add(30*time.Minute)) {
		t.Fatalf("build deadline: %+v %v", state, err)
	}
	now = start.Add(30 * time.Minute)
	state, err = m.Get(ctx, "r")
	if err != nil || state.Attention == nil {
		t.Fatalf("missed build silence: %+v %v", state, err)
	}
	session.Activity.LastActivityAt = now
	if err := db.UpdateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	state, err = m.Get(ctx, "r")
	if err != nil || state.Attention != nil || state.Freshness != "current" || state.State != "in_progress" {
		t.Fatalf("activity reconciliation: %+v %v", state, err)
	}
}

func TestMonitorStatusHonorsDeadlineWhileScanOwnsLock(t *testing.T) {
	m := NewMonitor(nil)
	release, err := m.lock(context.Background(), "r")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = m.Get(ctx, "r")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatalf("unbounded status: %v", err)
	}
	release()
}
