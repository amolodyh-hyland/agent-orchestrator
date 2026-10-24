package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type nativeDesktopLifecycleCommander struct {
	*fakeCommander
	st *sqlite.Store
}

func (m nativeDesktopLifecycleCommander) Kill(ctx context.Context, id domain.SessionID) (bool, error) {
	if err := m.st.CheckOuterOperation(ctx, "kill", "", id); err != nil {
		return false, err
	}
	return m.fakeCommander.Kill(ctx, id)
}
func (m nativeDesktopLifecycleCommander) Cleanup(ctx context.Context, project domain.ProjectID) (sessionmanager.CleanupResult, error) {
	if err := m.st.CheckOuterOperation(ctx, "cleanup", project, ""); err != nil {
		return sessionmanager.CleanupResult{}, err
	}
	return m.fakeCommander.Cleanup(ctx, project)
}

func TestNativeDesktopProjectLifecycleKeepsExactChildAuthority(t *testing.T) {
	ctx := context.Background()
	st := sqlitetest.MustOpen(t)
	for _, id := range []string{"anchor", "selected", "other"} {
		cfg := domain.ProjectConfig{}
		cfg.Orchestrator.Harness = domain.HarnessCodex
		if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: id, Kind: domain.ProjectKindScratch, Config: cfg, RegisteredAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SaveOuterBinding(ctx, domain.OuterBinding{AnchorProjectID: "anchor", Revision: 1, ScopeRevision: 1, Generation: 1, ProjectIDs: []string{"selected"}}, 0, domain.OuterAudit{Operation: "setup"}); err != nil {
		t.Fatal(err)
	}
	old, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "selected", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeCommander{spawnRecord: domain.SessionRecord{ID: "fresh", ProjectID: "selected", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat}}
	fake.retireFunc = func(child context.Context, id domain.SessionID) error {
		a, _ := domain.OuterNativeActionFrom(child)
		if a.ActionID != "exact-replacement" || a.SessionID != old.ID || id != old.ID {
			t.Error("replacement child lost exact native identity", a)
		}
		return st.CheckOuterOperation(child, "retire", "", id)
	}
	svc := NewWithDeps(Deps{Store: st, Manager: nativeDesktopLifecycleCommander{fakeCommander: fake, st: st}})
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "spawn", ProjectID: "selected", ActionID: "exact-replacement"})
	if _, err := svc.SpawnOrchestrator(native, "selected", true, domain.SessionModeChat, ""); err != nil {
		t.Fatal("exact replacement was rejected", err)
	}
	if fake.spawnCalls != 1 {
		t.Fatal("replacement did not launch exactly once", fake.spawnCalls)
	}
	wrong := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "spawn", ProjectID: "other"})
	if _, err := svc.SpawnOrchestrator(wrong, "selected", true, domain.SessionModeChat, ""); err == nil || fake.spawnCalls != 1 {
		t.Fatal("replacement crossed Project authority")
	}
	removal := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "project.remove", ProjectID: "selected", ActionID: "exact-removal"})
	if err := svc.TeardownProject(removal, "selected"); err != nil {
		t.Fatal("exact removal child effect was rejected", err)
	}
	if len(fake.killed) != 1 || fake.killed[0] != old.ID || len(fake.cleanupProjects) != 1 || fake.cleanupProjects[0] != "selected" {
		t.Fatal("removal widened its targets", fake.killed, fake.cleanupProjects)
	}
	if err := svc.TeardownProject(ctx, "selected"); err == nil {
		t.Fatal("unbound teardown was authorized")
	}
	if err := st.CheckOuterOperation(nativeProjectLifecycleEffect(removal, "other", old.ID, "kill"), "kill", "", old.ID); err == nil {
		t.Fatal("child authority crossed Project")
	}
	other, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "other", Kind: domain.KindWorker, Harness: domain.HarnessCodex, CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CheckOuterOperation(nativeProjectLifecycleEffect(removal, "selected", other.ID, "kill"), "kill", "", other.ID); err == nil {
		t.Fatal("native child escaped into an unselected Project")
	}
	if err := st.CheckOuterOperation(nativeProjectLifecycleEffect(native, "selected", old.ID, "send"), "send", "", old.ID); err == nil {
		t.Fatal("replacement became model-input authority")
	}
}

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
