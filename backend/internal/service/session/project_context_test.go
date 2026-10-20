package session

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type contextReadStore struct {
	*fakeStore
	manifest domain.ProjectContextManifest
	found    bool
	err      error
	reads    int
}

func (s *contextReadStore) GetProjectContextSnapshot(_ context.Context, _ domain.SessionID) (domain.ProjectContextManifest, bool, error) {
	s.reads++
	return s.manifest, s.found, s.err
}

func TestProjectContextReadsOnlyPinnedSnapshotForVisibleSession(t *testing.T) {
	store := &contextReadStore{fakeStore: newFakeStore(), found: true, manifest: domain.ProjectContextManifest{SessionID: "p-1", ProjectID: "p", ProjectRevision: 3, SharedInstructions: "pinned"}}
	store.sessions["p-1"] = domain.SessionRecord{ID: "p-1", ProjectID: "p"}
	store.projects["p"] = domain.ProjectRecord{ID: "p", Revision: 7, Instructions: domain.ProjectInstructions{Shared: "current"}}
	svc := &Service{store: store}
	got, err := svc.ProjectContext(context.Background(), "p-1")
	if err != nil || got == nil || got.SharedInstructions != "pinned" || got.ProjectRevision != 3 {
		t.Fatalf("pinned manifest = %#v, %v", got, err)
	}
	store.sessions["hidden"] = domain.SessionRecord{ID: "hidden", IsTaskPreparation: true}
	for _, id := range []domain.SessionID{"missing", "hidden"} {
		if _, err := svc.ProjectContext(context.Background(), id); err == nil {
			t.Fatalf("manifest for invisible session %s should fail", id)
		}
	}
	if store.reads != 1 {
		t.Fatalf("manifest reads = %d, want 1", store.reads)
	}
	store.found = false
	if got, err := svc.ProjectContext(context.Background(), "p-1"); err != nil || got != nil {
		t.Fatalf("legacy manifest = %#v, %v", got, err)
	}
	store.err = errors.New("snapshot corrupted")
	if _, err := svc.ProjectContext(context.Background(), "p-1"); err == nil {
		t.Fatal("snapshot error was hidden")
	}
}
