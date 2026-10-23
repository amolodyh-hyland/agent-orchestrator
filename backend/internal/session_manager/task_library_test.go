package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type taskSelectionFixture struct {
	librarySelectionStub
	snapshot domain.LibrarySnapshot
	events   *[]string
}

func (s *taskSelectionFixture) AcquireTaskLaunch(ctx context.Context, _ domain.SessionID) (context.Context, domain.LibrarySnapshot, func(), error) {
	*s.events = append(*s.events, "selection")
	return ctx, s.snapshot, func() { *s.events = append(*s.events, "release") }, nil
}

type taskAgentFixture struct {
	fakeAgent
	events *[]string
}

func (a taskAgentFixture) PrepareTaskLibrary(_ context.Context, cfg ports.TaskLibraryConfig) (ports.TaskLibraryProjection, error) {
	*a.events = append(*a.events, "projection")
	return ports.TaskLibraryProjection{Bindings: []ports.TaskLibraryBinding{{EntryID: "entry", Status: "unsupported_provider", ReasonCode: "version_evidence_required"}}}, nil
}
func (a taskAgentFixture) GetAgentHooks(context.Context, ports.WorkspaceHookConfig) error {
	*a.events = append(*a.events, "owned_hooks")
	return nil
}
func (a taskAgentFixture) PreLaunch(context.Context, ports.LaunchConfig) error {
	*a.events = append(*a.events, "folder_trust")
	return nil
}
func TestTaskLibraryChecksBeforeHooksAndFolderTrust(t *testing.T) {
	m, _, _, _ := newManager()
	events := []string{}
	selection := &taskSelectionFixture{librarySelectionStub: librarySelectionStub{allowed: true}, events: &events, snapshot: domain.LibrarySnapshot{SnapshotID: "snapshot", Channel: domain.SessionModeTUI, Entries: []domain.LibrarySnapshotEntry{{Required: true, ApprovalID: "approval"}}}}
	m.SetLibrarySelection(selection)
	agent := taskAgentFixture{events: &events}
	if err := m.prepareWorkspace(context.Background(), agent, "task", t.TempDir(), "", "", ports.AgentConfig{}, nil); err == nil {
		t.Fatal("unproved entry allowed")
	}
	for _, event := range events {
		if event == "owned_hooks" || event == "folder_trust" {
			t.Fatal("trust side effect before supported binding")
		}
	}
	events = nil
	selection.snapshot.Entries[0].Required = false
	if err := m.prepareWorkspace(context.Background(), agent, "task", t.TempDir(), "", "", ports.AgentConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	want := []string{"selection", "projection", "release", "owned_hooks", "folder_trust"}
	if len(events) != len(want) {
		t.Fatal(events)
	}
	for i := range want {
		if events[i] != want[i] {
			t.Fatal(events)
		}
	}
	events = nil
	selection.launchErr = errors.New("revoked")
	if err := m.prepareWorkspace(context.Background(), agent, "task", t.TempDir(), "", "", ports.AgentConfig{}, nil); err == nil || len(events) != 0 {
		t.Fatal("revoked prelaunch reached hooks")
	}
}
func TestTaskLibraryRuntimeStopPreservesWorkspaceAndSurfacesFailure(t *testing.T) {
	for _, fails := range []bool{false, true} {
		m, st, rt, ws := newManager()
		rec := domain.SessionRecord{ID: "task", Mode: domain.SessionModeTUI, Metadata: domain.SessionMetadata{RuntimeHandleID: "runtime", WorkspacePath: "retained-workspace"}}
		st.sessions[rec.ID] = rec
		if fails {
			rt.destroyErr = errors.New("failed stop")
		}
		err := m.StopLibraryRuntime(context.Background(), rec.ID)
		if (err != nil) != fails || rt.destroyed != 1 || ws.destroyed != 0 || st.sessions[rec.ID].IsTerminated == fails {
			t.Fatalf("failure=%v err=%v destroyed=%d session=%+v", fails, err, rt.destroyed, st.sessions[rec.ID])
		}
	}
}
