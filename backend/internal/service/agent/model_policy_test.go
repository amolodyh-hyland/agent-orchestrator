package agent

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/modelcatalog"
	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentcreds"
)

func testNoClaudeModelPolicy(context.Context, ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy {
	return agentcreds.ClaudeModelPolicy{}
}

func TestClaudePolicyChangeCannotReuseCachedChoices(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("ANTHROPIC_MODEL", "")
	var policy atomic.Value
	policy.Store(agentcreds.ClaudeModelPolicy{Available: []string{"sonnet"}})
	var offline atomic.Bool
	discoverer := modelcatalog.Discoverer{
		ClaudePolicy: func(context.Context, ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy {
			return policy.Load().(agentcreds.ClaudeModelPolicy)
		},
		ClaudeModels: func(context.Context, ports.AgentModelDiscoveryRequest) ([]ports.AgentModelInfo, error) {
			if offline.Load() {
				return nil, errors.New("offline fixture")
			}
			return []ports.AgentModelInfo{{ID: "sonnet"}, {ID: "opus"}}, nil
		},
	}
	svc := newService([]agentregistry.HarnessAgent{harnessAgent("claude-code", "Claude Code", nil)}, &fakeModelCache{}, nil, discoverer)
	first, err := svc.Models(context.Background(), "claude-code", "", true)
	if err != nil || len(first.Models) != 1 || first.Models[0].ID != "sonnet" {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	policy.Store(agentcreds.ClaudeModelPolicy{Available: []string{"opus"}})
	offline.Store(true)
	next, err := svc.Models(context.Background(), "claude-code", "", true)
	if err != nil || len(next.Models) != 2 || next.Models[0].ID != "opus" || next.Source != "built-in" {
		t.Fatalf("changed policy must replace cached sonnet: %+v err=%v", next, err)
	}
	for _, model := range next.Models {
		if model.ID != "opus" && model.ID != "opus[1m]" {
			t.Fatalf("excluded cached choice: %+v", model)
		}
	}
	policy.Store(agentcreds.ClaudeModelPolicy{Available: []string{}})
	empty, err := svc.Models(context.Background(), "claude-code", "", true)
	if err != nil || len(empty.Models) != 0 {
		t.Fatalf("empty policy retained choices: %+v err=%v", empty, err)
	}
}
