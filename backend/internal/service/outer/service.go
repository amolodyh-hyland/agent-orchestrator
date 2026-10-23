package outer

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

// Store provides the durable outer policy, journal and bounded evidence contracts.
type Store interface {
	domain.OuterPolicy
	SaveOuterBinding(context.Context, domain.OuterBinding, int64, domain.OuterAudit) error
	AppendOuterAudit(context.Context, domain.OuterAudit) error
	PageOuterAudit(context.Context, int64, int) ([]domain.OuterAudit, error)
	GetProject(context.Context, string) (domain.ProjectRecord, bool, error)
	UpsertProject(context.Context, domain.ProjectRecord) error
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ConversationForSession(context.Context, domain.SessionID) (domain.ConversationRecord, error)
	CreateOuterRequest(context.Context, domain.OuterRequest) error
	GetOuterRequest(context.Context, string) (domain.OuterRequestReceipt, error)
	ListOuterRequests(context.Context, domain.SessionID) ([]domain.OuterRequestReceipt, error)
	ListOuterHostRequests(context.Context) ([]domain.OuterRequestReceipt, error)
	RecordOuterNativeAction(context.Context, string, []byte) error
	AttemptOuterRequest(context.Context, string, string, time.Time) error
	ValidateOuterRequest(context.Context, domain.OuterRequest, time.Time) error
	OuterCapacity(context.Context) ([]domain.OuterCapacity, error)
	ObserveOuterCapacity(context.Context) (domain.OuterCapacityObservation, error)
	OuterFacts(context.Context, string, string, int) ([]domain.OuterFact, error)
	LabelOuterFacts(context.Context, domain.OuterBinding, string, []domain.OuterFact) ([]domain.OuterFact, error)
	OuterSources(context.Context, string) ([]domain.OuterSource, error)
	RecordOuterEvidence(context.Context, domain.SessionID, string, domain.OuterSource) error
	OuterEvidence(context.Context, domain.SessionID) ([]domain.OuterEvidence, error)
	AuthenticateOuterCaller(context.Context, string) (domain.OuterCaller, error)
	CheckOuterReadCaller(context.Context, domain.OuterCaller) error
	ResolveOuterTarget(context.Context, string, string) (domain.ProjectID, domain.SessionID, error)
}

// Projects creates the repository-free anchor through the existing Project service.
type Projects interface {
	CreateContainer(context.Context, projectsvc.CreateContainerInput) (projectsvc.Project, error)
}

// Sessions launches the ordinary orchestrator through the existing owned lifecycle.
type Sessions interface {
	Spawn(context.Context, ports.SpawnConfig) (domain.Session, int, int, error)
}

// Service owns explicit outer setup, request binding and passive observation.
type Service struct {
	store     Store
	projects  Projects
	sessions  Sessions
	mu        sync.Mutex
	transport Transport
	epoch     string
	now       func() time.Time
}

// Transport reuses the existing main Chat preparation and delivery path.
type Transport interface {
	PrepareOuterSend(context.Context, domain.SessionID, string) (chatsvc.OuterSendPreview, error)
	DeliverOuterSend(context.Context, domain.SessionID, string, string) (domain.ConversationTurn, error)
}

// SetTransport connects issuance to the existing main Chat controller.
func (s *Service) SetTransport(t Transport) { s.transport = t }

// Option configures an outer service without performing setup or computation.
type Option func(*Service)

// WithClock sets the request clock for deterministic expiry checks.
func WithClock(clock func() time.Time) Option { return func(s *Service) { s.now = clock } }

// New constructs the outer service without creating an anchor or submitting a turn.
func New(store Store, projects Projects, sessions Sessions, options ...Option) *Service {
	s := &Service{store: store, projects: projects, sessions: sessions, epoch: uuid.NewString(), now: time.Now}
	for _, option := range options {
		option(s)
	}
	return s
}

// Binding reads the host binding without ensuring a runtime.
func (s *Service) Binding(ctx context.Context) (domain.OuterBinding, bool, error) {
	return s.store.OuterBinding(ctx)
}

func native(ctx context.Context, op string) bool {
	a, ok := domain.OuterNativeActionFrom(ctx)
	return ok && a.Operation == op
}

