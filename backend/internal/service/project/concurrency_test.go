package project_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// racingStore runs after once, right after the first GetProject returns, to
// model another request committing between a handler's read and its write.
type racingStore struct {
	project.Store
	after func()
}

func (s *racingStore) GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error) {
	row, ok, err := s.Store.GetProject(ctx, id)
	if s.after != nil {
		after := s.after
		s.after = nil
		after()
	}
	return row, ok, err
}

func newRacingContainer(t *testing.T) (*project.Service, *racingStore, project.Project) {
	t.Helper()
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "folder")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("create folder: %v", err)
	}
	inner, err := sqlitetest.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = inner.Close() })
	racing := &racingStore{Store: inner}
	manager := project.New(racing)
	created, err := manager.CreateContainer(ctx, project.CreateContainerInput{
		DisplayName:  "Planning",
		Path:         dir,
		Instructions: domain.ProjectInstructions{Shared: "original"},
	})
	if err != nil {
		t.Fatalf("create container: %v", err)
	}
	return manager, racing, created
}

func commitInstructions(t *testing.T, store project.Store, id domain.ProjectID, text string) {
	t.Helper()
	instructions := domain.ProjectInstructions{Shared: text}
	if _, err := project.New(store).UpdateSettings(context.Background(), id, project.UpdateSettingsInput{DisplayName: "Planning", Instructions: &instructions}); err != nil {
		t.Fatalf("concurrent instructions update: %v", err)
	}
}

func TestSetConfigDoesNotOverwriteConcurrentInstructions(t *testing.T) {
	manager, racing, created := newRacingContainer(t)
	racing.after = func() { commitInstructions(t, racing.Store, created.ID, "newer") }

	got, err := manager.SetConfig(context.Background(), created.ID, project.SetConfigInput{})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if got.Instructions == nil || got.Instructions.Shared != "newer" {
		t.Fatalf("instructions after SetConfig = %#v, want the newer acknowledged value", got.Instructions)
	}
	if got.Revision != 3 {
		t.Fatalf("revision = %d, want 3 (create, instructions, config)", got.Revision)
	}
}

func TestUpdateSettingsWithoutInstructionsKeepsConcurrentInstructions(t *testing.T) {
	manager, racing, created := newRacingContainer(t)
	racing.after = func() { commitInstructions(t, racing.Store, created.ID, "newer") }

	got, err := manager.UpdateSettings(context.Background(), created.ID, project.UpdateSettingsInput{DisplayName: "Renamed"})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if got.Name != "Renamed" || got.Instructions == nil || got.Instructions.Shared != "newer" || got.Revision != 3 {
		t.Fatalf("project after settings update = %#v", got)
	}
}

func TestUpdateSettingsInstructionsConflictOnStaleRevision(t *testing.T) {
	manager, racing, created := newRacingContainer(t)
	racing.after = func() { commitInstructions(t, racing.Store, created.ID, "newer") }

	stale := domain.ProjectInstructions{Shared: "stale"}
	_, err := manager.UpdateSettings(context.Background(), created.ID, project.UpdateSettingsInput{DisplayName: "Planning", Instructions: &stale})
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Code != "PROJECT_REVISION_CONFLICT" {
		t.Fatalf("UpdateSettings err = %v, want conflict", err)
	}
	result, err := manager.Get(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if result.Project.Instructions == nil || result.Project.Instructions.Shared != "newer" || result.Project.Revision != 2 {
		t.Fatalf("project after conflict = %#v, want newer instructions at revision 2", result.Project)
	}
}

func TestAddReactivatedArchivedProjectKeepsInstructionsAndAdvancesRevision(t *testing.T) {
	ctx := context.Background()
	m := newManager(t)
	repo := gitRepo(t)
	id := "ao"
	if _, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: &id}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	instructions := domain.ProjectInstructions{Shared: "durable"}
	if _, err := m.UpdateSettings(ctx, "ao", project.UpdateSettingsInput{DisplayName: "ao", Instructions: &instructions}); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if _, err := m.Remove(ctx, "ao"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	readded, err := m.Add(ctx, project.AddInput{Path: repo, ProjectID: &id})
	if err != nil {
		t.Fatalf("re-Add: %v", err)
	}
	if readded.Instructions == nil || !reflect.DeepEqual(*readded.Instructions, instructions) {
		t.Fatalf("re-added instructions = %#v, want %#v", readded.Instructions, instructions)
	}
	// Add (1), settings (2), archive (3), reactivation (4).
	if readded.Revision != 4 {
		t.Fatalf("re-added revision = %d, want 4", readded.Revision)
	}
}
