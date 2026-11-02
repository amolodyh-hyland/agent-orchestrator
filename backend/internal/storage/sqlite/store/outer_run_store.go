package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func validateOuterRun(ctx context.Context, q *gen.Queries, a domain.OuterPlannedAction) error {
	spec := a.Spec
	if spec.Run == nil || spec.Run.ID == "" || spec.Review != nil || spec.Text != "" || spec.Branch != "" || spec.Config != (domain.AgentConfig{}) {
		return domain.ErrOuterHeld
	}
	doc, err := q.GetFactoryRun(ctx, spec.Run.ID)
	if spec.Operation == "run.create" {
		if !errors.Is(err, sql.ErrNoRows) || spec.Run.ExpectedVersion != 0 {
			return domain.ErrOuterHeld
		}
		return nil
	}
	if spec.Operation != "run.evidence" && spec.Operation != "run.evidence.request" && spec.Operation != "run.advance.request" {
		return domain.ErrOuterHeld
	}
	var run domain.FactoryRun
	if err != nil || json.Unmarshal([]byte(doc), &run) != nil || run.ProjectID != spec.ProjectID || run.SessionID != spec.SessionID || run.Version != spec.Run.ExpectedVersion || domain.OuterDigest(run) != a.RunDigest {
		return domain.ErrOuterHeld
	}
	return nil
}

func (s *Store) checkOuterRunWrite(ctx context.Context, run domain.FactoryRun, evidence domain.RunEvidence, create bool) error {
	e, executing := domain.OuterExecutionFrom(ctx)
	if !executing {
		return nil
	}
	op := "run.evidence"
	if create {
		op = "run.create"
	}
	if err := s.CheckOuterExecution(ctx, op, domain.ProjectID(run.ProjectID), run.SessionID); err != nil {
		return err
	}
	p, err := s.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return err
	}
	for _, a := range p.Plan.Actions {
		if a.ID != e.ActionID {
			continue
		}
		if a.Spec.Run == nil || a.Spec.Run.ID != run.ID || evidence.Confirmed || evidence.Actor != "outer-orchestrator" {
			return domain.ErrOuterHeld
		}
		if create && run.Version != 0 || !create && run.Version != a.Spec.Run.ExpectedVersion+1 {
			return domain.ErrOuterHeld
		}
		return nil
	}
	return domain.ErrOuterHeld
}

func (s *Store) RequestOuterRunDecision(ctx context.Context, id, digest string) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok || e.ActionID != id || !domain.SHA256Digest(digest) {
		return domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	p, err := s.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return err
	}
	for _, a := range p.Plan.Actions {
		if a.ID != id {
			continue
		}
		if a.Spec.Operation != "run.evidence.request" && a.Spec.Operation != "run.advance.request" {
			return domain.ErrOuterHeld
		}
		if err := s.CheckOuterExecution(ctx, a.Spec.Operation, domain.ProjectID(a.Spec.ProjectID), a.Spec.SessionID); err != nil {
			return err
		}
		return s.inTx(ctx, "request inert native run decision", func(q *gen.Queries) error {
			if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: a.Spec.Operation, State: "decision_requested", RequestID: p.Plan.Request.ID, ReceiptID: id, ProjectID: a.Spec.ProjectID, SessionID: a.Spec.SessionID, Digest: digest, Sources: p.Plan.Sources, Reason: "existing native run decision required; no execution or continuation authority"}); err != nil {
				return err
			}
			return q.CompleteOuterPlanAction(ctx, gen.CompleteOuterPlanActionParams{ID: id, State: "completed", CompletedAt: nullTime(time.Now().UTC())})
		})
	}
	return domain.ErrOuterHeld
}
