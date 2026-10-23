package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestOuterSessionGenerationReconcilesOriginalAndSerializesReplacement(t *testing.T) {
	ctx := context.Background()
	st := sqlitetest.MustOpen(t)
	now := time.Now()
	if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "outer-anchor", Kind: domain.ProjectKindScratch, RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	b := domain.OuterBinding{AnchorProjectID: "outer-anchor", Generation: 1, Revision: 1, ScopeRevision: 1}
	if err := st.SaveOuterBinding(ctx, b, 0, domain.OuterAudit{Operation: "setup"}); err != nil {
		t.Fatal(err)
	}
	commander := &fakeCommander{}
	svc := NewWithDeps(Deps{Store: st, Manager: commander})
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "spawn", ProjectID: "outer-anchor"})
	old, err := st.CreateSession(native, domain.SessionRecord{ProjectID: "outer-anchor", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, IsTerminated: true, Metadata: domain.SessionMetadata{OuterGeneration: 1}, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	cfg := ports.SpawnConfig{ProjectID: "outer-anchor", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, RequestedMode: domain.SessionModeChat, OuterGeneration: 1}
	got, _, _, err := svc.Spawn(native, cfg)
	if err != nil || got.ID != old.ID || commander.spawnCalls != 0 {
		t.Fatal("crash recovery replaced original generation", got.ID, err)
	}
	if _, _, _, err := svc.Spawn(ctx, cfg); err == nil {
		t.Fatal("claimed generation minted native authority")
	}
	b.Generation++
	b.Revision++
	if err := st.SaveOuterBinding(ctx, b, 1, domain.OuterAudit{Operation: "scope"}); err != nil {
		t.Fatal(err)
	}
	cfg.OuterGeneration = b.Generation
	commander.spawnFunc = func(input ports.SpawnConfig) domain.SessionRecord {
		r, err := st.CreateSession(native, domain.SessionRecord{ProjectID: input.ProjectID, Kind: input.Kind, Harness: input.Harness, Mode: input.RequestedMode, Metadata: domain.SessionMetadata{OuterGeneration: input.OuterGeneration}, CreatedAt: now, UpdatedAt: now})
		if err != nil {
			t.Error(err)
		}
		return r
	}
	var group sync.WaitGroup
	ids := make(chan domain.SessionID, 8)
	for range 8 {
		group.Go(func() {
			r, _, _, err := svc.Spawn(native, cfg)
			if err != nil {
				t.Error(err)
			}
			ids <- r.ID
		})
	}
	group.Wait()
	close(ids)
	var replacement domain.SessionID
	for id := range ids {
		if replacement == "" {
			replacement = id
		}
		if id == "" || id == old.ID || id != replacement {
			t.Fatal("replacement generation was not a singleton", id, replacement)
		}
	}
	if commander.spawnCalls != 1 {
		t.Fatal("duplicate launches", commander.spawnCalls)
	}
}
