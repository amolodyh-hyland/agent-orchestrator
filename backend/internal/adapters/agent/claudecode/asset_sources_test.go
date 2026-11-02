package claudecode

import (
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
)

func TestAssetLaunchArgumentsPreserveNativeLaunchAndResume(t *testing.T) {
	for _, argv := range [][]string{{"claude", "--session-id", "id", "--", "task"}, {"claude", "--resume", "id"}} {
		env := map[string]string{}
		agentassets.SetEnv(env, []string{"/live source/.claude", "/live source/.agents"})
		got := (&Plugin{}).ApplyAssetSources(argv, env)
		want := append([]string{"claude", "--add-dir", "/live source"}, argv[1:]...)
		if !reflect.DeepEqual(got, want) || env[agentassets.ClaudeInstructionsEnv] != "1" {
			t.Fatalf("argv=%v env=%v", got, env)
		}
	}
}
