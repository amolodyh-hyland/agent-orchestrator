package runrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// Reader observes Git and artifact facts without executing project code.
type Reader struct{}

func git(ctx context.Context, path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	argv := append([]string{"--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", path}, args...)
	cmd := process.CommandContext(ctx, "git", argv...)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0")
	data, err := cmd.Output()
	if err != nil {
		return "", errors.New("repository facts unavailable")
	}
	return strings.TrimSuffix(string(data), "\n"), nil
}

func canonical(path string) (string, error) {
	if path == "" {
		return "", errors.New("repository path missing")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return filepath.Abs(resolved)
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

// Inspect reads one registered owned repository and rejects unstable observations.
func (Reader) Inspect(ctx context.Context, repoPath, worktreePath, base string) (domain.RunRepoFacts, error) {
	var facts domain.RunRepoFacts
	if !domain.FullCommit(base) {
		return facts, errors.New("owned base SHA missing")
	}
	repo, err := canonical(repoPath)
	if err != nil {
		return facts, err
	}
	worktree, err := canonical(worktreePath)
	if err != nil {
		return facts, err
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
	if err != nil || common != projectCommon {
		return facts, errors.New("repository identity mismatch")
	}
	index, err := git(ctx, worktree, "ls-files", "-v", "-z")
	if err != nil {
		return facts, err
	}
	for _, entry := range strings.Split(index, "\x00") {
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
	status, err := git(ctx, worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	if err != nil {
		return facts, err
	}
	changed, err := git(ctx, worktree, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, head, "--")
	if err != nil {
		return facts, err
	}
	staged, err := git(ctx, worktree, "diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "--no-renames", "-z", "--")
	if err != nil {
		return facts, err
	}
	unstaged, err := git(ctx, worktree, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", "--")
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
	endStatus, err := git(ctx, worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	if err != nil || head != endHead || status != endStatus {
		return facts, errors.New("repository changed during observation")
	}
	facts = domain.RunRepoFacts{RepoPath: repo, WorktreePath: worktree, BaseSHA: base, HeadSHA: head, Branch: branch, ChangedFiles: names(changed), Staged: names(staged), Unstaged: names(unstaged), Untracked: names(untracked)}
	if status != "" && len(facts.Staged)+len(facts.Unstaged)+len(facts.Untracked) == 0 {
		return facts, errors.New("repository contains unresolved changes")
	}
	data, err := json.Marshal(struct {
		Facts          domain.RunRepoFacts
		Common, Status string
	}{facts, common, status})
	if err != nil {
		return facts, err
	}
	sum := sha256.Sum256(data)
	facts.Fingerprint = hex.EncodeToString(sum[:])
	return facts, nil
}

// VerifyArtifact checks a bounded regular file beneath an owned root.
func (Reader) VerifyArtifact(ctx context.Context, root string, artifact domain.RunArtifact) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if root == "" || !filepath.IsLocal(artifact.Path) || !domain.SHA256Digest(artifact.Digest) {
		return errors.New("invalid artifact reference")
	}
	base, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = base.Close() }()
	entry, err := base.Lstat(artifact.Path)
	if err != nil || !entry.Mode().IsRegular() || entry.Size() > 32<<20 {
		return errors.New("artifact must be a bounded regular file")
	}
	file, err := base.Open(artifact.Path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 32<<20 {
		return errors.New("artifact must be a bounded regular file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, (32<<20)+1))
	if err != nil {
		return err
	}
	if size > 32<<20 {
		return errors.New("artifact exceeds size limit")
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.Digest {
		return errors.New("artifact digest mismatch")
	}
	return ctx.Err()
}
