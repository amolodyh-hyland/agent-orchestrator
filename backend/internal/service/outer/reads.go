package outer

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// View contains passive binding, receipt, reservation and evidence observations.
type View struct {
	Session      *SessionView                     `json:"session"`
	Binding      *domain.OuterBinding             `json:"binding"`
	Requests     []RequestView                    `json:"requests"`
	Reservations []domain.OuterCapacity           `json:"reservations"`
	Capacity     *domain.OuterCapacityObservation `json:"capacity"`
	Incoming     []domain.OuterEvidence           `json:"incoming"`
	Limitations  []string                         `json:"limitations"`
}

// SessionView reports the current harness and existing conversation settings.
type SessionView struct {
	SettingsDigest       string                      `json:"settingsDigest"`
	Harness              domain.AgentHarness         `json:"harness"`
	Mode                 domain.SessionMode          `json:"mode"`
	ControllerGeneration string                      `json:"controllerGeneration"`
	Settings             domain.ConversationSettings `json:"settings"`
	Permissions          domain.PermissionMode       `json:"permissions"`
}

// RequestView exposes receipt metadata while keeping exact payloads in the private journal.
type RequestView struct {
	ID             string               `json:"id"`
	SessionID      domain.SessionID     `json:"sessionId"`
	Digest         string               `json:"digest"`
	TurnID         string               `json:"turnId"`
	ProviderTurnID string               `json:"providerTurnId"`
	State          string               `json:"state"`
	IssuedAt       time.Time            `json:"issuedAt"`
	ExpiresAt      time.Time            `json:"expiresAt"`
	AttemptedAt    time.Time            `json:"attemptedAt"`
	SubmittedAt    time.Time            `json:"submittedAt"`
	AcceptedAt     time.Time            `json:"acceptedAt"`
	SettledAt      time.Time            `json:"settledAt"`
	Sources        []domain.OuterSource `json:"sources"`
}

// View reads passive state without starting, resuming or draining a conversation.
func (s *Service) View(ctx context.Context) (View, error) {
	v := View{Requests: []RequestView{}, Reservations: []domain.OuterCapacity{}, Incoming: []domain.OuterEvidence{}, Limitations: []string{"M1: main desktop Chat only; every cross-project mutation held", "Observation-only restore; unknown submissions and reservations are retained", "Factory 2 stations / 1 heavy job; outside and unknown activity may hold admission", "Normal permissions; no process isolation, syscall audit, hard host cap or spending cap"}}
	if err := s.checkReader(ctx); err != nil {
		return v, err
	}
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil || !found {
		return v, err
	}
	v.Binding = &b
	if rec, ok, readErr := s.store.GetSession(ctx, b.SessionID); readErr != nil {
		return v, readErr
	} else if ok {
		v.Session = &SessionView{Harness: rec.Harness, Mode: rec.Mode, ControllerGeneration: rec.Metadata.ControllerGeneration, Permissions: rec.Metadata.Permissions}
		if conv, convErr := s.store.ConversationForSession(ctx, b.SessionID); convErr == nil {
			v.Session.Settings = conv.Settings
			if project, found, err := s.store.GetProject(ctx, b.AnchorProjectID); err != nil {
				return v, err
			} else if found {
				v.Session.SettingsDigest = domain.OuterSettingsDigest(rec, conv, project)
			}
		}
	}
	receipts, err := s.store.ListOuterHostRequests(ctx)
	if err != nil {
		return v, err
	}
	for _, r := range receipts {
		if r.AttemptedAt.IsZero() && (b.Paused || b.HistoryHeld || b.SessionID != r.Request.SessionID || b.Revision != r.Request.BindingRevision || !s.now().Before(r.Request.ExpiresAt)) {
			r.State = "held"
		}
		v.Requests = append(v.Requests, RequestView{ID: r.Request.ID, SessionID: r.Request.SessionID, Digest: r.Request.PayloadDigest, TurnID: r.TurnID, ProviderTurnID: r.ProviderTurnID, State: r.State, IssuedAt: r.Request.IssuedAt, ExpiresAt: r.Request.ExpiresAt, AttemptedAt: r.AttemptedAt, SubmittedAt: r.SubmittedAt, AcceptedAt: r.AcceptedAt, SettledAt: r.SettledAt, Sources: r.Request.Sources})
	}
	v.Reservations, err = s.store.OuterCapacity(ctx)
	if err != nil {
		return v, err
	}
	counts, err := s.store.ObserveOuterCapacity(ctx)
	if err != nil {
		return v, err
	}
	v.Capacity = &counts
	v.Incoming, err = s.store.OuterEvidence(ctx, b.SessionID)
	if err == nil {
		err = s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "outer.view", State: "observed", SessionID: b.SessionID})
	}
	return v, err
}

