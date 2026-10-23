package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
	"github.com/google/uuid"
)

func (s *Store) OuterBinding(ctx context.Context) (domain.OuterBinding, bool, error) {
	doc, err := s.conversationReader(ctx).GetOuterBinding(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.OuterBinding{}, false, nil
	}
	if err != nil {
		return domain.OuterBinding{}, false, err
	}
	var b domain.OuterBinding
	err = json.Unmarshal([]byte(doc), &b)
	return b, err == nil, err
}

func (s *Store) SaveOuterBinding(ctx context.Context, b domain.OuterBinding, expected int64, event domain.OuterAudit) error {
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "save outer binding", func(q *gen.Queries) error {
		count, err := q.SaveOuterBinding(ctx, gen.SaveOuterBindingParams{ExpectedRevision: expected, Document: string(data)})
		if err != nil {
			return err
		}
		if count != 1 || b.Revision != expected+1 {
			return domain.ErrOuterHeld
		}
		return appendOuterAudit(ctx, q, event)
	})
}

func appendOuterAudit(ctx context.Context, q *gen.Queries, e domain.OuterAudit) error {
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	e.InstructionRevision = domain.OuterInstructionRevision
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return q.AppendOuterAudit(ctx, gen.AppendOuterAuditParams{ID: e.ID, Document: string(data)})
}

func (s *Store) AppendOuterAudit(ctx context.Context, e domain.OuterAudit) error {
	q, release := s.conversationWriter(ctx)
	defer release()
	return appendOuterAudit(ctx, q, e)
}

func (s *Store) PageOuterAudit(ctx context.Context, after int64, limit int) ([]domain.OuterAudit, error) {
	limit = min(max(limit, 1), 100)
	rows, err := s.conversationReader(ctx).PageOuterAudit(ctx, gen.PageOuterAuditParams{AfterSequence: after, PageSize: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterAudit, 0, len(rows))
	for _, row := range rows {
		var e domain.OuterAudit
		if err := json.Unmarshal([]byte(row.Document), &e); err != nil {
			return nil, err
		}
		e.Sequence = row.Sequence
		out = append(out, e)
	}
	return out, nil
}

func (s *Store) IsOuterSession(ctx context.Context, id domain.SessionID) (bool, error) {
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return false, err
	}
	r, found, err := s.GetSession(ctx, id)
	return found && string(r.ProjectID) == b.AnchorProjectID, err
}

func (s *Store) CheckOuterOperation(ctx context.Context, operation string, project domain.ProjectID, session domain.SessionID) error {
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return err
	}
	if session != "" {
		r, ok, err := s.GetSession(ctx, session)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrOuterHeld
		}
		project = r.ProjectID
	}
	caller, scoped := domain.OuterCallerFrom(ctx)
	if scoped && !caller.Outer && caller.ProjectID!=project {
		if err:=s.AppendOuterAudit(ctx,domain.OuterAudit{Operation:operation,State:"held",Reason:"wrong_project_credential",SessionID:caller.SessionID,ProjectID:string(project)});err!=nil{return err}
		return domain.ErrOuterHeld
	}
	if scoped && caller.Outer {
		if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "M1 cross-project mutations disabled", SessionID: caller.SessionID, ProjectID: string(project)}); err != nil {
			return err
		}
		return domain.ErrOuterHeld
	}
	guarded := string(project) == b.AnchorProjectID || slices.Contains(b.ProjectIDs, string(project)) || (project == "" && session == "")
	if !guarded {
		return nil
	}
	if a, ok := domain.OuterNativeActionFrom(ctx); ok && a.Operation == operation && a.ProjectID == project && (a.SessionID == session || a.SessionID == "") {
		return nil
	}
	if scoped && !caller.Outer && caller.ProjectID == project && string(project) != b.AnchorProjectID && operation!="native_only" && operation!="unclassified" {
		return nil
	}
	if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "native_or_scoped_authority_required", ProjectID: string(project), SessionID: session}); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}
