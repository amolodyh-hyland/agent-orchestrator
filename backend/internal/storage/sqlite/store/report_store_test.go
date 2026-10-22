package store_test

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestReportCoordinatorMissingOrchestratorDoesNotBlockOtherProjects(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	now := time.Date(2026, 9, 14, 11, 0, 0, 0, time.UTC)
	createSession := func(project string, kind domain.SessionKind) domain.SessionRecord {
		t.Helper()
		rec := sampleRecord(project)
		rec.Kind = kind
		rec.Mode = domain.SessionModeChat
		sess, err := s.CreateSession(ctx, rec)
		if err != nil {
			t.Fatal(err)
		}
		return sess
	}
	seedProject(t, s, "a")
	seedProject(t, s, "b")
	workerA := createSession("a", domain.KindWorker)
	workerB := createSession("b", domain.KindWorker)
	orchB := createSession("b", domain.KindOrchestrator)
	outputs := []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "result", Label: "Evidence"}}
	createReport := func(id string, worker domain.SessionRecord, available time.Time) domain.ReportRecord {
		t.Helper()
		rec := domain.ReportRecord{
			ID: id, SessionID: worker.ID, ProjectID: worker.ProjectID,
			State: domain.ReportNeedsInput, Note: "decision for " + id, Outputs: outputs,
			CreatedAt: now.Add(-time.Minute), DeliveryState: domain.ReportPending,
			AvailableAt: available, RepeatCount: 1,
		}
		if _, err := s.CreateReport(ctx, rec); err != nil {
			t.Fatal(err)
		}
		return rec
	}
	originalA := createReport("report-a", workerA, now.Add(-time.Second))
	createReport("report-b", workerB, now)
	delivery := &reportCoordinatorDelivery{}
	newCoordinator := func() *reportsvc.Coordinator {
		return reportsvc.NewCoordinator(reportsvc.CoordinatorDeps{
			Store: s, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Minute,
		})
	}
	c := newCoordinator()
	if delay, err := c.RunDue(ctx); err != nil || delay != time.Minute {
		t.Fatalf("first run delay=%v err=%v", delay, err)
	}
	if len(delivery.targets) != 1 || delivery.targets[0] != orchB.ID {
		t.Fatalf("delivered to %v, want project B orchestrator", delivery.targets)
	}
	blocked, ok, err := s.GetReport(ctx, originalA.ID)
	if err != nil || !ok || blocked.DeliveryState != domain.ReportPending || blocked.ClaimToken != "" || !blocked.ClaimedAt.IsZero() || !blocked.AcknowledgedAt.IsZero() || blocked.DeliveryAttempts != 1 || !blocked.AvailableAt.Equal(now.Add(time.Minute)) || blocked.LastError != "project a has no active orchestrator" {
		t.Fatalf("blocked report=%+v ok=%v err=%v", blocked, ok, err)
	}
	if blocked.Note != originalA.Note || !blocked.CreatedAt.Equal(originalA.CreatedAt) || !reflect.DeepEqual(blocked.Outputs, outputs) || blocked.DeliveryBatchID == "" {
		t.Fatalf("report evidence changed: %+v", blocked)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := s.RequeueClaimedReports(ctx); err != nil || count != 0 {
		t.Fatalf("restart recovery count=%d err=%v", count, err)
	}
	restored, ok, err := s.GetReport(ctx, originalA.ID)
	if err != nil || !ok || !reflect.DeepEqual(restored, blocked) {
		t.Fatalf("restored=%+v want=%+v ok=%v err=%v", restored, blocked, ok, err)
	}
	c = newCoordinator()
	now = now.Add(30 * time.Second)
	createReport("report-b-later", workerB, now)
	if delay, err := c.RunDue(ctx); err != nil || delay != 30*time.Second {
		t.Fatalf("before retry delay=%v err=%v", delay, err)
	}
	if len(delivery.targets) != 2 || delivery.targets[1] != orchB.ID {
		t.Fatalf("deliveries before retry=%v", delivery.targets)
	}
	unchanged, _, err := s.GetReport(ctx, originalA.ID)
	if err != nil || !reflect.DeepEqual(unchanged, blocked) {
		t.Fatalf("retried before deadline: %+v err=%v", unchanged, err)
	}
	now = now.Add(30 * time.Second)
	if delay, err := c.RunDue(ctx); err != nil || delay != time.Minute {
		t.Fatalf("still blocked retry delay=%v err=%v", delay, err)
	}
	retried, _, err := s.GetReport(ctx, originalA.ID)
	if err != nil || retried.DeliveryAttempts != 2 || !retried.AvailableAt.Equal(now.Add(time.Minute)) || retried.DeliveryBatchID != blocked.DeliveryBatchID || retried.LastError != blocked.LastError {
		t.Fatalf("retried report=%+v err=%v", retried, err)
	}
	orchA := createSession("a", domain.KindOrchestrator)
	if delay, err := c.RunDue(ctx); err != nil || delay != time.Minute {
		t.Fatalf("orchestrator appeared before retry delay=%v err=%v", delay, err)
	}
	now = now.Add(time.Minute)
	if delay, err := c.RunDue(ctx); err != nil || delay != -1 {
		t.Fatalf("recovery delay=%v err=%v", delay, err)
	}
	if len(delivery.targets) != 3 || delivery.targets[2] != orchA.ID || !strings.Contains(delivery.messages[2], originalA.Note) || !strings.Contains(delivery.messages[2], "artifact: result") || delivery.keys[2] != blocked.DeliveryBatchID {
		t.Fatalf("recovery delivery=%+v", delivery)
	}
	acked, _, err := s.GetReport(ctx, originalA.ID)
	if err != nil || acked.DeliveryState != domain.ReportAcknowledged || !acked.AcknowledgedAt.Equal(now) || acked.LastError != "" || !reflect.DeepEqual(acked.Outputs, outputs) {
		t.Fatalf("acknowledged report=%+v err=%v", acked, err)
	}
}

