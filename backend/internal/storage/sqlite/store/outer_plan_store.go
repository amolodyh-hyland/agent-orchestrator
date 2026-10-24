package store

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// IsOuterParticipant reads durable enrollment without resuming an execution.
func (s *Store) IsOuterParticipant(ctx context.Context, id domain.SessionID) (bool, error) {
	return s.conversationReader(ctx).IsOuterParticipant(ctx, string(id))
}

func outerPlan(row gen.OuterActionPlan) (domain.OuterPlanReceipt, error) {
	r := domain.OuterPlanReceipt{ApprovedAt: timeFromNull(row.ApprovedAt), ExpiresAt: timeFromNull(row.ExpiresAt), Actions: []domain.OuterActionReceipt{}}
	err := json.Unmarshal([]byte(row.Document), &r.Plan)
	r.Digest = domain.OuterDigest(r.Plan)
	return r, err
}

// GetOuterPlan joins the immutable manifest to its original action receipts.
func (s *Store) GetOuterPlan(ctx context.Context, id string) (domain.OuterPlanReceipt, error) {
	row, err := s.conversationReader(ctx).GetOuterPlan(ctx, id)
	if err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	r, err := outerPlan(row)
	if err != nil {
		return r, err
	}
	rows, err := s.conversationReader(ctx).ListOuterPlanActions(ctx, id)
	for _, a := range rows {
		if receipt, err := s.GetOuterRequest(ctx, a.ID); err == nil {
			a.State = receipt.State
		}
		r.Actions = append(r.Actions, domain.OuterActionReceipt{ID: a.ID, SessionID: domain.SessionID(a.SessionID), AttemptedAt: timeFromNull(a.AttemptedAt), CompletedAt: timeFromNull(a.CompletedAt), State: a.State})
	}
	return r, err
}

// ListOuterPlans bounds full manifest reads while retaining older journals.
func (s *Store) ListOuterPlans(ctx context.Context) ([]domain.OuterPlanReceipt, error) {
	rows, err := s.conversationReader(ctx).ListOuterPlans(ctx)
	if err != nil {
		return nil, err
	}
	out := []domain.OuterPlanReceipt{}
	for _, row := range rows {
		r, err := s.GetOuterPlan(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func validateOuterPlan(ctx context.Context, q *gen.Queries, p domain.OuterActionPlan, now time.Time) error {
	r := p.Request
	r.Sources = p.Sources
	r.ExpiresAt = now.Add(time.Minute)
	return validateOuterRequest(ctx, q, r, now)
}

// CancelOuterPlan revokes an unapproved manifest permanently.
func (s *Store) CancelOuterPlan(ctx context.Context, id, digest string, now time.Time) error {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.plan.cancel" || a.RequestID != id {
		return domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "cancel sealed plan", func(q *gen.Queries) error {
		row, err := q.GetOuterPlan(ctx, id)
		if err != nil {
			return err
		}
		p, err := outerPlan(row)
		if err != nil {
			return err
		}
		if p.Digest != digest {
			return domain.ErrOuterHeld
		}
		count, err := q.CancelOuterPlan(ctx, gen.CancelOuterPlanParams{ID: id, ExpiresAt: nullTime(now)})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.plan.cancel", State: "cancelled", RequestID: p.Plan.Request.ID, ReceiptID: id, Digest: digest, Sources: p.Plan.Sources})
	})
}

func validateOuterPlannedTarget(ctx context.Context, q *gen.Queries, a domain.OuterPlannedAction) error {
	p, err := q.GetProject(ctx, domain.ProjectID(a.Spec.ProjectID))
	if err != nil || p.ArchivedAt.Valid || projectRowFromGen(p).Revision != a.ProjectRevision {
		return domain.ErrOuterHeld
	}
	if a.Spec.Operation == "spawn" {
		if domain.OuterDigest(projectRowFromGen(p)) != a.TargetDigest {
			return domain.ErrOuterHeld
		}
		return nil
	}
	raw, err := q.GetSession(ctx, a.Spec.SessionID)
	if err != nil {
		return err
	}
	r := rowToRecord(raw)
	if r.IsTerminated || string(r.ProjectID) != a.Spec.ProjectID || r.Mode != domain.SessionModeChat || r.Harness != domain.HarnessCodex || r.Metadata.ControllerGeneration != a.ControllerGeneration || r.Metadata.ProviderConversationID != a.ProviderConversationID {
		return domain.ErrOuterHeld
	}
	c, err := q.SelectConversationByID(ctx, a.ConversationID)
	if err != nil || domain.OuterSettingsDigest(r, conversationToDomain(c), projectRowFromGen(p)) != a.TargetDigest {
		return domain.ErrOuterHeld
	}
	if a.Spec.Operation == "send" {
		held, err := q.FactoryFeedbackHeld(ctx, r.ID)
		if err != nil {
			return err
		}
		if held || r.Kind != domain.KindOrchestrator {
			return domain.ErrOuterHeld
		}
	} else {
		held, err := q.IsOuterParticipant(ctx, string(r.ID))
		if err != nil {
			return err
		}
		if !held || r.Kind != domain.KindWorker {
			return domain.ErrOuterHeld
		}
	}
	return nil
}

// CreateOuterPlan seals concrete instances once for one human request.
func (s *Store) CreateOuterPlan(ctx context.Context, p domain.OuterActionPlan) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "seal outer action plan", func(q *gen.Queries) error {
		if err := validateOuterPlan(ctx, q, p, time.Now()); err != nil {
			return err
		}
		if err := q.InsertOuterPlan(ctx, gen.InsertOuterPlanParams{ID: p.ID, RequestID: p.Request.ID, Document: string(data)}); err != nil {
			return err
		}
		for _, a := range p.Actions {
			if err := validateOuterPlannedTarget(ctx, q, a); err != nil {
				return err
			}
			if err := q.InsertOuterPlanAction(ctx, gen.InsertOuterPlanActionParams{ID: a.ID, PlanID: p.ID}); err != nil {
				return err
			}
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.plan", State: "sealed", RequestID: p.Request.ID, Digest: domain.OuterDigest(p), ReceiptID: p.ID, Sources: p.Sources})
	})
}

// ApproveOuterPlan records single-use execution and separate disclosure consent.
func (s *Store) ApproveOuterPlan(ctx context.Context, id, digest, epoch string, now time.Time) error {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.plan.approve" || a.RequestID != id {
		return domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "approve sealed outer plan", func(q *gen.Queries) error {
		row, err := q.GetOuterPlan(ctx, id)
		if err != nil {
			return err
		}
		r, err := outerPlan(row)
		if err != nil {
			return err
		}
		if r.Digest != digest || r.Plan.Epoch != epoch || !r.ApprovedAt.IsZero() || row.ExpiresAt.Valid {
			return domain.ErrOuterHeld
		}
		if err := validateOuterPlan(ctx, q, r.Plan, now); err != nil {
			return err
		}
		for _, action := range r.Plan.Actions {
			if err := validateOuterPlannedTarget(ctx, q, action); err != nil {
				return err
			}
		}
		count, err := q.ApproveOuterPlan(ctx, gen.ApproveOuterPlanParams{ID: id, ApprovedAt: nullTime(now), ExpiresAt: nullTime(now.Add(2 * time.Minute))})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.disclosure", State: "confirmed", RequestID: r.Plan.Request.ID, ReceiptID: id, Digest: digest, Sources: r.Plan.Sources, Reason: "explicit source clarification and exact source-to-destination disclosure"}); err != nil {
			return err
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.plan.approve", State: "approved", RequestID: r.Plan.Request.ID, ReceiptID: id, Digest: digest, Sources: r.Plan.Sources})
	})
}

