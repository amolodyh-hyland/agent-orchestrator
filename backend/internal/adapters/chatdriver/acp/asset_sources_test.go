package acp

import (
	"context"
	"log/slog"
	"reflect"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestClaudeAssetSourcesUseNativeAdditionalDirectories(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "start", true: "resume"}[resume], func(t *testing.T) {
			agent := &fakeAgent{promptNoPermission: true, capabilities: &acpsdk.AgentCapabilities{
				SessionCapabilities: acpsdk.SessionCapabilities{Resume: &acpsdk.SessionResumeCapabilities{}, AdditionalDirectories: &acpsdk.SessionAdditionalDirectoriesCapabilities{}},
			}}
			driver := New(Config{Harness: domain.HarnessClaudeCode, Launch: func(context.Context, LaunchConfig) (Launch, error) { return Launch{Command: "fake"}, nil }}, slog.New(slog.DiscardHandler))
			driver.useTestProcess(fakeSpawn(agent))
			source := t.TempDir()
			env := map[string]string{}
			agentassets.SetEnv(env, []string{source})
			var conv ports.ChatConversation
			var err error
			if resume {
				conv, err = driver.Resume(context.Background(), ports.ChatResumeConfig{WorkspacePath: t.TempDir(), Env: env, ProviderConversationID: "session-1"})
			} else {
				conv, err = driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir(), Env: env})
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = conv.Close() }()
			agent.mu.Lock()
			defer agent.mu.Unlock()
			if !resume && !reflect.DeepEqual(agent.newParams.AdditionalDirectories, []string{source}) {
				t.Fatalf("native directories=%v", agent.newParams.AdditionalDirectories)
			}
			if resume && !reflect.DeepEqual(agent.resumeParams.AdditionalDirectories, []string{source}) {
				t.Fatalf("native resume directories=%v", agent.resumeParams.AdditionalDirectories)
			}
		})
	}
}
