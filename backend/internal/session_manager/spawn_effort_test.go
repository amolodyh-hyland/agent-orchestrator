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
		{name: "command code forwards raw effort", harness: domain.HarnessCommandCode, effort: "high"},
		{name: "copilot supported", harness: domain.HarnessCopilot, effort: "high"},
		{name: "copilot unsupported", harness: domain.HarnessCopilot, effort: "ultra", wantErr: true, wantMessage: "low, medium, high, xhigh, max"},
		{name: "gemini unsupported", harness: domain.HarnessGemini, effort: "high", wantErr: true, wantMessage: `harness "gemini"`, wantList: "claude-code, codex, command-code, copilot"},
		{name: "cursor unsupported", harness: domain.HarnessCursor, effort: "high", wantErr: true, wantMessage: `harness "cursor"`, wantList: "claude-code, codex, command-code, copilot"},
		{name: "opencode unsupported", harness: domain.HarnessOpenCode, effort: "high", wantErr: true, wantMessage: `harness "opencode"`, wantList: "claude-code, codex, command-code, copilot"},
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
		{name: "command code", harness: domain.HarnessCommandCode, effort: "high", want: "high"},
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

// staleClaudeCatalog is what discovery returns when it finds no credential: the
// static aliases, flagged stale. Provider-looking efforts are included on
// purpose, so a test fails if the fallback trusts the stale snapshot.
func staleClaudeCatalog(defaultModel string, extra ...string) tuningCatalog {
	catalog := ports.AgentModelCatalog{Stale: true}
	for _, id := range []string{"sonnet", "fable", "opus", "haiku", "opus[1m]"} {
		catalog.Models = append(catalog.Models, ports.AgentModelInfo{ID: id, IsDefault: id == defaultModel, Efforts: []string{"low"}})
	}
	for _, id := range extra {
		catalog.Models = append(catalog.Models, ports.AgentModelInfo{ID: id, IsDefault: id == defaultModel})
	}
	return tuningCatalog{catalog: catalog}
}

func resolveClaudeTUI(m *Manager, project domain.ProjectConfig, agentConfig ports.AgentConfig) (ports.AgentConfig, error) {
	return m.resolveAgentConfig(context.Background(), ports.SpawnConfig{
		ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		RequestedMode: domain.SessionModeTUI, AgentConfig: agentConfig, EffortOverride: agentConfig.Effort != "",
	}, project)
}

func TestResolveClaudeFallbackCapabilityTable(t *testing.T) {
	roleProject := domain.ProjectConfig{Worker: domain.RoleOverride{AgentConfig: domain.AgentConfig{Model: "sonnet", Effort: "high"}}}
	m := &Manager{modelCatalog: staleClaudeCatalog("")}

	for _, tc := range []struct {
		name       string
		project    domain.ProjectConfig
		request    ports.AgentConfig
		wantModel  string
		wantEffort string
	}{
		{name: "alias with effort", request: ports.AgentConfig{Model: "opus", Effort: "xhigh"}, wantModel: "opus", wantEffort: "xhigh"},
		{name: "alias without effort", request: ports.AgentConfig{Model: "opus[1m]"}, wantModel: "opus[1m]"},
		{name: "haiku without effort", request: ports.AgentConfig{Model: "haiku"}, wantModel: "haiku"},
		{name: "model and effort inherited from the role", project: roleProject, wantModel: "sonnet", wantEffort: "high"},
		{name: "inherited effort kept for a model that accepts it", project: roleProject, request: ports.AgentConfig{Model: "opus"}, wantModel: "opus", wantEffort: "high"},
		{name: "inherited effort dropped for haiku", project: roleProject, request: ports.AgentConfig{Model: "haiku"}, wantModel: "haiku"},
	} {
		got, err := resolveClaudeTUI(m, tc.project, tc.request)
		if err != nil {
			t.Fatalf("%s: error = %v", tc.name, err)
		}
		if got.Model != tc.wantModel || got.Effort != tc.wantEffort {
			t.Fatalf("%s: resolved model/effort = %q/%q, want %q/%q", tc.name, got.Model, got.Effort, tc.wantModel, tc.wantEffort)
		}
	}

	_, err := resolveClaudeTUI(m, domain.ProjectConfig{}, ports.AgentConfig{Model: "haiku", Effort: "high"})
	if !errors.Is(err, ports.ErrUnsupportedEffort) || !strings.Contains(err.Error(), `model "haiku" (supported: none)`) {
		t.Fatalf("haiku effort error = %v, want ErrUnsupportedEffort naming the model and (supported: none)", err)
	}
	_, err = resolveClaudeTUI(m, domain.ProjectConfig{}, ports.AgentConfig{Model: "sonnet", Effort: "ultra"})
	if !errors.Is(err, ports.ErrUnsupportedEffort) || !strings.Contains(err.Error(), "(supported: low, medium, high, xhigh, max)") {
		t.Fatalf("unknown level error = %v, want ErrUnsupportedEffort listing the supported levels", err)
	}
	_, err = resolveClaudeTUI(m, roleProject, ports.AgentConfig{Effort: "ultra"})
	if !errors.Is(err, ports.ErrUnsupportedEffort) {
		t.Fatalf("unknown level on an inherited model error = %v, want ErrUnsupportedEffort", err)
	}

	for _, request := range []ports.AgentConfig{
		{Model: "claude-opus-5-5", Effort: "high"},
		{Model: "provider/model-vNext"},
	} {
		_, err = resolveClaudeTUI(m, domain.ProjectConfig{}, request)
		if !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) {
			t.Fatalf("model %q error = %v, want ErrModelCapabilitiesUnavailable", request.Model, err)
		}
		if !strings.Contains(err.Error(), "sonnet, fable, opus, haiku, opus[1m]") {
			t.Fatalf("model %q error = %q, want it to list the models the table can validate", request.Model, err)
		}
	}
}

