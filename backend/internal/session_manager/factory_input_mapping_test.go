package sessionmanager

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type factoryInputFixture struct {
	store         *sqlite.Store
	manager       *Manager
	worker, other domain.SessionRecord
	reviewer      string
}

func realFactoryInputFixture(t *testing.T) factoryInputFixture {
	t.Helper()
	ctx := context.Background()
	st := sqlitetest.MustOpen(t)
	now := time.Now().UTC()
	for _, id := range []string{"factory-project", "plain-project"} {
		if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: id, Path: t.TempDir(), RegisteredAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	workers := make([]domain.SessionRecord, 2)
	for i := range workers {
		row, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "factory-project", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeTUI, CreatedAt: now, UpdatedAt: now})
		if err != nil {
			t.Fatal(err)
		}
		row.Metadata.RuntimeHandleID = "ptyhost-v1:" + string(row.ID)
		if err := st.UpdateSession(ctx, row); err != nil {
			t.Fatal(err)
		}
		workers[i] = row
	}
	handle := "review-" + string(workers[0].ID)
	if err := st.UpsertReview(ctx, domain.Review{ID: "review", ProjectID: "factory-project", SessionID: workers[0].ID, Harness: domain.ReviewerCodex, ReviewerHandleID: handle, InterfaceMode: domain.ReviewerInterfaceTUI, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for _, rec := range []shelltermsvc.ShellTerminalRecord{
		{HandleID: "shellterm-worker", ProjectID: "factory-project", SessionID: workers[0].ID},
		{HandleID: "shellterm-other", ProjectID: "factory-project", SessionID: workers[1].ID},
		{HandleID: "ptyhost-v1:shellterm-factory-board", ProjectID: "factory-project"},
		{HandleID: "shellterm-plain-board", ProjectID: "plain-project"},
		{HandleID: "shellterm-auth"},
	} {
		rec.AppRunID = "fixture"
		rec.WorkingDir = t.TempDir()
		rec.CreatedAt = now
		if err := st.InsertShellTerminal(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	manager := newInputLeaseTestManager()
	manager.store = st
	return factoryInputFixture{store: st, manager: manager, worker: workers[0], other: workers[1], reviewer: handle}
}
func (f factoryInputFixture) enroll(t *testing.T) {
	t.Helper()
	run := domain.FactoryRun{ID: "factory", ProjectID: "factory-project", SessionID: f.worker.ID, Stage: "implementation", CreatedAt: time.Now()}
	if err := f.store.SaveFactoryRun(context.Background(), run, domain.RunEvidence{ID: "approval", RunID: run.ID, Kind: "created", Confirmed: true, RecordedAt: time.Now()}, true); err != nil {
		t.Fatal(err)
	}
}

func TestFactoryRawInputResolvesTerminalOwnership(t *testing.T) {
	f := realFactoryInputFixture(t)
	// The same owner key must fence both the reviewer and the main pane.
	release, ok := f.manager.AcquireSessionInput(domain.SessionID(f.reviewer))
	if !ok || f.manager.inputLeases[f.worker.ID] != 1 {
		t.Fatal("reviewer did not lease its persisted worker")
	}
	release()
	release()
	if err := f.manager.beginAgentOperation(context.Background(), f.worker.ID, agentOperationSwitch); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.manager.AcquireSessionInput(domain.SessionID(f.reviewer)); ok {
		t.Fatal("reviewer bypassed its worker's exclusive operation")
	}
	f.manager.endAgentOperation(f.worker.ID, agentOperationSwitch)
	f.enroll(t)
	for _, tc := range []struct {
		handle  string
		allowed bool
	}{
		{string(f.worker.ID), false},
		{f.worker.Metadata.RuntimeHandleID, false},
		{f.reviewer, false},
		{"shellterm-worker", false},
		{"ptyhost-v1:shellterm-factory-board", false},
		{string(f.other.ID), true},
		{" " + string(f.other.ID) + " ", false},
		{"shellterm-other", true},
		{"shellterm-plain-board", true},
		{"shellterm-auth", true},
		{"unknown:review-" + string(f.worker.ID), false},
		{"ptyhost-v2:" + string(f.worker.ID), false},
		{"review-missing", false},
		{"", false},
	} {
		t.Run(tc.handle, func(t *testing.T) {
			release, ok := f.manager.AcquireSessionInput(domain.SessionID(tc.handle))
			if release != nil {
				defer release()
			}
			if ok != tc.allowed {
				t.Fatalf("terminal %q allowed=%v want=%v", tc.handle, ok, tc.allowed)
			}
		})
	}
}

func TestFactoryRawInputRechecksReviewerOwnershipAfterAdmission(t *testing.T) {
	for _, change := range []string{"enroll", "remove", "remap"} {
		t.Run(change, func(t *testing.T) {
			f := realFactoryInputFixture(t)
			library := &factoryInputLibrary{admit: func() {
				switch change {
				case "enroll":
					f.enroll(t)
				case "remove", "remap":
					if err := f.store.ClearReviewerHandle(context.Background(), f.worker.ID); err != nil {
						t.Fatal(err)
					}
					if change == "remap" {
						if err := f.store.UpsertReview(context.Background(), domain.Review{ID: "other-review", ProjectID: f.other.ProjectID, SessionID: f.other.ID, Harness: domain.ReviewerCodex, ReviewerHandleID: f.reviewer, InterfaceMode: domain.ReviewerInterfaceTUI, CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
							t.Fatal(err)
						}
					}
				}
			}}
			f.manager.SetLibrarySelection(library)
			if _, ok := f.manager.AcquireSessionInput(domain.SessionID(f.reviewer)); ok {
				t.Fatalf("reviewer input survived %s during admission", change)
			}
			if library.releases != 1 || len(f.manager.inputLeases) != 0 {
				t.Fatal("changed reviewer leaked an input lease")
			}
			if len(library.ids) != 1 || library.ids[0] != f.worker.ID {
				t.Fatalf("library admission used terminal handle instead of owner: %v", library.ids)
			}
		})
	}
}

func TestFactoryRawInputRejectsAmbiguousTerminalOwner(t *testing.T) {
	f := realFactoryInputFixture(t)
	f.enroll(t)
	if err := f.store.UpsertReview(context.Background(), domain.Review{ID: "conflicting-review", ProjectID: f.other.ProjectID, SessionID: f.other.ID, Harness: domain.ReviewerCodex, ReviewerHandleID: f.reviewer, InterfaceMode: domain.ReviewerInterfaceTUI, CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.manager.AcquireSessionInput(domain.SessionID(f.reviewer)); ok {
		t.Fatal("ambiguous handle chose an unheld owner")
	}
}
