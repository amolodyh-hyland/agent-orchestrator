package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestRuntimePermissionCleanupPreservesChosenCeiling(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	seedProject(t, s, "mer")
	rec := sampleRecord("mer")
	rec.Metadata.Permissions = domain.PermissionModeAcceptEdits
	created, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	if updated, err := s.UpdateSessionPermissions(ctx, created.ID, ""); err != nil || !updated {
		t.Fatalf("clear runtime: %v %v", updated, err)
	}
	if _, ok, err := s.SetProjectPermissions(ctx, "mer", domain.PermissionModeBypassPermissions); err != nil || !ok {
		t.Fatalf("change project default: %v %v", ok, err)
	}
	stale := created
	stale.Metadata.PermissionCeiling = domain.PermissionModeBypassPermissions
	stale.UpdatedAt = time.Now()
	if err := s.UpdateSession(ctx, stale); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetSession(ctx, created.ID)
	if err != nil || !ok {
		t.Fatalf("read: %v %v", ok, err)
	}
	if got.Metadata.Permissions != "" || got.Metadata.PermissionCeiling != domain.PermissionModeAcceptEdits {
		t.Fatalf("runtime cleanup or stale update changed ceiling: %+v", got.Metadata)
	}
}
