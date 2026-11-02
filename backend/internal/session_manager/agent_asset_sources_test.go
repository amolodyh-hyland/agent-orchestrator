package sessionmanager

import (
	"context"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type assetDefaults struct{ sources []string }

func (d assetDefaults) DefaultSessionMode(context.Context) domain.SessionMode {
	return domain.SessionModeTUI
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
