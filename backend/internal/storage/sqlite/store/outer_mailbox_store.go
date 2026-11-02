package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func mailboxValue(document string, sequence int64, recipient sql.NullString, at sql.NullTime, action sql.NullString) (domain.OuterMailboxMessage, error) {
	var m domain.OuterMailboxMessage
	err := json.Unmarshal([]byte(document), &m)
	m.Sequence, m.AcknowledgedBy, m.AcknowledgedAt, m.ReceiptActionID = sequence, domain.SessionID(recipient.String), timeFromNull(at), action.String
	return m, err
}
func (s *Store) GetOuterMailbox(ctx context.Context, id string) (domain.OuterMailboxMessage, error) {
	r, err := s.conversationReader(ctx).GetOuterMailbox(ctx, id)
	if err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	return mailboxValue(r.Document, r.Sequence, r.RecipientID, r.RecordedAt, r.ActionID)
}
func (s *Store) PageOuterMailbox(ctx context.Context, project string, coordinator domain.SessionID, after int64, limit int) ([]domain.OuterMailboxMessage, error) {
	if after < 0 || limit < 1 || limit > 50 {
		return nil, domain.ErrOuterHeld
	}
	rows, err := s.conversationReader(ctx).PageOuterMailbox(ctx, gen.PageOuterMailboxParams{ProjectID: project, CoordinatorID: string(coordinator), AfterSequence: after, PageSize: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterMailboxMessage, 0, len(rows))
	for _, r := range rows {
		m, err := mailboxValue(r.Document, r.Sequence, r.RecipientID, r.RecordedAt, r.ActionID)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (s *Store) ReadOuterCoordinatorMailbox(ctx context.Context, coordinator domain.SessionID, after int64, limit int) ([]domain.OuterMailboxMessage, error) {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return nil, err
	}
	defer s.writeMu.Unlock()
	if err := s.CheckOuterMailboxCaller(ctx, coordinator); err != nil {
		return nil, err
	}
	rec, found, err := s.GetSession(ctx, coordinator)
	if err != nil || !found {
		return nil, domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return nil, domain.ErrOuterHeld
	}
	rows, err := s.PageOuterMailbox(ctx, string(rec.ProjectID), coordinator, after, limit)
	if err != nil {
		return nil, err
	}
	if err := s.inTx(ctx, "import coordinator mailbox page", func(q *gen.Queries) error {
		return s.importOuterMailbox(ctx, q, b, rec, rows)
	}); err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *Store) importOuterMailbox(ctx context.Context, q *gen.Queries, b domain.OuterBinding, rec domain.SessionRecord, messages []domain.OuterMailboxMessage) error {
	if rec.Metadata.ProviderConversationID == "" {
		return domain.ErrOuterHeld
	}
	facts := make([]domain.OuterFact, 0, len(messages))
	for _, m := range messages {
		if m.CoordinatorID != rec.ID || m.ProjectID != string(rec.ProjectID) {
			return domain.ErrOuterHeld
		}
		facts = append(facts, domain.OuterMailboxFact(m))
	}
	if err := s.labelOuterFacts(ctx, q, b, rec.Metadata.ProviderConversationID, facts, domain.OuterAudit{Operation: "mailbox.import", State: "observed", SessionID: rec.ID, Reason: "bounded inert content import; no wake or turn authority"}); err != nil {
		return err
	}
	for _, fact := range facts {
		doc, err := json.Marshal(fact.Source)
		if err != nil {
			return err
		}
		if err := q.UpsertOuterSource(ctx, gen.UpsertOuterSourceParams{ConversationID: rec.Metadata.ProviderConversationID, SourceKey: "export:mailbox:" + fact.Source.ID, Document: string(doc)}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) CheckOuterMailboxCaller(ctx context.Context, id domain.SessionID) error {
	caller, ok := domain.OuterCallerFrom(ctx)
	if !ok || caller.Outer || caller.SessionID != id {
		return domain.ErrOuterHeld
	}
	rec, found, err := s.GetSession(ctx, id)
	if err != nil || !found || rec.IsTerminated || rec.Kind != domain.KindOrchestrator || rec.ProjectID != caller.ProjectID || rec.Mode != domain.SessionModeChat || rec.Harness != domain.HarnessCodex || s.callerGeneration(rec, "chat", rec.Metadata.ControllerGeneration) != caller.Generation {
		return domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found || b.SessionID == "" || !slices.Contains(b.ProjectIDs, string(rec.ProjectID)) {
		return domain.ErrOuterHeld
	}
	p, found, err := s.GetProject(ctx, string(rec.ProjectID))
	if err != nil || !found || !p.ArchivedAt.IsZero() {
		return domain.ErrOuterHeld
	}
	return nil
}

func validMailboxSpec(in domain.OuterMailboxSpec, appendMessage bool) bool {
	if in.ID == "" || len(in.ID) > 128 || in.ID == "." || in.ID == ".." {
		return false
	}
	for _, c := range in.ID {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.:", c)) {
			return false
		}
	}
	if appendMessage {
		return strings.TrimSpace(in.Text) != "" && len(in.Text) <= 8192
	}
	return in.Text == ""
}
func validateOuterMailbox(ctx context.Context, q *gen.Queries, a domain.OuterPlannedAction) error {
	spec := a.Spec
	if spec.Mailbox == nil || spec.Review != nil || spec.Run != nil || spec.Text != "" || spec.Branch != "" || spec.Config != (domain.AgentConfig{}) || !validMailboxSpec(*spec.Mailbox, spec.Operation == "mailbox.append") {
		return domain.ErrOuterHeld
	}
	row, err := q.GetSession(ctx, spec.SessionID)
	if err != nil || row.Kind != domain.KindOrchestrator {
		return domain.ErrOuterHeld
	}
	r, err := q.GetOuterMailbox(ctx, spec.Mailbox.ID)
	if spec.Operation == "mailbox.append" {
		if !errors.Is(err, sql.ErrNoRows) {
			return domain.ErrOuterHeld
		}
		count, err := q.CountOuterMailbox(ctx, spec.ProjectID)
		if err != nil {
			return err
		}
		if count >= 256 {
			return domain.ErrOuterHeld
		}
		return nil
	}
	if spec.Operation != "mailbox.receipt" || err != nil {
		return domain.ErrOuterHeld
	}
	m, err := mailboxValue(r.Document, r.Sequence, r.RecipientID, r.RecordedAt, r.ActionID)
	if err != nil || m.CoordinatorID != spec.SessionID || m.ProjectID != spec.ProjectID || !m.AcknowledgedAt.IsZero() || domain.OuterDigest(m) != a.MailboxDigest {
		return domain.ErrOuterHeld
	}
	doc, err := q.GetOuterBinding(ctx)
	var b domain.OuterBinding
	if err != nil || json.Unmarshal([]byte(doc), &b) != nil || m.RecipientID != b.SessionID {
		return domain.ErrOuterHeld
	}
	for _, source := range m.Sources {
		for _, id := range append(append([]string{}, source.Sources...), source.ProjectID) {
			if id != "" && !slices.Contains(b.ProjectIDs, id) {
				return domain.ErrOuterHeld
			}
		}
	}
	return nil
}

func (s *Store) AppendOuterMailbox(ctx context.Context, coordinator domain.SessionID, in domain.OuterMailboxSpec) (domain.OuterMailboxMessage, error) {
	if !validMailboxSpec(in, true) {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	defer s.writeMu.Unlock()
	rec, found, err := s.GetSession(ctx, coordinator)
	if err != nil || !found {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	m := domain.OuterMailboxMessage{ID: in.ID, ProjectID: string(rec.ProjectID), CoordinatorID: coordinator, Text: in.Text, RecordedAt: time.Now().UTC()}
	e, executing := domain.OuterExecutionFrom(ctx)
	if executing {
		if err := s.CheckOuterExecution(ctx, "mailbox.append", rec.ProjectID, coordinator); err != nil {
			return m, err
		}
		p, err := s.GetOuterPlan(ctx, e.PlanID)
		if err != nil {
			return m, err
		}
		matched := false
		for _, a := range p.Plan.Actions {
			if a.ID == e.ActionID && a.Spec.Mailbox != nil && *a.Spec.Mailbox == in {
				matched = true
			}
		}
		if !matched {
			return m, domain.ErrOuterHeld
		}
		m.SenderID, m.RecipientID, m.Direction, m.ActionID, m.Sources = p.Plan.Request.SessionID, coordinator, "to_coordinator", e.ActionID, p.Plan.Sources
		m.RequestID, m.PlanID = p.Plan.Request.ID, p.Plan.ID
	} else {
		if err := s.CheckOuterMailboxCaller(ctx, coordinator); err != nil {
			return m, err
		}
		m.SenderID, m.RecipientID, m.Direction = coordinator, b.SessionID, "to_outer"
		m.Sources = []domain.OuterSource{{ProjectID: m.ProjectID, Kind: "coordinator_mailbox", ID: in.ID, Unknown: true, Sources: append([]string{}, b.ProjectIDs...)}}
		if prior, err := s.GetOuterMailbox(ctx, in.ID); err == nil {
			if prior.SenderID == m.SenderID && prior.CoordinatorID == coordinator && prior.Text == m.Text && prior.Direction == m.Direction && prior.RecipientID == m.RecipientID {
				if err := s.inTx(ctx, "import retained coordinator mailbox append", func(q *gen.Queries) error {
					return s.importOuterMailbox(ctx, q, b, rec, []domain.OuterMailboxMessage{prior})
				}); err != nil {
					return domain.OuterMailboxMessage{}, err
				}
				return prior, nil
			}
			return m, domain.ErrOuterHeld
		} else if !errors.Is(err, sql.ErrNoRows) {
			return m, err
		}
	}
	data, err := json.Marshal(m)
	if err != nil {
		return m, err
	}
	err = s.inTx(ctx, "append inert coordinator mailbox", func(q *gen.Queries) error {
		count, err := q.CountOuterMailbox(ctx, m.ProjectID)
		if err != nil {
			return err
		}
		if count >= 256 {
			return domain.ErrOuterHeld
		}
		if err := q.InsertOuterMailbox(ctx, gen.InsertOuterMailboxParams{ID: m.ID, ProjectID: m.ProjectID, CoordinatorID: string(coordinator), Document: string(data)}); err != nil {
			return err
		}
		row, err := q.GetOuterMailbox(ctx, m.ID)
		if err != nil {
			return err
		}
		m, err = mailboxValue(row.Document, row.Sequence, row.RecipientID, row.RecordedAt, row.ActionID)
		if err != nil {
			return err
		}
		if !executing {
			if err := s.importOuterMailbox(ctx, q, b, rec, []domain.OuterMailboxMessage{m}); err != nil {
				return err
			}
		}
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "mailbox.append", State: "inert", ProjectID: m.ProjectID, SessionID: coordinator, ReceiptID: m.ID, Digest: domain.OuterDigest(m), RequestID: m.RequestID, Sources: m.Sources, Reason: "durable record only; no wake, queue or continuation"}); err != nil {
			return err
		}
		if executing {
			return q.CompleteOuterPlanAction(ctx, gen.CompleteOuterPlanActionParams{ID: e.ActionID, State: "completed", CompletedAt: nullTime(m.RecordedAt)})
		}
		return nil
	})
	if err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	return m, nil
}

func (s *Store) ReceiptOuterMailbox(ctx context.Context, coordinator domain.SessionID, id string) (domain.OuterMailboxMessage, error) {
	if !validMailboxSpec(domain.OuterMailboxSpec{ID: id}, false) {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	defer s.writeMu.Unlock()
	m, err := s.GetOuterMailbox(ctx, id)
	if err != nil || m.CoordinatorID != coordinator {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	actor := coordinator
	action := "scoped_record_acknowledgement"
	requestID := ""
	e, executing := domain.OuterExecutionFrom(ctx)
	if executing {
		if err := s.CheckOuterExecution(ctx, "mailbox.receipt", domain.ProjectID(m.ProjectID), coordinator); err != nil {
			return domain.OuterMailboxMessage{}, err
		}
		p, err := s.GetOuterPlan(ctx, e.PlanID)
		if err != nil {
			return domain.OuterMailboxMessage{}, err
		}
		matched := false
		for _, a := range p.Plan.Actions {
			if a.ID == e.ActionID && a.Spec.Mailbox != nil && a.Spec.Mailbox.ID == id {
				matched = true
			}
		}
		if !matched {
			return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
		}
		actor, action = p.Plan.Request.SessionID, e.ActionID
		requestID = p.Plan.Request.ID
	} else if err := s.CheckOuterMailboxCaller(ctx, coordinator); err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	if actor != m.RecipientID {
		return domain.OuterMailboxMessage{}, domain.ErrOuterHeld
	}
	now := time.Now().UTC()
	err = s.inTx(ctx, "acknowledge inert coordinator mailbox", func(q *gen.Queries) error {
		if err := q.ReceiptOuterMailbox(ctx, gen.ReceiptOuterMailboxParams{MessageID: id, RecipientID: string(actor), ActionID: action, RecordedAt: now}); err != nil {
			return err
		}
		row, err := q.GetOuterMailbox(ctx, id)
		if err != nil {
			return err
		}
		m, err = mailboxValue(row.Document, row.Sequence, row.RecipientID, row.RecordedAt, row.ActionID)
		if err != nil {
			return err
		}
		if !executing {
			rec, found, err := s.GetSession(ctx, coordinator)
			if err != nil || !found {
				return domain.ErrOuterHeld
			}
			b, found, err := s.OuterBinding(ctx)
			if err != nil || !found {
				return domain.ErrOuterHeld
			}
			if err := s.importOuterMailbox(ctx, q, b, rec, []domain.OuterMailboxMessage{m}); err != nil {
				return err
			}
		}
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "mailbox.receipt", State: "record_acknowledged", ProjectID: m.ProjectID, SessionID: actor, ReceiptID: id, RequestID: requestID, Sources: m.Sources, Reason: "record acknowledgement only; no model or delivery acceptance"}); err != nil {
			return err
		}
		if executing {
			return q.CompleteOuterPlanAction(ctx, gen.CompleteOuterPlanActionParams{ID: e.ActionID, State: "completed", CompletedAt: nullTime(now)})
		}
		return nil
	})
	if err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	return m, nil
}
