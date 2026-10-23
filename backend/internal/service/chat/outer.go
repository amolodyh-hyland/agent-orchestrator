package chat

import (
	"context"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// OuterAdmission guards exact outer requests at the final transport boundary.
type OuterAdmission interface {
	AcquireOuterInput(context.Context, domain.SessionID, ports.ChatUserMessage, string) (func(), error)
}

// SetOuterAdmission installs the exact-request predicate used at final transport writes.
func (s *Service) SetOuterAdmission(a OuterAdmission) {
	s.mu.Lock()
	s.outerAdmission = a
	s.mu.Unlock()
}
func (s *Service) acquireOuterInput(ctx context.Context, id domain.SessionID, msg ports.ChatUserMessage, action string) (func(), error) {
	bound, err := domain.IsOuter(ctx, s.store, id)
	if err != nil {
		return nil, err
	}
	if !bound {
		return func() {}, nil
	}
	s.mu.RLock()
	a := s.outerAdmission
	s.mu.RUnlock()
	if a == nil {
		return nil, domain.ErrOuterHeld
	}
	return a.AcquireOuterInput(ctx, id, msg, action)
}
func (c *Controller) acquireOuterInput(ctx context.Context, msg ports.ChatUserMessage, action string) (func(), error) {
	bound, err := domain.IsOuter(ctx, c.store, c.sessionID)
	if err != nil {
		return nil, err
	}
	if !bound {
		return func() {}, nil
	}
	if c.reviewID != "" || c.outerInput == nil {
		return nil, domain.ErrOuterHeld
	}
	msg.FeedbackControllerGeneration = c.generation
	msg.FeedbackConversationID = c.conversation.ID
	return c.outerInput(ctx, c.sessionID, msg, action)
}

// OuterSendPreview freezes supported text and native conversation identities before issuance.
type OuterSendPreview struct {
	SessionID              domain.SessionID
	ConversationID         string
	ProviderConversationID string
	ControllerGeneration   string
	Settings               domain.ConversationSettings
	Text                   string
}

// PrepareOuterSend freezes supported visible text and the current native identities.
func (s *Service) PrepareOuterSend(ctx context.Context, id domain.SessionID, text string) (OuterSendPreview, error) {
	if a, ok := domain.OuterNativeActionFrom(ctx); !ok || a.Operation != "outer.send" || a.SessionID != id {
		return OuterSendPreview{}, domain.ErrOuterHeld
	}
	c, err := s.Controller(id)
	if err != nil {
		return OuterSendPreview{}, err
	}
	if c.harness != domain.HarnessCodex || c.reviewID != "" || strings.TrimSpace(text) == "" || len(text) > 64000 {
		return OuterSendPreview{}, domain.ErrOuterHeld
	}
	msg, err := c.resolveSkillMessage(ctx, ports.ChatUserMessage{Text: text})
	if err != nil {
		return OuterSendPreview{}, err
	}
	// M1's trusted Send binds the exact visible plain text. Expansion adapters
	// require their own pre-Send preview; never append hidden skill bytes after
	// the trusted human gesture. Native tools within the turn remain available.
	if len(msg.NativeSkills) > 0 || len(msg.Content) > 0 || len(msg.Excerpts) > 0 || msg.Text != text {
		return OuterSendPreview{}, domain.ErrOuterHeld
	}
	return OuterSendPreview{SessionID: id, ConversationID: c.conversation.ID, ProviderConversationID: c.ProviderConversationID(), ControllerGeneration: c.generation, Settings: c.Settings(), Text: msg.Text}, nil
}

// DeliverOuterSend queues one previously issued native request through the existing Chat controller.
func (s *Service) DeliverOuterSend(ctx context.Context, id domain.SessionID, text, key string) (domain.ConversationTurn, error) {
	c, err := s.Controller(id)
	if err != nil {
		return domain.ConversationTurn{}, err
	}
	return c.Send(ctx, ports.ChatUserMessage{Text: text, ClientMessageID: key, Origin: domain.MessageOriginHuman})
}
func (c *Controller) auditOuterEvent(ctx context.Context, event ports.ChatEvent) error {
	bound, err := domain.IsOuter(ctx, c.store, c.sessionID)
	if err != nil || !bound {
		return err
	}
	audit, ok := c.store.(interface {
		AppendOuterAudit(context.Context, domain.OuterAudit) error
	})
	if !ok {
		return domain.ErrOuterHeld
	}
	if event.Kind != ports.ChatEventActivityStarted && event.Kind != ports.ChatEventActivityCompleted && event.Kind != ports.ChatEventTurnStarted && event.Kind != ports.ChatEventTurnCompleted {
		return nil
	}
	if event.Kind == ports.ChatEventTurnCompleted && event.NativeSettlement {
		if ledger, ok := c.store.(interface {
			RecordOuterSettlement(context.Context, string, string, string, time.Time) error
		}); ok {
			if err := ledger.RecordOuterSettlement(ctx, c.conversation.ID, event.ProviderTurnID, c.generation, c.now()); err != nil {
				return err
			}
		}
	}
	turn := event.ProviderTurnID
	if turn == "" {
		c.mu.Lock()
		turn = c.pendingTurnID
		c.mu.Unlock()
	}
	request := ""
	if linker, ok := c.store.(interface {
		OuterRequestAuditLink(context.Context, string, string, string) (string, error)
	}); ok {
		var err error
		request, err = linker.OuterRequestAuditLink(ctx, c.conversation.ID, turn, c.generation)
		if err != nil {
			return err
		}
	}
	return audit.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "native." + string(event.Kind), State: "observed", RequestID: request, SessionID: c.sessionID, Generation: c.generation, Digest: domain.OuterDigest([]any{event.Kind, event.ProviderTurnID, event.ProviderItemID}), ReceiptID: turn, Reason: "native invocation metadata only; raw output retained in transcript"})
}

func (c *Controller) checkOuterReply(ctx context.Context, id, kind string) error {
	bound, err := domain.IsOuter(ctx, c.store, c.sessionID)
	if err != nil || !bound {
		return err
	}
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.reply."+kind || a.SessionID != c.sessionID || a.RequestID != id || a.Generation != c.generation {
		return domain.ErrOuterHeld
	}
	c.mu.Lock()
	turn := c.pendingTurnID
	c.mu.Unlock()
	if turn == "" {
		return domain.ErrOuterHeld
	}
	guard, ok := c.store.(interface {
		CheckOuterPendingReply(context.Context, domain.SessionID, string, string, string, string) error
	})
	if !ok {
		return domain.ErrOuterHeld
	}
	return guard.CheckOuterPendingReply(ctx, c.sessionID, c.conversation.ID, c.generation, turn, id)
}