// Ensure creates or reconciles the explicitly requested repository-free anchor generation.
func (s *Service) Ensure(ctx context.Context, config domain.AgentConfig) (domain.OuterBinding, error) {
	if !native(ctx, "outer.setup") {
		return domain.OuterBinding{}, domain.ErrOuterHeld
	}
	if err := config.Validate(); err != nil {
		return domain.OuterBinding{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, exists, err := s.store.OuterBinding(ctx)
	if err != nil {
		return b, err
	}
	if !exists {
		p, err := s.projects.CreateContainer(ctx, projectsvc.CreateContainerInput{DisplayName: "Outer orchestrator"})
		if err != nil {
			return b, err
		}
		row, ok, err := s.store.GetProject(ctx, string(p.ID))
		if err != nil {
			return b, err
		}
		if !ok {
			return b, domain.ErrOuterHeld
		}
		row.Config = domain.ProjectConfig{Orchestrator: domain.RoleOverride{Harness: domain.HarnessCodex, AgentConfig: config}}
		if err := s.store.UpsertProject(ctx, row); err != nil {
			return b, err
		}
		b = domain.OuterBinding{AnchorProjectID: row.ID, Revision: 1, ScopeRevision: 1, Generation: 1, ProjectIDs: []string{}, ForegroundReserve: true, InstructionRevision: domain.OuterInstructionRevision}
		if err := s.store.SaveOuterBinding(ctx, b, 0, domain.OuterAudit{Operation: "outer.setup", State: "recorded", ProjectID: row.ID}); err != nil {
			return b, err
		}
	}
	if b.SessionID != "" && !b.HistoryHeld {
		return b, nil
	}
	launchCtx := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "spawn", ProjectID: domain.ProjectID(b.AnchorProjectID)})
	created, _, _, err := s.sessions.Spawn(launchCtx, ports.SpawnConfig{ProjectID: domain.ProjectID(b.AnchorProjectID), Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, RequestedMode: domain.SessionModeChat, DisplayName: "Outer orchestrator", OuterGeneration: b.Generation})
	if err != nil {
		return b, err
	}
	// A launcher may reconcile an already-running orchestrator. Only the
	// immutable, durably recorded launch generation proves it belongs to the
	// current scope; returned metadata alone cannot release a history fence.
	recorded, found, err := s.store.GetSession(ctx, created.ID)
	if err != nil {
		return b, err
	}
	fresh := found && created.ID != "" && recorded.ProjectID == domain.ProjectID(b.AnchorProjectID) && recorded.Kind == domain.KindOrchestrator && recorded.Harness == domain.HarnessCodex && recorded.Mode == domain.SessionModeChat && recorded.Metadata.OuterGeneration == b.Generation
	if b.HistoryHeld && b.SessionID != "" {
		previous, exists, err := s.store.GetSession(ctx, b.SessionID)
		if err != nil {
			return b, err
		}
		fresh = fresh && exists && created.ID != b.SessionID && recorded.Metadata.OuterGeneration > previous.Metadata.OuterGeneration
		if exists && ((recorded.Metadata.ProviderConversationID != "" && recorded.Metadata.ProviderConversationID == previous.Metadata.ProviderConversationID) || (recorded.Metadata.AgentSessionID != "" && recorded.Metadata.AgentSessionID == previous.Metadata.AgentSessionID)) {
			fresh = false
		}
	}
	if !fresh {
		if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "outer.bind", State: "held", SessionID: created.ID, Reason: "fresh_conversation_not_verified"}); err != nil {
			return b, err
		}
		return b, domain.ErrOuterHeld
	}
	previous := b.Revision
	b.Revision++
	b.SessionID = created.ID
	b.HistoryHeld = false
	if err := s.store.SaveOuterBinding(ctx, b, previous, domain.OuterAudit{Operation: "outer.bind", State: "recorded", SessionID: created.ID}); err != nil {
		return b, err
	}
	return b, nil
}

// SetScope records a human allowlist change and fences removed native history.
func (s *Service) SetScope(ctx context.Context, expected int64, ids []string, paused, foreground bool) (domain.OuterBinding, error) {
	if !native(ctx, "outer.scope") {
		return domain.OuterBinding{}, domain.ErrOuterHeld
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil {
		return b, err
	}
	if !found || expected != b.Revision || len(ids) > 32 {
		return b, domain.ErrOuterHeld
	}
	ids = append([]string{}, ids...)
	slices.Sort(ids)
	for i, id := range ids {
		if strings.TrimSpace(id) == "" || id == b.AnchorProjectID || (i > 0 && ids[i-1] == id) {
			return b, domain.ErrOuterHeld
		}
		p, ok, err := s.store.GetProject(ctx, id)
		if err != nil {
			return b, err
		}
		if !ok || !p.ArchivedAt.IsZero() {
			return b, domain.ErrOuterHeld
		}
	}
	for _, old := range b.ProjectIDs {
		if !slices.Contains(ids, old) {
			b.HistoryHeld = true
			b.Generation++
			break
		}
	}
	b.ProjectIDs = ids
	b.ScopeRevision++
	b.Revision++
	b.Paused = paused
	b.ForegroundReserve = foreground
	err = s.store.SaveOuterBinding(ctx, b, expected, domain.OuterAudit{Operation: "outer.scope", State: "recorded", Reason: "pending authority invalidated; reduced scope requires a fresh conversation"})
	return b, err
}

// Audit reads a bounded page of the append-only action timeline.
func (s *Service) Audit(ctx context.Context, after int64, limit int) ([]domain.OuterAudit, error) {
	if err := s.checkReader(ctx); err != nil {
		return nil, err
	}
	if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "outer.audit.read", State: "observed"}); err != nil {
		return nil, err
	}
	return s.store.PageOuterAudit(ctx, after, limit)
}
