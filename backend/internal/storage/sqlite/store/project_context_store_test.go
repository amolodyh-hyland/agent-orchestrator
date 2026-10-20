package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestProjectContextSnapshotAndLocalSourceSurviveRestart(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	project := domain.ProjectRecord{ID: "context-project", Path: "/tmp/context-project", RegisteredAt: time.Now().UTC()}
	if err := store.UpsertProject(ctx, project); err != nil {
		t.Fatalf("create project: %v", err)
	}
	session := sampleRecord(string(project.ID))
	session.ID = "context-session"
	createdSession, err := store.CreateSession(ctx, session)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	manifest := domain.ProjectContextManifest{
		SessionID: createdSession.ID, ProjectID: domain.ProjectID(project.ID), ProjectRevision: 3,
		Role: domain.ProjectContextRoleWorker, Channel: domain.SessionModeTUI,
		CreatedAt: time.Now().UTC(), SharedInstructions: "pinned guidance",
		Attachments: []domain.ProjectContextManifestEntry{},
	}
	digest, err := manifest.ComputeDigest()
	if err != nil {
		t.Fatalf("compute snapshot digest: %v", err)
	}
	manifest.Digest = digest
	created, err := store.CreateProjectContextSnapshot(ctx, manifest)
	if err != nil || !created {
		t.Fatalf("create snapshot: created=%v err=%v", created, err)
	}
	localSource := domain.ProjectContextLocalSourceRecord{
		SourceRef: "local-runbook", MachineID: "machine-a", RootPath: t.TempDir(),
		RelativePath: "runbook.md", MediaType: "text/markdown",
		OwnerKind: domain.ProjectContextOwnerUser, OwnerID: "library-a",
	}
	if err := store.UpsertProjectContextLocalSource(ctx, localSource); err != nil {
		t.Fatalf("upsert local source: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close initial store: %v", err)
	}

	store, err = sqlite.OpenPreMigrated(dataDir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close reopened store: %v", err)
		}
	})
	got, found, err := store.GetProjectContextSnapshot(ctx, manifest.SessionID)
	if err != nil || !found || got.SharedInstructions != "pinned guidance" || got.Digest != manifest.Digest {
		t.Fatalf("reloaded snapshot = %#v found=%v err=%v", got, found, err)
	}
	gotSource, found, err := store.GetProjectContextLocalSource(ctx, localSource.SourceRef)
	if err != nil || !found || gotSource.MachineID != localSource.MachineID || gotSource.RootPath != localSource.RootPath || gotSource.RelativePath != localSource.RelativePath {
		t.Fatalf("reloaded local source = %#v found=%v err=%v", gotSource, found, err)
	}
}

func TestProjectContextSnapshotIsCreateOnce(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	seedProject(t, store, "context-project")
	session := sampleRecord("context-project")
	session.ID = "context-session"
	createdSession, err := store.CreateSession(ctx, session)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	manifest := domain.ProjectContextManifest{
		SessionID: createdSession.ID, ProjectID: session.ProjectID, ProjectRevision: 1,
		Role: domain.ProjectContextRoleWorker, Channel: domain.SessionModeTUI,
		CreatedAt: time.Now().UTC(), SharedInstructions: "first",
		Attachments: []domain.ProjectContextManifestEntry{},
	}
	manifest.Digest, _ = manifest.ComputeDigest()
	if created, err := store.CreateProjectContextSnapshot(ctx, manifest); err != nil || !created {
		t.Fatalf("first insert: created=%v err=%v", created, err)
	}
	changed := manifest
	changed.SharedInstructions = "later edit"
	changed.Digest, _ = changed.ComputeDigest()
	if created, err := store.CreateProjectContextSnapshot(ctx, changed); err != nil || created {
		t.Fatalf("duplicate insert: created=%v err=%v, want existing snapshot", created, err)
	}
	got, found, err := store.GetProjectContextSnapshot(ctx, createdSession.ID)
	if err != nil || !found || got.SharedInstructions != "first" {
		t.Fatalf("snapshot after duplicate insert = %#v found=%v err=%v", got, found, err)
	}
}
