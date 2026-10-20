package modelcatalog

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentcreds"
)

func TestMain(m *testing.M) {
	defaultClaudeModelPolicy = func(ctx context.Context, request ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy {
		return agentcreds.ResolveClaudeModelPolicy(ctx, request.WorkingDir, request.Env, agentcreds.ResolveOptions{
			ManagedSettingsDir: filepath.Join(os.Getenv("HOME"), "test-managed-policy"), GOOS: "linux",
		})
	}
	os.Exit(m.Run())
}

func TestClaudeCatalogFiltersBothSourcesAndConfiguredDefaults(t *testing.T) {
	for _, provider := range []bool{false, true} {
		for _, allowed := range [][]string{{"sonnet"}, {}} {
			request := claudeRequest(t)
			request.Env["ANTHROPIC_MODEL"] = "opus"
			policy := func(context.Context, ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy {
				return agentcreds.ClaudeModelPolicy{Available: allowed}
			}
			list := func(context.Context, ports.AgentModelDiscoveryRequest) ([]ports.AgentModelInfo, error) {
				if !provider {
					return nil, errors.New("no exported credential")
				}
				return []ports.AgentModelInfo{{ID: "sonnet"}, {ID: "opus"}, {ID: "haiku"}, {ID: "claude-sonnet-4-5"}}, nil
			}
			catalog, err := discoverClaudeCatalog(context.Background(), request, list, policy)
			if (err == nil) != provider {
				t.Fatalf("provider=%v, err=%v", provider, err)
			}
			ids := []string{}
			for _, model := range catalog.Models {
				ids = append(ids, model.ID)
				if model.IsDefault {
					t.Fatal("blocked configured default was reintroduced")
				}
			}
			want := []string{}
			if len(allowed) > 0 {
				want = []string{"sonnet"}
				if provider {
					want = append(want, "claude-sonnet-4-5")
				}
			}
			slices.Sort(ids)
			slices.Sort(want)
			if !reflect.DeepEqual(ids, want) {
				t.Fatalf("provider=%v allowed=%v choices=%v want=%v", provider, allowed, ids, want)
			}
		}
	}
}

func TestClaudeCatalogPolicyFingerprintUsesEffectivePolicy(t *testing.T) {
	request := claudeRequest(t)
	policy := agentcreds.ClaudeModelPolicy{Available: []string{"sonnet"}}
	discoverer := Discoverer{ClaudePolicy: func(context.Context, ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy { return policy }}
	first := discoverer.CatalogFingerprint(context.Background(), request)
	policy.Available = []string{"opus"}
	if first == discoverer.CatalogFingerprint(context.Background(), request) {
		t.Fatal("policy change retained prior catalog identity")
	}
	second := discoverer.CatalogFingerprint(context.Background(), request)
	policy.Available = []string{}
	if second == discoverer.CatalogFingerprint(context.Background(), request) {
		t.Fatal("empty restriction retained prior catalog identity")
	}
}

func TestClaudeCatalogWithholdsUnresolvedPolicy(t *testing.T) {
	catalog, err := discoverClaudeCatalog(context.Background(), claudeRequest(t), func(context.Context, ports.AgentModelDiscoveryRequest) ([]ports.AgentModelInfo, error) {
		t.Fatal("unresolved policy must not fetch or offer unchecked models")
		return nil, nil
	}, func(context.Context, ports.AgentModelDiscoveryRequest) agentcreds.ClaudeModelPolicy {
		return agentcreds.ClaudeModelPolicy{Unresolved: true}
	})
	if err == nil || len(catalog.Models) != 0 {
		t.Fatal("unresolved policy did not withhold named models with a warning")
	}
}
