package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func validateOuterReview(ctx context.Context, q *gen.Queries, a domain.OuterPlannedAction) error {
	spec := a.Spec
	if spec.Review == nil || spec.SessionID == "" || spec.Text != "" || spec.Branch != "" || spec.Config.Model == "" || spec.Config.Mode != "" || spec.Config.Permissions != domain.PermissionModeAuto || spec.Config.Validate() != nil || len(spec.Review.HeadSHA) != 40 {
		return domain.ErrOuterHeld
	}
	prs, err := q.ListPRsBySession(ctx, spec.SessionID)
	if err != nil {
		return err
	}
	owned := false
	for _, pr := range prs {
		if pr.URL == spec.Review.PRURL && pr.HeadSha == spec.Review.HeadSHA && pr.IsClosed == 0 && pr.IsMerged == 0 {
			owned = true
		}
	}
	if !owned {
		return domain.ErrOuterHeld
	}
	runs, err := q.ListReviewRunsBySession(ctx, spec.SessionID)
	if err != nil {
		return err
	}
	if spec.Operation == "review.cancel" {
		count := 0
		for _, run := range runs {
			if run.Status != domain.ReviewRunRunning {
				continue
			}
			if run.ID != spec.Review.RunID || run.PRURL != spec.Review.PRURL || run.TargetSha != spec.Review.HeadSHA || run.Harness != domain.ReviewerCodex {
				return domain.ErrOuterHeld
			}
			review, err := q.GetReviewByID(ctx, run.ReviewID)
			if err != nil || review.InterfaceMode != string(domain.ReviewerInterfaceChat) || review.IsArchived || domain.OuterReviewDigest(reviewFromReview(review)) != a.ReviewDigest {
				return domain.ErrOuterHeld
			}
			count++
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		return nil
	}
	if spec.Operation != "review.trigger" || spec.Review.RunID != "" {
		return domain.ErrOuterHeld
	}
	for _, run := range runs {
		if run.BatchID == a.ID && run.Harness == domain.ReviewerCodex && run.PRURL == spec.Review.PRURL && run.TargetSha == spec.Review.HeadSHA && run.Status == domain.ReviewRunRunning {
			continue
		}
		if run.Status == domain.ReviewRunRunning || (run.PRURL == spec.Review.PRURL && run.TargetSha == spec.Review.HeadSHA) {
			return domain.ErrOuterHeld
		}
	}
	reviews, err := q.ListReviewsBySession(ctx, spec.SessionID)
	if err != nil {
		return err
	}
	for _, r := range reviews {
		if r.Harness != domain.ReviewerCodex || r.InterfaceMode != string(domain.ReviewerInterfaceChat) || r.IsArchived {
			return domain.ErrOuterHeld
		}
	}
	return nil
}

func (s *Store) OuterReviewSpec(ctx context.Context, op string, id domain.SessionID) (domain.OuterActionSpec, error) {
	if err := s.CheckOuterOperation(ctx, op, "", id); err != nil {
		return domain.OuterActionSpec{}, err
	}
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok {
		return domain.OuterActionSpec{}, domain.ErrOuterHeld
	}
	p, err := s.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return domain.OuterActionSpec{}, err
	}
	for _, a := range p.Plan.Actions {
		if a.ID == e.ActionID && a.Spec.Operation == op && a.Spec.SessionID == id {
			return a.Spec, nil
		}
	}
	return domain.OuterActionSpec{}, domain.ErrOuterHeld
}

func (s *Store) BindOuterReviewRequest(ctx context.Context, reviewID, text, batchMessageID string) (domain.OuterRequest, error) {
	review, found, err := s.GetReviewByID(ctx, reviewID)
	if err != nil || !found {
		return domain.OuterRequest{}, domain.ErrOuterHeld
	}
	spec, err := s.OuterReviewSpec(ctx, "review.trigger", review.SessionID)
	if err != nil {
		return domain.OuterRequest{}, err
	}
	e, _ := domain.OuterExecutionFrom(ctx)
	if batchMessageID != "review-batch:"+e.ActionID {
		return domain.OuterRequest{}, domain.ErrOuterHeld
	}
	p, err := s.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return domain.OuterRequest{}, err
	}
	conv, err := s.ConversationForReview(ctx, reviewID)
	if err != nil || conv.Settings.Model != spec.Config.Model || conv.Settings.ReasoningEffort != spec.Config.Effort || conv.Settings.ApprovalMode != domain.PermissionModeAuto {
		return domain.OuterRequest{}, domain.ErrOuterHeld
	}
	r := p.Plan.Request
	r.ID, r.PlanID, r.OwnerSessionID, r.SessionID, r.ReviewID = e.ActionID, e.PlanID, r.SessionID, review.SessionID, reviewID
	r.Payload, r.PayloadDigest = text, domain.OuterDigest(text)
	r.ConversationID, r.ControllerGeneration, r.ProviderConversationID = conv.ID, review.ControllerGeneration, review.ProviderConversationID
	r.SettingsDigest, r.Sources, r.IssuedAt, r.ExpiresAt = domain.OuterDigest(conv.Settings), p.Plan.Sources, time.Now().UTC(), p.ExpiresAt
	if strings.TrimSpace(text) == "" || len(text) > 128<<10 {
		return r, domain.ErrOuterHeld
	}
	ctx = domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.send", SessionID: r.SessionID, RequestID: r.ID})
	return r, s.CreateOuterRequest(ctx, r)
}

func (s *Store) RecordOuterReviewNoStart(ctx context.Context, id string) error {
	e, ok := domain.OuterExecutionFrom(ctx)
	if !ok || e.ActionID != id {
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
	aIndex := -1
	for i, a := range p.Plan.Actions {
		if a.ID == id && a.Spec.Operation == "review.trigger" {
			aIndex = i
		}
	}
	if aIndex < 0 || p.ApprovedAt.IsZero() {
		return domain.ErrOuterHeld
	}
	return s.inTx(ctx, "record definitive reviewer no-start", func(q *gen.Queries) error {
		row, err := q.GetOuterPlanAction(ctx, id)
		if err != nil || !row.AttemptedAt.Valid || row.CompletedAt.Valid {
			return domain.ErrOuterHeld
		}
		if _, err := q.GetOuterRequest(ctx, id); !errors.Is(err, sql.ErrNoRows) {
			return domain.ErrOuterHeld
		}
		reservations, err := q.ListOuterCapacity(ctx)
		if err != nil {
			return err
		}
		matched := false
		for _, r := range reservations {
			if r.RequestID == id && r.SessionID == "" && r.Generation == p.Plan.Epoch {
				matched = true
			}
		}
		if !matched {
			return domain.ErrOuterHeld
		}
		now := time.Now().UTC()
		count, err := q.ReleaseOuterCapacity(ctx, gen.ReleaseOuterCapacityParams{RequestID: id, ReleasedAt: nullTime(now), ReleaseEvidence: "definitive_no_start:review_preflight"})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		if err := q.CompleteOuterPlanAction(ctx, gen.CompleteOuterPlanActionParams{ID: id, State: "not_started", CompletedAt: nullTime(now)}); err != nil {
			return err
		}
		a := p.Plan.Actions[aIndex]
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.review.no_start", State: "not_started", ReceiptID: id, RequestID: p.Plan.Request.ID, ProjectID: a.Spec.ProjectID, SessionID: a.Spec.SessionID, Sources: p.Plan.Sources, Reason: "definitive preflight failure; reviewer station released without a retry"})
	})
}
