package sessionmanager

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (m *Manager) enrollOuterSpawn(ctx context.Context, cfg ports.SpawnConfig, id domain.SessionID) error {
	if cfg.OuterActionID == "" {
		return nil
	}
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok || e.ActionID != cfg.OuterActionID || cfg.Kind != domain.KindWorker || cfg.Harness != domain.HarnessCodex || cfg.RequestedMode != domain.SessionModeChat || cfg.Async || cfg.Prompt != "" || cfg.ParentSessionID != "" || cfg.NameFromPrompt || len(cfg.Attachments) > 0 || cfg.AutomationRunID != nil {
		return domain.ErrOuterHeld
	}
	st, ok := m.store.(interface {
		EnrollOuterParticipant(context.Context, string, string, domain.SessionID, time.Time) error
	})
	if !ok {
		return domain.ErrOuterHeld
	}
	return st.EnrollOuterParticipant(ctx, e.PlanID, e.ActionID, id, m.clock().UTC())
}

// StopOuterWorker stops the named participant while preserving its worktree and artifacts.
func (m *Manager) StopOuterWorker(ctx context.Context, id domain.SessionID, admit func(context.Context) (func(), error)) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok {
		return domain.ErrOuterHeld
	}
	st, ok := m.store.(interface {
		GetOuterPlan(context.Context, string) (domain.OuterPlanReceipt, error)
	})
	if !ok {
		return domain.ErrOuterHeld
	}
	p, err := st.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return err
	}
	op := ""
	for _, a := range p.Plan.Actions {
		if a.ID == e.ActionID {
			op = a.Spec.Operation
		}
	}
	if op != "kill" && op != "retire" {
		return domain.ErrOuterHeld
	}
	if err := domain.CheckOuterOperation(ctx, m.store, op, "", id); err != nil {
		return err
	}
	if err := m.beginAgentOperation(ctx, id, agentOperationKill); err != nil {
		return err
	}
	defer m.endAgentOperation(id, agentOperationKill)
	rec, found, err := m.store.GetSession(ctx, id)
	if err != nil || !found || rec.Kind != domain.KindWorker || rec.Mode != domain.SessionModeChat || rec.Harness != domain.HarnessCodex || m.chat == nil {
		return domain.ErrOuterHeld
	}
	if err := domain.CheckOuterOperation(ctx, m.store, op, "", id); err != nil {
		return err
	}
	if err := m.terminateNativeSession(ctx, rec); err != nil {
		return err
	}
	stopper, ok := m.chat.(interface {
		StopChatWithAdmission(context.Context, domain.SessionID, func(context.Context) (func(), error)) error
	})
	if !ok {
		return domain.ErrOuterHeld
	}
	if err := stopper.StopChatWithAdmission(ctx, id, func(writeCtx context.Context) (func(), error) {
		if err := domain.CheckOuterOperation(writeCtx, m.store, op, "", id); err != nil {
			return nil, err
		}
		if admit != nil {
			return admit(writeCtx)
		}
		return func() {}, nil
	}); err != nil {
		return err
	}
	return m.lcm.MarkTerminated(ctx, id)
}
