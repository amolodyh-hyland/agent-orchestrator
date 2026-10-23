package session

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestListReadOnlyDoesNotRepairOrStartSessions(t *testing.T) {
	dataDir := t.TempDir()
	artifactDir := filepath.Join(dataDir, "artifacts", "a-1")
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artifactDir, "result.md"), []byte("claim"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	st := newFakeStore()
	st.sessions["a-1"] = domain.SessionRecord{ID: "a-1", ProjectID: "a", Kind: domain.KindOrchestrator, UpdatedAt: now.Add(-time.Hour)}
	st.sessions["b-1"] = domain.SessionRecord{ID: "b-1", ProjectID: "b", Kind: domain.KindWorker, UpdatedAt: now, IsTerminated: true}
	before := map[domain.SessionID]domain.SessionRecord{}
	for id, rec := range st.sessions {
		before[id] = rec
	}
	reconciler := &fakeOutputTypeReconciler{}
	svc := NewWithDeps(Deps{Store: st, DataDir: dataDir, OutputTypeReconciler: reconciler})
	for range 2 {
		got, err := svc.List(context.Background(), ListFilter{ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Fatalf("sessions = %d, want both projects", len(got))
		}
		for _, session := range got {
			if session.ProjectID == "a" && (!session.UpdatedAt.Equal(now.Add(-time.Hour)) || len(session.ArtifactFiles) != 1) {
				t.Fatalf("lost source facts: %+v", session)
			}
		}
	}
	if len(reconciler.reconciled) != 0 {
		t.Fatalf("observation repaired metadata: %v", reconciler.reconciled)
	}
	if !reflect.DeepEqual(st.sessions, before) {
		t.Fatal("observation changed stored session facts")
	}
	if _, err := svc.List(context.Background(), ListFilter{}); err != nil {
		t.Fatal(err)
	}
	if len(reconciler.reconciled) == 0 {
		t.Fatal("legacy listing no longer repairs metadata")
	}
}
