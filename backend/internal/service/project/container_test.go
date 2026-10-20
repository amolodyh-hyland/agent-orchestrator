package project_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestCreateContainerUsesScratchWithoutGitAndPersistsInstructions(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	emptyDir := filepath.Join(t.TempDir(), "empty")
	if err := os.Mkdir(emptyDir, 0o755); err != nil {
		t.Fatalf("create empty directory: %v", err)
	}
	store, err := sqlitetest.Open(dataDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	manager := project.New(store)
	instructions := domain.ProjectInstructions{
		Shared:      "Keep the scope clear.",
		Worker:      "Make focused changes.",
		Coordinator: "Coordinate without changing worker rules.",
		Attachments: []domain.ProjectContextAttachment{{
			ID: "runbook", SourceKind: domain.ProjectContextInlineText, Text: "Reference only.",
			MediaType: "text/plain", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared},
			Position: 1, Enabled: true,
		}},
	}
	created, err := manager.CreateContainer(ctx, project.CreateContainerInput{
		DisplayName:  "Planning",
		Path:         emptyDir,
		Instructions: instructions,
	})
	if err != nil {
		_ = store.Close()
		t.Fatalf("create Project container: %v", err)
	}
	if created.ID == "" || string(created.ID) == created.Name {
		t.Fatalf("container id = %q, want opaque stable id", created.ID)
	}
	if created.Kind != domain.ProjectKindScratch || created.Path != emptyDir || created.Repo != "" || created.DefaultBranch != "" {
		t.Fatalf("container execution shape = %#v", created)
	}
	if created.Revision != 1 || created.FolderMissing {
		t.Fatalf("container revision/folder state = %d/%t, want 1/false", created.Revision, created.FolderMissing)
	}
	if created.Instructions == nil || !reflect.DeepEqual(*created.Instructions, instructions) {
		t.Fatalf("container instructions = %#v, want %#v", created.Instructions, instructions)
	}
	entries, err := os.ReadDir(emptyDir)
	if err != nil {
		_ = store.Close()
		t.Fatalf("read empty folder: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("container creation changed empty folder: %v", entries)
	}

	updatedInstructions := domain.ProjectInstructions{Shared: "Use this updated guidance."}
	updated, err := manager.UpdateSettings(ctx, created.ID, project.UpdateSettingsInput{
		DisplayName:  "Planning",
		Instructions: &updatedInstructions,
	})
	if err != nil {
		_ = store.Close()
		t.Fatalf("update Project instructions: %v", err)
	}
	if updated.Revision != 2 || updated.Instructions == nil || !reflect.DeepEqual(*updated.Instructions, updatedInstructions) {
		t.Fatalf("updated Project metadata = revision %d, instructions %#v", updated.Revision, updated.Instructions)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store before restart: %v", err)
	}

	restartedStore, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = restartedStore.Close() })
	restarted := project.New(restartedStore)
	result, err := restarted.Get(ctx, created.ID)
	if err != nil {
		t.Fatalf("get Project after restart: %v", err)
	}
	if result.Project == nil || result.Project.ID != created.ID || result.Project.Revision != 2 || result.Project.Instructions == nil || !reflect.DeepEqual(*result.Project.Instructions, updatedInstructions) {
		t.Fatalf("Project after restart = %#v", result)
	}

	pathless, err := restarted.CreateContainer(ctx, project.CreateContainerInput{DisplayName: "No execution resource"})
	if err != nil {
		t.Fatalf("create pathless Project: %v", err)
	}
	if pathless.Path != "" || pathless.Kind != domain.ProjectKindScratch || pathless.FolderMissing {
		t.Fatalf("pathless Project = %#v", pathless)
	}
}
