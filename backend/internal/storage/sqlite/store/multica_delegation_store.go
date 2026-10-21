package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func decodeDelegation(document string, err error) (domain.MulticaDelegationRecord, error) {
	var record domain.MulticaDelegationRecord
	if err != nil {
		return record, err
	}
	if err := domain.StrictDelegationJSON([]byte(document), &record); err != nil {
		return record, err
	}
	return record.Normalize()
}

// GetMulticaDelegation reads and verifies a request, including earlier reruns.
func (s *Store) GetMulticaDelegation(ctx context.Context, id string) (domain.MulticaDelegationRecord, error) {
	return decodeDelegation(s.qr.GetMulticaDelegation(ctx, id))
}

// FindMulticaDelegation finds the current confirmed request for an AO task.
func (s *Store) FindMulticaDelegation(ctx context.Context, projectID, taskID string) (domain.MulticaDelegationRecord, error) {
	return decodeDelegation(s.qr.FindMulticaDelegation(ctx, gen.FindMulticaDelegationParams{ProjectID: projectID, TaskID: taskID}))
}

// ReserveMulticaDelegation atomically journals intent or reuses an existing request.
func (s *Store) ReserveMulticaDelegation(ctx context.Context, record domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error) {
	normalized, err := record.Normalize()
	if err != nil {
		return record, err
	}
	record = normalized
	if record.Version != 0 || record.State != "submitting" || record.Attempted || string(record.Remote) != "null" || string(record.Cancellation) != "null" {
		return record, domain.ErrDelegationInvalid
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return record, err
	}
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return record, err
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	confirmed, err := decodeDelegation(q.FindMulticaDelegationConfirmation(ctx, record.ConfirmationID))
	if err == nil {
		candidate := record
		candidate.RequestID = confirmed.RequestID
		if !confirmed.SameIntent(candidate) {
			return record, domain.ErrDelegationConflict
		}
		return confirmed, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return record, err
	}
	current, err := decodeDelegation(q.FindMulticaDelegation(ctx, gen.FindMulticaDelegationParams{ProjectID: record.ProjectID, TaskID: record.TaskID}))
	if err == nil {
		if record.RerunOf == "" {
			if current.PayloadHash == record.PayloadHash && domain.DelegationJSONEqual(current.Intent, record.Intent) {
				return current, nil
			}
			return record, domain.ErrDelegationConflict
		}
		if current.RequestID != record.RerunOf || (current.State != "terminal" && current.State != "rejected") {
			return record, domain.ErrDelegationConflict
		}
		count, err := q.RetireMulticaDelegation(ctx, gen.RetireMulticaDelegationParams{RequestID: record.RerunOf, ProjectID: record.ProjectID, TaskID: record.TaskID})
		if err != nil {
			return record, err
		}
		if count != 1 {
			return record, domain.ErrDelegationConflict
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return record, err
	} else if record.RerunOf != "" {
		return record, domain.ErrDelegationConflict
	}
	data, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	if err := q.InsertMulticaDelegation(ctx, gen.InsertMulticaDelegationParams{RequestID: record.RequestID, ProjectID: record.ProjectID, TaskID: record.TaskID, ConfirmationID: record.ConfirmationID, Document: string(data)}); err != nil {
		return record, err
	}
	if err := q.InsertMulticaDelegationTransition(ctx, gen.InsertMulticaDelegationTransitionParams{RequestID: record.RequestID, Version: 0, State: record.State, Document: string(data)}); err != nil {
		return record, err
	}
	return record, tx.Commit()
}

// SaveMulticaDelegation appends a transition with optimistic version checking.
func (s *Store) SaveMulticaDelegation(ctx context.Context, record domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error) {
	normalized, err := record.Normalize()
	if err != nil {
		return record, err
	}
	record = normalized
	if err := s.writeMu.LockContext(ctx); err != nil {
		return record, err
	}
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return record, err
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	old, err := decodeDelegation(q.GetMulticaDelegation(ctx, record.RequestID))
	if err != nil {
		return record, err
	}
	if !old.SameIntent(record) || old.Version != record.Version || old.Attempted && !record.Attempted || old.State == "terminal" || old.State == "rejected" || string(old.Cancellation) != "null" && !domain.DelegationJSONEqual(old.Cancellation, record.Cancellation) {
		return record, domain.ErrDelegationConflict
	}

	if string(old.Remote) != "null" && len(old.Remote) > 0 {
		var before, after struct {
			DelegationID string `json:"delegation_id"`
			TaskID       string `json:"task_id"`
		}
		if json.Unmarshal(old.Remote, &before) != nil || json.Unmarshal(record.Remote, &after) != nil || before != after {
			return record, domain.ErrDelegationConflict
		}
	}
	record.Version++
	data, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	count, err := q.UpdateMulticaDelegation(ctx, gen.UpdateMulticaDelegationParams{Version: record.Version, Document: string(data), RequestID: record.RequestID, Version_2: old.Version})
	if err != nil {
		return record, err
	}
	if count != 1 {
		return record, domain.ErrDelegationConflict
	}
	if err := q.InsertMulticaDelegationTransition(ctx, gen.InsertMulticaDelegationTransitionParams{RequestID: record.RequestID, Version: record.Version, State: record.State, Document: string(data)}); err != nil {
		return record, err
	}
	return record, tx.Commit()
}
