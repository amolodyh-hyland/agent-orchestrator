package sessionmanager

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (m *Manager) prepareTaskLibrary(ctx context.Context, agent ports.Agent, id domain.SessionID, workspace string, env map[string]string) error {
	selection, ok := m.librarySelectionValue().(ports.TaskLibrarySelection)
	if !ok {
		return nil
	}
	_, snapshot, release, err := selection.AcquireTaskLaunch(ctx, id)
	if err != nil {
		return err
	}
	defer release()
	if snapshot.SnapshotID == "" || len(snapshot.Entries) == 0 || snapshot.Channel != domain.SessionModeTUI {
		return nil
	}
	projector, ok := agent.(ports.TaskLibraryProjector)
	if !ok {
		for _, e := range snapshot.Entries {
			if e.Required {
				return fmt.Errorf("library: unsupported_provider")
			}
		}
		return nil
	}
	projection, err := projector.PrepareTaskLibrary(ctx, ports.TaskLibraryConfig{Snapshot: snapshot, WorkspacePath: workspace, Env: env})
	if projection.Cleanup != nil {
		if cleanupErr := projection.Cleanup(); cleanupErr != nil {
			return fmt.Errorf("library: cleanup_conflict")
		}
	}
	if err != nil {
		return err
	}
	// Prepared fixture bindings cannot authorize a runtime. A native evidence release is separate.
	for i, e := range snapshot.Entries {
		if e.Required {
			why := "unsupported_provider"
			if i < len(projection.Bindings) {
				why = projection.Bindings[i].ReasonCode
			}
			return fmt.Errorf("library: %s", why)
		}
	}
	return nil
}

func (m *Manager) FenceLibraryInput(ctx context.Context, id domain.SessionID) (func(), error) {
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil || !found {
		return func() {}, err
	}
	if domain.NormalizeSessionMode(rec.Mode) != domain.SessionModeTUI {
		return func() {}, nil
	}
	m.terminalInputGateMu.Lock()
	gate := m.terminalInputGate
	m.terminalInputGateMu.Unlock()
	if fencer, ok := gate.(interface{ FenceLibraryInput(string) func() }); ok {
		return fencer.FenceLibraryInput(rec.Metadata.RuntimeHandleID), nil
	}
	if rec.Metadata.RuntimeHandleID != "" {
		return nil, fmt.Errorf("library: runtime_input_fence_unsupported")
	}
	return func() {}, nil
}

func (m *Manager) StopLibraryRuntime(ctx context.Context, id domain.SessionID) error {
	if err := m.beginAgentOperation(ctx, id, agentOperationRetire); err != nil {
		return err
	}
	defer m.endAgentOperation(id, agentOperationRetire)
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil || !found {
		return err
	}
	if domain.NormalizeSessionMode(rec.Mode) == domain.SessionModeChat {
		return fmt.Errorf("library: runtime_stop_unsupported")
	}
	handle := runtimeHandle(rec.Metadata)
	if handle.ID != "" {
		if err := m.runtime.Destroy(ctx, handle); err != nil {
			return fmt.Errorf("library: runtime_stop_failed")
		}
	}
	return m.recordTermination(ctx, id, false)
}

func (m *Manager) acquireLibraryRuntimeLaunch(ctx context.Context, id domain.SessionID) (context.Context, func(), error) {
	selection, ok := m.librarySelectionValue().(ports.TaskLibrarySelection)
	if !ok {
		return ctx, func() {}, nil
	}
	leaseCtx, _, release, err := selection.AcquireTaskLaunch(ctx, id)
	if err != nil {
		return ctx, nil, err
	}
	return leaseCtx, release, nil
}
