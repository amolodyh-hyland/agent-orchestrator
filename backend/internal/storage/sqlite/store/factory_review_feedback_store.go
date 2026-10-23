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

// FactoryRunsForSession returns run membership without changing execution.
func (s *Store) FactoryRunsForSession(ctx context.Context, id domain.SessionID) ([]domain.FactoryRun, error) {
	documents, err := s.qr.FactoryRunsForSession(ctx, string(id))
	if err != nil {
		return nil, err
	}
	runs := make([]domain.FactoryRun, 0, len(documents))
	for _, doc := range documents {
		var r domain.FactoryRun
		if err := json.Unmarshal([]byte(doc), &r); err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, nil
}

// ReserveFactoryFeedback seals a native-approved binding and fences older unsubmitted authority.
func (s *Store) ReserveFactoryFeedback(ctx context.Context, b domain.RunFeedbackBinding) error {
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "reserve factory feedback", func(q *gen.Queries) error {
		if _, err := q.GetFactoryFeedback(ctx, b.ID); err == nil {
			return domain.ErrRunConflict
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := q.SupersedeFactoryFeedback(ctx, gen.SupersedeFactoryFeedbackParams{RunID: b.RunID, Round: int64(b.Round)}); err != nil {
			return err
		}
		count, err := q.ReserveFactoryFeedback(ctx, gen.ReserveFactoryFeedbackParams{ID: b.ID, RunID: b.RunID, RepoName: b.RepoName, Round: int64(b.Round), Document: string(data), ExpectedVersion: b.RunVersion})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrRunConflict
		}
		return nil
	})
}

// ListFactoryFeedback returns retained round delivery facts.
func (s *Store) ListFactoryFeedback(ctx context.Context, id string) ([]domain.RunFeedbackReceipt, error) {
	rows, err := s.qr.ListFactoryFeedback(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RunFeedbackReceipt, 0, len(rows))
	for _, row := range rows {
		receipt, err := s.factoryFeedbackReceipt(ctx, row)
		if err != nil {
			return nil, err
		}
		out = append(out, receipt)
	}
	return out, nil
}

// GetFactoryFeedback reads one immutable authority binding and its receipt.
func (s *Store) GetFactoryFeedback(ctx context.Context, id string) (domain.RunFeedbackReceipt, error) {
	row, err := s.qr.GetFactoryFeedback(ctx, id)
	if err != nil {
		return domain.RunFeedbackReceipt{}, err
	}
	return s.factoryFeedbackReceipt(ctx, row)
}
func (s *Store) factoryFeedbackReceipt(ctx context.Context, row gen.FactoryReviewFeedback) (domain.RunFeedbackReceipt, error) {
	r := domain.RunFeedbackReceipt{Active: row.Active != 0, State: "approved", AttemptedAt: timeFromNull(row.AttemptedAt), SubmittedAt: timeFromNull(row.SubmittedAt), AcceptedAt: timeFromNull(row.AcceptedAt), ProviderTurnID: row.ProviderTurnID, ProviderConversationID: row.ProviderConversationID}
	if err := json.Unmarshal([]byte(row.Document), &r.Binding); err != nil {
		return r, err
	}
	turn, err := s.qr.FactoryFeedbackTurn(ctx, row.ID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return r, err
	}
	if err == nil {
		r.TurnID = turn.ID
		r.State = "held"
		if turn.State == domain.TurnStateQueued {
			r.State = "ao_queued"
		}
	}
	if row.DeliveryError != "" {
		r.State = "unknown"
		r.HoldReason = row.DeliveryError
	}
	if !r.AttemptedAt.IsZero() {
		r.State = "unknown"
	}
	if !r.SubmittedAt.IsZero() {
		r.State = "provider_submitted"
	}
	if !r.AcceptedAt.IsZero() {
		r.State = "native_accepted"
		r.HoldReason = ""
	}
	return r, nil
}

// AttemptFactoryFeedback atomically checks live authority before transport submission.
func (s *Store) AttemptFactoryFeedback(ctx context.Context, id string, at time.Time) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	count, err := s.qw.AttemptFactoryFeedback(ctx, gen.AttemptFactoryFeedbackParams{ID: id, AttemptedAt: nullTime(at), NowRfc3339: at.UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return err
	}
	if count != 1 {
		return domain.ErrRunConflict
	}
	return nil
}

// FactoryFeedbackControl reads the current pause and revocation revision.
func (s *Store) FactoryFeedbackControl(ctx context.Context, id string) (int64, bool, error) {
	row, err := s.qr.FactoryFeedbackControl(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return row.Revision, row.Paused != 0, err
}

// SetFactoryFeedbackControl compares and advances the feedback control revision.
func (s *Store) SetFactoryFeedbackControl(ctx context.Context, id string, revision int64, paused bool) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	current, _, err := s.FactoryFeedbackControl(ctx, id)
	if err != nil {
		return err
	}
	if current != revision {
		return domain.ErrRunConflict
	}
	value := int64(0)
	if paused {
		value = 1
	}
	count, err := s.qw.SetFactoryFeedbackControl(ctx, gen.SetFactoryFeedbackControlParams{RunID: id, Paused: value, ExpectedRevision: revision})
	if err != nil {
		return err
	}
	if count != 1 {
		return domain.ErrRunConflict
	}
	return nil
}

// HoldFactoryFeedback records a lost delivery return without implying no submission.
func (s *Store) HoldFactoryFeedback(ctx context.Context, id string) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.qw.HoldFactoryFeedback(ctx, id)
}
