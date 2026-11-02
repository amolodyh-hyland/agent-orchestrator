package sessionmanager

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type assetDefaults struct{ sources []string }

func (d assetDefaults) DefaultSessionMode(context.Context) domain.SessionMode {
	return domain.SessionModeTUI
}

func TestAgentAssetLaunchMappingPreservesReservedGeneration(t *testing.T) {
	for _, tc := range []struct {
		name  string
		agent ports.Agent
		argv  []string
		want  []string
	}{
		{"claude", claudecode.New(), []string{"claude", "--resume", "native"}, []string{"claude", "--add-dir", "/live", "--resume", "native"}},
		{"codex", codex.New(), []string{"codex", "resume", "native"}, []string{"codex", "resume", "native"}},
	} {
		for _, supervised := range []bool{false, true} {
			t.Run(tc.name+map[bool]string{false: "/native", true: "/supervised"}[supervised], func(t *testing.T) {
				m := New(Deps{Executable: func() (string, error) { return "/ao", nil }})
				env := map[string]string{}
				agentassets.SetEnv(env, []string{"/live/.claude", "/live/.agents"})
				argv, err := m.wrapAgentProcessWithLaunchID(tc.agent, "session", env, tc.argv, "reserved-target", supervised)
				if err != nil {
					t.Fatal(err)
				}
				start := slices.Index(argv, tc.argv[0])
				if start < 0 || !reflect.DeepEqual(argv[start:], tc.want) {
					t.Fatalf("native launch argv=%v want suffix %v", argv, tc.want)
				}
				if env[EnvRuntimeLaunchID] != "reserved-target" || supervised && env[EnvSupervisedProcess] != "1" {
					t.Fatalf("reserved launch env=%v", env)
				}
				if tc.name == "claude" && env[agentassets.ClaudeInstructionsEnv] != "1" {
					t.Fatal("Claude extra instructions were not enabled")
				}
			})
		}
	}
}
func (d assetDefaults) AgentAssetSources(context.Context) ([]string, error) { return d.sources, nil }

func TestAgentAssetEnvResolvesGlobalAndProjectSources(t *testing.T) {
	global := t.TempDir()
	projectRoot := t.TempDir()
	for _, tc := range []struct {
		name     string
		override *[]string
		want     []string
	}{
		{"inherit", nil, []string{global}},
		{"disable", new([]string{}), nil},
		{"replace", new([]string{projectRoot}), []string{projectRoot}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.projects["project"] = domain.ProjectRecord{ID: "project", Path: projectRoot, Config: domain.ProjectConfig{AgentAssetSources: tc.override}}
			m := New(Deps{Store: store, Defaults: assetDefaults{[]string{global}}})
			env := map[string]string{}
			if err := m.agentAssetEnv(context.Background(), "project", env); err != nil {
				t.Fatal(err)
			}
			got := agentassets.FromEnv(env)
			if len(got) != len(tc.want) || len(got) > 0 && !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
