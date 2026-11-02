package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

const outerReviewSessionPrefix = "review-session:"

// IssueOuterReviewSessionGeneration bootstraps a process credential, not result
// authority. Only an approved turn can bind it to a run. The secret goes solely
// to the owned reviewer's launch environment and is never returned by an API.
func (s *Store) IssueOuterReviewSessionGeneration(ctx context.Context, reviewID, generation string) (string, error) {
	reviewer, found, err := s.GetReviewByID(ctx, reviewID)
	if err != nil || !found || generation == "" || reviewer.IsArchived || reviewer.Harness != domain.ReviewerCodex || reviewer.InterfaceMode != domain.ReviewerInterfaceChat {
		return "", domain.ErrOuterHeld
	}
	if _, err := s.OuterReviewSpec(ctx, "review.trigger", reviewer.SessionID); err != nil {
		return "", err
	}
	worker, found, err := s.GetSession(ctx, reviewer.SessionID)
	if err != nil || !found || worker.IsTerminated || worker.ProjectID != reviewer.ProjectID {
		return "", domain.ErrOuterHeld
	}
	scope := domain.OuterReviewResultScope{ReviewID: reviewID, Generation: s.callerGeneration(worker, "review", generation)}
	document, err := json.Marshal(scope)
	if err != nil {
		return "", err
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret[:])
	if err := s.writeMu.LockContext(ctx); err != nil {
		return "", err
	}
	defer s.writeMu.Unlock()
	if err := s.CheckOuterOperation(ctx, "review.trigger", reviewer.ProjectID, reviewer.SessionID); err != nil {
		return "", err
	}
	err = s.inTx(ctx, "bootstrap reviewer session credential", func(q *gen.Queries) error {
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "review.session.scope", State: "issued", ProjectID: string(reviewer.ProjectID), SessionID: reviewer.SessionID, Generation: generation, Reason: "owned process environment only; no active result binding"}); err != nil {
			return err
		}
		return q.IssueOuterCaller(ctx, gen.IssueOuterCallerParams{Verifier: callerVerifier(token), SessionID: string(worker.ID), ProjectID: string(worker.ProjectID), Generation: outerReviewSessionPrefix + string(document)})
	})
	return token, err
}

// CheckOuterReviewSession holds legacy reviewers before the engine changes
// their activity or creates a run. BindOuterReviewResult rechecks at dispatch.
func (s *Store) CheckOuterReviewSession(ctx context.Context, reviewID string) error {
	reviewer, found, err := s.GetReviewByID(ctx, reviewID)
	if err != nil || !found || reviewer.ControllerGeneration == "" {
		return errors.Join(domain.ErrOuterHeld, domain.ErrOuterReviewNotStarted)
	}
	if _, err := s.OuterReviewSpec(ctx, "review.trigger", reviewer.SessionID); err != nil {
		return err
	}
	worker, found, err := s.GetSession(ctx, reviewer.SessionID)
	if err != nil || !found {
		return domain.ErrOuterHeld
	}
	count, err := s.qr.CountOuterReviewSessions(ctx, gen.CountOuterReviewSessionsParams{SessionID: string(worker.ID), ReviewID: reviewID, Generation: s.callerGeneration(worker, "review", reviewer.ControllerGeneration)})
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.Join(domain.ErrOuterHeld, domain.ErrOuterReviewNotStarted)
	}
	return nil
}

// BindOuterReviewResult rotates only daemon-side metadata. A live process without
// a matching launch credential must hold; no secret is minted or sent on a turn.
func (s *Store) BindOuterReviewResult(ctx context.Context, reviewID, generation string) error {
	reviewer, found, err := s.GetReviewByID(ctx, reviewID)
	if err != nil || !found || generation == "" || reviewer.ControllerGeneration != generation {
		return domain.ErrOuterHeld
	}
	spec, err := s.OuterReviewSpec(ctx, "review.trigger", reviewer.SessionID)
	if err != nil {
		return err
	}
	e, _ := domain.OuterExecutionFrom(ctx)
	runs, err := s.ListReviewRunsBySession(ctx, reviewer.SessionID)
	if err != nil {
		return err
	}
	var runID string
	for _, run := range runs {
		if run.ReviewID == reviewID && run.BatchID == e.ActionID && run.Status == domain.ReviewRunRunning && run.PRURL == spec.Review.PRURL && run.TargetSHA == spec.Review.HeadSHA {
			if runID != "" {
				return domain.ErrOuterHeld
			}
			runID = run.ID
		}
	}
	worker, found, err := s.GetSession(ctx, reviewer.SessionID)
	if err != nil || !found || runID == "" {
		return domain.ErrOuterHeld
	}
	scope := domain.OuterReviewResultScope{ReviewID: reviewID, RunID: runID, HeadSHA: spec.Review.HeadSHA, Generation: s.callerGeneration(worker, "review", generation)}
	document, err := json.Marshal(scope)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	if err := s.CheckOuterOperation(ctx, "review.trigger", reviewer.ProjectID, reviewer.SessionID); err != nil {
		return err
	}
	return s.inTx(ctx, "bind exact reviewer result scope", func(q *gen.Queries) error {
		count, err := q.BindOuterReviewSession(ctx, gen.BindOuterReviewSessionParams{SessionID: string(worker.ID), ReviewID: reviewID, Generation: scope.Generation, NextGeneration: outerReviewSessionPrefix + string(document)})
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.Join(domain.ErrOuterHeld, domain.ErrOuterReviewNotStarted)
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "review.result.scope", State: "bound", ProjectID: string(reviewer.ProjectID), SessionID: reviewer.SessionID, ReceiptID: runID, RequestID: e.ActionID, Generation: generation, Reason: "exact run/head binding on existing process credential; no feedback or turn authority"})
	})
}

