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

func TestRawExecutableModeChangeRemainsDirty(t *testing.T) {
	path, base := repoFixture(t)
	if err := os.Chmod(filepath.Join(path, "source.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	facts, err := (Reader{}).Inspect(context.Background(), path, path, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(facts.Unstaged) != 1 || facts.Unstaged[0] != "source.txt" {
		t.Fatal("executable mode change was hidden", facts)
	}
}

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
	view, err := newGitView(context.Background(), clean, clean, root, head)
	if err != nil {
		t.Fatal(err)
	}
	defer view.close()
	cmd := exec.Command("git", append(append(inspectionOptions(), "-C", clean), "rev-parse", "--verify", "HEAD^{commit}")...)
	cmd.Env = inspectionEnv(view.directory)
	release, err := pinCommand(cmd, root, clean, view.directory)
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