// AttemptOuterPlanAction fences one exact instance before any effect.
func (s *Store) AttemptOuterPlanAction(ctx context.Context, plan, id, epoch string, now time.Time) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "attempt exact outer action", func(q *gen.Queries) error {
		row, err := q.GetOuterPlan(ctx, plan)
		if err != nil {
			return err
		}
		r, err := outerPlan(row)
		if err != nil {
			return err
		}
		if r.ApprovedAt.IsZero() || !now.Before(r.ExpiresAt) || r.Plan.Epoch != epoch {
			return domain.ErrOuterHeld
		}
		if err := validateOuterPlan(ctx, q, r.Plan, now); err != nil {
			return err
		}
		index := slices.IndexFunc(r.Plan.Actions, func(a domain.OuterPlannedAction) bool { return a.ID == id })
		if index < 0 {
			return domain.ErrOuterHeld
		}
		a := r.Plan.Actions[index]
		for _, dep := range a.Spec.DependsOn {
			if dep < 1 || dep > index {
				return domain.ErrOuterHeld
			}
			d, err := q.GetOuterPlanAction(ctx, r.Plan.Actions[dep-1].ID)
			if err != nil || d.State != "completed" {
				return domain.ErrOuterHeld
			}
		}
		if err := validateOuterPlannedTarget(ctx, q, a); err != nil {
			return err
		}
		count, err := q.AttemptOuterPlanAction(ctx, gen.AttemptOuterPlanActionParams{ID: id, AttemptedAt: nullTime(now)})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.action." + a.Spec.Operation, State: "attempted", RequestID: r.Plan.Request.ID, ReceiptID: id, ProjectID: a.Spec.ProjectID, SessionID: a.Spec.SessionID, Digest: domain.OuterDigest(a), Sources: r.Plan.Sources})
	})
}

