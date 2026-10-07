package sessionmanager

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestValidateSpawnEffort(t *testing.T) {
	tests := []struct {
		name        string
		harness     domain.AgentHarness
		effort      string
		wantErr     bool
		wantMessage string
		wantList    string
	}{
		{name: "empty", harness: domain.HarnessGemini},
		{name: "codex catalog validation", harness: domain.HarnessCodex, effort: "xhigh"},
		{name: "claude code catalog validation", harness: domain.HarnessClaudeCode, effort: "max"},
		{name: "copilot supported", harness: domain.HarnessCopilot, effort: "high"},
		{name: "copilot unsupported", harness: domain.HarnessCopilot, effort: "ultra", wantErr: true, wantMessage: "low, medium, high, xhigh, max"},
		{name: "gemini unsupported", harness: domain.HarnessGemini, effort: "high", wantErr: true, wantMessage: `harness "gemini"`, wantList: "claude-code, codex, copilot"},
		{name: "cursor unsupported", harness: domain.HarnessCursor, effort: "high", wantErr: true, wantMessage: `harness "cursor"`, wantList: "claude-code, codex, copilot"},
		{name: "opencode unsupported", harness: domain.HarnessOpenCode, effort: "high", wantErr: true, wantMessage: `harness "opencode"`, wantList: "claude-code, codex, copilot"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSpawnEffort(tt.harness, tt.effort)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("validateSpawnEffort() error = %v", err)
				}
				return
			}
			if !errors.Is(err, ports.ErrUnsupportedEffort) {
				t.Fatalf("validateSpawnEffort() error = %v, want ErrUnsupportedEffort", err)
			}
			if !strings.Contains(err.Error(), tt.wantMessage) {
				t.Fatalf("validateSpawnEffort() error = %q, want it to contain %q", err, tt.wantMessage)
			}
			if tt.wantList != "" && !strings.Contains(err.Error(), tt.wantList) {
				t.Fatalf("validateSpawnEffort() error = %q, want it to contain %q", err, tt.wantList)
			}
		})
	}
}

func TestAppliedSpawnEffort(t *testing.T) {
	tests := []struct {
		name    string
		harness domain.AgentHarness
		effort  string
		want    string
	}{
		{name: "codex", harness: domain.HarnessCodex, effort: "xhigh", want: "xhigh"},
		{name: "claude code", harness: domain.HarnessClaudeCode, effort: "max", want: "max"},
		{name: "copilot supported", harness: domain.HarnessCopilot, effort: "high", want: "high"},
		{name: "copilot unsupported", harness: domain.HarnessCopilot, effort: "ultra"},
		{name: "gemini", harness: domain.HarnessGemini, effort: "high"},
		{name: "cursor", harness: domain.HarnessCursor, effort: "high"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := appliedSpawnEffort(tt.harness, tt.effort); got != tt.want {
				t.Fatalf("appliedSpawnEffort(%q, %q) = %q, want %q", tt.harness, tt.effort, got, tt.want)
			}
		})
	}
}

func TestSpawn_RejectsExplicitEffortOnUnsupportedHarness(t *testing.T) {
	m, st, rt, ws, _ := newSpawnEffortFixture(t, domain.ProjectConfig{})
	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessGemini,
		AgentConfig: ports.AgentConfig{Effort: "high"},
	})
	if !errors.Is(err, ports.ErrUnsupportedEffort) {
		t.Fatalf("Spawn() error = %v, want ErrUnsupportedEffort", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("session rows = %d, want none", len(st.sessions))
	}
	if ws.createCount != 0 {
		t.Fatalf("workspace creates = %d, want none", ws.createCount)
	}
	if rt.created != 0 {
		t.Fatalf("runtime creates = %d, want none", rt.created)
	}
}

func TestSpawn_DropsInheritedEffortOnUnsupportedHarness(t *testing.T) {
	project := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Effort: "high"}}
	m, st, _, _, agent := newSpawnEffortFixture(t, project)
	rec, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessGemini,
	})
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	if got := agent.lastConfig.Effort; got != "" {
		t.Fatalf("adapter effort = %q, want empty", got)
	}
	if got := rec.Metadata.Effort; got != "" {
		t.Fatalf("returned metadata effort = %q, want empty", got)
	}
	stored := st.sessions[rec.ID]
	if got := stored.Metadata.Effort; got != "" {
		t.Fatalf("persisted metadata effort = %q, want empty", got)
	}
}

