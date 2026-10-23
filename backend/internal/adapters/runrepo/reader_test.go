package runrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func fixtureGit(t *testing.T, path string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + os.DevNull, "-C", path}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}
func repoFixture(t *testing.T) (string, string) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	path := t.TempDir()
	fixtureGit(t, path, "init", "-b", "main")
	fixtureGit(t, path, "config", "user.name", "Fixture")
	fixtureGit(t, path, "config", "user.email", "fixture@example.invalid")
	if err := os.WriteFile(filepath.Join(path, "source.txt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, path, "add", ".")
	fixtureGit(t, path, "commit", "-m", "base")
	return path, fixtureGit(t, path, "rev-parse", "HEAD")
}
func TestRawInspectionNeverExecutesFilters(t *testing.T) {
	path, base := repoFixture(t)
	ctx := context.Background()
	if _, err := (Reader{}).Inspect(ctx, path, path, base); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "executed")
	driver := "touch '" + marker + "'; printf original"
	for _, key := range []string{"filter.evil.clean", "filter.evil.process", "diff.evil.textconv", "diff.evil.command", "core.fsmonitor"} {
		fixtureGit(t, path, "config", key, driver)
	}
	if err := os.WriteFile(filepath.Join(path, ".gitattributes"), []byte("source.txt filter=evil diff=evil\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "source.txt"), []byte("hidden dirty bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	facts, err := (Reader{}).Inspect(ctx, path, path, base)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(facts.Unstaged, ","), "source.txt") {
		t.Fatal("raw changes hidden by filter", facts)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("repository program executed: %v", err)
	}
}
func TestOwnedRootSymlinksAreRejected(t *testing.T) {
	path, base := repoFixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][2]string{{alias, path}, {path, alias}, {alias, alias}} {
		if _, err := (Reader{}).Inspect(context.Background(), paths[0], paths[1], base); err == nil {
			t.Fatal("accepted symlinked source root")
		}
	}
	sum := sha256.Sum256([]byte("original"))
	if err := (Reader{}).VerifyArtifact(context.Background(), alias, domain.RunArtifact{Path: "source.txt", Digest: hex.EncodeToString(sum[:])}); err == nil {
		t.Fatal("accepted symlinked artifact root")
	}
}

func TestObservationLimitsFailClosed(t *testing.T) {
	var output boundedBuffer
	if _, err := output.Write(make([]byte, maxObservation)); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("x")); err == nil || output.Len() != maxObservation {
		t.Fatal("unbounded process output")
	}
	path, base := repoFixture(t)
	file, err := os.OpenFile(filepath.Join(path, "source.txt"), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(maxFile + 1)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (Reader{}).Inspect(context.Background(), path, path, base); err == nil {
		t.Fatal("oversized source admitted")
	}
	if safeInspectionArgs([]string{"status", "--porcelain"}) || safeInspectionArgs([]string{"diff-tree", "--ext-diff"}) {
		t.Fatal("executable worktree commands allowed")
	}
}

func TestArtifactRootReplacementCannotEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	for _, dir := range []string{root, outside} {
		if err := os.WriteFile(filepath.Join(dir, "proof"), []byte("identical"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	sum := sha256.Sum256([]byte("identical"))
	artifact := domain.RunArtifact{Path: "proof", Digest: hex.EncodeToString(sum[:])}
	reader := Reader{}
	if err := reader.VerifyArtifact(context.Background(), root, artifact); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(t.TempDir(), "previous-root")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	if err := reader.VerifyArtifact(context.Background(), root, artifact); err == nil {
		t.Fatal("replacement artifact root followed outside, despite matching digest")
	}
}
