package project_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func localContextBinding(id, ref, machine string, kind domain.ProjectContextSourceKind, path string) domain.ProjectContextAttachment {
	return domain.ProjectContextAttachment{
		ID: id, SourceKind: kind, SourceRef: ref, MachineID: machine, LocalPath: path,
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
}

func TestProjectContextLocalSourcesAreRegisteredByTheOwningDaemon(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store, err := sqlitetest.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	manager := project.New(store)
	manager.SetProjectContextMachineID("machine-a")

	abs := filepath.Join(t.TempDir(), "notes", "guide.md")
	created, err := manager.CreateContainer(ctx, project.CreateContainerInput{
		DisplayName: "Planning", Path: root,
		Instructions: domain.ProjectInstructions{Attachments: []domain.ProjectContextAttachment{
			localContextBinding("repo", "repo-ref", "machine-a", domain.ProjectContextRepoRelativeFile, "docs/guide.md"),
			localContextBinding("abs", "abs-ref", "machine-a", domain.ProjectContextMachineLocalFile, abs),
		}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, a := range created.Instructions.Attachments {
		if a.LocalPath != "" {
			t.Fatalf("attachment %s returned a local path", a.ID)
		}
	}
	repo, found, err := store.GetProjectContextLocalSource(ctx, "repo-ref")
	if err != nil || !found || repo.MachineID != "machine-a" || repo.RootPath != root || repo.RelativePath != "docs/guide.md" ||
		repo.OwnerKind != domain.ProjectContextOwnerProject || repo.OwnerID != string(created.ID) {
		t.Fatalf("repo source = %#v found=%v err=%v", repo, found, err)
	}
	local, found, err := store.GetProjectContextLocalSource(ctx, "abs-ref")
	if err != nil || !found || local.RootPath != filepath.Dir(abs) || local.RelativePath != "guide.md" {
		t.Fatalf("machine-local source = %#v found=%v err=%v", local, found, err)
	}
	stored, ok, err := store.GetProject(ctx, string(created.ID))
	if err != nil || !ok {
		t.Fatalf("load project: %v %v", ok, err)
	}
	for _, a := range stored.Instructions.Attachments {
		if a.LocalPath != "" {
			t.Fatalf("stored attachment %s kept a local path", a.ID)
		}
	}

	// Resending a path refreshes the locator; omitting it leaves it alone.
	refreshed := *created.Instructions
	refreshed.Attachments = append([]domain.ProjectContextAttachment(nil), refreshed.Attachments...)
	refreshed.Attachments[0].LocalPath = "docs/other.md"
	if _, err := manager.UpdateSettings(ctx, created.ID, project.UpdateSettingsInput{DisplayName: "Planning", Config: domain.ProjectConfig{}, Instructions: &refreshed}); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	repo, _, _ = store.GetProjectContextLocalSource(ctx, "repo-ref")
	if repo.RelativePath != "docs/other.md" {
		t.Fatalf("refreshed relative path = %q", repo.RelativePath)
	}
	refreshed.Attachments[0].LocalPath = ""
	refreshed.Attachments[1].LocalPath = ""
	if _, err := manager.UpdateSettings(ctx, created.ID, project.UpdateSettingsInput{DisplayName: "Planning", Config: domain.ProjectConfig{}, Instructions: &refreshed}); err != nil {
		t.Fatalf("resave without paths: %v", err)
	}
	if repo, _, _ = store.GetProjectContextLocalSource(ctx, "repo-ref"); repo.RelativePath != "docs/other.md" {
		t.Fatalf("resave without path changed locator to %q", repo.RelativePath)
	}

	t.Run("escaping repo-relative path is rejected", func(t *testing.T) {
		bad := domain.ProjectInstructions{Attachments: []domain.ProjectContextAttachment{
			localContextBinding("esc", "esc-ref", "machine-a", domain.ProjectContextRepoRelativeFile, "../secret.md"),
		}}
		if _, err := manager.CreateContainer(ctx, project.CreateContainerInput{DisplayName: "Bad", Path: t.TempDir(), Instructions: bad}); err == nil {
			t.Fatal("escaping path accepted")
		}
	})
	t.Run("another machine cannot be registered here", func(t *testing.T) {
		other := domain.ProjectInstructions{Attachments: []domain.ProjectContextAttachment{
			localContextBinding("far", "far-ref", "machine-b", domain.ProjectContextRepoRelativeFile, "docs/guide.md"),
		}}
		if _, err := manager.CreateContainer(ctx, project.CreateContainerInput{DisplayName: "Far", Path: t.TempDir(), Instructions: other}); err == nil {
			t.Fatal("registration for a different machine accepted")
		}
		if _, found, _ := store.GetProjectContextLocalSource(ctx, "far-ref"); found {
			t.Fatal("source registered for a different machine")
		}
	})
	t.Run("a source reference cannot be taken over by another project", func(t *testing.T) {
		steal := domain.ProjectInstructions{Attachments: []domain.ProjectContextAttachment{
			localContextBinding("steal", "repo-ref", "machine-a", domain.ProjectContextRepoRelativeFile, "x.md"),
		}}
		if _, err := manager.CreateContainer(ctx, project.CreateContainerInput{DisplayName: "Thief", Path: t.TempDir(), Instructions: steal}); err == nil {
			t.Fatal("source reference owned by another project was overwritten")
		}
		if repo, _, _ = store.GetProjectContextLocalSource(ctx, "repo-ref"); repo.RootPath != root {
			t.Fatalf("source root changed to %q", repo.RootPath)
		}
	})
}
