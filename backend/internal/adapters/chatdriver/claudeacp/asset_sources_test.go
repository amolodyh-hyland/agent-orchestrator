package claudeacp

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
)

func TestAssetSourcesEnableNativeAddedDirectoryInstructions(t *testing.T) {
	input := map[string]string{}
	agentassets.SetEnv(input, []string{"/live/.claude"})
	env := claudeACPLaunchEnv(input, "/bin/claude", "", nil)
	if env[agentassets.ClaudeInstructionsEnv] != "1" || input[agentassets.ClaudeInstructionsEnv] != "" {
		t.Fatalf("launch env=%v, input=%v", env, input)
	}
}
