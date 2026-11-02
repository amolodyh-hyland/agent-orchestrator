package agentassets

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNativeSourceMappings(t *testing.T) {
	root := t.TempDir()
	for _, folder := range []string{".claude", ".agents/skills"} {
		if err := os.MkdirAll(filepath.Join(root, folder), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	env := map[string]string{}
	SetEnv(env, []string{root, filepath.Join(root, ".claude"), filepath.Join(root, ".agents")})
	if got := ClaudeRoots(env); !reflect.DeepEqual(got, []string{root}) {
		t.Fatalf("Claude roots = %v", got)
	}
	if got, err := CodexSkillRoots(context.Background(), env); err != nil || !reflect.DeepEqual(got, []string{filepath.Join(root, ".agents", "skills")}) {
		t.Fatalf("Codex skill roots = %v, err=%v", got, err)
	}
	argv := []string{"claude", "--resume", "native-id", "--", "-a task"}
	want := []string{"claude", "--add-dir", root, "--resume", "native-id", "--", "-a task"}
	if got := ClaudeCommand(argv, env); !reflect.DeepEqual(got, want) || env[ClaudeInstructionsEnv] != "1" {
		t.Fatalf("Claude launch = %v, env=%v", got, env)
	}
	if !reflect.DeepEqual(argv, []string{"claude", "--resume", "native-id", "--", "-a task"}) {
		t.Fatal("mutated caller argv")
	}
}

func TestResolveSkipsMissingAndDoesNotWriteAssets(t *testing.T) {
	root := t.TempDir()
	asset := filepath.Join(root, ".claude")
	if err := os.Mkdir(asset, 0o750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(asset, "CLAUDE.md")
	if err := os.WriteFile(path, []byte("live instructions"), 0o640); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		var warnings []string
		got, err := Resolve(context.Background(), root, []string{".claude", "missing", asset}, func(message string) { warnings = append(warnings, message) })
		if err != nil || !reflect.DeepEqual(got, []string{asset}) || len(warnings) != 1 {
			t.Fatalf("resolved=%v warnings=%v err=%v", got, warnings, err)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "live instructions" {
			t.Fatal("source was changed")
		}
	}
	for _, invalid := range []string{"../outside", "", "bad\npath"} {
		if _, err := Resolve(context.Background(), root, []string{invalid}, func(string) {}); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
	if got, err := Resolve(context.Background(), root, []string{"."}, func(string) {}); err != nil || !reflect.DeepEqual(got, []string{root}) {
		t.Fatalf("project root source=%v err=%v", got, err)
	}
}
