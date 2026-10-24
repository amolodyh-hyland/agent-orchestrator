package outer

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Send issues and queues one exact human request without granting later continuations.
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
	if !found || b.Paused || b.HistoryHeld || b.SessionID != a.SessionID || a.Expected == nil || a.Expected.BindingRevision != b.Revision || a.Expected.ScopeRevision != b.ScopeRevision {
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
	settingsDigest := domain.OuterSettingsDigest(rec, conv, p)
	if a.Expected.ControllerGeneration != preview.ControllerGeneration || a.Expected.SettingsDigest != settingsDigest {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, domain.ErrOuterHeld
	}
	sources, err := s.store.OuterSources(ctx, preview.ProviderConversationID)
	if err != nil {
		s.mu.Unlock()
		return domain.OuterRequestReceipt{}, err
	}
	sources = append(sources, domain.OuterSource{Kind: "human_input", ID: a.RequestID, Digest: domain.OuterDigest(text), SourceAt: now, ObservedAt: now, Unknown: true, Sources: append([]string{}, b.ProjectIDs...)})
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

// AcquireOuterInput rechecks exact authority and reserves capacity immediately before submission.
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
	owner := id
	if r.PlanID != "" {
		owner = r.OwnerSessionID
	}
	if !found || b.Paused || b.HistoryHeld || b.SessionID != owner || b.Revision != r.BindingRevision || b.ScopeRevision != r.ScopeRevision || r.Epoch != s.epoch || !s.now().Before(r.ExpiresAt) || !receipt.AttemptedAt.IsZero() {
		return fail("stale_or_used_authority")
	}
	expectedOrigin := domain.MessageOriginHuman
	if r.PlanID != "" {
		expectedOrigin = domain.MessageOriginAutomation
	}
	if r.SessionID != id || msg.Text != r.Payload || domain.OuterDigest(msg.Text) != r.PayloadDigest || msg.Origin != expectedOrigin || len(msg.Content) > 0 || len(msg.Excerpts) > 0 || len(msg.NativeSkills) > 0 || msg.Continuation || msg.ReportBatchID != "" {
		return fail("exact_payload_required")
	}
	if r.PlanID != "" && (msg.SenderSessionID != string(r.OwnerSessionID) || msg.SenderProjectID != b.AnchorProjectID || msg.SenderDisplayName == "") {
		return fail("sealed_export_attribution_required")
	}
	if msg.FeedbackControllerGeneration != "" && (msg.FeedbackControllerGeneration != r.ControllerGeneration || msg.FeedbackConversationID != r.ConversationID) {
		return fail("native_generation_changed")
	}
	if err := s.store.ValidateOuterRequest(ctx, r, s.now()); err != nil {
		return fail("effective_target_or_settings_changed")
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
		// Recording the attempt can itself wait for the database. Keep that
		// receipt single-use, but never write if the deadline passed meanwhile.
		if ctx.Err() != nil || !s.now().Before(r.ExpiresAt) {
			return fail("expired_or_cancelled_before_write")
		}
		return release, nil
	}
	release()
	return func() {}, nil
}
