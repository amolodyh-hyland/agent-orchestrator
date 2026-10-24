package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// OuterBinding reads the singleton host anchor and allowlist binding.
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

// SaveOuterBinding atomically compares the binding revision and appends its audit event.
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
	if a, ok := domain.OuterNativeActionFrom(ctx); ok && e.RequestID == "" {
		e.RequestID = a.ActionID
	}
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	e.InstructionRevision = domain.OuterInstructionRevision
	projects := append([]string{}, e.ProjectIDs...)
	projects = append(projects, e.ProjectID)
	sources := e.Sources
	if e.RequestID != "" {
		request, err := q.GetOuterRequest(ctx, e.RequestID)
		if err == nil {
			var bound domain.OuterRequest
			if err := json.Unmarshal([]byte(request.Document), &bound); err != nil {
				return err
			}
			sources = append(append([]domain.OuterSource{}, sources...), bound.Sources...)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	for _, source := range sources {
		projects = append(projects, source.ProjectID)
		projects = append(projects, source.Sources...)
	}
	slices.Sort(projects)
	e.ProjectIDs = slices.DeleteFunc(slices.Compact(projects), func(id string) bool { return id == "" })
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return q.AppendOuterAudit(ctx, gen.AppendOuterAuditParams{ID: e.ID, Document: string(data)})
}

// AppendOuterAudit appends a safe logical event without replacing prior evidence.
func (s *Store) AppendOuterAudit(ctx context.Context, e domain.OuterAudit) error {
	q, release := s.conversationWriter(ctx)
	defer release()
	return appendOuterAudit(ctx, q, e)
}

// PageOuterAudit reads a bounded sequence cursor from the retained timeline.
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

// PageOuterProjectAudit selects affected-Project events before applying the page bound.
func (s *Store) PageOuterProjectAudit(ctx context.Context, project string, after int64, limit int) ([]domain.OuterAudit, error) {
	rows, err := s.conversationReader(ctx).PageOuterProjectAudit(ctx, gen.PageOuterProjectAuditParams{ProjectID: project, AfterSequence: after, PageSize: int64(min(max(limit, 1), 100))})
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

// IsOuterSession keeps every session owned by the anchor behind the outer target guard.
func (s *Store) IsOuterSession(ctx context.Context, id domain.SessionID) (bool, error) {
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return false, err
	}
	r, found, err := s.GetSession(ctx, id)
	return found && string(r.ProjectID) == b.AnchorProjectID, err
}

// CheckOuterOperation applies the common target-side mutation predicate.
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
	if _, executing := domain.OuterExecutionFrom(ctx); executing {
		return s.CheckOuterExecution(ctx, operation, project, session)
	}
	caller, scoped := domain.OuterCallerFrom(ctx)
	if scoped && !caller.Outer {
		owner, ok, err := s.GetSession(ctx, caller.SessionID)
		if err != nil {
			return err
		}
		kind, generation := "runtime", owner.Metadata.RuntimeLaunchID
		if owner.Mode == domain.SessionModeChat {
			kind, generation = "chat", owner.Metadata.ControllerGeneration
		}
		if !ok || owner.IsTerminated || owner.ProjectID != caller.ProjectID || s.callerGeneration(owner, kind, generation) != caller.Generation {
			if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "stale_scoped_caller", SessionID: caller.SessionID, ProjectID: string(project)}); err != nil {
				return err
			}
			return domain.ErrOuterHeld
		}
	}
	if scoped {
		if held, err := s.IsOuterParticipant(ctx, caller.SessionID); err != nil {
			return err
		} else if held && operation != "report.scoped" {
			return s.AppendOuterHeld(ctx, operation, project, session, "participant_cascade_held")
		}
	}
	if scoped && !caller.Outer && caller.ProjectID != project {
		if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "wrong_project_credential", SessionID: caller.SessionID, ProjectID: string(project)}); err != nil {
			return err
		}
		return domain.ErrOuterHeld
	}
	if scoped && caller.Outer {
		if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "M1 cross-project mutations disabled", SessionID: caller.SessionID, ProjectID: string(project)}); err != nil {
			return err
		}
		return domain.ErrOuterHeld
	}
	// A native Project control cannot widen into another Project merely because
	// that destination is outside the outer allowlist. Child lifecycle effects
	// retain the approved Project and re-resolve every durable session owner.
	if a, native := domain.OuterNativeActionFrom(ctx); native && a.ProjectID != "" && a.ProjectID != project {
		if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "wrong_project_native_action", SessionID: session, ProjectID: string(project)}); err != nil {
			return err
		}
		return domain.ErrOuterHeld
	}
	if session != "" {
		if held, err := s.IsOuterParticipant(ctx, session); err != nil {
			return err
		} else if held && operation != "outer.reply.approval" && operation != "outer.reply.input" {
			return s.AppendOuterHeld(ctx, operation, project, session, "participant_exact_plan_required")
		}
	}
	guarded := operation == "native_only" || operation == "unclassified" || string(project) == b.AnchorProjectID || slices.Contains(b.ProjectIDs, string(project)) || (project == "" && session == "")
	if !guarded {
		return nil
	}
	if project != "" {
		p, ok, err := s.GetProject(ctx, string(project))
		if err != nil {
			return err
		}
		if !ok || !p.ArchivedAt.IsZero() {
			if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "guarded_project_unavailable", ProjectID: string(project), SessionID: session}); err != nil {
				return err
			}
			return domain.ErrOuterHeld
		}
	}
	if a, ok := domain.OuterNativeActionFrom(ctx); ok && a.Operation == operation && a.ProjectID == project && (a.SessionID == session || a.SessionID == "") {
		if operation != "terminal.write" {
			return s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "authorized", ProjectID: string(project), SessionID: session})
		}
		return nil
	}
	if scoped && !caller.Outer && caller.ProjectID == project && string(project) != b.AnchorProjectID && operation != "native_only" && operation != "unclassified" {
		return nil
	}
	if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: "native_or_scoped_authority_required", ProjectID: string(project), SessionID: session}); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}

// AppendOuterHeld persists the denial before returning the common hold.
func (s *Store) AppendOuterHeld(ctx context.Context, op string, project domain.ProjectID, session domain.SessionID, reason string) error {
	if err := s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: op, State: "held", ProjectID: string(project), SessionID: session, Reason: reason}); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}
