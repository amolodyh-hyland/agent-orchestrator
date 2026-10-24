package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func outerReceipt(row gen.OuterRequest) (domain.OuterRequestReceipt, error) {
	r := domain.OuterRequestReceipt{TurnID: row.TurnID, AttemptedAt: timeFromNull(row.AttemptedAt), SubmittedAt: timeFromNull(row.SubmittedAt), AcceptedAt: timeFromNull(row.AcceptedAt), SettledAt: timeFromNull(row.SettledAt), ProviderTurnID: row.ProviderTurnID, State: "recorded"}
	if err := json.Unmarshal([]byte(row.Document), &r.Request); err != nil {
		return r, err
	}
	if r.TurnID != "" {
		r.State = "ao_queued"
	}
	if !r.AttemptedAt.IsZero() {
		r.State = "unknown"
	}
	if !r.SubmittedAt.IsZero() {
		r.State = "provider_submitted"
	}
	if !r.AcceptedAt.IsZero() {
		r.State = "native_accepted"
	}
	if !r.SettledAt.IsZero() {
		r.State = "settled"
	}
	return r, nil
}

// GetOuterRequest reads the original immutable request and its delivery observations.
func (s *Store) GetOuterRequest(ctx context.Context, id string) (domain.OuterRequestReceipt, error) {
	r, err := s.conversationReader(ctx).GetOuterRequest(ctx, id)
	if err != nil {
		return domain.OuterRequestReceipt{}, err
	}
	receipt, err := outerReceipt(r)
	return s.decorateOuterReceipt(ctx, receipt), err
}

// ListOuterRequests reads bounded request receipts for one outer session.
func (s *Store) ListOuterRequests(ctx context.Context, id domain.SessionID) ([]domain.OuterRequestReceipt, error) {
	rows, err := s.qr.ListOuterRequests(ctx, string(id))
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterRequestReceipt, 0, len(rows))
	for _, row := range rows {
		r, err := outerReceipt(row)
		if err != nil {
			return nil, err
		}
		out = append(out, s.decorateOuterReceipt(ctx, r))
	}
	return out, nil
}

// CreateOuterRequest persists an exact native-issued request before queue insertion.
func (s *Store) CreateOuterRequest(ctx context.Context, r domain.OuterRequest) error {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.send" || a.SessionID != r.SessionID || a.RequestID != r.ID {
		return domain.ErrOuterHeld
	}
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "issue outer request", func(q *gen.Queries) error {
		if err := validateOuterRequest(ctx, q, r, r.IssuedAt); err != nil {
			return err
		}
		if err := q.InsertOuterRequest(ctx, gen.InsertOuterRequestParams{ID: r.ID, Document: string(data)}); err != nil {
			return err
		}
		for _, source := range r.Sources {
			if r.PlanID != "" {
				doc, err := json.Marshal(source)
				if err != nil {
					return err
				}
				if err := q.UpsertOuterSource(ctx, gen.UpsertOuterSourceParams{ConversationID: r.ProviderConversationID, SourceKey: "export:" + r.ID + ":" + source.ProjectID + ":" + source.ID, Document: string(doc)}); err != nil {
					return err
				}
			}
			if source.Kind == "human_input" {
				doc, err := json.Marshal(source)
				if err != nil {
					return err
				}
				if err := q.UpsertOuterSource(ctx, gen.UpsertOuterSourceParams{ConversationID: r.ProviderConversationID, SourceKey: "unknown_human_and_native_context", Document: string(doc)}); err != nil {
					return err
				}
			}
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.send", State: "recorded", RequestID: r.ID, SessionID: r.SessionID, Generation: r.ControllerGeneration, Digest: r.PayloadDigest, Sources: r.Sources})
	})
}