func TestResolveClaudeFallbackEffortWithoutModelUsesTheConfiguredDefault(t *testing.T) {
	request := ports.AgentConfig{Effort: "high"}

	got, err := resolveClaudeTUI(&Manager{modelCatalog: staleClaudeCatalog("opus")}, domain.ProjectConfig{}, request)
	if err != nil || got.Effort != "high" {
		t.Fatalf("configured alias default: resolved = %#v, %v; want effort high", got, err)
	}

	// A configured default that takes no effort must not let the effort through
	// for the CLI to drop silently.
	_, err = resolveClaudeTUI(&Manager{modelCatalog: staleClaudeCatalog("haiku")}, domain.ProjectConfig{}, request)
	if !errors.Is(err, ports.ErrUnsupportedEffort) || !strings.Contains(err.Error(), `model "haiku" (supported: none)`) {
		t.Fatalf("haiku default error = %v, want ErrUnsupportedEffort for haiku", err)
	}

	// No configured default: the model Claude would pick is unknown.
	_, err = resolveClaudeTUI(&Manager{modelCatalog: staleClaudeCatalog("")}, domain.ProjectConfig{}, request)
	if !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) || !strings.Contains(err.Error(), "no model is selected") {
		t.Fatalf("no default error = %v, want ErrModelCapabilitiesUnavailable naming the missing model", err)
	}
}

func TestResolveClaudeFallbackFailsClosedForConfiguredProviderModels(t *testing.T) {
	// A custom or gateway model in the stale catalog means the provider decides
	// what each model accepts; the alias table says nothing about it.
	for name, catalog := range map[string]tuningCatalog{
		"configured custom default": staleClaudeCatalog("claude-opus-4-6", "claude-opus-4-6"),
		"gateway model listed":      staleClaudeCatalog("", "provider/model-vNext"),
		"retained provider catalog": staleClaudeCatalog("", "claude-sonnet-5-5-20260301"),
	} {
		t.Run(name, func(t *testing.T) {
			m := &Manager{modelCatalog: catalog}
			for _, request := range []ports.AgentConfig{
				{Model: "opus", Effort: "xhigh"},
				{Model: "opus"},
				{Effort: "high"},
			} {
				_, err := resolveClaudeTUI(m, domain.ProjectConfig{}, request)
				if !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) || !strings.Contains(err.Error(), "which is not a built-in alias") {
					t.Fatalf("request %+v error = %v, want ErrModelCapabilitiesUnavailable naming the non-alias model", request, err)
				}
			}
		})
	}
}