// EnrollOuterParticipant snapshots feedback controls before a worker can execute.
func (s *Store) EnrollOuterParticipant(ctx context.Context, plan, id string, session domain.SessionID, now time.Time) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "enroll exact participant", func(q *gen.Queries) error {
		a, err := q.GetOuterPlanAction(ctx, id)
		if err != nil || a.PlanID != plan || !a.AttemptedAt.Valid || a.SessionID != "" {
			return domain.ErrOuterHeld
		}
		row, err := q.GetSession(ctx, session)
		if err != nil {
			return err
		}
		r := rowToRecord(row)
		policies, err := q.FactoryMonitorPolicies(ctx, session)
		if err != nil {
			return err
		}
		snapshot := domain.RunParticipantSnapshot{SessionID: session, AutoReview: r.AutoReviewEnabled, AutoInjectReview: r.AutoInjectReview, AutoInjectCI: r.AutoInjectCI, FeedbackPolicies: policies, ReportRoute: "display_only", CapturedAt: now}
		data, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		if _, err := q.BindOuterPlanAction(ctx, gen.BindOuterPlanActionParams{ID: id, SessionID: string(session)}); err != nil {
			return err
		}
		if err := q.EnrollOuterParticipant(ctx, gen.EnrollOuterParticipantParams{SessionID: string(session), ActionID: id, Snapshot: string(data), EnrolledAt: now}); err != nil {
			return err
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.participant", State: "enrolled", SessionID: session, ProjectID: string(r.ProjectID), ReceiptID: id, Digest: domain.OuterDigest(snapshot), Reason: "feedback and cascades held; independent review gates retained"})
	})
}

// CompleteOuterPlanAction records a definite outcome without granting follow-up.
func (s *Store) CompleteOuterPlanAction(ctx context.Context, id, state string, now time.Time) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "record action outcome", func(q *gen.Queries) error {
		if err := q.CompleteOuterPlanAction(ctx, gen.CompleteOuterPlanActionParams{ID: id, State: state, CompletedAt: nullTime(now)}); err != nil {
			return err
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.action.outcome", State: state, ReceiptID: id})
	})
}

func validateOuterActionRequest(ctx context.Context, q *gen.Queries, r domain.OuterRequest, now time.Time) error {
	row, err := q.GetOuterPlan(ctx, r.PlanID)
	if err != nil {
		return err
	}
	p, err := outerPlan(row)
	if err != nil {
		return err
	}
	if p.ApprovedAt.IsZero() || !now.Before(p.ExpiresAt) || r.ExpiresAt.After(p.ExpiresAt) || p.Plan.Epoch != r.Epoch || p.Plan.Request.SessionID != r.OwnerSessionID {
		return domain.ErrOuterHeld
	}
	index := slices.IndexFunc(p.Plan.Actions, func(a domain.OuterPlannedAction) bool { return a.ID == r.ID })
	if index < 0 {
		return domain.ErrOuterHeld
	}
	a := p.Plan.Actions[index]
	receipt, err := q.GetOuterPlanAction(ctx, r.ID)
	if err != nil || !receipt.AttemptedAt.Valid || receipt.SessionID != string(r.SessionID) || a.Spec.Text != r.Payload || domain.OuterDigest(r.Sources) != domain.OuterDigest(p.Plan.Sources) {
		return domain.ErrOuterHeld
	}
	if a.Spec.Operation == "spawn" {
		row, err := q.GetSession(ctx, r.SessionID)
		if err != nil {
			return err
		}
		rec := rowToRecord(row)
		if rec.Kind != domain.KindWorker || rec.ProjectID != domain.ProjectID(a.Spec.ProjectID) || rec.Metadata.Branch != a.Spec.Branch || rec.Metadata.WorkspacePath == "" || rec.Metadata.Model != a.Spec.Config.Model || rec.Metadata.Effort != a.Spec.Config.Effort || rec.Metadata.Permissions != a.Spec.Config.Permissions {
			return domain.ErrOuterHeld
		}
		p, err := q.GetProject(ctx, rec.ProjectID)
		if err != nil || projectRowFromGen(p).Revision != a.ProjectRevision || domain.OuterDigest(projectRowFromGen(p)) != a.TargetDigest {
			return domain.ErrOuterHeld
		}
	} else if a.Spec.Operation != "send" || a.Spec.SessionID != r.SessionID {
		return domain.ErrOuterHeld
	} else if err := validateOuterPlannedTarget(ctx, q, a); err != nil {
		return err
	}
	return nil
}

// CheckOuterExecution revalidates a private attempted instance at its service boundary.
func (s *Store) CheckOuterExecution(ctx context.Context, operation string, project domain.ProjectID, session domain.SessionID) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok {
		return domain.ErrOuterHeld
	}
	p, err := s.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return err
	}
	if p.ApprovedAt.IsZero() || !time.Now().Before(p.ExpiresAt) {
		return domain.ErrOuterHeld
	}
	if err := validateOuterPlan(ctx, s.conversationReader(ctx), p.Plan, time.Now()); err != nil {
		return err
	}
	index := slices.IndexFunc(p.Plan.Actions, func(a domain.OuterPlannedAction) bool { return a.ID == e.ActionID })
	if index < 0 {
		return domain.ErrOuterHeld
	}
	a := p.Plan.Actions[index]
	r := p.Actions[index]
	if a.Spec.Operation != operation || a.Spec.ProjectID != string(project) || (session != "" && a.Spec.SessionID != session && r.SessionID != session) || r.AttemptedAt.IsZero() || !r.CompletedAt.IsZero() {
		return domain.ErrOuterHeld
	}
	return validateOuterPlannedTarget(ctx, s.conversationReader(ctx), a)
}
