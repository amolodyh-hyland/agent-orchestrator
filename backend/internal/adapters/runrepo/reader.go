package runrepo

import (
	"bytes"
	"context"
	"crypto/sha1" //nolint:gosec // Git object format compatibility; evidence digests use SHA-256.
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// Reader observes raw Git objects and file bytes, never worktree conversion drivers.
type Reader struct{}

const maxObservation = 1 << 20
const maxFile = 32 << 20
const maxFiles = 4096

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > maxObservation {
		return 0, errors.New("repository observation exceeds limit")
	}
	return b.Buffer.Write(p)
}

// openOwned anchors every path component beneath the filesystem root, rejecting
// symlinks including the root argument. The system's macOS /var and /tmp aliases
// are resolved explicitly; repository-controlled aliases are never followed.
func openOwned(path string) (*os.Root, string, error) {
	if !filepath.IsAbs(path) {
		return nil, "", errors.New("owned root must be absolute")
	}
	path = filepath.Clean(path)
	if runtime.GOOS == "darwin" {
		for _, alias := range []string{"/var", "/tmp"} {
			if path == alias || strings.HasPrefix(path, alias+"/") {
				path = "/private" + path
				break
			}
		}
	}
	volume := filepath.VolumeName(path)
	base, err := os.OpenRoot(volume + string(filepath.Separator))
	if err != nil {
		return nil, "", err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, volume+string(filepath.Separator)), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		before, e := base.Lstat(part)
		if e != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			_ = base.Close()
			return nil, "", errors.New("owned root contains an unsafe component")
		}
		child, e := base.OpenRoot(part)
		if e != nil {
			_ = base.Close()
			return nil, "", e
		}
		after, e := child.Stat(".")
		_ = base.Close()
		if e != nil || !os.SameFile(before, after) {
			_ = child.Close()
			return nil, "", errors.New("owned root identity changed")
		}
		base = child
	}
	return base, path, nil
}

func inspectionOptions() []string {
	return []string{"--no-pager", "--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=" + os.DevNull}
}
func inspectionEnv() []string {
	out := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			out = append(out, entry)
		}
	}
	return append(out, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_ATTR_NOSYSTEM=1", "GIT_NO_LAZY_FETCH=1", "GIT_ALLOW_PROTOCOL=")
}

// Keep the child trampoline limited to the exact non-converting plumbing used here.
func safeInspectionArgs(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "rev-parse":
		return slices.Equal(args[1:], []string{"--show-toplevel"}) || slices.Equal(args[1:], []string{"--path-format=absolute", "--git-common-dir"}) || slices.Equal(args[1:], []string{"--verify", "HEAD^{commit}"})
	case "symbolic-ref":
		return slices.Equal(args[1:], []string{"--short", "HEAD"})
	case "ls-files":
		return slices.Equal(args[1:], []string{"-v", "-z"}) || slices.Equal(args[1:], []string{"--stage", "-z"}) || slices.Equal(args[1:], []string{"--others", "--exclude-standard", "-z", "--"})
	case "merge-base":
		if len(args) != 4 {
			return false
		}
		return args[1] == "--is-ancestor" && domain.FullCommit(args[2]) && domain.FullCommit(args[3])
	case "diff-tree":
		if len(args) != 11 {
			return false
		}
		return slices.Equal(args[1:8], []string{"--no-commit-id", "-r", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z"}) && domain.FullCommit(args[8]) && domain.FullCommit(args[9]) && args[10] == "--"
	case "diff-index":
		if len(args) != 9 {
			return false
		}
		return slices.Equal(args[1:7], []string{"--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z"}) && domain.FullCommit(args[7]) && args[8] == "--"
	}
	return false
}

func git(ctx context.Context, path string, args ...string) (string, error) {
	if !safeInspectionArgs(args) {
		return "", errors.New("unsupported inspection command")
	}
	root, clean, err := openOwned(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = root.Close() }()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	argv := append(append(inspectionOptions(), "-C", clean), args...)
	cmd := process.CommandContext(ctx, "git", argv...)
	release, err := pinCommand(cmd, root, clean)
	if err != nil {
		return "", err
	}
	defer release()
	cmd.Env = inspectionEnv()
	var output boundedBuffer
	cmd.Stdout = &output
	var stderr boundedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("repository facts unavailable or oversized (%s): %w", args[0], err)
	}
	// Keep the anchor open throughout the command and reject replacement.
	current, e := os.Stat(clean)
	before, e2 := root.Stat(".")
	if e != nil || e2 != nil || !os.SameFile(current, before) {
		return "", errors.New("owned root changed")
	}
	return strings.TrimSuffix(output.String(), "\n"), nil
}