func validateOuterRequest(ctx context.Context, q *gen.Queries, r domain.OuterRequest, now time.Time) error {
	doc, err := q.GetOuterBinding(ctx)
	if err != nil {
		return err
	}
	var b domain.OuterBinding
	if err := json.Unmarshal([]byte(doc), &b); err != nil {
		return err
	}
	owner := r.SessionID
	if r.PlanID != "" {
		owner = r.OwnerSessionID
	}
	if b.Paused || b.HistoryHeld || b.SessionID != owner || b.Revision != r.BindingRevision || b.ScopeRevision != r.ScopeRevision || !now.Before(r.ExpiresAt) {
		return domain.ErrOuterHeld
	}
	if r.PlanID != "" {
		if err := validateOuterActionRequest(ctx, q, r, now); err != nil {
			return err
		}
	}
	for _, id := range b.ProjectIDs {
		p, err := q.GetProject(ctx, domain.ProjectID(id))
		if err != nil || p.ArchivedAt.Valid {
			return domain.ErrOuterHeld
		}
	}
	for _, source := range r.Sources {
		for _, id := range append(append([]string{}, source.Sources...), source.ProjectID) {
			if id != "" && !slices.Contains(b.ProjectIDs, id) {
				return domain.ErrOuterHeld
			}
		}
		if err := validateOuterFactSource(ctx, q, source); err != nil {
			return err
		}
	}
	row, err := q.GetSession(ctx, r.SessionID)
	if err != nil {
		return err
	}
	rec := rowToRecord(row)
	if rec.IsTerminated || rec.Harness != domain.HarnessCodex || rec.Mode != domain.SessionModeChat || rec.Metadata.ControllerGeneration != r.ControllerGeneration || rec.Metadata.ProviderConversationID != r.ProviderConversationID {
		return domain.ErrOuterHeld
	}
	conv, err := q.SelectConversationByID(ctx, r.ConversationID)
	if err != nil {
		return err
	}
	project, err := q.GetProject(ctx, rec.ProjectID)
	if err != nil {
		return err
	}
	p := projectRowFromGen(project)
	if !p.ArchivedAt.IsZero() {
		return domain.ErrOuterHeld
	}
	if domain.OuterSettingsDigest(rec, conversationToDomain(conv), p) != r.SettingsDigest {
		return domain.ErrOuterHeld
	}
	return nil
}

func validateOuterFactSource(ctx context.Context, q *gen.Queries, source domain.OuterSource) error {
	switch source.Kind {
	case "sessions":
		r, err := q.GetSession(ctx, domain.SessionID(source.ID))
		if err != nil || r.ProjectID == nil || string(*r.ProjectID) != source.ProjectID || r.Revision != source.Revision || source.Digest == "" {
			return domain.ErrOuterHeld
		}
	case "reports":
		r, err := q.GetReport(ctx, source.ID)
		if err != nil || r.ProjectID != source.ProjectID {
			return domain.ErrOuterHeld
		}
		note := []rune(r.Note)
		summary := string(note[:min(len(note), 8000)])
		if domain.OuterDigest([]any{summary, r.State, r.DeliveryState + ":" + r.DeliveryBatchID, int64(0), ""}) != source.Digest {
			return domain.ErrOuterHeld
		}
	case "runs":
		document, err := q.GetFactoryRun(ctx, source.ID)
		var run domain.FactoryRun
		if err != nil || json.Unmarshal([]byte(document), &run) != nil || run.ProjectID != source.ProjectID || run.Version != source.Revision || source.Digest == "" {
			return domain.ErrOuterHeld
		}
	}
	return nil
}

// ValidateOuterRequest checks current scope, settings, native identity and labeled source revisions.
func (s *Store) ValidateOuterRequest(ctx context.Context, r domain.OuterRequest, now time.Time) error {
	return validateOuterRequest(ctx, s.conversationReader(ctx), r, now)
}

// AttemptOuterRequest earmarks one submission and its capacity before any provider bytes.
func (s *Store) AttemptOuterRequest(ctx context.Context, id, epoch string, now time.Time) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "attempt outer submission", func(q *gen.Queries) error {
		row, err := q.GetOuterRequest(ctx, id)
		if err != nil {
			return err
		}
		r, err := outerReceipt(row)
		if err != nil {
			return err
		}
		if r.Request.Epoch != epoch || r.TurnID == "" || !r.AttemptedAt.IsZero() {
			return domain.ErrOuterHeld
		}
		if err := validateOuterRequest(ctx, q, r.Request, now); err != nil {
			return err
		}
		adopted, err := q.AdoptOuterCapacity(ctx, gen.AdoptOuterCapacityParams{RequestID: id, SessionID: string(r.Request.SessionID), Generation: r.Request.ControllerGeneration})
		if err != nil {
			return err
		}
		if adopted != 0 {
			counts, err := s.observeOuterCapacity(ctx, q, r.Request.SessionID)
			if err != nil {
				return err
			}
			if counts.Unknown != 0 || counts.Stations > 2 || counts.HeavyReserved > 1 || (counts.ForegroundReserve && counts.Background > 1) {
				return domain.ErrOuterHeld
			}
		}
		if adopted == 0 {
			if err := s.reserveOuterCapacity(ctx, q, domain.OuterCapacity{RequestID: id, SessionID: r.Request.SessionID, Generation: r.Request.ControllerGeneration, Foreground: r.Request.PlanID == "", ReservedAt: now}); err != nil {
				return err
			}
		}
		count, err := q.AttemptOuterRequest(ctx, gen.AttemptOuterRequestParams{ID: id, AttemptedAt: nullTime(now)})
		if err != nil {
			return err
		}
		if count != 1 {
			return domain.ErrOuterHeld
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.submit", State: "attempted", RequestID: id, SessionID: r.Request.SessionID, Generation: r.Request.ControllerGeneration, Digest: r.Request.PayloadDigest, ReceiptID: r.TurnID})
	})
}

