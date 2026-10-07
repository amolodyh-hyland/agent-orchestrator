package sessionmanager

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func boolPtr(v bool) *bool { return &v }

func TestPermissionFallbackConfigMerge(t *testing.T) {
	t.Run("unset stays unset and means enabled", func(t *testing.T) {
		got := effectiveAgentConfig(domain.HarnessCodex, domain.KindWorker, domain.ProjectConfig{})
		if got.PermissionFallback != nil || !got.PermissionFallbackEnabled() {
			t.Fatalf("config = %#v, want the fallback unset and enabled", got)
		}
	})
	t.Run("project level off applies to every role", func(t *testing.T) {
		cfg := domain.ProjectConfig{AgentConfig: domain.AgentConfig{PermissionFallback: boolPtr(false)}}
		for _, kind := range []domain.SessionKind{domain.KindWorker, domain.KindOrchestrator} {
			if got := effectiveAgentConfig(domain.HarnessCodex, kind, cfg); got.PermissionFallbackEnabled() {
				t.Errorf("%s: fallback enabled, want the project's off", kind)
			}
		}
	})
	t.Run("a role override wins over the project", func(t *testing.T) {
		cfg := domain.ProjectConfig{
			AgentConfig: domain.AgentConfig{PermissionFallback: boolPtr(false)},
			Worker:      domain.RoleOverride{AgentConfig: domain.AgentConfig{PermissionFallback: boolPtr(true)}},
		}
		if got := effectiveAgentConfig(domain.HarnessCodex, domain.KindWorker, cfg); !got.PermissionFallbackEnabled() {
			t.Fatal("worker fallback off, want the worker override's on")
		}
		if got := effectiveAgentConfig(domain.HarnessCodex, domain.KindOrchestrator, cfg); got.PermissionFallbackEnabled() {
			t.Fatal("orchestrator fallback on, want the project's off")
		}
	})
	t.Run("a spawn override wins over the resolved config", func(t *testing.T) {
		base := ports.AgentConfig{PermissionFallback: boolPtr(true)}
		got := applySpawnAgentConfig(base, ports.AgentConfig{PermissionFallback: boolPtr(false)})
		if got.PermissionFallbackEnabled() {
			t.Fatal("fallback on, want the spawn override's off")
		}
		if got := applySpawnAgentConfig(base, ports.AgentConfig{}); !got.PermissionFallbackEnabled() {
			t.Fatal("an empty spawn override changed the resolved fallback")
		}
	})
}

// The resolved flag has to reach the controller start, because the chat service
// owns the retry. Off in config means DisablePermissionFallback on the start.
func TestChatSpawnCarriesThePermissionFallbackSetting(t *testing.T) {
	for _, tc := range []struct {
		name        string
		fallback    *bool
		wantDisable bool
	}{
		{"unset defaults to on", nil, false},
		{"explicitly on", boolPtr(true), false},
		{"explicitly off", boolPtr(false), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			launcher := &recordingLauncher{}
			mgr, store, _ := newChatManager(launcher)
			project := store.projects[string(chatTestProject)]
			project.Config.AgentConfig = domain.AgentConfig{
				Permissions: ports.PermissionModeBypassPermissions, PermissionFallback: tc.fallback,
			}
			store.projects[string(chatTestProject)] = project

			if _, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
				ProjectID: chatTestProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex,
				RequestedMode: domain.SessionModeChat,
			}); err != nil {
				t.Fatalf("Spawn: %v", err)
			}
			if len(launcher.started) != 1 {
				t.Fatalf("started %d controllers, want 1", len(launcher.started))
			}
			start := launcher.started[0]
			if start.DisablePermissionFallback != tc.wantDisable {
				t.Fatalf("DisablePermissionFallback = %t, want %t", start.DisablePermissionFallback, tc.wantDisable)
			}
			if start.Permissions != ports.PermissionModeBypassPermissions {
				t.Fatalf("Permissions = %q, want the requested bypass-permissions", start.Permissions)
			}
		})
	}
}

