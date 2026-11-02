package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// CreateReport atomically persists one validated pending report and all outputs.
func (s *Store) CreateReport(ctx context.Context, rec domain.ReportRecord) (domain.ReportRecord, error) {
	if err := rec.Validate(); err != nil {
		return domain.ReportRecord{}, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var row gen.Report
	err := s.inTx(ctx, "create report", func(q *gen.Queries) error {
		var err error
		row, err = q.CreateReport(ctx, gen.CreateReportParams{
			ID: rec.ID, SessionID: string(rec.SessionID), ProjectID: string(rec.ProjectID),
			State: string(rec.State), Note: rec.Note, Message: rec.Message,
			CreatedAt: rec.CreatedAt, AvailableAt: rec.AvailableAt,
			SettlementDeadline: nullTime(rec.SettlementDeadline), RepeatCount: rec.RepeatCount,
		})
		if err != nil {
			return err
		}
		for i, output := range rec.Outputs {
			if err := q.CreateReportOutput(ctx, gen.CreateReportOutputParams{
				ReportID: rec.ID, Position: int64(i), Kind: string(output.Kind),
				Reference: output.Reference, Label: output.Label,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return domain.ReportRecord{}, fmt.Errorf("create report %s: %w", rec.ID, err)
	}
	created := reportFromGen(row)
	created.Outputs = append([]domain.ReportOutput(nil), rec.Outputs...)
	return created, nil
}

// GetReport returns one report by durable ID with its ordered outputs.
func (s *Store) GetReport(ctx context.Context, id string) (domain.ReportRecord, bool, error) {
	row, err := s.qr.GetReport(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ReportRecord{}, false, nil
	}
	if err != nil {
		return domain.ReportRecord{}, false, fmt.Errorf("get report %s: %w", id, err)
	}
	rec, err := s.reportWithOutputs(ctx, row)
	if err != nil {
		return domain.ReportRecord{}, false, err
	}
	return rec, true, nil
}

// ListReportsBySession returns a worker's reports in creation order.
func (s *Store) ListReportsBySession(ctx context.Context, id domain.SessionID) ([]domain.ReportRecord, error) {
	rows, err := s.qr.ListReportsBySession(ctx, string(id))
	if err != nil {
		return nil, fmt.Errorf("list reports: %w", err)
	}
	return s.reportsWithOutputs(ctx, rows)
}

// ListReportedPRURLs returns only a worker's structured created-PR outputs.
func (s *Store) ListReportedPRURLs(ctx context.Context, id domain.SessionID) ([]string, error) {
	urls, err := s.qr.ListReportedPRURLs(ctx, string(id))
	if err != nil {
		return nil, fmt.Errorf("list reported PR URLs for %s: %w", id, err)
	}
	return urls, nil
}

// ListReportsByProject is the read-only persisted report projection. Consumers
// such as Project Summary do not participate in the delivery claim lifecycle.
func (s *Store) ListReportsByProject(ctx context.Context, id domain.ProjectID) ([]domain.ReportRecord, error) {
	rows, err := s.qr.ListReportsByProject(ctx, string(id))
	if err != nil {
		return nil, fmt.Errorf("list project reports: %w", err)
	}
	return s.reportsWithOutputs(ctx, rows)
}

// ListPendingReportSchedule returns the earliest pending work regardless of
// availability so a coordinator can restore the original deadline after restart.
func (s *Store) ListPendingReportSchedule(ctx context.Context, limit int64) ([]domain.ReportRecord, error) {
	rows, err := s.qr.ListPendingReportSchedule(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("list report schedule: %w", err)
	}
	return s.reportsWithOutputs(ctx, rows)
}

// ClaimPendingReportBatch atomically claims every pending report for a project.
// A due, attention, or piggyback trigger therefore includes earlier batch work.
func (s *Store) ClaimPendingReportBatch(ctx context.Context, projectID domain.ProjectID, token string, at time.Time) ([]domain.ReportRecord, error) {
	if projectID == "" || token == "" || at.IsZero() {
		return nil, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var rows []gen.Report
	err := s.inTx(ctx, "claim project report batch", func(q *gen.Queries) error {
		scheduled, err := q.ListPendingReportsByProjectSchedule(ctx, gen.ListPendingReportsByProjectScheduleParams{
			ProjectID: string(projectID), Limit: 1,
		})
		if err != nil || len(scheduled) == 0 {
			return err
		}
		batchID := scheduled[0].DeliveryBatchID
		if batchID == "" {
			batchID = "report-batch:" + scheduled[0].ID
			if err := q.AssignPendingReportsToBatch(ctx, gen.AssignPendingReportsToBatchParams{
				DeliveryBatchID: batchID, ProjectID: string(projectID),
			}); err != nil {
				return err
			}
		}
		if err := q.RecoverReportChatDelivery(ctx, batchID); err != nil {
			return err
		}
		if err := q.RecoverReportChatAcceptance(ctx, batchID); err != nil {
			return err
		}
		rows, err = q.ClaimPendingReportsByBatch(ctx, gen.ClaimPendingReportsByBatchParams{
			ProjectID: string(projectID), DeliveryBatchID: batchID,
			ClaimToken: token, ClaimedAt: nullTime(at),
		})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("claim project report batch: %w", err)
	}
	return s.reportsWithOutputs(ctx, orderedReportRows(rows))
}

// AcknowledgeReportBatch completes only the project batch holding token.
func (s *Store) AcknowledgeReportBatch(ctx context.Context, projectID domain.ProjectID, token string, at time.Time) (int, error) {
	if projectID == "" || token == "" || at.IsZero() {
		return 0, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.AcknowledgeReportBatch(ctx, gen.AcknowledgeReportBatchParams{
		ProjectID: string(projectID), ClaimToken: token, AcknowledgedAt: nullTime(at),
	})
	if err != nil {
		return 0, fmt.Errorf("acknowledge project report batch: %w", err)
	}
	return len(rows), nil
}

// ReleaseReportBatch returns the matching project batch to pending without
// moving any report's original deadline later.
func (s *Store) ReleaseReportBatch(ctx context.Context, projectID domain.ProjectID, token string, at time.Time, lastError string) (int, error) {
	if projectID == "" || token == "" || at.IsZero() {
		return 0, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.ReleaseReportBatch(ctx, gen.ReleaseReportBatchParams{
		ProjectID: string(projectID), ClaimToken: token, AvailableAt: at, LastError: lastError,
	})
	if err != nil {
		return 0, fmt.Errorf("release project report batch: %w", err)
	}
	return len(rows), nil
}

// DeferReportBatch coalesces a throttled urgent retry until it may request the
// next interruption. Unlike failure release, this intentionally moves its
// delivery availability later.
func (s *Store) DeferReportBatch(ctx context.Context, projectID domain.ProjectID, token string, at time.Time, lastError string) (int, error) {
	if projectID == "" || token == "" || at.IsZero() {
		return 0, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.DeferReportBatch(ctx, gen.DeferReportBatchParams{
		ProjectID: string(projectID), ClaimToken: token, AvailableAt: at, LastError: lastError,
	})
	if err != nil {
		return 0, fmt.Errorf("defer project report batch: %w", err)
	}
	return len(rows), nil
}

// AcquireReportInterrupt durably enforces the per-worker interruption window.
func (s *Store) AcquireReportInterrupt(ctx context.Context, sessionID domain.SessionID, at time.Time, window time.Duration) (bool, time.Time, error) {
	if sessionID == "" || at.IsZero() || window <= 0 {
		return false, time.Time{}, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	acquired := false
	next := at
	err := s.inTx(ctx, "acquire report interrupt", func(q *gen.Queries) error {
		last, err := q.GetReportInterrupt(ctx, string(sessionID))
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil && last.After(at.Add(-window)) {
			next = last.Add(window)
			return nil
		}
		if err := q.PutReportInterrupt(ctx, gen.PutReportInterruptParams{SessionID: string(sessionID), LastInterruptedAt: at}); err != nil {
			return err
		}
		acquired = true
		return nil
	})
	return acquired, next, err
}

// ListPendingReports returns reports eligible for a later delivery batch.
func (s *Store) ListPendingReports(ctx context.Context, at time.Time, limit int64) ([]domain.ReportRecord, error) {
	rows, err := s.qr.ListPendingReports(ctx, gen.ListPendingReportsParams{AvailableAt: at, Limit: limit})
	if err != nil {
		return nil, fmt.Errorf("list pending reports: %w", err)
	}
	return s.reportsWithOutputs(ctx, rows)
}

// ClaimReport atomically fences one pending report to a delivery attempt token.
func (s *Store) ClaimReport(ctx context.Context, id, token string, at time.Time) (domain.ReportRecord, bool, error) {
	return s.updateReportClaim(ctx, id, token, at, "claim", func() (gen.Report, error) {
		return s.qw.ClaimReport(ctx, gen.ClaimReportParams{ID: id, ClaimToken: token, ClaimedAt: nullTime(at)})
	})
}

// AcknowledgeReport completes only the delivery attempt holding the current token.
func (s *Store) AcknowledgeReport(ctx context.Context, id, token string, at time.Time) (domain.ReportRecord, bool, error) {
	return s.updateReportClaim(ctx, id, token, at, "acknowledge", func() (gen.Report, error) {
		return s.qw.AcknowledgeReport(ctx, gen.AcknowledgeReportParams{ID: id, ClaimToken: token, AcknowledgedAt: nullTime(at)})
	})
}

// ReleaseReport returns the matching token's claim to pending with retry metadata.
func (s *Store) ReleaseReport(ctx context.Context, id, token string, availableAt time.Time, lastError string) (domain.ReportRecord, bool, error) {
	return s.updateReportClaim(ctx, id, token, availableAt, "release", func() (gen.Report, error) {
		return s.qw.ReleaseReport(ctx, gen.ReleaseReportParams{ID: id, ClaimToken: token, AvailableAt: availableAt, LastError: lastError})
	})
}

func (s *Store) updateReportClaim(ctx context.Context, id, token string, at time.Time, action string, update func() (gen.Report, error)) (domain.ReportRecord, bool, error) {
	if id == "" || token == "" || at.IsZero() {
		return domain.ReportRecord{}, false, domain.ErrInvalidReport
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := update()
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ReportRecord{}, false, nil
	}
	if err != nil {
		return domain.ReportRecord{}, false, fmt.Errorf("%s report %s: %w", action, id, err)
	}
	rec, err := s.reportWithOutputs(ctx, row)
	return rec, err == nil, err
}

// RequeueClaimedReports atomically recovers claims owned by a prior daemon process.
func (s *Store) RequeueClaimedReports(ctx context.Context) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	count, err := s.qw.RequeueClaimedReports(ctx)
	if err != nil {
		return 0, fmt.Errorf("requeue claimed reports: %w", err)
	}
	return count, nil
}

func (s *Store) reportWithOutputs(ctx context.Context, row gen.Report) (domain.ReportRecord, error) {
	outputs, err := s.qr.ListReportOutputs(ctx, row.ID)
	if err != nil {
		return domain.ReportRecord{}, fmt.Errorf("list report %s outputs: %w", row.ID, err)
	}
	rec := reportFromGen(row)
	rec.Outputs = make([]domain.ReportOutput, len(outputs))
	for i, output := range outputs {
		rec.Outputs[i] = domain.ReportOutput{Kind: domain.ReportOutputKind(output.Kind), Reference: output.Reference, Label: output.Label}
	}
	rec.DeliveryStatus = string(rec.DeliveryState)
	if rec.DeliveryBatchID != "" {
		receipt, linked, err := s.ReportChatReceipt(ctx, rec.DeliveryBatchID)
		if err != nil {
			return domain.ReportRecord{}, err
		}
		if linked {
			rec.DeliveryStatus = string(receipt.State)
			if receipt.State == domain.ReportReceiptUnknown || receipt.State == domain.ReportReceiptHeld {
				if rec.LastError == "" {
					rec.LastError = "native acceptance unproved: " + receipt.ErrorMessage
				}
				rec.LastError += "; inspect the linked turn or explicitly resolve as delivered elsewhere"
			}
		}
		resolution, err := s.qr.GetReportDeliveryResolution(ctx, rec.DeliveryBatchID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return domain.ReportRecord{}, err
		}
		if err == nil {
			rec.DeliveryStatus = resolution.Resolution
			if resolution.Resolution == "delivered_elsewhere" {
				rec.ResolutionNote = resolution.Note
				rec.LastError = ""
			} else {
				rec.LastError = resolution.Note
			}
		}
	}
	return rec, nil
}

func (s *Store) reportsWithOutputs(ctx context.Context, rows []gen.Report) ([]domain.ReportRecord, error) {
	out := make([]domain.ReportRecord, 0, len(rows))
	for _, row := range rows {
		rec, err := s.reportWithOutputs(ctx, row)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, nil
}

func orderedReportRows(rows []gen.Report) []gen.Report {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt.Equal(rows[j].CreatedAt) {
			return rows[i].ID < rows[j].ID
		}
		return rows[i].CreatedAt.Before(rows[j].CreatedAt)
	})
	return rows
}

func reportFromGen(r gen.Report) domain.ReportRecord {
	return domain.ReportRecord{
		ID: r.ID, SessionID: domain.SessionID(r.SessionID), ProjectID: domain.ProjectID(r.ProjectID),
		State: domain.ReportState(r.State), Note: r.Note, Message: r.Message, CreatedAt: r.CreatedAt,
		DeliveryState: domain.ReportDeliveryState(r.DeliveryState), AvailableAt: r.AvailableAt,
		SettlementDeadline: timeFromNull(r.SettlementDeadline), RepeatCount: r.RepeatCount,
		ClaimToken: r.ClaimToken, ClaimedAt: timeFromNull(r.ClaimedAt), DeliveryAttempts: r.DeliveryAttempts,
		AcknowledgedAt: timeFromNull(r.AcknowledgedAt), LastError: r.LastError,
		DeliveryBatchID: r.DeliveryBatchID,
	}
}

func (s *Store) ReportChatReceipt(ctx context.Context, batchID string) (domain.ReportDeliveryReceipt, bool, error) {
	row, err := s.conversationReader(ctx).ReportChatReceipt(ctx, batchID)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ReportDeliveryReceipt{}, false, nil
	}
	if err != nil {
		return domain.ReportDeliveryReceipt{}, false, err
	}
	receipt := domain.ReportDeliveryReceipt{State: domain.ReportReceiptUnknown,
		MessageID: row.MessageID, ClientMessageID: row.ClientMessageID, TurnID: row.TurnID,
		ProviderTurnID: row.ProviderTurnID, ProviderConversationID: row.ProviderConversationID, SubmittedAt: timeFromNull(row.SubmittedAt), AcceptedAt: timeFromNull(row.AcceptedAt)}
	receipt.ErrorMessage = row.ErrorMessage
	if receipt.ErrorMessage == "" {
		receipt.ErrorMessage = "native acceptance evidence unavailable for turn state " + row.State
	}
	if row.State == string(domain.TurnStateCancelled) || row.State == string(domain.TurnStateRecovered) || row.State == string(domain.TurnStateFailed) || row.State == string(domain.TurnStateInterrupted) || row.State == string(domain.TurnStateCompleted) {
		receipt.State = domain.ReportReceiptHeld
	}
	if row.State == string(domain.TurnStateQueued) {
		receipt.State = domain.ReportReceiptQueued
	}
	if row.SubmittedAt.Valid && receipt.State != domain.ReportReceiptHeld {
		receipt.State = domain.ReportReceiptProviderSubmitted
	}
	if row.AcceptedAt.Valid {
		receipt.State = domain.ReportReceiptNativeAccepted
	}
	return receipt, true, nil
}

func (s *Store) RecordReportChatAcceptance(ctx context.Context, conversationID, providerConversationID, providerTurnID string, at time.Time) error {
	q, unlock := s.conversationWriter(ctx)
	defer unlock()
	if err := q.AcceptOuterRequest(ctx, gen.AcceptOuterRequestParams{ConversationID: conversationID, ProviderConversationID: providerConversationID, ProviderTurnID: providerTurnID, AcceptedAt: nullTime(at)}); err != nil {
		return err
	}
	if err := q.AcceptOuterPlanActions(ctx, gen.AcceptOuterPlanActionsParams{ConversationID: conversationID, ProviderTurnID: providerTurnID, AcceptedAt: nullTime(at)}); err != nil {
		return err
	}
	if err := q.AcceptFactoryFeedback(ctx, gen.AcceptFactoryFeedbackParams{ConversationID: conversationID, ProviderConversationID: providerConversationID, ProviderTurnID: providerTurnID, AcceptedAt: nullTime(at)}); err != nil {
		return err
	}
	return q.RecordReportChatAcceptance(ctx, gen.RecordReportChatAcceptanceParams{
		ConversationID: conversationID, ProviderConversationID: providerConversationID, ProviderTurnID: providerTurnID, AcceptedAt: nullTime(at),
	})
}

func (s *Store) RecordReportChatSubmission(ctx context.Context, turnID string, at time.Time) error {
	q, unlock := s.conversationWriter(ctx)
	defer unlock()
	if err := q.SubmitOuterRequest(ctx, gen.SubmitOuterRequestParams{TurnID: turnID, SubmittedAt: nullTime(at)}); err != nil {
		return err
	}
	if err := q.SubmitFactoryFeedback(ctx, gen.SubmitFactoryFeedbackParams{TurnID: nullableString(turnID), SubmittedAt: nullTime(at)}); err != nil {
		return err
	}
	return q.RecordReportChatSubmission(ctx, gen.RecordReportChatSubmissionParams{TurnID: turnID, SubmittedAt: nullTime(at)})
}

func (s *Store) ResolveReportDelivery(ctx context.Context, reportID, note string, at time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "resolve report delivery", func(q *gen.Queries) error {
		r, err := q.GetReport(ctx, reportID)
		if errors.Is(err, sql.ErrNoRows) {
			return apierr.NotFound("REPORT_NOT_FOUND", "Unknown report")
		}
		if err != nil {
			return err
		}
		if r.DeliveryBatchID == "" {
			return apierr.Conflict("REPORT_NOT_LINKED", "Report has no delivery batch", nil)
		}
		existing, err := q.GetReportDeliveryResolution(ctx, r.DeliveryBatchID)
		if err == nil && existing.Resolution != "held" {
			if existing.Note != note {
				return apierr.Conflict("REPORT_RESOLUTION_CONFLICT", "A different resolution is already recorded", nil)
			}
			return nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if r.DeliveryState != "pending" {
			return apierr.Conflict("REPORT_DELIVERY_BUSY", "Only pending deliveries can be resolved", nil)
		}
		receipt, receiptErr := q.ReportChatReceipt(ctx, r.DeliveryBatchID)
		if receiptErr != nil && !errors.Is(receiptErr, sql.ErrNoRows) {
			return receiptErr
		}
		if (receiptErr != nil && existing.Resolution != "held") || receipt.State == "queued" || receipt.AcceptedAt.Valid {
			return apierr.Conflict("REPORT_NOT_UNCERTAIN", "Only a held or unknown linked delivery can be resolved", nil)
		}
		count, err := q.ResolveReportDelivery(ctx, gen.ResolveReportDeliveryParams{BatchID: r.DeliveryBatchID, Note: note, ResolvedAt: at})
		if err != nil {
			return err
		}
		if count != 1 {
			return apierr.Conflict("REPORT_RESOLUTION_CONFLICT", "Delivery changed before resolution", nil)
		}
		return nil
	})
}
