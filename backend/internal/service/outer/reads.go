package outer

import (
	"context"
	"fmt"
	"slices"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type View struct {
	Binding      *domain.OuterBinding         `json:"binding"`
	Requests     []domain.OuterRequestReceipt `json:"requests"`
	Reservations []domain.OuterCapacity       `json:"reservations"`
	Incoming     []domain.OuterEvidence       `json:"incoming"`
	Limitations  []string                     `json:"limitations"`
}

func (s *Service) View(ctx context.Context) (View, error) {
	v := View{Requests: []domain.OuterRequestReceipt{}, Reservations: []domain.OuterCapacity{}, Incoming: []domain.OuterEvidence{}, Limitations: []string{"M1: main desktop Chat only; every cross-project mutation held", "Observation-only restore; unknown submissions and reservations are retained", "Factory 2 stations / 1 heavy job; outside and unknown activity may hold admission", "Normal permissions; no process isolation, syscall audit, hard host cap or spending cap"}}
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil || !found {
		return v, err
	}
	v.Binding = &b
	v.Requests, err = s.store.ListOuterRequests(ctx, b.SessionID)
	if err != nil {
		return v, err
	}
	v.Reservations, err = s.store.OuterCapacity(ctx)
	if err != nil {
		return v, err
	}
	v.Incoming, err = s.store.OuterEvidence(ctx, b.SessionID)
	return v, err
}

func (s *Service) Read(ctx context.Context, project, kind string, limit int) ([]domain.OuterFact, error) {
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil {
		return nil, err
	}
	if !found || !slices.Contains(b.ProjectIDs, project) {
		return nil, s.denied(ctx, "outer.read", "project_not_selected", project)
	}
	p, found, err := s.store.GetProject(ctx, project)
	if err != nil {
		return nil, err
	}
	if !found || !p.ArchivedAt.IsZero() {
		return nil, s.denied(ctx, "outer.read", "project_unavailable", project)
	}
	facts, err := s.store.OuterFacts(ctx, project, kind, limit)
	if err != nil {
		return nil, err
	}
	conversation, err := s.store.ConversationForSession(ctx, b.SessionID)
	if err != nil {
		return nil, err
	}
	key := conversation.ID
	if b.HistoryHeld {
		key = fmt.Sprintf("remaining:%d", b.Generation)
	}
	labeled, err := s.store.LabelOuterFacts(ctx, b, key, facts)
	if err != nil {
		return nil, s.denied(ctx, "outer.read", "source_scope_or_revision_changed", project)
	}
	return labeled, nil
}

func (s *Service) denied(ctx context.Context, operation, reason, project string) error {
	if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: reason, ProjectID: project}); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}

func(s *Service) Deny(ctx context.Context,op,reason,project string)error{return s.denied(ctx,op,reason,project)}
func(s *Service) RetainIncoming(ctx context.Context,id domain.SessionID,text string)error{
	source:=domain.OuterSource{Kind:"incoming",Unknown:true}
	if caller,ok:=domain.OuterCallerFrom(ctx);ok{source.ProjectID=string(caller.ProjectID);source.ID=string(caller.SessionID);source.Unknown=false}
	if err:=s.store.RecordOuterEvidence(ctx,id,text,source);err!=nil{return err};return domain.ErrOuterHeld
}

func (s *Service) AuthenticateCaller(ctx context.Context, token string) (domain.OuterCaller, error) {
	return s.store.AuthenticateOuterCaller(ctx, token)
}
func (s *Service) ResolveTarget(ctx context.Context, kind, id string) (domain.ProjectID, domain.SessionID, error) {
	return s.store.ResolveOuterTarget(ctx, kind, id)
}
func (s *Service) AuthorizeOperation(ctx context.Context, op string, p domain.ProjectID, id domain.SessionID) error {
	return s.store.CheckOuterOperation(ctx, op, p, id)
}
