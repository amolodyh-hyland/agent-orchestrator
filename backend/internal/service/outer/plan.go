package outer

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/google/uuid"
)

type actionStore interface {
	CreateOuterPlan(context.Context, domain.OuterActionPlan) error
	GetOuterPlan(context.Context, string) (domain.OuterPlanReceipt, error)
	ListOuterPlans(context.Context) ([]domain.OuterPlanReceipt, error)
	ApproveOuterPlan(context.Context, string, string, string, time.Time) error
	AttemptOuterPlanAction(context.Context, string, string, string, time.Time) error
	CompleteOuterPlanAction(context.Context, string, string, time.Time) error
	EnrollOuterParticipant(context.Context, string, string, domain.SessionID, time.Time) error
	IsOuterParticipant(context.Context, domain.SessionID) (bool, error)
	ReserveOuterCapacity(context.Context, domain.OuterCapacity) error
}

// WithActionsEnabled opts into the finite adapters; the default remains held.
func WithActionsEnabled(enabled bool) Option { return func(s *Service) { s.actionsEnabled = enabled } }

// ProposePlan resolves exact eligible instances and conservative sources without executing them.
func (s *Service) ProposePlan(ctx context.Context, in domain.OuterPlanProposal) (receipt domain.OuterPlanReceipt, resultErr error) {
	defer func() {
		if resultErr != nil {
			if err := s.store.AppendOuterAudit(context.WithoutCancel(ctx), domain.OuterAudit{Operation: "outer.plan.propose", State: "held", RequestID: in.RequestID, Digest: domain.OuterDigest(in), Reason: "unsupported_or_unbound_manifest"}); err != nil {
				resultErr = err
			}
		}
	}()
	st, ok := s.store.(actionStore)
	if !ok || !s.actionsEnabled || s.transport == nil {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	if err := s.checkReader(ctx); err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil || !found || b.Paused || b.HistoryHeld || len(in.Actions) < 1 || len(in.Actions) > 16 {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	r, err := s.store.GetOuterRequest(ctx, in.RequestID)
	if err != nil || r.Request.PlanID != "" || r.Request.SessionID != b.SessionID || r.Request.ScopeRevision != b.ScopeRevision || r.Request.Epoch != s.epoch {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	sources, err := s.store.OuterSources(ctx, r.Request.ProviderConversationID)
	if err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	selected := append([]string{}, in.SourceProjects...)
	slices.Sort(selected)
	if len(selected) > 32 || len(slices.Compact(append([]string{}, selected...))) != len(selected) {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	for _, id := range selected {
		if !slices.Contains(b.ProjectIDs, id) {
			return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
		}
	}
	for _, source := range sources {
		ids := append(append([]string{}, source.Sources...), source.ProjectID)
		if source.Unknown {
			ids = append(ids, b.ProjectIDs...)
		}
		for _, id := range ids {
			if id != "" && !slices.Contains(selected, id) {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
		}
	}
	for _, id := range selected {
		p, found, err := s.store.GetProject(ctx, id)
		if err != nil || !found || !p.ArchivedAt.IsZero() {
			return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
		}
		sources = append(sources, domain.OuterSource{ProjectID: id, Label: p.DisplayName, Kind: "explicit_source_clarification", Sources: []string{id}})
	}
	p := domain.OuterActionPlan{ID: uuid.NewString(), Request: r.Request, Epoch: s.epoch, CreatedAt: s.now().UTC(), Sources: sources, Actions: []domain.OuterPlannedAction{}}
	for index, spec := range in.Actions {
		if !slices.Contains(b.ProjectIDs, spec.ProjectID) || strings.ContainsAny(spec.ProjectID, "*?\x00") {
			return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
		}
		for _, dep := range spec.DependsOn {
			if dep < 1 || dep > index {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
		}
		project, found, err := s.store.GetProject(ctx, spec.ProjectID)
		if err != nil || !found || !project.ArchivedAt.IsZero() {
			return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
		}
		a := domain.OuterPlannedAction{ID: uuid.NewString(), Spec: spec, ProjectLabel: project.DisplayName, ProjectRevision: project.Revision}
		switch spec.Operation {
		case "send", "kill", "retire":
			if spec.SessionID == "" || spec.Branch != "" || domain.OuterDigest(spec.Config) != domain.OuterDigest(domain.AgentConfig{}) {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
			rec, found, err := s.store.GetSession(ctx, spec.SessionID)
			if err != nil || !found || rec.IsTerminated || string(rec.ProjectID) != spec.ProjectID || rec.Mode != domain.SessionModeChat || rec.Harness != domain.HarnessCodex {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
			conv, err := s.store.ConversationForSession(ctx, rec.ID)
			if err != nil || rec.Metadata.ControllerGeneration == "" || rec.Metadata.ProviderConversationID == "" {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
			a.TargetDigest = domain.OuterSettingsDigest(rec, conv, project)
			a.ControllerGeneration = rec.Metadata.ControllerGeneration
			a.ProviderConversationID = rec.Metadata.ProviderConversationID
			a.ConversationID = conv.ID
			if spec.Operation == "send" {
				if rec.Kind != domain.KindOrchestrator {
					return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
				}
				if _, err := s.transport.PrepareOuterSend(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.send", SessionID: rec.ID}), rec.ID, spec.Text); err != nil {
					return domain.OuterPlanReceipt{}, err
				}
			} else {
				participant, err := st.IsOuterParticipant(ctx, rec.ID)
				if err != nil || !participant || rec.Kind != domain.KindWorker || spec.Text != "" {
					return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
				}
			}
		case "spawn":
			if spec.SessionID != "" || spec.Branch == "" || strings.ContainsAny(spec.Branch, "*?\x00 \n") || strings.HasPrefix(spec.Branch, "-") || spec.Config.Model == "" || spec.Config.Permissions == "" || strings.TrimSpace(spec.Text) == "" || len(spec.Text) > 64000 || strings.Contains(spec.Text, "[skill:") || project.Kind.WithDefault() == domain.ProjectKindScratch || len(project.Config.PostCreate) > 0 || len(project.Config.Symlinks) > 0 {
				return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
			}
			if err := spec.Config.Validate(); err != nil {
				return domain.OuterPlanReceipt{}, err
			}
			a.TargetDigest = domain.OuterDigest(project)
		default:
			return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
		}
		p.Actions = append(p.Actions, a)
	}
	if err := st.CreateOuterPlan(ctx, p); err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	return st.GetOuterPlan(ctx, p.ID)
}

// Plans reads bounded sealed manifests under current scope or trusted desktop authority.
func (s *Service) Plans(ctx context.Context) ([]domain.OuterPlanReceipt, error) {
	if err := s.checkReader(ctx); err != nil {
		return nil, err
	}
	st, ok := s.store.(actionStore)
	if !ok {
		return []domain.OuterPlanReceipt{}, nil
	}
	rows, err := st.ListOuterPlans(ctx)
	if err != nil {
		return nil, err
	}
	if native(ctx, "outer.read") {
		return rows, nil
	}
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil || !found {
		return nil, domain.ErrOuterHeld
	}
	return slices.DeleteFunc(rows, func(r domain.OuterPlanReceipt) bool {
		return r.Plan.Request.SessionID != b.SessionID || r.Plan.Request.ScopeRevision != b.ScopeRevision
	}), nil
}

// ApprovePlan spends one native confirmation on only its sealed concrete instances.
func (s *Service) ApprovePlan(ctx context.Context, id, digest string) (domain.OuterPlanReceipt, error) {
	st, ok := s.store.(actionStore)
	if !ok || !s.actionsEnabled || !native(ctx, "outer.plan.approve") {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	s.mu.Lock()
	err := st.ApproveOuterPlan(ctx, id, digest, s.epoch, s.now().UTC())
	s.mu.Unlock()
	if err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	p, err := st.GetOuterPlan(ctx, id)
	if err != nil {
		return p, err
	}
	for _, a := range p.Plan.Actions {
		if err := s.executeAction(ctx, st, p, a); err != nil {
			if auditErr := s.store.AppendOuterAudit(context.WithoutCancel(ctx), domain.OuterAudit{Operation: "outer.action", State: "held_or_unknown", ReceiptID: a.ID, RequestID: p.Plan.Request.ID, ProjectID: a.Spec.ProjectID, Reason: "inspect original action and turn receipt; never replay"}); auditErr != nil {
				return p, auditErr
			}
			continue
		}
	}
	return st.GetOuterPlan(ctx, id)
}

func (s *Service) executeAction(ctx context.Context, st actionStore, p domain.OuterPlanReceipt, a domain.OuterPlannedAction) error {
	if err := st.AttemptOuterPlanAction(ctx, p.Plan.ID, a.ID, s.epoch, s.now().UTC()); err != nil {
		return err
	}
	ctx = domain.WithOuterExecution(ctx, domain.OuterExecution{PlanID: p.Plan.ID, ActionID: a.ID})
	if a.Spec.Operation == "kill" || a.Spec.Operation == "retire" {
		lifecycle, ok := s.sessions.(interface {
			StopOuterWorker(context.Context, domain.SessionID, func(context.Context) (func(), error)) error
		})
		if !ok {
			return domain.ErrOuterHeld
		}
		if err := lifecycle.StopOuterWorker(ctx, a.Spec.SessionID, func(writeCtx context.Context) (func(), error) {
			s.mu.Lock()
			if !s.now().Before(p.ExpiresAt) || writeCtx.Err() != nil {
				s.mu.Unlock()
				return nil, domain.ErrOuterHeld
			}
			if err := s.store.CheckOuterOperation(writeCtx, a.Spec.Operation, domain.ProjectID(a.Spec.ProjectID), a.Spec.SessionID); err != nil {
				s.mu.Unlock()
				return nil, err
			}
			if !s.now().Before(p.ExpiresAt) {
				s.mu.Unlock()
				return nil, domain.ErrOuterHeld
			}
			return s.mu.Unlock, nil
		}); err != nil {
			return err
		}
		return st.CompleteOuterPlanAction(ctx, a.ID, "completed", s.now().UTC())
	}
	id := a.Spec.SessionID
	if a.Spec.Operation == "spawn" {
		if s.sessions == nil {
			return domain.ErrOuterHeld
		}
		if err := st.ReserveOuterCapacity(ctx, domain.OuterCapacity{RequestID: a.ID, Generation: s.epoch, ReservedAt: s.now().UTC()}); err != nil {
			return err
		}
		created, _, _, err := s.sessions.Spawn(ctx, ports.SpawnConfig{ProjectID: domain.ProjectID(a.Spec.ProjectID), Kind: domain.KindWorker, Harness: domain.HarnessCodex, RequestedMode: domain.SessionModeChat, Branch: a.Spec.Branch, AgentConfig: a.Spec.Config, AgentConfigResolved: true, EffortOverride: true, ClientRequestID: a.ID, ClientRequestHash: domain.OuterDigest(a), OuterActionID: a.ID})
		if err != nil {
			return err
		}
		id = created.ID
	} else {
		if err := st.EnrollOuterParticipant(ctx, p.Plan.ID, a.ID, id, s.now().UTC()); err != nil {
			return err
		}
	}
	ctx = domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.send", SessionID: id, RequestID: a.ID})
	preview, err := s.transport.PrepareOuterSend(ctx, id, a.Spec.Text)
	if err != nil {
		return err
	}
	if a.Spec.Operation == "spawn" && (preview.Settings.Model != a.Spec.Config.Model || preview.Settings.ReasoningEffort != a.Spec.Config.Effort || preview.Settings.ApprovalMode != a.Spec.Config.Permissions) {
		return domain.ErrOuterHeld
	}
	rec, found, err := s.store.GetSession(ctx, id)
	if err != nil || !found {
		return domain.ErrOuterHeld
	}
	project, found, err := s.store.GetProject(ctx, a.Spec.ProjectID)
	if err != nil || !found {
		return domain.ErrOuterHeld
	}
	conv, err := s.store.ConversationForSession(ctx, id)
	if err != nil {
		return err
	}
	r := domain.OuterRequest{ID: a.ID, PlanID: p.Plan.ID, OwnerSessionID: p.Plan.Request.SessionID, HumanMessage: p.Plan.Request.HumanMessage, Payload: preview.Text, PayloadDigest: domain.OuterDigest(preview.Text), SessionID: id, ConversationID: preview.ConversationID, ProviderConversationID: preview.ProviderConversationID, ControllerGeneration: preview.ControllerGeneration, BindingRevision: p.Plan.Request.BindingRevision, ScopeRevision: p.Plan.Request.ScopeRevision, SettingsDigest: domain.OuterSettingsDigest(rec, conv, project), Epoch: s.epoch, IssuedAt: s.now().UTC(), ExpiresAt: p.ExpiresAt, Sources: p.Plan.Sources}
	if err := s.store.CreateOuterRequest(ctx, r); err != nil {
		return err
	}
	_, err = s.transport.DeliverOuterSend(ctx, id, preview.Text, r.ID)
	return err
}

// CancelPlan records the native decline without dispatching an action.
func (s *Service) CancelPlan(ctx context.Context, id, digest string) (domain.OuterPlanReceipt, error) {
	st, ok := s.store.(interface {
		CancelOuterPlan(context.Context, string, string, time.Time) error
		GetOuterPlan(context.Context, string) (domain.OuterPlanReceipt, error)
	})
	if !ok || !native(ctx, "outer.plan.cancel") {
		return domain.OuterPlanReceipt{}, domain.ErrOuterHeld
	}
	if err := st.CancelOuterPlan(ctx, id, digest, s.now().UTC()); err != nil {
		return domain.OuterPlanReceipt{}, err
	}
	return st.GetOuterPlan(ctx, id)
}
