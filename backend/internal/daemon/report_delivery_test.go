package daemon

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

type reportDeliverySession struct {
	sentID      domain.SessionID
	sentMessage string
	sentKey     string
	interrupted domain.SessionID
	sendErr     error
}

func (s *reportDeliverySession) SendSemantic(_ context.Context, id domain.SessionID, message, key string) error {
	s.sentID, s.sentMessage, s.sentKey = id, message, key
	return s.sendErr
}

func (s *reportDeliverySession) InterruptTUI(_ context.Context, id domain.SessionID) error {
	s.interrupted = id
	return nil
}

type reportDeliveryStore struct{ rec domain.SessionRecord }

func (s reportDeliveryStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return s.rec, true, nil
}

func TestReportSemanticDeliveryUsesAcceptedTUIBoundary(t *testing.T) {
	sessions := &reportDeliverySession{}
	delivery := reportSemanticDelivery{
		sessions: sessions,
		store: reportDeliveryStore{rec: domain.SessionRecord{
			ID: "ao-1", Mode: domain.SessionModeTUI,
		}},
	}
	if receipt, err := delivery.Submit(context.Background(), "ao-1", "report context", reportsvc.PreparedBatch{ID: "report-batch:abc123"}); err != nil || receipt.State != domain.ReportReceiptPromptSubmitted {
		t.Fatal(err)
	}
	if sessions.sentID != "ao-1" || sessions.sentMessage != "report context" || sessions.sentKey != "report-batch:abc123" {
		t.Fatalf("semantic send = %+v", sessions)
	}
	if err := delivery.Interrupt(context.Background(), "ao-1"); err != nil {
		t.Fatal(err)
	}
	if sessions.interrupted != "ao-1" {
		t.Fatalf("interrupted = %q", sessions.interrupted)
	}
}

func (s reportDeliveryStore) ReportChatReceipt(context.Context, string) (domain.ReportDeliveryReceipt, bool, error) {
	return domain.ReportDeliveryReceipt{}, false, nil
}

func TestReportSemanticDeliveryDoesNotUseQueueReturnAsAcceptance(t *testing.T) {
	sessions := &reportDeliverySession{}
	delivery := reportSemanticDelivery{sessions: sessions, store: reportDeliveryStore{rec: domain.SessionRecord{ID: "chat", Mode: domain.SessionModeChat}}}
	receipt, err := delivery.Submit(context.Background(), "chat", "context", reportsvc.PreparedBatch{ID: "batch"})
	if !errors.Is(err, reportsvc.ErrReportDeliveryModeUnsupported) || receipt.Accepted() || sessions.sentID != "" {
		t.Fatalf("unsupported chat receipt=%+v err=%v semantic send=%q", receipt, err, sessions.sentID)
	}
}

func TestReportSemanticDeliveryMarksAComposerDraftAsBusy(t *testing.T) {
	// The coordinator backs off a busy orchestrator instead of retrying it ahead
	// of every other project, so the draft refusal must reach it as busy.
	sessions := &reportDeliverySession{sendErr: fmt.Errorf("send ao-1: %w", sessionmanager.ErrComposerBusy)}
	delivery := reportSemanticDelivery{sessions: sessions, store: reportDeliveryStore{rec: domain.SessionRecord{ID: "ao-1", Mode: domain.SessionModeTUI}}}
	_, err := delivery.Submit(context.Background(), "ao-1", "report context", reportsvc.PreparedBatch{ID: "abc123"})
	if !errors.Is(err, reportsvc.ErrOrchestratorBusy) || !errors.Is(err, sessionmanager.ErrComposerBusy) {
		t.Fatalf("Submit error = %v, want ErrOrchestratorBusy wrapping ErrComposerBusy", err)
	}

	sessions.sendErr = sessionmanager.ErrTerminated
	if _, err := delivery.Submit(context.Background(), "ao-1", "report context", reportsvc.PreparedBatch{ID: "abc123"}); errors.Is(err, reportsvc.ErrOrchestratorBusy) {
		t.Fatalf("Submit error = %v, want other failures left as they are", err)
	}
}
