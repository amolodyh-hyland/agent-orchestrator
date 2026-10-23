package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestFactoryFeedbackImmutableBindingAndAtomicRevocation(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	seedProject(t, st, "p")
	session, err := st.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	run := domain.FactoryRun{ID: "run", ProjectID: "p", SessionID: session.ID, Stage: "review", CreatedAt: time.Now()}
	if err := st.SaveFactoryRun(ctx, run, domain.RunEvidence{ID: "initial", RunID: run.ID, Kind: "created"}, true); err != nil {
		t.Fatal(err)
	}
	binding := domain.RunFeedbackBinding{ID: "feedback", RunID: run.ID, SessionID: session.ID, Round: 1, RepoName: "root", ExpiresAt: time.Now().Add(time.Minute)}
	if err := st.ReserveFactoryFeedback(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if err := st.ReserveFactoryFeedback(ctx, binding); err == nil {
		t.Fatal("duplicate binding admitted")
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{"UPDATE factory_review_feedback SET document='{}'", "DELETE FROM factory_review_feedback"} {
		if _, err := db.ExecContext(ctx, query); err == nil {
			t.Fatal("binding was mutable")
		}
	}
	if err := st.SetFactoryFeedbackControl(ctx, run.ID, 0, true); err != nil {
		t.Fatal(err)
	}
	if err := st.AttemptFactoryFeedback(ctx, binding.ID, time.Now()); err == nil {
		t.Fatal("paused submission passed final CAS")
	}
	if err := st.SetFactoryFeedbackControl(ctx, run.ID, 1, false); err != nil {
		t.Fatal(err)
	}
	if err := st.AttemptFactoryFeedback(ctx, binding.ID, time.Now()); err == nil {
		t.Fatal("unpause revived old authority")
	}
	binding.ID = "feedback-2"
	binding.Round = 2
	binding.ControlRevision = 2
	if err := st.ReserveFactoryFeedback(ctx, binding); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- st.AttemptFactoryFeedback(ctx, binding.ID, time.Now()) }()
	}
	success := 0
	for range 2 {
		if <-results == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("submission attempts accepted=%d", success)
	}
}
