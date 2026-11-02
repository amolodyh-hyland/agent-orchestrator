package codexappserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestNativeAssetSkillsOnStartAndResume(t *testing.T) {
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "start", true: "resume"}[resume], func(t *testing.T) {
			root := t.TempDir()
			skills := filepath.Join(root, ".agents", "skills")
			if err := os.MkdirAll(skills, 0o750); err != nil {
				t.Fatal(err)
			}
			env := map[string]string{}
			agentassets.SetEnv(env, []string{root})
			d, srv := newTestDriver(t)
			srv.respondTo("skills/extraRoots/set", `{}`)
			var conv ports.ChatConversation
			var err error
			if resume {
				conv, err = d.Resume(context.Background(), ports.ChatResumeConfig{WorkspacePath: t.TempDir(), Env: env, ProviderConversationID: "thread-1"})
			} else {
				conv, err = d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir(), Env: env})
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = conv.Close() }()
			f := srv.awaitFrame(func(f frame) bool { return f.Method == "skills/extraRoots/set" })
			var params struct {
				ExtraRoots []string `json:"extraRoots"`
			}
			if err := json.Unmarshal(f.Params, &params); err != nil || !reflect.DeepEqual(params.ExtraRoots, []string{skills}) {
				t.Fatalf("skill root request=%s err=%v", f.Params, err)
			}
		})
	}
}

func TestNativeAssetSkillsReportsUnsupportedProvider(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".agents", "skills"), 0o750); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	agentassets.SetEnv(env, []string{root})
	driver, server := newTestDriver(t)
	server.replyError("skills/extraRoots/set", -32601, "method not found")
	_, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir(), Env: env})
	if err == nil || !strings.Contains(err.Error(), "requires Codex skills/extraRoots/set support") {
		t.Fatalf("unsupported native API error=%v", err)
	}
}