func (s *Store) authenticateOuterReviewCaller(ctx context.Context, row gen.OuterCaller) (domain.OuterCaller, error) {
	var scope domain.OuterReviewResultScope
	if row.OuterScope != 0 || json.Unmarshal([]byte(strings.TrimPrefix(row.Generation, outerReviewSessionPrefix)), &scope) != nil {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	caller := domain.OuterCaller{ProjectID: domain.ProjectID(row.ProjectID), SessionID: domain.SessionID(row.SessionID), Generation: row.Generation, ReviewResult: &scope}
	if err := s.checkOuterReviewResult(ctx, caller, caller.SessionID, scope.RunID); err != nil {
		return domain.OuterCaller{}, err
	}
	return caller, nil
}

func (s *Store) checkOuterReviewResult(ctx context.Context, caller domain.OuterCaller, workerID domain.SessionID, runID string) error {
	scope := caller.ReviewResult
	if scope == nil || caller.Outer || caller.SessionID != workerID || scope.RunID != runID || scope.ReviewID == "" || !domain.FullCommit(scope.HeadSHA) {
		return domain.ErrOuterHeld
	}
	// Also fence contexts authenticated before a later approved turn revoked
	// this scope. The verdict writer invokes this under the common writer lock.
	exists, err := s.qr.OuterCallerGenerationExists(ctx, gen.OuterCallerGenerationExistsParams{SessionID: string(workerID), Generation: caller.Generation})
	if err != nil || !exists {
		return domain.ErrOuterHeld
	}
	run, found, err := s.GetReviewRun(ctx, runID)
	if err != nil || !found || run.SessionID != workerID || run.ReviewID != scope.ReviewID || run.TargetSHA != scope.HeadSHA || run.Harness != domain.ReviewerCodex || (run.Status != domain.ReviewRunRunning && run.Status != domain.ReviewRunComplete) {
		return domain.ErrOuterHeld
	}
	reviewer, found, err := s.GetReviewByID(ctx, scope.ReviewID)
	if err != nil || !found || reviewer.IsArchived || reviewer.SessionID != workerID || reviewer.ProjectID != caller.ProjectID || reviewer.Harness != domain.ReviewerCodex || reviewer.InterfaceMode != domain.ReviewerInterfaceChat || reviewer.ControllerGeneration == "" || reviewer.ProviderConversationID == "" {
		return domain.ErrOuterHeld
	}
	worker, found, err := s.GetSession(ctx, workerID)
	if err != nil || !found || worker.IsTerminated || worker.ProjectID != caller.ProjectID || s.callerGeneration(worker, "review", reviewer.ControllerGeneration) != scope.Generation {
		return domain.ErrOuterHeld
	}
	request, err := s.GetOuterRequest(ctx, run.BatchID)
	if err != nil || request.AcceptedAt.IsZero() || request.Request.ReviewID != reviewer.ID || request.Request.SessionID != workerID || request.Request.ControllerGeneration != reviewer.ControllerGeneration || request.Request.ProviderConversationID != reviewer.ProviderConversationID {
		return domain.ErrOuterHeld
	}
	plan, err := s.GetOuterPlan(ctx, request.Request.PlanID)
	if err != nil || plan.ApprovedAt.IsZero() {
		return domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found || !slices.Contains(b.ProjectIDs, string(caller.ProjectID)) {
		return domain.ErrOuterHeld
	}
	for _, action := range plan.Plan.Actions {
		if action.ID == run.BatchID && action.Spec.Operation == "review.trigger" && action.Spec.SessionID == workerID && action.Spec.ProjectID == string(caller.ProjectID) && action.Spec.Review != nil && action.Spec.Review.HeadSHA == run.TargetSHA && action.Spec.Review.PRURL == run.PRURL {
			return nil
		}
	}
	return domain.ErrOuterHeld
}

func (s *Store) CheckOuterReviewSubmission(ctx context.Context, workerID domain.SessionID, runs []string) error {
	caller, scoped := domain.OuterCallerFrom(ctx)
	if scoped && caller.ReviewResult != nil {
		if len(runs) != 1 {
			return domain.ErrOuterHeld
		}
		return s.checkOuterReviewResult(ctx, caller, workerID, runs[0])
	}
	if scoped && caller.Outer {
		return domain.ErrOuterHeld
	}
	if held, err := s.IsOuterParticipant(ctx, workerID); err != nil {
		return err
	} else if held {
		return domain.ErrOuterHeld
	}
	return nil
}
