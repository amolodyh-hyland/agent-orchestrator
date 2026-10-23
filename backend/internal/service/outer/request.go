package outer

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (s *Service) Send(ctx context.Context, text string) (domain.OuterRequestReceipt, error) {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.send" || a.RequestID == "" || s.transport == nil {
		return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
	}
	s.mu.Lock()
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	if !found || b.Paused || b.HistoryHeld || b.SessionID != a.SessionID {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
	}
	if receipt, err := s.store.GetOuterRequest(ctx, a.RequestID); err == nil {
		s.mu.Unlock()
		if receipt.Request.HumanMessage != text || receipt.Request.SessionID != a.SessionID {
			return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
		}
		return receipt, nil
	}
	preview, err := s.transport.PrepareOuterSend(ctx, b.SessionID, text)
	if err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	rec, found, err := s.store.GetSession(ctx, b.SessionID)
	if err != nil || !found {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
	}
	conv, err := s.store.ConversationForSession(ctx, b.SessionID)
	if err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	p, found, err := s.store.GetProject(ctx, b.AnchorProjectID)
	if err != nil || !found {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
	}
	now := s.now().UTC()
	sources, err := s.store.OuterSources(ctx, preview.ProviderConversationID)
	if err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	r := domain.OuterRequest{ID: a.RequestID, HumanMessage: text, Payload: preview.Text, PayloadDigest: domain.OuterDigest(preview.Text), SessionID: b.SessionID, ConversationID: preview.ConversationID, ProviderConversationID: preview.ProviderConversationID, ControllerGeneration: preview.ControllerGeneration, BindingRevision: b.Revision, ScopeRevision: b.ScopeRevision, SettingsDigest: domain.OuterSettingsDigest(rec, conv, p), Epoch: s.epoch, IssuedAt: now, ExpiresAt: now.Add(2 * time.Minute), Sources: sources}
	if err := s.store.CreateOuterRequest(ctx, r); err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	s.mu.Unlock()
	_, deliveryErr := s.transport.DeliverOuterSend(ctx, b.SessionID, preview.Text, r.ID)
	receipt, err := s.store.GetOuterRequest(ctx, r.ID)
	if err != nil {
		return receipt, err
	}
	if deliveryErr != nil {
		_ = s.store.AppendOuterAudit(context.WithoutCancel(ctx), domain.OuterAudit{Operation: "outer.send", State: "held", Reason: "delivery uncertain; inspect original receipt", RequestID: r.ID, SessionID: b.SessionID})
		return receipt, deliveryErr
	}
	return receipt, nil
}

func (s *Service) AcquireOuterInput(ctx context.Context, id domain.SessionID, msg ports.ChatUserMessage, phase string) (func(), error) {
	s.mu.Lock()
	release := s.mu.Unlock
	fail := func(reason string) (func(), error) {
		release()
		if err := s.store.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "outer." + phase, State: "held", Reason: reason, SessionID: id, RequestID: msg.ClientMessageID, Digest: domain.OuterDigest(msg.Text)}); err != nil {
			return nil, err
		}
		return nil, domain.ErrOuterHeld
	}
	receipt, err := s.store.GetOuterRequest(ctx, msg.ClientMessageID)
	if err != nil {
		return fail("missing_native_request")
	}
	r := receipt.Request
	b, found, err := s.store.OuterBinding(ctx)
	if err != nil {
		release()
		return nil, err
	}
	if !found || b.Paused || b.HistoryHeld || b.SessionID != id || b.Revision != r.BindingRevision || b.ScopeRevision != r.ScopeRevision || r.Epoch != s.epoch || !s.now().Before(r.ExpiresAt) || !receipt.AttemptedAt.IsZero() {
		return fail("stale_or_used_authority")
	}
	if r.SessionID != id || msg.Text != r.Payload || domain.OuterDigest(msg.Text) != r.PayloadDigest || msg.Origin != domain.MessageOriginHuman || len(msg.Content) > 0 || len(msg.Excerpts) > 0 || len(msg.NativeSkills) > 0 || msg.Continuation || msg.ReportBatchID != "" {
		return fail("exact_payload_required")
	}
	if msg.FeedbackControllerGeneration != "" && (msg.FeedbackControllerGeneration != r.ControllerGeneration || msg.FeedbackConversationID != r.ConversationID) {
		return fail("native_generation_changed")
	}
	switch phase {
	case "enqueue":
		a, ok := domain.OuterNativeActionFrom(ctx)
		if !ok || a.Operation != "outer.send" || a.RequestID != r.ID || a.SessionID != id || receipt.TurnID != "" {
			return fail("native_send_required")
		}
	case "prepare", "next_turn":
		if receipt.TurnID == "" {
			return fail("request_not_bound_to_turn")
		}
	default:
		return fail("adapter_held")
	}
	if phase == "next_turn" {
		if err := s.store.AttemptOuterRequest(ctx, r.ID, s.epoch, s.now().UTC()); err != nil {
			return fail("final_submission_or_capacity_held")
		}
		return release, nil
	}
	release()
	return func() {}, nil
}