func TestSpawn_CopilotEffortReachesAdapterAndMetadata(t *testing.T) {
	m, st, _, _, agent := newSpawnEffortFixture(t, domain.ProjectConfig{})
	rec, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCopilot,
		AgentConfig: ports.AgentConfig{Effort: "high"},
	})
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	if got := agent.lastLaunch.Config.Effort; got != "high" {
		t.Fatalf("adapter effort = %q, want high", got)
	}
	if got := rec.Metadata.Effort; got != "high" {
		t.Fatalf("returned metadata effort = %q, want high", got)
	}
	if got := st.sessions[rec.ID].Metadata.Effort; got != "high" {
		t.Fatalf("persisted metadata effort = %q, want high", got)
	}

	invalidManager, invalidStore, invalidRuntime, invalidWorkspace, _ := newSpawnEffortFixture(t, domain.ProjectConfig{})
	_, _, _, err = invalidManager.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCopilot,
		AgentConfig: ports.AgentConfig{Effort: "ultra"},
	})
	if !errors.Is(err, ports.ErrUnsupportedEffort) {
		t.Fatalf("Spawn() error = %v, want ErrUnsupportedEffort", err)
	}
	if len(invalidStore.sessions) != 0 || invalidWorkspace.createCount != 0 || invalidRuntime.created != 0 {
		t.Fatalf("invalid effort created state: sessions=%d workspaces=%d runtimes=%d", len(invalidStore.sessions), invalidWorkspace.createCount, invalidRuntime.created)
	}
}

func TestSpawn_CopilotTUIEffortOverride(t *testing.T) {
	for _, tc := range []struct {
		name           string
		effortOverride bool
		wantEffort     string
	}{
		{name: "explicit reset", effortOverride: true},
		{name: "inherit project effort", wantEffort: "high"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			project := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Effort: "high"}}
			m, st, _, _, agent := newSpawnEffortFixture(t, project)
			rec, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
				ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCopilot,
				RequestedMode: domain.SessionModeTUI, EffortOverride: tc.effortOverride,
			})
			if err != nil {
				t.Fatalf("Spawn() error = %v", err)
			}
			if got := agent.lastLaunch.Config.Effort; got != tc.wantEffort {
				t.Fatalf("adapter effort = %q, want %q", got, tc.wantEffort)
			}
			if got := rec.Metadata.Effort; got != tc.wantEffort {
				t.Fatalf("returned metadata effort = %q, want %q", got, tc.wantEffort)
			}
			if got := st.sessions[rec.ID].Metadata.Effort; got != tc.wantEffort {
				t.Fatalf("persisted metadata effort = %q, want %q", got, tc.wantEffort)
			}
		})
	}
}

func TestEffectiveAndRestoredAgentConfigFilterCopilotEffort(t *testing.T) {
	for _, tc := range []struct {
		name          string
		projectEffort string
		wantEffort    string
	}{
		{name: "unsupported inherited effort", projectEffort: "ultra"},
		{name: "supported inherited effort", projectEffort: "high", wantEffort: "high"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			project := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Effort: tc.projectEffort}}
			if got := effectiveAgentConfig(domain.HarnessCopilot, domain.KindWorker, project).Effort; got != tc.wantEffort {
				t.Fatalf("effectiveAgentConfig() effort = %q, want %q", got, tc.wantEffort)
			}
			rec := domain.SessionRecord{Harness: domain.HarnessCopilot, Kind: domain.KindWorker}
			if got := restoredAgentConfig(rec, project).Effort; got != tc.wantEffort {
				t.Fatalf("restoredAgentConfig() effort = %q, want %q", got, tc.wantEffort)
			}
		})
	}

	project := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Effort: "high"}}
	if got := effectiveAgentConfig(domain.HarnessGemini, domain.KindWorker, project).Effort; got != "high" {
		t.Fatalf("effectiveAgentConfig() Gemini effort = %q, want high", got)
	}
}

