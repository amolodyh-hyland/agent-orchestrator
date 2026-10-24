package sessionmanager

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type m2ManagerStore struct {
	*fakeStore
	plan         domain.OuterPlanReceipt
	participants map[domain.SessionID]bool
	hold         bool
}

func (s *m2ManagerStore) OuterBinding(context.Context) (domain.OuterBinding, bool, error) {
	return domain.OuterBinding{}, true, nil
}
func (s *m2ManagerStore) IsOuterSession(context.Context, domain.SessionID) (bool, error) {
	return false, nil
}
func (s *m2ManagerStore) IsOuterParticipant(_ context.Context, id domain.SessionID) (bool, error) {
	return s.participants[id], nil
}
func (s *m2ManagerStore) CheckOuterOperation(ctx context.Context, op string, _ domain.ProjectID, id domain.SessionID) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok || s.hold || e.PlanID != s.plan.Plan.ID || e.ActionID != s.plan.Plan.Actions[0].ID || op != s.plan.Plan.Actions[0].Spec.Operation {
		return domain.ErrOuterHeld
	}
	if id != "" && id != s.plan.Plan.Actions[0].Spec.SessionID {
		return domain.ErrOuterHeld
	}
	return nil
}
func (s *m2ManagerStore) GetOuterPlan(context.Context, string) (domain.OuterPlanReceipt, error) {
	return s.plan, nil
}
func (s *m2ManagerStore) EnrollOuterParticipant(_ context.Context, _, _ string, id domain.SessionID, _ time.Time) error {
	s.participants[id] = true
	return nil
}

func TestOuterM2ManagerSpawnHasNoUnapprovedOpeningPrompt(t *testing.T) {
	launcher := &recordingLauncher{}
	m, st, runtime := newChatManager(launcher)
	m.dataDir = t.TempDir()
	policy := &m2ManagerStore{fakeStore: st, participants: map[domain.SessionID]bool{}, plan: domain.OuterPlanReceipt{Plan: domain.OuterActionPlan{ID: "plan", Actions: []domain.OuterPlannedAction{{ID: "spawn", Spec: domain.OuterActionSpec{Operation: "spawn", ProjectID: string(chatTestProject)}}}}}}
	m.store = policy
	ctx := domain.WithOuterExecution(context.Background(), domain.OuterExecution{PlanID: "plan", ActionID: "spawn"})
	cfg := ports.SpawnConfig{ProjectID: chatTestProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex, RequestedMode: domain.SessionModeChat, Branch: "feat/exact-owned", OuterActionID: "spawn", AgentConfig: ports.AgentConfig{Permissions: ports.PermissionModeDefault}}
	launcher.beforeStart = func(start ChatStart) {
		if !policy.participants[start.SessionID] {
			t.Fatal("launch preceded enrollment")
		}
	}
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.participants[rec.ID] || len(launcher.started) != 1 || len(launcher.turns) != 0 || len(launcher.queued) != 0 || runtime.created != 0 {
		t.Fatal("spawn bypassed passive provisioning", launcher.turns, launcher.queued, runtime.created)
	}
	if rec.Metadata.Branch != cfg.Branch || rec.Metadata.WorkspacePath == "" {
		t.Fatal("no owned task worktree", rec.Metadata)
	}
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("unbound spawn")
	}
}

func TestOuterM2ManagerStopPreservesWorktreeAndArtifacts(t *testing.T) {
	for _, op := range []string{"kill", "retire"} {
		t.Run(op, func(t *testing.T) {
			launcher := &recordingLauncher{}
			m, st, runtime := newChatManager(launcher)
			m.dataDir = t.TempDir()
			id := domain.SessionID("mer-1")
			st.sessions[id] = domain.SessionRecord{ID: id, ProjectID: chatTestProject, Kind: domain.KindWorker, Mode: domain.SessionModeChat, Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{WorkspacePath: "/owned/worktree", Branch: "feat/owned", ArtifactDir: "/owned/artifacts", ControllerGeneration: "exact-native"}}
			policy := &m2ManagerStore{fakeStore: st, participants: map[domain.SessionID]bool{id: true}, plan: domain.OuterPlanReceipt{Plan: domain.OuterActionPlan{ID: "plan", Actions: []domain.OuterPlannedAction{{ID: "stop", Spec: domain.OuterActionSpec{Operation: op, ProjectID: string(chatTestProject), SessionID: id}}}}}}
			m.store = policy
			if err := m.StopOuterWorker(context.Background(), id, nil); err == nil {
				t.Fatal("unbound stop")
			}
			ctx := domain.WithOuterExecution(context.Background(), domain.OuterExecution{PlanID: "plan", ActionID: "stop"})
			policy.hold = true
			if err := m.StopOuterWorker(ctx, id, nil); err == nil {
				t.Fatal("stale stop authority")
			}
			policy.hold = false
			if err := m.StopOuterWorker(ctx, id, nil); err != nil {
				t.Fatal(err)
			}
			if len(launcher.stopped) != 1 || launcher.stopped[0] != id || m.workspace.(*fakeWorkspace).destroyed != 0 || runtime.destroyed != 0 {
				t.Fatal("stop cleaned artifacts or wrong execution", launcher.stopped)
			}
			rec := st.sessions[id]
			if !rec.IsTerminated || rec.Metadata.WorkspacePath != "/owned/worktree" || rec.Metadata.ArtifactDir != "/owned/artifacts" {
				t.Fatal("preservation lost", rec)
			}
		})
	}
}

func (l *recordingLauncher) StopChatWithAdmission(ctx context.Context, id domain.SessionID, admit func(context.Context) (func(), error)) error {
	release, err := admit(ctx)
	if err != nil {
		return err
	}
	defer release()
	return l.StopChat(ctx, id)
}