func (s *Store) reserveOuterCapacity(ctx context.Context, q *gen.Queries, r domain.OuterCapacity) error {
	counts, err := s.observeOuterCapacity(ctx, q, r.SessionID)
	if err != nil {
		return err
	}
	if counts.Unknown != 0 || counts.Stations >= 2 || (r.Heavy && counts.HeavyReserved >= 1) || (!r.Foreground && counts.ForegroundReserve && counts.Background >= 1) {
		return domain.ErrOuterHeld
	}
	return q.ReserveOuterCapacity(ctx, gen.ReserveOuterCapacityParams{RequestID: r.RequestID, SessionID: string(r.SessionID), Generation: r.Generation, Heavy: boolInt(r.Heavy), Foreground: boolInt(r.Foreground), ReservedAt: r.ReservedAt})
}

func (s *Store) observeOuterCapacity(ctx context.Context, q *gen.Queries, target domain.SessionID) (domain.OuterCapacityObservation, error) {
	c := domain.OuterCapacityObservation{ObservedAt: time.Now()}
	reservations, err := q.ListOuterCapacity(ctx)
	if err != nil {
		return c, err
	}
	c.Stations, c.Reserved = len(reservations), len(reservations)
	owners := map[domain.SessionID]bool{target: true}
	for _, v := range reservations {
		owners[domain.SessionID(v.SessionID)] = true
		if v.Heavy != 0 {
			c.HeavyReserved++
		}
		if v.Foreground == 0 {
			c.Background++
		}
	}
	// Relevant outside work is observed, never stopped or silently ignored.
	sessions, err := s.ListAllSessions(ctx)
	if err != nil {
		return c, err
	}
	for _, v := range sessions {
		if v.IsTerminated || owners[v.ID] {
			continue
		}
		switch v.Activity.State {
		case domain.ActivityActive, domain.ActivityWaitingInput, domain.ActivityBlocked:
			c.Stations++
			c.OutsideActive++
			c.Background++
		case domain.ActivityIdle, domain.ActivityExited:
		default:
			c.Unknown++
		}
	}
	reviews, err := q.OuterObservedReviewActivity(ctx)
	if err != nil {
		return c, err
	}
	for _, v := range reviews {
		if v.IsArchived && v.ReviewerHandleID == "" {
			continue
		}
		switch domain.ActivityState(v.ReviewerActivityState) {
		case domain.ActivityActive, domain.ActivityWaitingInput, domain.ActivityBlocked:
			c.Stations++
			c.OutsideActive++
			c.Background++
		case domain.ActivityIdle, domain.ActivityExited:
		default:
			if v.ReviewerHandleID != "" || v.ProviderConversationID != "" {
				c.Unknown++
			}
		}
	}
	doc, err := q.GetOuterBinding(ctx)
	if err != nil {
		return c, err
	}
	var b domain.OuterBinding
	if err := json.Unmarshal([]byte(doc), &b); err != nil {
		return c, err
	}
	c.ForegroundReserve = b.ForegroundReserve
	c.Overage = c.Stations > 2 || c.HeavyReserved > 1 || (c.ForegroundReserve && c.Background > 1)
	return c, nil
}

// ObserveOuterCapacity reports the same outside and unknown counts used by admission.
func (s *Store) ObserveOuterCapacity(ctx context.Context) (domain.OuterCapacityObservation, error) {
	return s.observeOuterCapacity(ctx, s.qr, "")
}

// ReserveOuterCapacity transactionally enforces station, heavy and foreground limits.
func (s *Store) ReserveOuterCapacity(ctx context.Context, r domain.OuterCapacity) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "reserve outer station", func(q *gen.Queries) error { return s.reserveOuterCapacity(ctx, q, r) })
}

// OuterCapacity reads retained reservations without releasing uncertain execution.
func (s *Store) OuterCapacity(ctx context.Context) ([]domain.OuterCapacity, error) {
	rows, err := s.qr.ListOuterCapacity(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterCapacity, 0, len(rows))
	for _, r := range rows {
		out = append(out, domain.OuterCapacity{RequestID: r.RequestID, SessionID: domain.SessionID(r.SessionID), Generation: r.Generation, Heavy: r.Heavy != 0, Foreground: r.Foreground != 0, ReservedAt: r.ReservedAt})
	}
	return out, nil
}

