package outer

import (
	"context"
	"encoding/json"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type Runs interface {
	Create(context.Context, factoryrun.CreateInput) (domain.RunDetail, error)
	Record(context.Context, string, factoryrun.RecordInput) (domain.RunDetail, error)
	Get(context.Context, string) (domain.RunDetail, error)
	Preview(context.Context, string, string) (factoryrun.ConfirmationPreview, error)
}

func (s *Service) SetRuns(r Runs) { s.runs = r }

func (s *Service) prepareRun(ctx context.Context, a *domain.OuterPlannedAction) error {
	spec := a.Spec
	if s.runs == nil || spec.Run == nil || spec.Run.ID == "" || len(spec.Run.ID) > 128 || spec.Review != nil || spec.Text != "" || spec.Branch != "" || spec.Config != (domain.AgentConfig{}) {
		return domain.ErrOuterHeld
	}
	rec, found, err := s.store.GetSession(ctx, spec.SessionID)
	if err != nil || !found || rec.IsTerminated || string(rec.ProjectID) != spec.ProjectID || rec.Kind != domain.KindWorker || rec.Mode != domain.SessionModeChat || rec.Harness != domain.HarnessCodex {
		return domain.ErrOuterHeld
	}
	conv, err := s.store.ConversationForSession(ctx, rec.ID)
	if err != nil || rec.Metadata.ControllerGeneration == "" || rec.Metadata.ProviderConversationID == "" {
		return domain.ErrOuterHeld
	}
	project, found, err := s.store.GetProject(ctx, spec.ProjectID)
	if err != nil || !found {
		return domain.ErrOuterHeld
	}
	a.TargetDigest = domain.OuterSettingsDigest(rec, conv, project)
	a.ControllerGeneration, a.ProviderConversationID, a.ConversationID = rec.Metadata.ControllerGeneration, rec.Metadata.ProviderConversationID, conv.ID
	a.Settings, a.PermissionCeiling = conv.Settings, rec.Metadata.PermissionCeiling
	switch spec.Operation {
	case "run.create":
		var in factoryrun.CreateInput
		if spec.Run.ExpectedVersion != 0 || domain.StrictDelegationJSON(spec.Run.Payload, &in) != nil || in.ID != spec.Run.ID || in.ProjectID != spec.ProjectID || in.SessionID != spec.SessionID || in.Actor != "outer-orchestrator" {
			return domain.ErrOuterHeld
		}
	case "run.evidence":
		var in factoryrun.RecordInput
		if domain.StrictDelegationJSON(spec.Run.Payload, &in) != nil || in.ExpectedVersion != spec.Run.ExpectedVersion || in.Actor != "outer-orchestrator" {
			return domain.ErrOuterHeld
		}
	case "run.evidence.request", "run.advance.request":
		if len(spec.Run.Payload) != 0 {
			return domain.ErrOuterHeld
		}
	default:
		return domain.ErrOuterHeld
	}
	if spec.Operation != "run.create" {
		d, err := s.runs.Get(ctx, spec.Run.ID)
		if err != nil || d.Run.ProjectID != spec.ProjectID || d.Run.SessionID != spec.SessionID || d.Run.Version != spec.Run.ExpectedVersion {
			return domain.ErrOuterHeld
		}
		a.RunDigest = domain.OuterDigest(d.Run)
	}
	return nil
}

func (s *Service) executeRun(ctx context.Context, st actionStore, p domain.OuterPlanReceipt, a domain.OuterPlannedAction) error {
	if s.runs == nil || a.Spec.Run == nil {
		return domain.ErrOuterHeld
	}
	if err := st.EnrollOuterParticipant(ctx, p.Plan.ID, a.ID, a.Spec.SessionID, s.now().UTC()); err != nil {
		return err
	}
	switch a.Spec.Operation {
	case "run.create":
		var in factoryrun.CreateInput
		if err := json.Unmarshal(a.Spec.Run.Payload, &in); err != nil {
			return err
		}
		if _, err := s.runs.Create(ctx, in); err != nil {
			return err
		}
	case "run.evidence":
		var in factoryrun.RecordInput
		if err := json.Unmarshal(a.Spec.Run.Payload, &in); err != nil {
			return err
		}
		if _, err := s.runs.Record(ctx, a.Spec.Run.ID, in); err != nil {
			return err
		}
	case "run.evidence.request", "run.advance.request":
		if err := s.store.CheckOuterOperation(ctx, a.Spec.Operation, domain.ProjectID(a.Spec.ProjectID), a.Spec.SessionID); err != nil {
			return err
		}
		action := "evidence"
		if a.Spec.Operation == "run.advance.request" {
			action = "advance"
		}
		preview, err := s.runs.Preview(ctx, a.Spec.Run.ID, action)
		if err != nil {
			return err
		}
		if preview.Detail.Run.Version != a.Spec.Run.ExpectedVersion {
			return domain.ErrOuterHeld
		}
		recorder, ok := s.store.(interface {
			RequestOuterRunDecision(context.Context, string, string) error
		})
		if !ok {
			return domain.ErrOuterHeld
		}
		return recorder.RequestOuterRunDecision(ctx, a.ID, preview.Digest)
	default:
		return domain.ErrOuterHeld
	}
	return st.CompleteOuterPlanAction(ctx, a.ID, "completed", s.now().UTC())
}
