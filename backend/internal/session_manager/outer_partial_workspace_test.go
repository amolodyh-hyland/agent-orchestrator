package sessionmanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type outerInventoryStore struct{ *sqlite.Store }

func (*outerInventoryStore) CheckOuterOperation(ctx context.Context, op string, _ domain.ProjectID, _ domain.SessionID) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok || e.PlanID != "plan" || e.ActionID != "spawn" || op != "spawn" {
		return domain.ErrOuterHeld
	}
	return nil
}

func (*outerInventoryStore) EnrollOuterParticipant(context.Context, string, string, domain.SessionID, time.Time) error {
	return nil
}

type outerPartialWorkspace struct {
	*fakeWorkspace
	rootPath string
	repoPath string
	cause    error
	cancel   context.CancelFunc
	id       domain.SessionID
}

func (w *outerPartialWorkspace) CreateWorkspaceProject(_ context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	w.id = cfg.SessionID
	if w.cancel != nil {
		w.cancel()
	}
	return ports.WorkspaceProjectInfo{
		Root: ports.WorkspaceInfo{Path: w.rootPath, RepoPath: w.repoPath, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID},
		Worktrees: []ports.WorkspaceRepoInfo{{
			RepoName: domain.RootWorkspaceRepoName, RepoPath: w.repoPath, Path: w.rootPath,
			Branch: cfg.Branch, BaseSHA: "root-base", BaseRef: "main", CreationSHA: "root-created",
			SessionID: cfg.SessionID, ProjectID: cfg.ProjectID,
		}},
	}, w.cause
}

func TestOuterM2PartialWorkspaceInventorySurvivesFailedSpawnAndRestart(t *testing.T) {
	for _, failure := range []string{"child_checkout", "late_child_collision", "canceled_after_root"} {
		t.Run(failure, func(t *testing.T) {
			dataDir := t.TempDir()
			st := sqlitetest.MustOpenAt(t, dataDir)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			source := t.TempDir()
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: string(chatTestProject), Kind: domain.ProjectKindWorkspace, Path: source, Config: testRoleAgents(), RegisteredAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			launcher := &recordingLauncher{}
			m, _, runtime := newChatManager(launcher)
			m.dataDir = dataDir
			m.store = &outerInventoryStore{Store: st}
			m.lcm = lifecycle.New(st, nil)
			rootPath := t.TempDir()
			if err := os.WriteFile(filepath.Join(rootPath, "preserve.txt"), []byte("retained root checkout"), 0600); err != nil {
				t.Fatal(err)
			}
			workspace := &outerPartialWorkspace{fakeWorkspace: &fakeWorkspace{}, rootPath: rootPath, repoPath: source, cause: errors.New(failure)}
			if failure == "canceled_after_root" {
				workspace.cancel, workspace.cause = cancel, context.Canceled
			}
			m.workspace = workspace
			cfg := ports.SpawnConfig{ProjectID: chatTestProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex, RequestedMode: domain.SessionModeChat, Branch: "feat/sealed-partial", OuterActionID: "spawn", AgentConfig: ports.AgentConfig{Permissions: ports.PermissionModeDefault}}
			_, _, _, err := m.Spawn(domain.WithOuterExecution(ctx, domain.OuterExecution{PlanID: "plan", ActionID: "spawn"}), cfg)
			if !errors.Is(err, workspace.cause) || !errors.Is(err, domain.ErrOuterSpawnNotStarted) {
				t.Fatal("partial failure lost no-start evidence", err)
			}
			if len(launcher.started) != 0 || runtime.created != 0 || workspace.projectDestroyed != 0 || workspace.destroyed != 0 {
				t.Fatal("partial failure launched or destroyed resources")
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := sqlite.Open(dataDir)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.Close() })
			rec, found, err := reopened.GetSession(context.Background(), workspace.id)
			if err != nil || !found || !rec.IsTerminated || rec.Metadata.WorkspacePath != rootPath || rec.Metadata.Branch != cfg.Branch || rec.Metadata.WorkspaceRepoPath != source {
				t.Fatal("restart lost retained root workspace", rec, found, err)
			}
			rows, err := reopened.ListSessionWorktrees(context.Background(), workspace.id)
			if err != nil || len(rows) != 1 || rows[0].RepoName != domain.RootWorkspaceRepoName || rows[0].WorktreePath != rootPath || rows[0].Branch != cfg.Branch || rows[0].BaseRef != "main" || rows[0].BaseSHA != "root-base" || rows[0].CreationSHA != "root-created" {
				t.Fatal("restart lost partial worktree inventory", rows, err)
			}
			if content, err := os.ReadFile(filepath.Join(rootPath, "preserve.txt")); err != nil || string(content) != "retained root checkout" {
				t.Fatal("retained root files changed", string(content), err)
			}
		})
	}
}