func linkOuterRequest(ctx context.Context, q *gen.Queries, session domain.SessionID, generation, conversation, turn string, msg domain.ConversationMessage, now time.Time) error {
	doc, err := q.GetOuterBinding(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var b domain.OuterBinding
	if err := json.Unmarshal([]byte(doc), &b); err != nil {
		return err
	}
	row, err := q.GetSession(ctx, session)
	if err != nil {
		return err
	}
	participant, err := q.IsOuterParticipant(ctx, session)
	if err != nil {
		return err
	}
	if !participant && (row.ProjectID == nil || string(*row.ProjectID) != b.AnchorProjectID) {
		return nil
	}
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "outer.send" || a.SessionID != session || a.RequestID != msg.ClientMessageID {
		return domain.ErrOuterHeld
	}
	request, err := q.GetOuterRequest(ctx, msg.ClientMessageID)
	if err != nil {
		return domain.ErrOuterHeld
	}
	receipt, err := outerReceipt(request)
	if err != nil {
		return err
	}
	r := receipt.Request
	expectedOrigin := domain.MessageOriginHuman
	if r.PlanID != "" {
		expectedOrigin = domain.MessageOriginAutomation
	}
	if r.ControllerGeneration != generation || r.ConversationID != conversation || msg.Text != r.Payload || msg.Origin != expectedOrigin || msg.DeliveryContentJSON != "" || msg.Continuation {
		return domain.ErrOuterHeld
	}
	if err := validateOuterRequest(ctx, q, r, now); err != nil {
		return err
	}
	count, err := q.LinkOuterRequest(ctx, gen.LinkOuterRequestParams{ID: r.ID, TurnID: turn})
	if err != nil {
		return err
	}
	if count != 1 {
		return domain.ErrOuterHeld
	}
	return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.enqueue", State: "ao_queued", RequestID: r.ID, SessionID: session, ReceiptID: turn, Digest: r.PayloadDigest})
}

// CheckOuterPendingReply binds a native reply to the original authorized turn and interaction.
func (s *Store) CheckOuterPendingReply(ctx context.Context, id domain.SessionID, conv, generation, turn, request string) error {
	row, err := s.qr.OuterRequestForProvider(ctx, gen.OuterRequestForProviderParams{ConversationID: conv, ProviderTurnID: turn, Generation: generation})
	if err != nil {
		return domain.ErrOuterHeld
	}
	receipt, err := outerReceipt(row)
	if err != nil {
		return err
	}
	b, found, err := s.OuterBinding(ctx)
	owner := id
	if receipt.Request.PlanID != "" {
		owner = receipt.Request.OwnerSessionID
	}
	if err != nil || !found || b.SessionID != owner || b.HistoryHeld || b.Paused || b.ScopeRevision != receipt.Request.ScopeRevision {
		return domain.ErrOuterHeld
	}
	r, found, err := s.GetSession(ctx, id)
	if err != nil || !found || r.IsTerminated || r.Metadata.ControllerGeneration != generation || r.Metadata.ProviderConversationID != receipt.Request.ProviderConversationID {
		return domain.ErrOuterHeld
	}
	count, err := s.qr.OuterPendingInteraction(ctx, gen.OuterPendingInteractionParams{ConversationID: conv, RequestID: request, ProviderTurnID: turn, Generation: generation, SessionID: id})
	if err != nil {
		return err
	}
	if count != 1 {
		return domain.ErrOuterHeld
	}
	return s.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "outer.pending_reply", State: "attempted", SessionID: id, Generation: generation, ReceiptID: request})
}

// RecordOuterSettlement releases a reservation only for matching accepted native settlement.
func (s *Store) RecordOuterSettlement(ctx context.Context, conversation, providerTurn, generation string, at time.Time) error {
	q, release := s.conversationWriter(ctx)
	defer release()
	row, err := q.OuterRequestForProvider(ctx, gen.OuterRequestForProviderParams{ConversationID: conversation, ProviderTurnID: providerTurn, Generation: generation})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !row.AcceptedAt.Valid || row.SettledAt.Valid {
		return nil
	}
	if err := q.SettleOuterRequest(ctx, gen.SettleOuterRequestParams{ConversationID: conversation, ProviderTurnID: providerTurn, SettledAt: nullTime(at)}); err != nil {
		return err
	}
	if _, err := q.ReleaseOuterCapacity(ctx, gen.ReleaseOuterCapacityParams{RequestID: row.ID, ReleasedAt: nullTime(at), ReleaseEvidence: "native_turn_settled:" + providerTurn}); err != nil {
		return err
	}
	return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.settlement", State: "settled", RequestID: row.ID, ReceiptID: providerTurn, Generation: generation})
}

// OuterRequestAuditLink correlates native activity with its original exact request.
func (s *Store) OuterRequestAuditLink(ctx context.Context, conv, turn, generation string) (string, error) {
	id, err := s.conversationReader(ctx).OuterRequestAuditLink(ctx, gen.OuterRequestAuditLinkParams{ConversationID: conv, ProviderTurnID: turn, Generation: generation})
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}
