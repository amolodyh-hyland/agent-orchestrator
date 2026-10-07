package cli

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

func TestRootRegistersHiddenMulticaHostAndFlagOffExits78(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(multicahost.FlagEnv, "")

	var stderr bytes.Buffer
	root := NewRootCommand(Deps{Err: &stderr})
	var hostCommandFound bool
	for _, cmd := range root.Commands() {
		if cmd.Name() == multicahost.HostCommand {
			hostCommandFound = true
			if !cmd.Hidden {
				t.Fatal("Multica host command is visible")
			}
			if cmd.Flags().Lookup("watch-stdin") == nil {
				t.Fatal("Multica host command is missing --watch-stdin")
			}
		}
	}
	if !hostCommandFound {
		t.Fatalf("root is missing command %q", multicahost.HostCommand)
	}

	root.SetArgs([]string{multicahost.HostCommand})
	err := root.Execute()
	if got := ExitCode(err); got != multicahost.ExitConfig {
		t.Fatalf("ExitCode(%v) = %d, want %d", err, got, multicahost.ExitConfig)
	}
	if err == nil || !strings.Contains(err.Error(), "hosting is disabled") {
		t.Fatalf("error = %v, want disabled host message", err)
	}
	if strings.ContainsAny(err.Error(), "\r\n") {
		t.Fatalf("disabled message is not one line: %q", err)
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("flag-off command created files: %v", entries)
	}
}
