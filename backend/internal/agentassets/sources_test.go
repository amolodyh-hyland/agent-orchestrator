package agentassets

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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
	if got, err := CodexSkillRoots(context.Background(), env, func(message string) { t.Error(message) }); err != nil || !reflect.DeepEqual(got, []string{filepath.Join(root, ".agents", "skills")}) {
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

func TestUnreadableAssetSourcesWarnAndContinue(t *testing.T) {
	for _, harness := range []string{"claude", "codex"} {
		t.Run(harness, func(t *testing.T) {
			root := t.TempDir()
			blocked := filepath.Join(root, "blocked")
			healthy := filepath.Join(root, "healthy")
			for _, path := range []string{blocked, healthy} {
				if err := os.MkdirAll(path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			blockedSource, healthySource := blocked, healthy
			if harness == "codex" {
				blockedSource = filepath.Join(blocked, ".agents", "skills")
				healthySource = filepath.Join(healthy, ".agents", "skills")
				for _, path := range []string{blockedSource, healthySource} {
					if err := os.MkdirAll(path, 0o700); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := os.Chmod(blockedSource, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.Chmod(blockedSource, 0o700); err != nil {
					t.Error(err)
				}
			})
			probe, err := os.Open(blockedSource)
			if err == nil {
				_, err = probe.ReadDir(1)
				if closeErr := probe.Close(); closeErr != nil {
					t.Fatal(closeErr)
				}
			}
			if !os.IsPermission(err) {
				t.Skipf("directory permission denial is not enforced on this host: %v", err)
			}
			var warnings []string
			warn := func(message string) { warnings = append(warnings, message) }
			var got []string
			if harness == "codex" {
				env := map[string]string{}
				SetEnv(env, []string{blocked, healthy})
				got, err = CodexSkillRoots(context.Background(), env, warn)
			} else {
				got, err = Resolve(context.Background(), root, []string{blocked, healthy}, warn)
			}
			if err != nil || !reflect.DeepEqual(got, []string{healthySource}) || len(warnings) != 1 || !strings.Contains(warnings[0], blockedSource) || !strings.Contains(warnings[0], "unreadable") {
				t.Fatalf("roots=%v warnings=%v err=%v", got, warnings, err)
			}
		})
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
