package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// ApprovedActiveFactoryRuns returns natively confirmed run references.
func (s *Store) ApprovedActiveFactoryRuns(ctx context.Context) ([]domain.FactoryRun, error) {
	docs, err := s.qr.ApprovedActiveFactoryRuns(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.FactoryRun, 0, len(docs))
	for _, doc := range docs {
		var r domain.FactoryRun
		if err := json.Unmarshal([]byte(doc), &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// FactoryFeedbackHeld applies the passive policy to run workers and report recipients.
func (s *Store) FactoryFeedbackHeld(ctx context.Context, id domain.SessionID) (bool, error) {
	return s.qr.FactoryFeedbackHeld(ctx, id)
}

// GetRunMonitor reads the last durable observation snapshot.
func (s *Store) GetRunMonitor(ctx context.Context, id string) (domain.RunMonitoring, bool, error) {
	doc, err := s.qr.GetRunMonitor(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.RunMonitoring{}, false, nil
	}
	var m domain.RunMonitoring
	if err != nil {
		return m, false, err
	}
	err = json.Unmarshal([]byte(doc), &m)
	return m, err == nil, err
}

// SaveRunMonitor persists display settings, preflight snapshots and attention.
func (s *Store) SaveRunMonitor(ctx context.Context, m domain.RunMonitoring) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.qw.SaveRunMonitor(ctx, gen.SaveRunMonitorParams{RunID: m.RunID, Document: string(data)})
}
