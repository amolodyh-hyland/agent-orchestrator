package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type librarySelectionStub struct {
	allowed     bool
	held        int
	pinCalls    int
	launchCalls int
	launchErr   error
}

func (s *librarySelectionStub) Pin(context.Context, domain.ProjectContextManifest, domain.ProjectRecord, string) error {
	s.pinCalls++
	return nil
}
func (s *librarySelectionStub) CheckLaunch(context.Context, domain.SessionID) error {
	s.launchCalls++
	return s.launchErr
}
func (s *librarySelectionStub) AcquireTaskInput(domain.SessionID) (func(), bool) {
	if !s.allowed {
		return nil, false
	}
	s.held++
	return func() { s.held-- }, true
}
func TestLibraryTaskAdmissionCoversEveryRawTerminalWrite(t *testing.T) {
	m := newInputLeaseTestManager()
	library := &librarySelectionStub{allowed: true}
	m.SetLibrarySelection(library)
	release, ok := m.AcquireSessionInput("task-1")
	if !ok || library.held != 1 {
		t.Fatal("library lease not held")
	}
	release()
	release()
	if library.held != 0 {
		t.Fatal("library lease leaked")
	}
	library.allowed = false
	if _, ok := m.AcquireSessionInput("task-1"); ok {
		t.Fatal("closed library admission bypassed")
	}
	library.allowed = true
	m.agentOperations["task-1"] = agentOperationSwitch
	if _, ok := m.AcquireSessionInput("task-1"); ok || library.held != 0 {
		t.Fatal("exclusive-operation refusal leaked library lease")
	}
}
func TestLibrarySnapshotPreparationUsesAtomicSelectionAndChecksRetainedLaunch(t *testing.T) {
	store := &projectContextTestStore{snapshots: map[domain.SessionID]domain.ProjectContextManifest{}}
	m := newProjectContextManager()
	m.store = store
	library := &librarySelectionStub{allowed: true, launchErr: errors.New("unsupported_provider")}
	m.SetLibrarySelection(library)
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	if err := m.ensureProjectContextSnapshot(context.Background(), rec, domain.ProjectRecord{ID: "p", Revision: 1}); err == nil {
		t.Fatal("unproved required provider started")
	}
	if library.pinCalls != 1 || library.launchCalls != 1 || len(store.snapshots) != 0 {
		t.Fatal("parent written outside atomic selection")
	}
	parent := domain.ProjectContextManifest{SessionID: rec.ID}
	store.snapshots[rec.ID] = parent
	if err := m.ensureProjectContextSnapshot(context.Background(), rec, domain.ProjectRecord{ID: "p", Revision: 2}); err == nil || library.pinCalls != 1 || library.launchCalls != 2 {
		t.Fatal("retained launch skipped recheck")
	}
}
