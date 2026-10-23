package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// GetFactoryRun reads the durable run header.
func (s *Store) GetFactoryRun(ctx context.Context, id string) (domain.FactoryRun, error) {
	document, err := s.qr.GetFactoryRun(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.FactoryRun{}, domain.ErrRunNotFound
	}
	var record domain.FactoryRun
	if err != nil {
		return record, err
	}
	err = json.Unmarshal([]byte(document), &record)
	return record, err
}

// ListFactoryRuns lists a project's immutable run identities and stage decisions.
func (s *Store) ListFactoryRuns(ctx context.Context, projectID string) ([]domain.FactoryRun, error) {
	documents, err := s.qr.ListFactoryRuns(ctx, projectID)
	if err != nil {
		return nil, err
	}
	records := make([]domain.FactoryRun, 0, len(documents))
	for _, document := range documents {
		var record domain.FactoryRun
		if err := json.Unmarshal([]byte(document), &record); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

// ListRunEvidence reads append-only receipts in version order.
func (s *Store) ListRunEvidence(ctx context.Context, id string) ([]domain.RunEvidence, error) {
	documents, err := s.qr.ListRunEvidence(ctx, id)
	if err != nil {
		return nil, err
	}
	records := make([]domain.RunEvidence, 0, len(documents))
	for _, document := range documents {
		var record domain.RunEvidence
		if err := json.Unmarshal([]byte(document), &record); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, nil
}

// SaveFactoryRun atomically compares immutable intent/version and appends evidence.
func (s *Store) SaveFactoryRun(ctx context.Context, record domain.FactoryRun, evidence domain.RunEvidence, create bool) error {
	if evidence.RunID != record.ID || evidence.Version != record.Version || record.Version < 0 || evidence.ID == "" {
		return domain.ErrRunConflict
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "save factory run", func(q *gen.Queries) error {
		document, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if create {
			if record.Version != 0 {
				return domain.ErrRunConflict
			}

			count, err := q.InsertFactoryRun(ctx, gen.InsertFactoryRunParams{ID: record.ID, ProjectID: record.ProjectID, SessionID: string(record.SessionID), Document: string(document)})
			if err != nil {
				return err
			}
			if count != 1 {
				return domain.ErrRunConflict
			}
		} else {
			if record.Version < 1 {
				return domain.ErrRunConflict
			}
			count, err := q.UpdateFactoryRun(ctx, gen.UpdateFactoryRunParams{NextVersion: record.Version, Document: string(document), ID: record.ID, ExpectedVersion: record.Version - 1})
			if err != nil {
				return err
			}
			if count != 1 {
				return domain.ErrRunConflict
			}
		}
		data, err := json.Marshal(evidence)
		if err != nil {
			return err
		}
		return q.InsertRunEvidence(ctx, gen.InsertRunEvidenceParams{ID: evidence.ID, RunID: record.ID, Version: record.Version, Document: string(data)})
	})
}