func canonical(path string) (string, error) {
	root, clean, err := openOwned(path)
	if err != nil {
		return "", err
	}
	_ = root.Close()
	return clean, nil
}
func names(value string) []string {
	out := []string{}
	for _, name := range strings.Split(value, "\x00") {
		if name != "" {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// rawFiles compares index entries with anchored raw bytes. Neither Git status nor
// worktree diff is safe here: both may execute repository-defined clean filters.
func rawFiles(root *os.Root, index string, sha256Objects bool) ([]string, error) {
	dirty := []string{}
	total := int64(0)
	entries := names(index)
	if len(entries) > maxFiles {
		return nil, errors.New("too many indexed files")
	}
	for _, entry := range entries {
		header, name, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(header)
		if !ok || len(fields) != 3 || fields[2] != "0" || !filepath.IsLocal(name) {
			return nil, errors.New("unresolved index entry")
		}
		mode, oid := fields[0], fields[1]
		if mode != "100644" && mode != "100755" && mode != "120000" {
			return nil, errors.New("unsupported index mode")
		}
		info, err := root.Lstat(name)
		if os.IsNotExist(err) {
			dirty = append(dirty, name)
			continue
		}
		if err != nil {
			return nil, err
		}
		var data []byte
		if mode == "120000" && info.Mode()&os.ModeSymlink != 0 {
			target, e := root.Readlink(name)
			if e != nil {
				return nil, e
			}
			data = []byte(target)
		} else if info.Mode().IsRegular() && mode != "120000" {
			if info.Size() > maxFile {
				return nil, errors.New("source file exceeds limit")
			}
			file, e := root.Open(name)
			if e != nil {
				return nil, e
			}
			opened, e := file.Stat()
			if e != nil || !os.SameFile(info, opened) {
				_ = file.Close()
				return nil, errors.New("source identity changed")
			}
			data, e = io.ReadAll(io.LimitReader(file, maxFile+1))
			_ = file.Close()
			if e != nil {
				return nil, e
			}
			if len(data) > maxFile {
				return nil, errors.New("source file exceeds limit")
			}
			if runtime.GOOS != "windows" && (info.Mode()&0o111 != 0) != (mode == "100755") {
				dirty = append(dirty, name)
				continue
			}
		} else {
			dirty = append(dirty, name)
			continue
		}
		total += int64(len(data))
		if total > 256<<20 {
			return nil, errors.New("source observation exceeds limit")
		}
		digest := sha1.New() //nolint:gosec // Compare Git SHA-1 object IDs; this is not an evidence signature.
		if sha256Objects {
			digest = sha256.New()
		}
		_, _ = fmt.Fprintf(digest, "blob %d%c", len(data), 0)
		_, _ = digest.Write(data)
		if hex.EncodeToString(digest.Sum(nil)) != oid {
			dirty = append(dirty, name)
		}
	}
	return dirty, nil
}

// Inspect reads one registered owned repository with bounded, non-converting plumbing.
func (Reader) Inspect(ctx context.Context, repoPath, worktreePath, base string) (domain.RunRepoFacts, error) {
	var facts domain.RunRepoFacts
	if !domain.FullCommit(base) {
		return facts, errors.New("owned base SHA missing")
	}
	repo, err := canonical(repoPath)
	if err != nil {
		return facts, err
	}
	root, worktree, err := openOwned(worktreePath)
	if err != nil {
		return facts, err
	}
	defer func() { _ = root.Close() }()
	repoRoot, _, err := openOwned(repo)
	if err != nil {
		return facts, err
	}
	metadata, err := repoRoot.Lstat(".git")
	_ = repoRoot.Close()
	if err != nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
		return facts, errors.New("registered repository metadata must be an owned directory")
	}
	metadata, err = root.Lstat(".git")
	if err != nil || metadata.Mode()&os.ModeSymlink != 0 {
		return facts, errors.New("owned worktree metadata unavailable")
	}
	if !metadata.IsDir() {
		if !metadata.Mode().IsRegular() || metadata.Size() > 4096 {
			return facts, errors.New("invalid owned worktree metadata")
		}
		file, e := root.Open(".git")
		if e != nil {
			return facts, e
		}
		info, e := file.Stat()
		if e != nil || !os.SameFile(metadata, info) {
			_ = file.Close()
			return facts, errors.New("worktree pointer identity changed")
		}
		data, e := io.ReadAll(io.LimitReader(file, 4097))
		_ = file.Close()
		if e != nil {
			return facts, e
		}
		if len(data) > 4096 {
			return facts, errors.New("worktree pointer exceeds limit")
		}
		target, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir: ")
		if !ok {
			return facts, errors.New("invalid worktree pointer")
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(worktree, target)
		}
		target, e = canonical(target)
		if e != nil {
			return facts, e
		}
		rel, e := filepath.Rel(filepath.Join(repo, ".git"), target)
		if e != nil || !filepath.IsLocal(rel) {
			return facts, errors.New("worktree metadata escapes registered repository")
		}
	}
	top, err := git(ctx, worktree, "rev-parse", "--show-toplevel")
	if err != nil {
		return facts, err
	}
	top, err = canonical(top)
	if err != nil || top != worktree {
		return facts, errors.New("owned worktree identity changed")
	}
	projectCommon, err := git(ctx, repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return facts, err
	}
	common, err := git(ctx, worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return facts, err
	}
	projectCommon, err = canonical(projectCommon)
	if err != nil {
		return facts, err
	}
	common, err = canonical(common)
	if err != nil || common != projectCommon || projectCommon != filepath.Join(repo, ".git") {
		return facts, errors.New("repository identity mismatch")
	}
	flags, err := git(ctx, worktree, "ls-files", "-v", "-z")
	if err != nil {
		return facts, err
	}
	for _, entry := range strings.Split(flags, "\x00") {
		if entry != "" && (entry[0] == 'S' || entry[0] >= 'a' && entry[0] <= 'z') {
			return facts, errors.New("index hides working source changes")
		}
	}
	head, err := git(ctx, worktree, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || !domain.FullCommit(head) {
		return facts, errors.New("HEAD unavailable")
	}
	branch, err := git(ctx, worktree, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return facts, err
	}
	if _, err := git(ctx, worktree, "merge-base", "--is-ancestor", base, head); err != nil {
		return facts, errors.New("owned base is not an ancestor")
	}
	changed, err := git(ctx, worktree, "diff-tree", "--no-commit-id", "-r", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, head, "--")
	if err != nil {
		return facts, err
	}
	staged, err := git(ctx, worktree, "diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", head, "--")
	if err != nil {
		return facts, err
	}
	index, err := git(ctx, worktree, "ls-files", "--stage", "-z")
	if err != nil {
		return facts, err
	}
	unstaged, err := rawFiles(root, index, len(head) == 64)
	if err != nil {
		return facts, err
	}
	untracked, err := git(ctx, worktree, "ls-files", "--others", "--exclude-standard", "-z", "--")
	if err != nil {
		return facts, err
	}
	endHead, err := git(ctx, worktree, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return facts, err
	}
	endIndex, err := git(ctx, worktree, "ls-files", "--stage", "-z")
	if err != nil {
		return facts, err
	}
	endUntracked, err := git(ctx, worktree, "ls-files", "--others", "--exclude-standard", "-z", "--")
	if err != nil {
		return facts, err
	}
	endDirty, err := rawFiles(root, endIndex, len(head) == 64)
	if err != nil || head != endHead || index != endIndex || untracked != endUntracked || strings.Join(unstaged, "\x00") != strings.Join(endDirty, "\x00") {
		return facts, errors.New("repository changed during observation")
	}
	facts = domain.RunRepoFacts{RepoPath: repo, WorktreePath: worktree, BaseSHA: base, HeadSHA: head, Branch: branch, ChangedFiles: names(changed), Staged: names(staged), Unstaged: unstaged, Untracked: names(untracked)}
	for _, list := range [][]string{facts.ChangedFiles, facts.Staged, facts.Unstaged, facts.Untracked} {
		if len(list) > maxFiles {
			return domain.RunRepoFacts{}, errors.New("too many source paths")
		}
	}
	data, err := json.Marshal(struct {
		Facts         domain.RunRepoFacts
		Common, Index string
	}{facts, common, index})
	if err != nil {
		return facts, err
	}
	if len(data) > 16<<10 {
		return domain.RunRepoFacts{}, errors.New("repository facts exceed limit")
	}
	sum := sha256.Sum256(data)
	facts.Fingerprint = hex.EncodeToString(sum[:])
	return facts, nil
}

// VerifyArtifact hashes a bounded regular file beneath a symlink-free owned root.
func (Reader) VerifyArtifact(ctx context.Context, root string, artifact domain.RunArtifact) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsLocal(artifact.Path) || !domain.SHA256Digest(artifact.Digest) {
		return errors.New("invalid artifact reference")
	}
	base, _, err := openOwned(root)
	if err != nil {
		return err
	}
	defer func() { _ = base.Close() }()
	entry, err := base.Lstat(artifact.Path)
	if err != nil || !entry.Mode().IsRegular() || entry.Size() > maxFile {
		return errors.New("artifact must be a bounded regular file")
	}
	file, err := base.Open(artifact.Path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFile || !os.SameFile(entry, info) {
		return errors.New("artifact identity changed")
	}
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(file, maxFile+1))
	if err != nil {
		return err
	}
	if size > maxFile || hex.EncodeToString(digest.Sum(nil)) != artifact.Digest {
		return errors.New("artifact digest mismatch or size exceeds " + strconv.Itoa(maxFile))
	}
	return ctx.Err()
}