// Read returns bounded, labeled evidence from the current allowlist.
func (s *Service) Read(ctx context.Context, project, kind string, limit int) ([]domain.OuterFact, error) {
	if err := s.checkReader(ctx); err != nil {
		return nil, err
	}
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
	session, sessionFound, err := s.store.GetSession(ctx, b.SessionID)
	if err != nil {
		return nil, err
	}
	if !sessionFound {
		return nil, domain.ErrOuterHeld
	}
	key := session.Metadata.ProviderConversationID
	if b.HistoryHeld {
		key = fmt.Sprintf("remaining:%d", b.Generation)
	}
	labeled, err := s.store.LabelOuterFacts(ctx, b, key, facts)
	if err != nil {
		return nil, s.denied(ctx, "outer.read", "source_scope_or_revision_changed", project)
	}
	return labeled, nil
}

func (s *Service) checkReader(ctx context.Context) error {
	if caller, scoped := domain.OuterCallerFrom(ctx); scoped {
		if err := s.store.CheckOuterReadCaller(ctx, caller); err != nil {
			return s.denied(ctx, "outer.read", "caller_scope_or_generation_held", string(caller.ProjectID))
		}
	}
	return nil
}

func (s *Service) denied(ctx context.Context, operation, reason, project string) error {
	if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: operation, State: "held", Reason: reason, ProjectID: project}); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}

// Deny records a held operation before returning the outer hold error.
func (s *Service) Deny(ctx context.Context, op, reason, project string) error {
	return s.denied(ctx, op, reason, project)
}

// RetainIncoming journals incoming claims as inert evidence with unknown content provenance.
func (s *Service) RetainIncoming(ctx context.Context, id domain.SessionID, text string) error {
	source := domain.OuterSource{Kind: "incoming", Unknown: true}
	if caller, ok := domain.OuterCallerFrom(ctx); ok {
		source.ProjectID = string(caller.ProjectID)
		source.ID = string(caller.SessionID)
	}
	if err := s.store.RecordOuterEvidence(ctx, id, text, source); err != nil {
		return err
	}
	return domain.ErrOuterHeld
}

// AuthenticateCaller verifies a generation-scoped runtime credential.
func (s *Service) AuthenticateCaller(ctx context.Context, token string) (domain.OuterCaller, error) {
	return s.store.AuthenticateOuterCaller(ctx, token)
}

// RecordNativeAction persists the exact private native payload before its effect.
func (s *Service) RecordNativeAction(ctx context.Context, id string, document []byte) error {
	return s.store.RecordOuterNativeAction(ctx, id, document)
}

// ResolveTarget resolves a durable resource to its owning Project and session.
func (s *Service) ResolveTarget(ctx context.Context, kind, id string) (domain.ProjectID, domain.SessionID, error) {
	return s.store.ResolveOuterTarget(ctx, kind, id)
}

// AuthorizeOperation applies the common mutation guard to a resolved target.
func (s *Service) AuthorizeOperation(ctx context.Context, op string, p domain.ProjectID, id domain.SessionID) error {
	return s.store.CheckOuterOperation(ctx, op, p, id)
}

// BindTerminal issues a purpose-bound grant for one supported project-local runtime.
func (s *Service) BindTerminal(ctx context.Context, handle string) (any, error) {
	if !native(ctx, "terminal.bind") {
		return nil, domain.ErrOuterHeld
	}
	p, id, err := s.ResolveTarget(ctx, "terminal", handle)
	if err != nil {
		return nil, err
	}
	issuer, ok := s.store.(interface {
		IssueOuterTerminal(context.Context, string) (string, error)
	})
	if !ok {
		return nil, domain.ErrOuterHeld
	}
	token, err := issuer.IssueOuterTerminal(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "terminal.bind", ProjectID: p, SessionID: id}), handle)
	return map[string]string{"handleId": handle, "authority": token}, err
}

// BeginNativeControl journals an exact desktop intent and serializes settings changes.
// Serialize settings with the outer's actual-write gate and record each native
// control's intent before forwarding it to the existing lifecycle/reply gates.
func (s *Service) BeginNativeControl(ctx context.Context, a domain.OuterNativeAction, digest string) (func(bool) error, error) {
	if _, ok := domain.OuterNativeActionFrom(ctx); !ok {
		return nil, domain.ErrOuterHeld
	}
	s.mu.Lock()
	if err := s.store.CheckOuterOperation(ctx, a.Operation, a.ProjectID, a.SessionID); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	id := fmt.Sprintf("native:%s:%d", digest, time.Now().UnixNano())
	if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{ID: id, Operation: a.Operation, State: "attempted", SessionID: a.SessionID, ProjectID: string(a.ProjectID), Generation: a.Generation, Digest: digest}); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	// Replies and lifecycle controls can wait on a controller's send gate. Do
	// not invert that gate with final submission, which acquires this mutex
	// after the provider's serialized-write lock. Settings alone need to share
	// the exact settings snapshot barrier through their local commit.
	hold := a.Operation == "settings"
	if !hold {
		s.mu.Unlock()
	}
	return func(ok bool) error {
		if hold {
			defer s.mu.Unlock()
		}
		state := "held_or_unknown"
		if ok {
			state = "recorded"
		}
		return s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: a.Operation, State: state, ReceiptID: id, SessionID: a.SessionID, ProjectID: string(a.ProjectID), Digest: digest})
	}, nil
}
