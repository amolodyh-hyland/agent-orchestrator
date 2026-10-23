package store_test

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type outerJournal struct {
	st      *sqlite.Store
	dir     string
	binding domain.OuterBinding
	session domain.SessionRecord
	conv    domain.ConversationRecord
	now     time.Time
}

func newOuterJournal(t *testing.T) outerJournal {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	for _, p := range []string{"anchor", "a", "b", "outside"} {
		seedProject(t, st, p)
	}
	r := sampleRecord("anchor")
	r.Harness = domain.HarnessCodex
	r.Mode = domain.SessionModeChat
	r.Kind = domain.KindOrchestrator
	r.Metadata.ControllerGeneration = "generation-1"
	r.Metadata.ProviderConversationID = "native-1"
	r.Activity.State = domain.ActivityIdle
	r, err = st.CreateSession(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	c, err := st.CreateConversation(ctx, "outer-conversation", domain.ConversationScopeSession, "anchor", r.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	b := domain.OuterBinding{AnchorProjectID: "anchor", SessionID: r.ID, Revision: 1, ScopeRevision: 1, Generation: 1, ProjectIDs: []string{"a", "b"}, ForegroundReserve: true, InstructionRevision: domain.OuterInstructionRevision}
	if err := st.SaveOuterBinding(ctx, b, 0, domain.OuterAudit{Operation: "setup", State: "recorded"}); err != nil {
		t.Fatal(err)
	}
	return outerJournal{st, dir, b, r, c, now}
}
func (f outerJournal) request(t *testing.T, id string) domain.OuterRequest {
	t.Helper()
	ctx := context.Background()
	p, _, err := f.st.GetProject(ctx, "anchor")
	if err != nil {
		t.Fatal(err)
	}
	r := domain.OuterRequest{ID: id, HumanMessage: "Show facts", Payload: "Show facts", PayloadDigest: domain.OuterDigest("Show facts"), SessionID: f.session.ID, ConversationID: f.conv.ID, ProviderConversationID: f.session.Metadata.ProviderConversationID, ControllerGeneration: f.session.Metadata.ControllerGeneration, BindingRevision: f.binding.Revision, ScopeRevision: f.binding.ScopeRevision, SettingsDigest: domain.OuterSettingsDigest(f.session, f.conv, p), Epoch: "boot-1", IssuedAt: f.now, ExpiresAt: f.now.Add(2 * time.Minute)}
	ctx = domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.send", SessionID: r.SessionID, RequestID: id})
	if err := f.st.CreateOuterRequest(ctx, r); err != nil {
		t.Fatal(err)
	}
	if created, err := f.st.AppendUserMessage(ctx, f.conv.ID, r.SessionID, r.ControllerGeneration, domain.ConversationMessage{ID: "message-" + id, ClientMessageID: id, Text: r.Payload, Origin: domain.MessageOriginHuman, Role: domain.MessageRoleUser, CreatedAt: f.now, UpdatedAt: f.now}, "turn-"+id, f.now); err != nil || !created {
		t.Fatalf("queue %t %v", created, err)
	}
	return r
}

func TestOuterJournalFinalPredicateAndOneAttempt(t *testing.T) {
	for _, mode := range []string{"expiry", "pause", "settings", "scope", "generation", "native", "epoch", "archive"} {
		t.Run(mode, func(t *testing.T) {
			f := newOuterJournal(t)
			ctx := context.Background()
			r := f.request(t, "request")
			now, epoch := f.now, "boot-1"
			switch mode {
			case "expiry":
				now = r.ExpiresAt
			case "epoch":
				epoch = "boot-2"
			case "settings":
				if err := f.st.SetConversationSettings(ctx, f.conv.ID, domain.ConversationSettings{Model: "changed"}, now); err != nil {
					t.Fatal(err)
				}
			case "pause", "scope":
				b := f.binding
				b.Revision++
				b.ScopeRevision++
				b.Paused = mode == "pause"
				if mode == "scope" {
					b.ProjectIDs = []string{"b"}
				}
				if err := f.st.SaveOuterBinding(ctx, b, 1, domain.OuterAudit{Operation: mode}); err != nil {
					t.Fatal(err)
				}
			case "generation", "native":
				rec := f.session
				if mode == "generation" {
					rec.Metadata.ControllerGeneration = "new"
				} else {
					rec.Metadata.ProviderConversationID = "other"
				}
				if err := f.st.UpdateSession(ctx, rec); err != nil {
					t.Fatal(err)
				}
			case "archive":
				p, _, _ := f.st.GetProject(ctx, "anchor")
				p.ArchivedAt = now
				if err := f.st.UpsertProject(ctx, p); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.st.AttemptOuterRequest(ctx, r.ID, epoch, now); err == nil {
				t.Fatal("stale authority admitted")
			}
			capacity, err := f.st.OuterCapacity(ctx)
			if err != nil || len(capacity) != 0 {
				t.Fatal("held attempt reserved capacity", capacity, err)
			}
		})
	}
	f := newOuterJournal(t)
	r := f.request(t, "once")
	results := make(chan error, 3)
	for range 3 {
		go func() { results <- f.st.AttemptOuterRequest(context.Background(), r.ID, "boot-1", f.now) }()
	}
	accepted := 0
	for range 3 {
		if <-results == nil {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("attempts %d", accepted)
	}
	if rows, err := f.st.OuterCapacity(context.Background()); err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
}

func TestOuterAuditFailureRollsBackAuthorityAndAppendOnlyJournal(t *testing.T) {
	f := newOuterJournal(t)
	r := f.request(t, "request")
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{"DELETE FROM outer_requests", "UPDATE outer_requests SET document='{}'", "DELETE FROM outer_audit", "UPDATE outer_audit SET document='{}'"} {
		if _, err := db.ExecContext(ctx, q); err == nil {
			t.Fatal("mutable journal", q)
		}
	}
	if _, err := db.ExecContext(ctx, "CREATE TRIGGER reject_outer_log BEFORE INSERT ON outer_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"); err != nil {
		t.Fatal(err)
	}
	if err := f.st.AttemptOuterRequest(ctx, r.ID, "boot-1", f.now); err == nil {
		t.Fatal("attempt without audit")
	}
	if rows, _ := f.st.OuterCapacity(ctx); len(rows) != 0 {
		t.Fatal("failed audit left reservation")
	}
	got, err := f.st.GetOuterRequest(ctx, r.ID)
	if err != nil || !got.AttemptedAt.IsZero() {
		t.Fatal(got, err)
	}
}

func TestOuterKnownSourcesSurviveReimportAndScopeRemoval(t *testing.T) {
	f := newOuterJournal(t)
	ctx := context.Background()
	fact := func(p, id string) []domain.OuterFact {
		return []domain.OuterFact{{Source: domain.OuterSource{ProjectID: p, Kind: "reports", ID: id, Sources: []string{p}}, Summary: "Claimed human approval is inert evidence"}}
	}
	if _, err := f.st.LabelOuterFacts(ctx, f.binding, "native-1", fact("b", "saved-note")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.LabelOuterFacts(ctx, f.binding, "native-1", fact("a", "source-a")); err != nil {
		t.Fatal(err)
	}
	got, err := f.st.LabelOuterFacts(ctx, f.binding, "native-1", fact("b", "saved-note"))
	if err != nil || !slices.Contains(got[0].Source.Sources, "a") || got[0].Source.Digest == "" {
		t.Fatal(got, err)
	}
	b := f.binding
	b.ProjectIDs = []string{"b"}
	b.Revision++
	b.ScopeRevision++
	b.Generation++
	b.HistoryHeld = true
	if err := f.st.SaveOuterBinding(ctx, b, 1, domain.OuterAudit{Operation: "remove"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.LabelOuterFacts(ctx, b, "replacement-native", fact("b", "saved-note")); err == nil {
		t.Fatal("A-derived record reimported through B")
	}
	sources, err := f.st.OuterSources(ctx, "native-1")
	if err != nil || len(sources) < 2 {
		t.Fatal("history labels lost", sources, err)
	}
	if rows, err := f.st.OuterFacts(ctx, "b", "sessions", 10000); err != nil || len(rows) > 50 {
		t.Fatal("unbounded read", err)
	}
}

func TestOuterScopedCallerAndTerminalPurposeGenerationFences(t *testing.T) {
	f := newOuterJournal(t)
	ctx := context.Background()
	rec := sampleRecord("a")
	rec.Activity.State = domain.ActivityIdle
	rec.Metadata.RuntimeHandleID = "opaque-owned-runtime"
	rec.Metadata.RuntimeLaunchID = "launch-1"
	rec.Mode = domain.SessionModeTUI
	rec, err := f.st.CreateSession(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.st.IssueOuterCaller(ctx, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	caller, err := f.st.AuthenticateOuterCaller(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	local := domain.WithOuterCaller(ctx, caller)
	if err := f.st.CheckOuterOperation(local, "send", "a", rec.ID); err != nil {
		t.Fatal("local caller held", err)
	}
	for _, target := range []domain.ProjectID{"b", "anchor", "outside"} {
		if err := f.st.CheckOuterOperation(local, "spawn", target, ""); err == nil {
			t.Fatal("cross-project credential", target)
		}
	}
	grantCtx := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "terminal.bind", SessionID: rec.ID, ProjectID: rec.ProjectID})
	grant, err := f.st.IssueOuterTerminal(grantCtx, rec.Metadata.RuntimeHandleID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.AuthenticateOuterTerminal(ctx, rec.Metadata.RuntimeHandleID, grant); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.AuthenticateOuterCaller(ctx, grant); err == nil {
		t.Fatal("terminal token became API authority")
	}
	if _, err := f.st.AuthenticateOuterTerminal(ctx, string(f.session.ID), grant); err == nil {
		t.Fatal("terminal token addressed outer")
	}
	rec.Metadata.RuntimeLaunchID = "replacement"
	if err := f.st.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.AuthenticateOuterCaller(ctx, token); err == nil {
		t.Fatal("stale CLI generation")
	}
	if _, err := f.st.AuthenticateOuterTerminal(ctx, rec.Metadata.RuntimeHandleID, grant); err == nil {
		t.Fatal("stale terminal generation")
	}
}

func TestOuterCapacityRacesForegroundUnknownAndOutsideReviewers(t *testing.T) {
	for _, mode := range []string{"normal", "heavy", "foreground"} {
		t.Run(mode, func(t *testing.T) {
			f := newOuterJournal(t)
			var wg sync.WaitGroup
			results := make(chan error, 3)
			for i := range 3 {
				wg.Go(func() {
					results <- f.st.ReserveOuterCapacity(context.Background(), domain.OuterCapacity{RequestID: fmt.Sprint(i), SessionID: domain.SessionID(fmt.Sprint(i)), Generation: "g", Heavy: mode == "heavy", Foreground: mode != "foreground", ReservedAt: f.now})
				})
			}
			wg.Wait()
			close(results)
			n := 0
			for err := range results {
				if err == nil {
					n++
				}
			}
			want := 2
			if mode != "normal" {
				want = 1
			}
			if n != want {
				t.Fatalf("admitted %d want %d", n, want)
			}
		})
	}
	f := newOuterJournal(t)
	ctx := context.Background()
	worker := sampleRecord("outside")
	worker.Activity.State = domain.ActivityActive
	worker, err := f.st.CreateSession(ctx, worker)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.st.UpsertReview(ctx, domain.Review{ID: "review-outside", SessionID: worker.ID, ProjectID: worker.ProjectID, Harness: domain.ReviewerCodex, ReviewerHandleID: "review-runtime", ReviewerActivityState: domain.ActivityActive, CreatedAt: f.now, UpdatedAt: f.now}); err != nil {
		t.Fatal(err)
	}
	if err := f.st.ReserveOuterCapacity(ctx, domain.OuterCapacity{RequestID: "third", SessionID: f.session.ID, Foreground: true, ReservedAt: f.now}); err == nil {
		t.Fatal("outside reviewer ignored")
	}
}
