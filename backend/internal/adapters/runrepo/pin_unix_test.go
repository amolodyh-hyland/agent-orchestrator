//go:build !windows

package runrepo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedRepositoryCannotBeRedirectedBeforeExec(t *testing.T) {
	path, head := repoFixture(t)
	outside, _ := repoFixture(t)
	fixtureGit(t, outside, "commit", "--allow-empty", "-m", "external repository")
	if fixtureGit(t, outside, "rev-parse", "HEAD") == head {
		t.Fatal("outside fixture must have a different identity")
	}
	root, clean, err := openOwned(path)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	cmd := exec.Command("git", append(append(inspectionOptions(), "-C", clean), "rev-parse", "--verify", "HEAD^{commit}")...)
	cmd.Env = inspectionEnv()
	release, err := pinCommand(cmd, root, clean)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	moved := filepath.Join(t.TempDir(), "pinned")
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(output)) != head {
		t.Fatal("Git followed replacement root")
	}
	if _, err := (Reader{}).Inspect(context.Background(), path, path, head); err == nil {
		t.Fatal("subsequent inspection accepted replacement symlink")
	}
}
