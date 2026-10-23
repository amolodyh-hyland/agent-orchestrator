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

// ApprovedFactoryRunPage reads a bounded exclusive-cursor page of approved references.
func (s *Store) ApprovedFactoryRunPage(ctx context.Context, project, after string, limit int64) ([]domain.FactoryRun, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("monitoring page size must be 1..101")
	}
	docs, err := s.qr.ApprovedFactoryRunPage(ctx, gen.ApprovedFactoryRunPageParams{ProjectID: project, AfterID: after, PageSize: limit})
	if err != nil {
		return nil, err
	}
	out := make([]domain.FactoryRun, 0, len(docs))
	for _, doc := range docs {
		var run domain.FactoryRun
		if err := json.Unmarshal([]byte(doc), &run); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, nil
}

// GetFactoryMonitorCursor reads the last attempted reference for a sweep scope.
func (s *Store) GetFactoryMonitorCursor(ctx context.Context, scope string) (string, error) {
	after, err := s.qr.GetFactoryMonitorCursor(ctx, scope)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return after, err
}

// SaveFactoryMonitorCursor advances before observation so interruption retains progress.
func (s *Store) SaveFactoryMonitorCursor(ctx context.Context, scope, after string) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.qw.SaveFactoryMonitorCursor(ctx, gen.SaveFactoryMonitorCursorParams{Scope: scope, AfterID: after})
}

// FactoryMonitorParticipants loads only named workers and active report recipients.
func (s *Store) FactoryMonitorParticipants(ctx context.Context, project string, worker domain.SessionID) ([]domain.SessionRecord, error) {
	projectID := domain.ProjectID(project)
	ids, err := s.qr.FactoryMonitorParticipants(ctx, gen.FactoryMonitorParticipantsParams{ProjectID: &projectID, WorkerID: worker})
	if err != nil {
		return nil, err
	}
	out := make([]domain.SessionRecord, 0, len(ids))
	for _, id := range ids {
		session, found, err := s.GetSession(ctx, id)
		if err != nil {
			return nil, err
		}
		if found {
			out = append(out, session)
		}
	}
	return out, nil
}

// FactoryMonitorReports reads at most 100 recent metadata rows without hydrating bodies or outputs.
func (s *Store) FactoryMonitorReports(ctx context.Context, id domain.SessionID, stageAt time.Time) ([]domain.ReportRecord, error) {
	rows, err := s.qr.FactoryMonitorReports(ctx, gen.FactoryMonitorReportsParams{SessionID: string(id), StageAt: stageAt})
	if err != nil {
		return nil, err
	}
	out := make([]domain.ReportRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.ReportRecord{ID: row.ID, ProjectID: domain.ProjectID(row.ProjectID), CreatedAt: row.CreatedAt, DeliveryState: domain.ReportDeliveryState(row.DeliveryState), DeliveryBatchID: row.DeliveryBatchID})
	}
	return out, nil
}

// FactoryMonitorPolicies snapshots bounded feedback metadata without hydrating provider bodies.
func (s *Store) FactoryMonitorPolicies(ctx context.Context, id domain.SessionID) ([]string, error) {
	policies, err := s.qr.FactoryMonitorPolicies(ctx, id)
	if err != nil {
		return nil, err
	}
	if len(policies) > 1000 {
		policies = append(policies[:1000], "additional_feedback_policies:held")
	}
	return policies, nil
}