func TestResolveClaudeFallbackOnlyAppliesToAStaleCatalog(t *testing.T) {
	request := ports.AgentConfig{Model: "sonnet", Effort: "high"}

	// No catalog service and a failed discovery stay fail-closed.
	for name, m := range map[string]*Manager{
		"no catalog service": {},
		"discovery error":    {modelCatalog: tuningCatalog{err: errors.New("no credential could be resolved for this provider")}},
	} {
		if _, err := resolveClaudeTUI(m, domain.ProjectConfig{}, request); !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) {
			t.Fatalf("%s: error = %v, want ErrModelCapabilitiesUnavailable", name, err)
		}
	}

	// A live catalog is authoritative: its levels and its model list win.
	live := &Manager{modelCatalog: tuningCatalog{catalog: ports.AgentModelCatalog{Models: []ports.AgentModelInfo{
		{ID: "sonnet", Efforts: []string{"low"}},
	}}}}
	_, err := resolveClaudeTUI(live, domain.ProjectConfig{}, request)
	if !errors.Is(err, ports.ErrUnsupportedEffort) || !strings.Contains(err.Error(), "(supported: low)") {
		t.Fatalf("live catalog error = %v, want the live catalog's levels, not the fallback table's", err)
	}
	_, err = resolveClaudeTUI(live, domain.ProjectConfig{}, ports.AgentConfig{Model: "opus"})
	if !errors.Is(err, ErrUnsupportedModel) {
		t.Fatalf("live catalog error = %v, want ErrUnsupportedModel", err)
	}

	// Codex has no table: a stale catalog still fails closed.
	codex := &Manager{modelCatalog: tuningCatalog{catalog: ports.AgentModelCatalog{
		Stale: true, Models: []ports.AgentModelInfo{{ID: "gpt-5", Efforts: []string{"high"}}},
	}}}
	_, err = codex.resolveAgentConfig(context.Background(), ports.SpawnConfig{
		ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		AgentConfig: ports.AgentConfig{Model: "gpt-5", Effort: "high"},
	}, domain.ProjectConfig{})
	if !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) {
		t.Fatalf("codex stale catalog error = %v, want ErrModelCapabilitiesUnavailable", err)
	}
}

func TestSpawn_ClaudeTUIUsesFallbackTableWhenCatalogIsStale(t *testing.T) {
	m, st, _, _, agent := newSpawnEffortFixture(t, domain.ProjectConfig{})
	m.modelCatalog = staleClaudeCatalog("")
	rec, _, _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		RequestedMode: domain.SessionModeTUI, AgentConfig: ports.AgentConfig{Model: "opus", Effort: "high"},
	})
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	if got := agent.lastLaunch.Config; got.Model != "opus" || got.Effort != "high" {
		t.Fatalf("adapter model/effort = %q/%q, want opus/high", got.Model, got.Effort)
	}
	if got := rec.Metadata; got.Model != "opus" || got.Effort != "high" {
		t.Fatalf("returned metadata model/effort = %q/%q, want opus/high", got.Model, got.Effort)
	}
	if got := st.sessions[rec.ID].Metadata; got.Model != "opus" || got.Effort != "high" {
		t.Fatalf("persisted metadata model/effort = %q/%q, want opus/high", got.Model, got.Effort)
	}

	rejected, rejectedStore, rejectedRuntime, rejectedWorkspace, _ := newSpawnEffortFixture(t, domain.ProjectConfig{})
	rejected.modelCatalog = staleClaudeCatalog("")
	for _, request := range []ports.AgentConfig{
		{Model: "haiku", Effort: "high"},
		{Model: "claude-opus-5-5"},
		{Effort: "high"},
	} {
		_, _, _, err = rejected.Spawn(ctx, ports.SpawnConfig{
			ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
			RequestedMode: domain.SessionModeTUI, AgentConfig: request,
		})
		if !errors.Is(err, ports.ErrUnsupportedEffort) && !errors.Is(err, ports.ErrModelCapabilitiesUnavailable) {
			t.Fatalf("Spawn(%+v) error = %v, want a capability error", request, err)
		}
	}
	if len(rejectedStore.sessions) != 0 || rejectedWorkspace.createCount != 0 || rejectedRuntime.created != 0 {
		t.Fatalf("rejected spawns created state: sessions=%d workspaces=%d runtimes=%d", len(rejectedStore.sessions), rejectedWorkspace.createCount, rejectedRuntime.created)
	}
}
