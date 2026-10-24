package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func outerSessionInsert(ctx context.Context, q *gen.Queries, rec domain.SessionRecord, num int64) error {
	a, native := domain.OuterNativeActionFrom(ctx)
	if !native || a.Operation != "spawn" || a.ProjectID != rec.ProjectID || rec.Kind != domain.KindOrchestrator {
		return domain.ErrOuterHeld
	}
	document, err := q.GetOuterBinding(ctx)
	if err != nil {
		return err
	}
	var binding domain.OuterBinding
	if json.Unmarshal([]byte(document), &binding) != nil || binding.AnchorProjectID != string(rec.ProjectID) || binding.Generation != rec.Metadata.OuterGeneration {
		return domain.ErrOuterHeld
	}
	if err := q.InsertSession(ctx, recordToInsert(rec, num)); err != nil {
		return err
	}
	if err := q.RecordOuterSessionGeneration(ctx, gen.RecordOuterSessionGenerationParams{SessionID: string(rec.ID), ProjectID: string(rec.ProjectID), Generation: rec.Metadata.OuterGeneration}); err != nil {
		return err
	}
	return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.session.record", State: "recorded", SessionID: rec.ID, ProjectID: string(rec.ProjectID)})
}

// Old migration fixtures intentionally operate on a schema predating M1.
// Outer generations are immutable side records so those old session formats
// remain readable without weakening any bound outer's input predicate.
func (s *Store) withOuterSessionGeneration(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	if rec.Kind != domain.KindOrchestrator {
		return rec, nil
	}
	generation, err := s.conversationReader(ctx).GetOuterSessionGeneration(ctx, string(rec.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return rec, nil
	}
	if err != nil && strings.Contains(err.Error(), "no such table: outer_session_generations") {
		_, bindingErr := s.conversationReader(ctx).GetOuterBinding(ctx)
		if bindingErr == nil {
			return rec, domain.ErrOuterHeld
		}
		if errors.Is(bindingErr, sql.ErrNoRows) || strings.Contains(bindingErr.Error(), "no such table: outer_binding") {
			return rec, nil
		}
		return rec, bindingErr
	}
	rec.Metadata.OuterGeneration = generation
	return rec, err
}

// RecordOuterNativeAction journals one exact immutable native action with its audit record.
func (s *Store) RecordOuterNativeAction(ctx context.Context, id string, document []byte) error {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.ActionID != id || len(id) < 16 || len(id) > 128 || !json.Valid(document) || len(document) > 256<<10 {
		return domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "journal exact native action", func(q *gen.Queries) error {
		if err := q.RecordOuterNativeAction(ctx, gen.RecordOuterNativeActionParams{ID: id, Document: string(document)}); err != nil {
			return err
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.native.action", State: "recorded", RequestID: id, Digest: domain.OuterDigest(string(document))})
	})
}

// ListOuterHostRequests retains receipt visibility across outer conversation generations.
func (s *Store) ListOuterHostRequests(ctx context.Context) ([]domain.OuterRequestReceipt, error) {
	rows, err := s.qr.ListOuterHostRequests(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterRequestReceipt, 0, len(rows))
	for _, row := range rows {
		r, err := outerReceipt(row)
		if err != nil {
			return nil, err
		}
		out = append(out, s.decorateOuterReceipt(ctx, r))
	}
	return out, nil
}

func (s *Store) decorateOuterReceipt(ctx context.Context, r domain.OuterRequestReceipt) domain.OuterRequestReceipt {
	if r.TurnID != "" && r.AttemptedAt.IsZero() {
		if turn, err := s.TurnByID(ctx, r.TurnID); err == nil && turn.CompletedAt != nil {
			r.State = "held"
		}
	}
	return r
}