func TestPersistChatPermissionsRecordsTheEffectiveModeWithoutDisturbingTheSession(t *testing.T) {
	ctx := context.Background()
	base := sqlitetest.MustOpen(t)
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	if err := base.UpsertProject(ctx, domain.ProjectRecord{ID: "fallback", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	created, err := base.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "fallback", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		Metadata: domain.SessionMetadata{
			Permissions:            domain.PermissionModeBypassPermissions,
			ProviderConversationID: "thread-1",
			ControllerGeneration:   "generation-1",
		},
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{store: base}

	if err := manager.PersistChatPermissions(ctx, created.ID, domain.PermissionModeAuto); err != nil {
		t.Fatalf("PersistChatPermissions: %v", err)
	}
	got, ok, err := base.GetSession(ctx, created.ID)
	if err != nil || !ok {
		t.Fatalf("read session: ok=%v err=%v", ok, err)
	}
	if got.Metadata.Permissions != domain.PermissionModeAuto {
		t.Fatalf("permissions = %q, want the effective auto", got.Metadata.Permissions)
	}
	if got.Metadata.ProviderConversationID != "thread-1" || got.Metadata.ControllerGeneration != "generation-1" ||
		got.IsTerminated || got.Activity.State != domain.ActivityActive {
		t.Fatalf("a permissions write disturbed the session: %+v", got)
	}

	if err := manager.PersistChatPermissions(ctx, "fallback-missing", domain.PermissionModeAuto); !errors.Is(err, ErrNotFound) {
		t.Fatalf("PersistChatPermissions(unknown) = %v, want ErrNotFound", err)
	}
}

// A store without the optional write leaves the pinned mode alone rather than
// failing the turn that already succeeded.
func TestPersistChatPermissionsIsANoOpWithoutStoreSupport(t *testing.T) {
	manager, store, _, _ := newManager()
	store.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{Permissions: domain.PermissionModeBypassPermissions},
	}
	if err := manager.PersistChatPermissions(context.Background(), "mer-1", domain.PermissionModeAuto); err != nil {
		t.Fatalf("PersistChatPermissions: %v", err)
	}
	if got := store.sessions["mer-1"].Metadata.Permissions; got != domain.PermissionModeBypassPermissions {
		t.Fatalf("permissions = %q, want the pinned mode untouched", got)
	}
}

// The launch commit rewrites the session's metadata. If the fallback launched a
// lower mode, that commit must pin it rather than the mode that was requested, or
// the session would read back (and restore with) a mode the provider refused.
func TestChatSpawnPinsTheModeTheFallbackLaunched(t *testing.T) {
	for _, tc := range []struct {
		name      string
		effective ports.PermissionMode
		want      ports.PermissionMode
	}{
		{"fallback lowered it", ports.PermissionModeAuto, ports.PermissionModeAuto},
		{"requested mode ran", "", ports.PermissionModeBypassPermissions},
	} {
		t.Run(tc.name, func(t *testing.T) {
			launcher := &recordingLauncher{effectivePermissions: tc.effective}
			mgr, store, _ := newChatManager(launcher)
			project := store.projects[string(chatTestProject)]
			project.Config.AgentConfig = domain.AgentConfig{Permissions: ports.PermissionModeBypassPermissions}
			store.projects[string(chatTestProject)] = project

			rec, _, _, err := mgr.Spawn(context.Background(), ports.SpawnConfig{
				ProjectID: chatTestProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex,
				RequestedMode: domain.SessionModeChat,
			})
			if err != nil {
				t.Fatalf("Spawn: %v", err)
			}
			if got := store.sessions[rec.ID].Metadata.Permissions; got != tc.want {
				t.Fatalf("pinned permissions = %q, want %q", got, tc.want)
			}
		})
	}
}
