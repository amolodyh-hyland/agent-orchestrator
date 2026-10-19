package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestInsertProjectIfAbsentDoesNotOverwriteExistingProject(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: "/tmp/p", RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	instructions := domain.ProjectInstructions{Shared: "acknowledged"}
	if ok, err := s.UpdateProjectSettings(ctx, "p", "P", domain.ProjectConfig{}, &instructions, 1); err != nil || !ok {
		t.Fatalf("UpdateProjectSettings ok=%v err=%v", ok, err)
	}
	inserted, err := s.InsertProjectIfAbsent(ctx, domain.ProjectRecord{ID: "p", Path: "/tmp/other", RegisteredAt: now})
	if err != nil || inserted {
		t.Fatalf("InsertProjectIfAbsent inserted=%v err=%v, want false", inserted, err)
	}
	got, _, err := s.GetProject(ctx, "p")
	if err != nil || got.Path != "/tmp/p" || got.Instructions != instructions || got.Revision != 2 {
		t.Fatalf("project after skipped insert = %#v, %v", got, err)
	}
	if inserted, err := s.InsertProjectIfAbsent(ctx, domain.ProjectRecord{ID: "q", Path: "/tmp/q", RegisteredAt: now}); err != nil || !inserted {
		t.Fatalf("InsertProjectIfAbsent new inserted=%v err=%v, want true", inserted, err)
	}
}

func TestImportWorkspaceProjectAdvancesTargetRevision(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.UpsertProject(ctx, domain.ProjectRecord{ID: "w", Path: "/tmp/w", Kind: domain.ProjectKindWorkspace, RegisteredAt: now, Revision: 5}); err != nil {
		t.Fatal(err)
	}
	source := domain.ProjectRecord{ID: "w", Path: "/tmp/w", Kind: domain.ProjectKindWorkspace, RegisteredAt: now, Revision: 2, Instructions: domain.ProjectInstructions{Shared: "from source"}}
	if err := s.ImportWorkspaceProject(ctx, source, nil); err != nil {
		t.Fatalf("ImportWorkspaceProject: %v", err)
	}
	got, _, err := s.GetProject(ctx, "w")
	if err != nil || got.Instructions != source.Instructions || got.Revision != 6 {
		t.Fatalf("project after import = %#v, %v; want source instructions at revision 6", got, err)
	}
}
