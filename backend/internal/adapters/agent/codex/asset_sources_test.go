package codex

import (
	"context"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestTerminalAssetSourcesDoNotGrantUnrequestedWriteAccess(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "codex"}
	cfg := ports.LaunchConfig{WorkspacePath: canonicalTempDir(t), Prompt: "task", Permissions: ports.PermissionModeDefault}
	base, err := plugin.GetLaunchCommand(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Env = map[string]string{}
	agentassets.SetEnv(cfg.Env, []string{"/live/.agents"})
	withSources, err := plugin.GetLaunchCommand(context.Background(), cfg)
	if err != nil || !reflect.DeepEqual(withSources, base) {
		t.Fatalf("unsupported extra sources changed terminal launch: %v, err=%v", withSources, err)
	}
}