type reportCoordinatorDelivery struct {
	targets  []domain.SessionID
	messages []string
	keys     []string
}

func (d *reportCoordinatorDelivery) Submit(_ context.Context, target domain.SessionID, message, key string) error {
	d.targets = append(d.targets, target)
	d.messages = append(d.messages, message)
	d.keys = append(d.keys, key)
	return nil
}

func (*reportCoordinatorDelivery) Interrupt(context.Context, domain.SessionID) error { return nil }

func TestReportStorePersistsOutputsAndDeadlinesAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	want := domain.ReportRecord{
		ID: "rpt_1", SessionID: sess.ID, ProjectID: sess.ProjectID,
		Outputs: []domain.ReportOutput{
			{Kind: domain.ReportOutputArtifact, Reference: "opaque-ref", Label: "Result"},
			{Kind: domain.ReportOutputArtifact, Reference: "second"},
			{Kind: domain.ReportOutputPRCreated, Reference: "https://github.com/o/r/pull/1"},
		},
		CreatedAt: now, DeliveryState: domain.ReportPending,
		AvailableAt: now.Add(domain.ReportBatchFallback), RepeatCount: 1,
	}
	if _, err = s.CreateReport(ctx, want); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, ok, err := s.GetReport(ctx, want.ID)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.SessionID != sess.ID || got.ProjectID != sess.ProjectID || len(got.Outputs) != 3 || got.Outputs[0].Label != "Result" || got.Outputs[1].Reference != "second" || got.Outputs[2].Kind != domain.ReportOutputPRCreated || !got.AvailableAt.Equal(want.AvailableAt) {
		t.Fatalf("got=%+v", got)
	}
	if pending, err := s.ListPendingReports(ctx, now, 10); err != nil || len(pending) != 0 {
		t.Fatalf("early pending=%+v err=%v", pending, err)
	}
	urls, err := s.ListReportedPRURLs(ctx, sess.ID)
	if err != nil || len(urls) != 1 || urls[0] != "https://github.com/o/r/pull/1" {
		t.Fatalf("reported PR URLs=%v err=%v", urls, err)
	}
	events, err := s.EventsAfter(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	var reportEvents int
	for _, event := range events {
		if event.SessionID == string(sess.ID) && event.Type == "session_updated" {
			reportEvents++
		}
	}
	if reportEvents != 1 {
		t.Fatalf("reported PR CDC events=%d, want 1", reportEvents)
	}
	pending, err := s.ListPendingReports(ctx, want.AvailableAt, 10)
	if err != nil || len(pending) != 1 || pending[0].ID != want.ID || len(pending[0].Outputs) != 3 {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
}

func TestReportStoreRejectsInvalidRecord(t *testing.T) {
	s := newTestStore(t)
	_, err := s.CreateReport(context.Background(), domain.ReportRecord{})
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestReportStoreClaimAcknowledgeAndTokenFence(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.ReportRecord{ID: "rpt_lease", SessionID: sess.ID, ProjectID: sess.ProjectID, State: domain.ReportDone, Note: "done", CreatedAt: now.Add(-domain.ReportSettlementWindow), DeliveryState: domain.ReportPending, AvailableAt: now, SettlementDeadline: now, RepeatCount: 1}
	if _, err = s.CreateReport(ctx, rec); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := s.ClaimReport(ctx, rec.ID, "lease-1", now)
	if err != nil || !ok || claimed.DeliveryAttempts != 1 || claimed.DeliveryState != domain.ReportClaimed {
		t.Fatalf("claimed=%+v ok=%v err=%v", claimed, ok, err)
	}
	if _, ok, err = s.ClaimReport(ctx, rec.ID, "lease-2", now); err != nil || ok {
		t.Fatalf("second claim ok=%v err=%v", ok, err)
	}
	if _, ok, err = s.AcknowledgeReport(ctx, rec.ID, "wrong", now.Add(time.Second)); err != nil || ok {
		t.Fatalf("wrong ack ok=%v err=%v", ok, err)
	}
	acked, ok, err := s.AcknowledgeReport(ctx, rec.ID, "lease-1", now.Add(time.Second))
	if err != nil || !ok || acked.DeliveryState != domain.ReportAcknowledged {
		t.Fatalf("acked=%+v ok=%v err=%v", acked, ok, err)
	}
}

func TestReportStoreRequeuesInterruptedClaimOnRestartAndFencesOldToken(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.ReportRecord{ID: "rpt_restart", SessionID: sess.ID, ProjectID: sess.ProjectID, Message: "information", CreatedAt: now.Add(-time.Hour), DeliveryState: domain.ReportPending, AvailableAt: now, RepeatCount: 1}
	if _, err = s.CreateReport(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ClaimReport(ctx, rec.ID, "old-token", now); err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if count, err := s.RequeueClaimedReports(ctx); err != nil || count != 1 {
		t.Fatalf("restart recovery count=%d err=%v", count, err)
	}
	recovered, ok, err := s.GetReport(ctx, rec.ID)
	if err != nil || !ok || recovered.DeliveryState != domain.ReportPending || recovered.ClaimToken != "" || !recovered.ClaimedAt.IsZero() || recovered.DeliveryAttempts != 1 || !strings.Contains(recovered.LastError, "restart") {
		t.Fatalf("recovered=%+v ok=%v err=%v", recovered, ok, err)
	}
	if _, ok, err := s.AcknowledgeReport(ctx, rec.ID, "old-token", now.Add(time.Second)); err != nil || ok {
		t.Fatalf("stale acknowledge ok=%v err=%v", ok, err)
	}
	claimed, ok, err := s.ClaimReport(ctx, rec.ID, "new-token", now.Add(2*time.Second))
	if err != nil || !ok || claimed.DeliveryAttempts != 2 {
		t.Fatalf("reclaim=%+v ok=%v err=%v", claimed, ok, err)
	}
	if _, ok, err := s.AcknowledgeReport(ctx, rec.ID, "old-token", now.Add(3*time.Second)); err != nil || ok {
		t.Fatalf("old token crossed fence ok=%v err=%v", ok, err)
	}
	if _, ok, err := s.AcknowledgeReport(ctx, rec.ID, "new-token", now.Add(4*time.Second)); err != nil || !ok {
		t.Fatalf("new acknowledge ok=%v err=%v", ok, err)
	}
}

func TestReportStoreDurableBatchIdentityExcludesLaterReportsOnRetry(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	create := func(id string) {
		t.Helper()
		_, err := s.CreateReport(ctx, domain.ReportRecord{ID: id, SessionID: sess.ID, ProjectID: "ao", Message: id, CreatedAt: now, DeliveryState: domain.ReportPending, AvailableAt: now, RepeatCount: 1})
		if err != nil {
			t.Fatal(err)
		}
	}
	create("first")
	create("second")
	claimed, err := s.ClaimPendingReportBatch(ctx, "ao", "token-1", now)
	if err != nil || len(claimed) != 2 || claimed[0].DeliveryBatchID == "" || claimed[0].DeliveryBatchID != claimed[1].DeliveryBatchID {
		t.Fatalf("claimed = %+v, err = %v", claimed, err)
	}
	batchID := claimed[0].DeliveryBatchID
	if _, err := s.ReleaseReportBatch(ctx, "ao", "token-1", now, "accepted response lost"); err != nil {
		t.Fatal(err)
	}
	create("later")
	retried, err := s.ClaimPendingReportBatch(ctx, "ao", "token-2", now)
	if err != nil || len(retried) != 2 || retried[0].DeliveryBatchID != batchID {
		t.Fatalf("retried = %+v, err = %v", retried, err)
	}
	if _, err := s.AcknowledgeReportBatch(ctx, "ao", "token-2", now); err != nil {
		t.Fatal(err)
	}
	next, err := s.ClaimPendingReportBatch(ctx, "ao", "token-3", now)
	if err != nil || len(next) != 1 || next[0].ID != "later" || next[0].DeliveryBatchID == batchID {
		t.Fatalf("next = %+v, err = %v", next, err)
	}
}

func TestReportStoreInterruptLimitSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if acquired, _, err := s.AcquireReportInterrupt(ctx, sess.ID, now, 3*time.Minute); err != nil || !acquired {
		t.Fatalf("first acquired = %v, err = %v", acquired, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if acquired, next, err := s.AcquireReportInterrupt(ctx, sess.ID, now.Add(2*time.Minute), 3*time.Minute); err != nil || acquired || !next.Equal(now.Add(3*time.Minute)) {
		t.Fatalf("restart acquired = %v, err = %v", acquired, err)
	}
	if acquired, _, err := s.AcquireReportInterrupt(ctx, sess.ID, now.Add(3*time.Minute), 3*time.Minute); err != nil || !acquired {
		t.Fatalf("boundary acquired = %v, err = %v", acquired, err)
	}
}
