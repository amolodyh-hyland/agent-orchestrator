package outer

import (
	"context"
	"slices"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type mailboxStore interface {
	CheckOuterMailboxCaller(context.Context, domain.SessionID) error
	GetOuterMailbox(context.Context, string) (domain.OuterMailboxMessage, error)
	PageOuterMailbox(context.Context, string, domain.SessionID, int64, int) ([]domain.OuterMailboxMessage, error)
	AppendOuterMailbox(context.Context, domain.SessionID, domain.OuterMailboxSpec) (domain.OuterMailboxMessage, error)
	ReceiptOuterMailbox(context.Context, domain.SessionID, string) (domain.OuterMailboxMessage, error)
}

func (s *Service) CheckMailboxCaller(ctx context.Context, id domain.SessionID) error {
	st, ok := s.store.(mailboxStore)
	if !ok || !s.actionsEnabled {
		return s.denied(ctx, "mailbox.scoped", "adapter_disabled", "")
	}
	if err := st.CheckOuterMailboxCaller(ctx, id); err != nil {
		return s.denied(ctx, "mailbox.scoped", "owned_coordinator_required", "")
	}
	return nil
}

func (s *Service) AppendMailbox(ctx context.Context, id domain.SessionID, in domain.OuterMailboxSpec) (domain.OuterMailboxMessage, error) {
	if err := s.CheckMailboxCaller(ctx, id); err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	return s.store.(mailboxStore).AppendOuterMailbox(ctx, id, in)
}
func (s *Service) ReceiptMailbox(ctx context.Context, id domain.SessionID, message string) (domain.OuterMailboxMessage, error) {
	if err := s.CheckMailboxCaller(ctx, id); err != nil {
		return domain.OuterMailboxMessage{}, err
	}
	return s.store.(mailboxStore).ReceiptOuterMailbox(ctx, id, message)
}

func (s *Service) Mailbox(ctx context.Context, project string, coordinator domain.SessionID, after int64, limit int) ([]domain.OuterMailboxMessage, error) {
	st, ok := s.store.(mailboxStore)
	if !ok || after < 0 || limit < 1 || limit > 50 {
		return nil, domain.ErrOuterHeld
	}
	local := coordinator != ""
	if local {
		if err := s.CheckMailboxCaller(ctx, coordinator); err != nil {
			return nil, err
		}
		rec, found, err := s.store.GetSession(ctx, coordinator)
		if err != nil || !found {
			return nil, domain.ErrOuterHeld
		}
		project = string(rec.ProjectID)
	} else if err := s.checkReader(ctx); err != nil {
		return nil, err
	}
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil || !found || !slices.Contains(b.ProjectIDs, project) {
		return nil, domain.ErrOuterHeld
	}
	p, found, err := s.store.GetProject(ctx, project)
	if err != nil || !found || !p.ArchivedAt.IsZero() {
		return nil, domain.ErrOuterHeld
	}
	rows, err := st.PageOuterMailbox(ctx, project, coordinator, after, limit)
	if err != nil {
		return nil, err
	}
	if local {
		if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "mailbox.read", State: "observed", ProjectID: project, SessionID: coordinator, Reason: "bounded passive mailbox page"}); err != nil {
			return nil, err
		}
		return rows, nil
	}
	rec, found, err := s.store.GetSession(ctx, b.SessionID)
	if err != nil || !found {
		return nil, domain.ErrOuterHeld
	}
	facts := make([]domain.OuterFact, 0, len(rows))
	for _, m := range rows {
		facts = append(facts, domain.OuterMailboxFact(m))
	}
	if _, err := s.store.LabelOuterFacts(ctx, b, rec.Metadata.ProviderConversationID, facts); err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *Service) prepareMailbox(ctx context.Context, a *domain.OuterPlannedAction) error {
	spec := a.Spec
	if spec.Mailbox == nil || spec.Run != nil || spec.Review != nil || spec.Text != "" || spec.Branch != "" || spec.Config != (domain.AgentConfig{}) {
		return domain.ErrOuterHeld
	}
	rec, found, err := s.store.GetSession(ctx, spec.SessionID)
	if err != nil || !found || rec.IsTerminated || rec.Kind != domain.KindOrchestrator || rec.Mode != domain.SessionModeChat || rec.Harness != domain.HarnessCodex || string(rec.ProjectID) != spec.ProjectID {
		return domain.ErrOuterHeld
	}
	conv, err := s.store.ConversationForSession(ctx, rec.ID)
	if err != nil || rec.Metadata.ControllerGeneration == "" || rec.Metadata.ProviderConversationID == "" {
		return domain.ErrOuterHeld
	}
	project, found, err := s.store.GetProject(ctx, spec.ProjectID)
	if err != nil || !found {
		return domain.ErrOuterHeld
	}
	a.TargetDigest = domain.OuterSettingsDigest(rec, conv, project)
	a.ControllerGeneration, a.ProviderConversationID, a.ConversationID = rec.Metadata.ControllerGeneration, rec.Metadata.ProviderConversationID, conv.ID
	a.Settings, a.PermissionCeiling = conv.Settings, rec.Metadata.PermissionCeiling
	if spec.Operation == "mailbox.receipt" {
		st, ok := s.store.(mailboxStore)
		if !ok {
			return domain.ErrOuterHeld
		}
		m, err := st.GetOuterMailbox(ctx, spec.Mailbox.ID)
		if err != nil {
			return err
		}
		a.MailboxDigest = domain.OuterDigest(m)
	}
	return nil
}

func (s *Service) executeMailbox(ctx context.Context, st actionStore, p domain.OuterPlanReceipt, a domain.OuterPlannedAction) error {
	mailbox, ok := s.store.(mailboxStore)
	if !ok || a.Spec.Mailbox == nil {
		return domain.ErrOuterHeld
	}
	if err := st.EnrollOuterParticipant(ctx, p.Plan.ID, a.ID, a.Spec.SessionID, s.now().UTC()); err != nil {
		return err
	}
	var err error
	if a.Spec.Operation == "mailbox.append" {
		_, err = mailbox.AppendOuterMailbox(ctx, a.Spec.SessionID, *a.Spec.Mailbox)
	} else {
		_, err = mailbox.ReceiptOuterMailbox(ctx, a.Spec.SessionID, a.Spec.Mailbox.ID)
	}
	return err
}
