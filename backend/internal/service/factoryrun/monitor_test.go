package factoryrun_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestMonitorSilenceDedupAcknowledgementAndRestart(t *testing.T) {
	f := setup(t)
	run := f.create().Run
	m := factoryrun.NewMonitor(f.db)
	state, err := m.Get(f.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.State != "in_progress" || state.Config.SilenceSeconds != 300 || state.Config.BuildSeconds <= 300 || state.Attention != nil {
		t.Fatalf("idle misrepresented: %+v", state)
	}
	deadline := time.Now().Add(-time.Minute)
	state, err = m.Configure(f.ctx, run.ID, domain.RunMonitorConfig{SilenceSeconds: 300, BuildSeconds: 1800, StageDeadline: &deadline, NextOwner: "human"})
	if err != nil {
		t.Fatal(err)
	}
	if state.Attention == nil {
		t.Fatal("missed silence")
	}
	key := state.Attention.Key
	first := state.Attention.FirstAt
	if _, err = m.Acknowledge(f.ctx, run.ID, key); err != nil {
		t.Fatal(err)
	}
	state, err = factoryrun.NewMonitor(f.db).Get(f.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Attention == nil || state.Attention.Key != key || !state.Attention.FirstAt.Equal(first) || state.Attention.AcknowledgedAt == nil || state.State != "in_progress" {
		t.Fatalf("lost alert/ack: %+v", state)
	}
	report, found, err := f.db.GetReport(f.ctx, "done")
	if err != nil || !found || report.DeliveryState == domain.ReportAcknowledged {
		t.Fatalf("observation acknowledged a report: %+v %v", report, err)
	}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	rows, err := factoryrun.NewMonitor(db).Scan(context.Background(), "p")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Attention == nil || rows[0].Attention.Key != key || rows[0].Attention.AcknowledgedAt == nil {
		t.Fatalf("restart lost monitoring: %+v", rows)
	}
}

func TestMonitorApprovedReferencesAndParticipantScope(t *testing.T) {
	f := setup(t)
	unconfirmed, err := f.svc.Create(f.ctx, factoryrun.CreateInput{ID: "unconfirmed", ProjectID: "p", TaskID: "other", SessionID: f.session.ID, DesignDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PolicyDecision: "human", RequiredChecks: []string{"focused"}, Actor: "human", Decision: "claim"})
	if err != nil {
		t.Fatal(err)
	}
	m := factoryrun.NewMonitor(f.db)
	rows, err := m.Scan(f.ctx, "")
	if err != nil || len(rows) != 0 {
		t.Fatalf("unapproved reference: %v %+v", err, rows)
	}
	if _, err = m.Get(f.ctx, unconfirmed.Run.ID); err == nil {
		t.Fatal("monitored unconfirmed claim")
	}
	if _, err := f.db.SetSessionAutoReview(f.ctx, f.session.ID, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.SetSessionAutoInjectCI(f.ctx, f.session.ID, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.SetSessionAutoInjectReview(f.ctx, f.session.ID, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	run := f.create().Run
	coordinator, err := f.db.CreateSession(f.ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := f.db.CreateSession(f.ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, CreatedAt: time.Now(), UpdatedAt: time.Now(), AutoReviewEnabled: true, AutoInjectCI: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []domain.SessionID{f.session.ID, coordinator.ID} {
		if held, err := f.db.FactoryFeedbackHeld(f.ctx, id); err != nil || !held {
			t.Fatalf("participant not held: %s %v", id, err)
		}
	}
	if held, err := f.db.FactoryFeedbackHeld(f.ctx, unrelated.ID); err != nil || held {
		t.Fatalf("unrelated held: %v %v", held, err)
	}
	state, err := m.Get(f.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, participant := range state.Participants {
		if participant.SessionID == f.session.ID && (!participant.AutoReview || !participant.AutoInjectCI || !participant.AutoInjectReview) {
			t.Fatalf("inherited settings were not captured: %+v", participant)
		}
	}
	if len(state.Participants) != 2 {
		t.Fatalf("wrong snapshot: %+v", state.Participants)
	}
	after, ok, err := f.db.GetSession(f.ctx, unrelated.ID)
	if err != nil || !ok || !after.AutoReviewEnabled || !after.AutoInjectCI {
		t.Fatal("unrelated settings changed")
	}
}

func TestMonitorUnknownOwnershipAndConcurrentReads(t *testing.T) {
	f := setup(t)
	run := f.create().Run
	m := factoryrun.NewMonitor(f.db)
	f.session.IsTerminated = true
	if err := f.db.UpdateSession(f.ctx, f.session); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			state, err := m.Get(f.ctx, run.ID)
			if err != nil {
				t.Error(err)
				return
			}
			if state.Ownership != "unknown" || state.State != "in_progress" || state.Attention == nil || state.Attention.Condition != "ownership_unknown" {
				t.Errorf("unknown released work: %+v", state)
			}
		}()
	}
	wg.Wait()
}