func TestSpawn_CodexTUIExplicitEffortUsesCatalog(t *testing.T) {
	catalog := ports.AgentModelCatalog{Models: []ports.AgentModelInfo{{ID: "gpt-5", IsDefault: true, Efforts: []string{"low", "medium", "high"}}}}
	calls := 0
	m, _, _, _, _ := newSpawnEffortFixture(t, domain.ProjectConfig{})
	m.modelCatalog = tuningCatalog{catalog: catalog, calls: &calls}
	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		RequestedMode: domain.SessionModeTUI, AgentConfig: ports.AgentConfig{Effort: "ultra"},
	})
	if !errors.Is(err, ports.ErrUnsupportedEffort) {
		t.Fatalf("Spawn() error = %v, want ErrUnsupportedEffort", err)
	}
	if !strings.Contains(err.Error(), "supported: low, medium, high") {
		t.Fatalf("Spawn() error = %q, want supported effort list", err)
	}
	if calls != 1 {
		t.Fatalf("catalog calls = %d, want 1", calls)
	}

	calls = 0
	successManager, successStore, _, _, successAgent := newSpawnEffortFixture(t, domain.ProjectConfig{})
	successManager.modelCatalog = tuningCatalog{catalog: catalog, calls: &calls}
	successRec, _, _, err := successManager.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		RequestedMode: domain.SessionModeTUI, AgentConfig: ports.AgentConfig{Effort: "high"},
	})
	if err != nil {
		t.Fatalf("Spawn() with supported effort error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("catalog calls for supported explicit effort = %d, want 1", calls)
	}
	if got := successAgent.lastLaunch.Config.Effort; got != "high" {
		t.Fatalf("adapter effort = %q, want high", got)
	}
	if got := successRec.Metadata.Effort; got != "high" {
		t.Fatalf("returned metadata effort = %q, want high", got)
	}
	if got := successStore.sessions[successRec.ID].Metadata.Effort; got != "high" {
		t.Fatalf("persisted metadata effort = %q, want high", got)
	}

	calls = 0
	project := domain.ProjectConfig{AgentConfig: domain.AgentConfig{Effort: "high"}}
	inheritedManager, _, _, _, _ := newSpawnEffortFixture(t, project)
	inheritedManager.modelCatalog = tuningCatalog{catalog: catalog, calls: &calls}
	if _, _, _, err := inheritedManager.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		RequestedMode: domain.SessionModeTUI,
	}); err != nil {
		t.Fatalf("Spawn() with inherited effort error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("catalog calls for inherited effort = %d, want 0", calls)
	}
}

func TestResolveAgentConfig_UnsupportedEffortListsSupported(t *testing.T) {
	m := &Manager{modelCatalog: tuningCatalog{catalog: ports.AgentModelCatalog{Models: []ports.AgentModelInfo{{
		ID: "gpt-5", Efforts: []string{"low", "medium", "high"},
	}}}}}
	_, err := m.resolveAgentConfig(context.Background(), ports.SpawnConfig{
		Harness:     domain.HarnessCodex,
		AgentConfig: ports.AgentConfig{Model: "gpt-5", Effort: "ultra"},
	}, domain.ProjectConfig{})
	if !errors.Is(err, ports.ErrUnsupportedEffort) {
		t.Fatalf("resolveAgentConfig() error = %v, want ErrUnsupportedEffort", err)
	}
	if !strings.Contains(err.Error(), "supported: low, medium, high") {
		t.Fatalf("resolveAgentConfig() error = %q, want supported effort list", err)
	}
}

func newSpawnEffortFixture(t *testing.T, projectConfig domain.ProjectConfig) (*Manager, *fakeStore, *fakeRuntime, *fakeWorkspace, *recordingAgent) {
	t.Helper()
	store := newFakeStore()
	store.projects["mer"] = domain.ProjectRecord{ID: "mer", Kind: domain.ProjectKindScratch, Config: projectConfig}
	runtime := &fakeRuntime{}
	workspace := &fakeWorkspace{}
	agent := &recordingAgent{}
	manager := New(Deps{
		Runtime: runtime, Agents: singleAgent{agent: agent}, Workspace: workspace, Store: store,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: store},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	return manager, store, runtime, workspace, agent
}
