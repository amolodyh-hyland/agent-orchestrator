package outer

import (
	"context"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
)

type Reviews interface {
	TriggerRequested(context.Context, domain.SessionID, reviewsvc.TriggerRequest) (reviewsvc.TriggerOutcome, error)
	Cancel(context.Context, domain.SessionID) (reviewcore.CancelResult, error)
}

func (s *Service) SetReviews(r Reviews) { s.reviews = r }

func (s *Service) prepareReview(ctx context.Context, a *domain.OuterPlannedAction) error {
	spec := a.Spec
	if s.reviews == nil || spec.Review == nil || spec.SessionID == "" || spec.Text != "" || spec.Branch != "" || spec.Config.Model == "" || spec.Config.Permissions != domain.PermissionModeAuto || spec.Config.Mode != "" || spec.Config.Validate() != nil || strings.TrimSpace(spec.Review.PRURL) == "" || len(spec.Review.HeadSHA) != 40 {
		return domain.ErrOuterHeld
	}
	rec, found, err := s.store.GetSession(ctx, spec.SessionID)
	if err != nil || !found || rec.IsTerminated || rec.Kind != domain.KindWorker || rec.Harness != domain.HarnessCodex || rec.Mode != domain.SessionModeChat || string(rec.ProjectID) != spec.ProjectID {
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
	a.Settings = domain.ConversationSettings{Model: spec.Config.Model, ReasoningEffort: spec.Config.Effort, ApprovalMode: domain.PermissionModeAuto}
	a.PermissionCeiling = domain.PermissionModeAuto
	if spec.Operation == "review.cancel" {
		st, ok := s.store.(interface {
			GetReviewRun(context.Context, string) (domain.ReviewRun, bool, error)
			GetReviewByID(context.Context, string) (domain.Review, bool, error)
		})
		if !ok {
			return domain.ErrOuterHeld
		}
		run, found, err := st.GetReviewRun(ctx, spec.Review.RunID)
		if err != nil || !found {
			return domain.ErrOuterHeld
		}
		review, found, err := st.GetReviewByID(ctx, run.ReviewID)
		if err != nil || !found {
			return domain.ErrOuterHeld
		}
		a.ReviewDigest = domain.OuterReviewDigest(review)
	}
	return nil
}

func (s *Service) executeReview(ctx context.Context, st actionStore, p domain.OuterPlanReceipt, a domain.OuterPlannedAction) error {
	if s.reviews == nil {
		return domain.ErrOuterHeld
	}
	if a.Spec.Operation == "review.cancel" {
		ctx = domain.WithOuterExecution(ctx, domain.OuterExecution{PlanID: p.Plan.ID, ActionID: a.ID, AdmitControl: func(writeCtx context.Context) (func(), error) {
			s.mu.Lock()
			if writeCtx.Err() != nil || !s.now().Before(p.ExpiresAt) {
				s.mu.Unlock()
				return nil, domain.ErrOuterHeld
			}
			if err := s.store.CheckOuterOperation(writeCtx, "review.cancel", domain.ProjectID(a.Spec.ProjectID), a.Spec.SessionID); err != nil {
				s.mu.Unlock()
				return nil, err
			}
			if !s.now().Before(p.ExpiresAt) {
				s.mu.Unlock()
				return nil, domain.ErrOuterHeld
			}
			return s.mu.Unlock, nil
		}})
		if _, err := s.reviews.Cancel(ctx, a.Spec.SessionID); err != nil {
			return err
		}
		return st.CompleteOuterPlanAction(ctx, a.ID, "completed", s.now().UTC())
	}
	if err := st.EnrollOuterParticipant(ctx, p.Plan.ID, a.ID, a.Spec.SessionID, s.now().UTC()); err != nil {
		return err
	}
	if err := st.ReserveOuterCapacity(ctx, domain.OuterCapacity{RequestID: a.ID, Generation: p.Plan.Epoch, ReservedAt: s.now().UTC()}); err != nil {
		return err
	}
	_, err := s.reviews.TriggerRequested(ctx, a.Spec.SessionID, reviewsvc.TriggerRequest{Harness: domain.ReviewerCodex, Config: a.Spec.Config, Source: domain.ReviewTriggerManual, InterfaceMode: domain.ReviewerInterfaceChat, PRURL: a.Spec.Review.PRURL, RejectReviewedHead: true})
	if errors.Is(err, domain.ErrOuterReviewNotStarted) {
		noStart, ok := s.store.(interface {
			RecordOuterReviewNoStart(context.Context, string) error
		})
		if !ok {
			return domain.ErrOuterHeld
		}
		return errors.Join(err, noStart.RecordOuterReviewNoStart(context.WithoutCancel(ctx), a.ID))
	}
	return err
}
