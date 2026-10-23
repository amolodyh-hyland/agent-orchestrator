package runrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func fixtureGit(t *testing.T, path string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "gc.auto=0", "-c", "gc.autoDetach=false", "-c", "maintenance.auto=false", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + os.DevNull, "-C", path}, args...)...)
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

func TestInspectionNeverLoadsOriginalConfig(t *testing.T) {
	for _, mode := range []string{"outward symlink", "absolute include", "conditional include", "worktree config"} {
		t.Run(mode, func(t *testing.T) {
			path, base := repoFixture(t)
			reader := Reader{}
			before, err := reader.Inspect(context.Background(), path, path, base)
			if err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "poison-config")
			// Any Git config read of this file fails. A successful observation proves
			// that the original symlink/include was not followed, even for parsing.
			poison := []byte("[invalid config which must never be parsed\n")
			if err := os.WriteFile(outside, poison, 0600); err != nil {
				t.Fatal(err)
			}
			config := filepath.Join(path, ".git", "config")
			data, err := os.ReadFile(config)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "outward symlink":
				if err := os.Remove(config); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, config); err != nil {
					t.Fatal(err)
				}
			case "absolute include":
				data = append(data, []byte("\n[include]\npath = "+outside+"\n")...)
				if err := os.WriteFile(config, data, 0600); err != nil {
					t.Fatal(err)
				}
			case "conditional include":
				data = append(data, []byte("\n[includeIf \"onbranch:main\"]\npath = "+outside+"\n")...)
				if err := os.WriteFile(config, data, 0600); err != nil {
					t.Fatal(err)
				}
			case "worktree config":
				data = append(data, []byte("\n[extensions]\nworktreeConfig = true\n")...)
				if err := os.WriteFile(config, data, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(path, ".git", "config.worktree")); err != nil {
					t.Fatal(err)
				}
			}
			after, err := reader.Inspect(context.Background(), path, path, base)
			if err != nil {
				t.Fatalf("inspection loaded original config: %v", err)
			}
			if after.Fingerprint != before.Fingerprint || after.HeadSHA != base {
				t.Fatal("original config affected owned source facts")
			}
			untouched, err := os.ReadFile(outside)
			if err != nil || string(untouched) != string(poison) {
				t.Fatal("external config changed", err)
			}
		})
	}
}

func TestTenThousandFilesUseCompactIndexDigest(t *testing.T) {
	path, _ := repoFixture(t)
	paths := make([]string, 10000)
	for i := range paths {
		paths[i] = fmt.Sprintf("packages/feature-%03d/implementation/source-%05d.fixture.txt", i/100, i)
		if err := os.MkdirAll(filepath.Dir(filepath.Join(path, paths[i])), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, paths[i]), fmt.Appendf(nil, "unique source %d\n", i), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, path, "add", "--all")
	fixtureGit(t, path, "commit", "-m", "large repository")
	base := fixtureGit(t, path, "rev-parse", "HEAD")
	if size := len(fixtureGit(t, path, "ls-files", "--stage", "-z")); size <= 1<<20 {
		t.Fatalf("large fixture must exceed the old Git-output limit: %d", size)
	}
	fixtureGit(t, path, "gc", "--prune=now")
	reader := Reader{}
	clean, err := reader.Inspect(context.Background(), path, path, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(clean.ChangedFiles)+len(clean.Staged)+len(clean.Unstaged)+len(clean.Untracked) != 0 {
		t.Fatal("large clean repository falsely dirty", clean)
	}
	encoded, err := json.Marshal(clean)
	if err != nil || len(encoded) > 2048 {
		t.Fatalf("index leaked into facts: %d %v", len(encoded), err)
	}
	again, err := reader.Inspect(context.Background(), path, path, base)
	if err != nil || clean.Fingerprint != again.Fingerprint {
		t.Fatal("temporary view changed fingerprint", err)
	}
	if err := os.WriteFile(filepath.Join(path, paths[0]), []byte("committed candidate"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, path, "commit", "-am", "candidate")
	for _, name := range paths[1:3] {
		if err := os.WriteFile(filepath.Join(path, name), []byte("changed source"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, path, "add", paths[1])
	if err := os.WriteFile(filepath.Join(path, "new-source.txt"), []byte("untracked"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "ignored-source.txt"), []byte("ignored"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, ".git", "info", "exclude"), []byte("ignored-source.txt\n"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := reader.Inspect(context.Background(), path, path, base)
	if err != nil {
		t.Fatal(err)
	}
	if changed.HeadSHA == base || changed.Fingerprint == clean.Fingerprint || !slices.Equal(changed.ChangedFiles, paths[:1]) || !slices.Equal(changed.Staged, paths[1:2]) || !slices.Equal(changed.Unstaged, paths[2:3]) || !slices.Equal(changed.Untracked, []string{"new-source.txt"}) {
		t.Fatal("large repository facts lost changes", changed)
	}
}

func TestMetadataViewChecksOriginalHeadAndIndex(t *testing.T) {
	path, base := repoFixture(t)
	root, clean, err := openOwned(path)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	view, err := newGitView(context.Background(), clean, clean, root, base)
	if err != nil {
		t.Fatal(err)
	}
	defer view.close()
	fixtureGit(t, path, "commit", "--allow-empty", "-m", "moved HEAD")
	if err := view.unchanged(clean, clean, root); err == nil {
		t.Fatal("snapshotted view hid a changed original HEAD")
	}
	directory := view.directory
	view.close()
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("private view was not removed")
	}
	second, err := newGitView(context.Background(), clean, clean, root, base)
	if err != nil {
		t.Fatal(err)
	}
	defer second.close()
	if err := os.WriteFile(filepath.Join(path, "source.txt"), []byte("changed index"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, path, "add", "source.txt")
	if err := second.unchanged(clean, clean, root); err == nil {
		t.Fatal("snapshotted view hid a changed original index")
	}
}

func TestMetadataViewRefusesOutwardReferences(t *testing.T) {
	for _, name := range []string{"index", "refs/heads/main", "objects/foreign", "objects/info/alternates"} {
		t.Run(name, func(t *testing.T) {
			path, base := repoFixture(t)
			outside := filepath.Join(t.TempDir(), "external-file")
			if err := os.WriteFile(outside, []byte(base+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(path, ".git", name)
			if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if name == "objects/info/alternates" {
				if err := os.WriteFile(target, []byte(filepath.Dir(outside)+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Symlink(outside, target); err != nil {
				t.Fatal(err)
			}
			if _, err := (Reader{}).Inspect(context.Background(), path, path, base); err == nil {
				t.Fatal("accepted unowned metadata reference", name)
			}
		})
	}
}

func TestIndexedDirectoryDeletionRemainsDirty(t *testing.T) {
	path, _ := repoFixture(t)
	directory := filepath.Join(path, "tracked")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, path, "add", "--all")
	fixtureGit(t, path, "commit", "-m", "tracked directory")
	base := fixtureGit(t, path, "rev-parse", "HEAD")
	if err := os.RemoveAll(directory); err != nil {
		t.Fatal(err)
	}
	facts, err := (Reader{}).Inspect(context.Background(), path, path, base)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(facts.Unstaged, []string{"tracked/a", "tracked/b"}) {
		t.Fatal("missing indexed directory was hidden", facts)
	}
}
