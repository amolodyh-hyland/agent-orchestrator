package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestFreshPreparedBranchSkipsRemoteCollision(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	mainSHA := gitOutput(t, git, repo, "rev-parse", "refs/heads/main")
	runGit(t, git, repo, "update-ref", "refs/remotes/origin/ao/sess/root", mainSHA)
	ws, err := New(Options{Binary: git, ManagedRoot: filepath.Join(tmp, "managed"), RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := ws.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID: "proj", SessionID: "sess", Branch: "ao/sess/root", FreshBranch: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if info.Branch != "ao/sess/root-2" {
		t.Fatalf("prepared branch = %q, want fresh suffix", info.Branch)
	}
	if got := gitOutput(t, git, info.Path, "rev-parse", "HEAD"); got != mainSHA {
		t.Fatalf("prepared HEAD = %q, want main %q", got, mainSHA)
	}
}

func TestExactBranchRefusesCollisionsBeforeCreatingWorktrees(t *testing.T) {
	for _, project := range []bool{false, true} {
		for _, collision := range []string{"none", "root_local", "root_remote", "child_local", "child_remote", "raced_root"} {
			if !project && (collision == "child_local" || collision == "child_remote") {
				continue
			}
			t.Run(map[bool]string{false: "single", true: "workspace"}[project]+"/"+collision, func(t *testing.T) {
				git := requireGit(t)
				tmp := t.TempDir()
				repo := setupOriginClone(t, git, filepath.Join(tmp, "root"))
				child := setupOriginClone(t, git, filepath.Join(tmp, "child"))
				branch := "feat/sealed"
				collisionRepo := repo
				if collision == "child_local" || collision == "child_remote" {
					collisionRepo = child
				}
				if collision != "none" && collision != "raced_root" {
					ref := "refs/heads/" + branch
					if collision == "root_remote" || collision == "child_remote" {
						ref = "refs/remotes/origin/" + branch
					}
					runGit(t, git, collisionRepo, "update-ref", ref, "HEAD")
				}
				beforeRoot := gitOutput(t, git, repo, "show-ref")
				beforeChild := gitOutput(t, git, child, "show-ref")
				ws, err := New(Options{Binary: git, ManagedRoot: filepath.Join(tmp, "managed"), RepoResolver: StaticRepoResolver{"proj": repo}})
				if err != nil {
					t.Fatal(err)
				}
				if collision == "raced_root" {
					actualRun := ws.run
					injected := false
					ws.run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
						if !injected && strings.Contains(strings.Join(args, " "), "worktree add -b "+branch+" ") {
							injected = true
							runGit(t, git, repo, "update-ref", "refs/heads/"+branch, "HEAD")
							beforeRoot = gitOutput(t, git, repo, "show-ref")
						}
						return actualRun(ctx, binary, args...)
					}
				}
				ctx := context.Background()
				var info ports.WorkspaceInfo
				if project {
					var result ports.WorkspaceProjectInfo
					result, err = ws.CreateWorkspaceProject(ctx, ports.WorkspaceProjectConfig{ProjectID: "proj", SessionID: "sess", Branch: branch, ExactBranch: true, RootRepoPath: repo, Repos: []ports.WorkspaceProjectRepoConfig{{Name: "child", RelativePath: "packages/child", RepoPath: child}}})
					info = result.Root
					if err == nil {
						for _, wt := range result.Worktrees {
							if wt.Branch != branch {
								t.Fatal("confirmed child branch changed", wt.Branch)
							}
						}
					}
				} else {
					info, err = ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess", Branch: branch, ExactBranch: true})
				}
				if collision == "none" {
					if err != nil || info.Branch != branch || info.Path == "" {
						t.Fatal("exact new branch failed", info, err)
					}
					return
				}
				if err == nil {
					t.Fatal("collision silently allocated another branch")
				}
				if got := gitOutput(t, git, repo, "show-ref"); got != beforeRoot {
					t.Fatal("collision changed root refs", got)
				}
				if got := gitOutput(t, git, child, "show-ref"); got != beforeChild {
					t.Fatal("collision changed child refs", got)
				}
				if _, err := os.Stat(filepath.Join(ws.managedRoot, "proj", "sess")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("collision created a worktree", err)
				}
			})
		}
	}
}

func TestExactWorkspaceReturnsRootInventoryAfterChildFailure(t *testing.T) {
	for _, failure := range []string{"checkout_failure", "late_branch_collision"} {
		t.Run(failure, func(t *testing.T) {
			git := requireGit(t)
			tmp := t.TempDir()
			repo := setupOriginClone(t, git, filepath.Join(tmp, "root"))
			child := setupOriginClone(t, git, filepath.Join(tmp, "child"))
			repo, err := physicalAbs(repo)
			if err != nil {
				t.Fatal(err)
			}
			child, err = physicalAbs(child)
			if err != nil {
				t.Fatal(err)
			}
			ws, err := New(Options{Binary: git, ManagedRoot: filepath.Join(tmp, "managed"), RepoResolver: StaticRepoResolver{"proj": repo}})
			if err != nil {
				t.Fatal(err)
			}
			branch := "feat/sealed-partial"
			rootPath := filepath.Join(ws.managedRoot, "proj", "sess")
			actualRun := ws.run
			childAttempted := false
			ws.run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
				if len(args) > 3 && args[0] == "-C" && args[1] == child && strings.HasPrefix(strings.Join(args[2:], " "), "worktree add -b "+branch+" ") {
					childAttempted = true
					if _, err := os.Stat(filepath.Join(rootPath, ".git")); err != nil {
						t.Fatal("child failure occurred before the root existed", err)
					}
					if failure == "checkout_failure" {
						return nil, errors.New("child checkout failed")
					}
					runGit(t, git, child, "update-ref", "refs/heads/"+branch, "HEAD")
				}
				return actualRun(ctx, binary, args...)
			}
			info, err := ws.CreateWorkspaceProject(context.Background(), ports.WorkspaceProjectConfig{
				ProjectID: "proj", SessionID: "sess", Branch: branch, ExactBranch: true, RootRepoPath: repo,
				Repos: []ports.WorkspaceProjectRepoConfig{{Name: "child", RelativePath: "packages/child", RepoPath: child}},
			})
			if err == nil || !childAttempted || info.Root.Path != rootPath || info.Root.Branch != branch || len(info.Worktrees) != 1 {
				t.Fatal("partial root inventory lost", info, err)
			}
			row := info.Worktrees[0]
			rootSHA := gitOutput(t, git, repo, "rev-parse", "refs/heads/"+branch)
			if row.RepoName != domain.RootWorkspaceRepoName || row.Path != rootPath || row.RepoPath != repo || row.CreationSHA != rootSHA {
				t.Fatal("retained root identity changed", row)
			}
			if got := gitOutput(t, git, rootPath, "rev-parse", "HEAD"); got != rootSHA {
				t.Fatal("root worktree removed or replaced", got)
			}
			if failure == "late_branch_collision" {
				if got := gitOutput(t, git, child, "rev-parse", "refs/heads/"+branch); got != gitOutput(t, git, child, "rev-parse", "HEAD") {
					t.Fatal("racing child branch changed", got)
				}
			}
		})
	}
}
