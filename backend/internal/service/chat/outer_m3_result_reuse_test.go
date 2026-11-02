package chat_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
)

type m3ResultReviewService struct {
	*reviewsvc.Service
	triggerErr error
}

func (s *m3ResultReviewService) TriggerRequested(ctx context.Context, worker domain.SessionID, request reviewsvc.TriggerRequest) (reviewsvc.TriggerOutcome, error) {
	result, err := s.Service.TriggerRequested(ctx, worker, request)
	s.triggerErr = err
	return result, err
}

// Only the owned provider bootstrap receives this credential, in its process
// environment. Tests never recover it from model input or shared content.
func m3ResultCredential(t *testing.T, f *m2Fixture, run domain.ReviewRun) string {
	t.Helper()
	for _, start := range f.starts {
		if start.SessionID == domain.SessionID("review-"+run.ReviewID) {
			if token := start.Env["AO_SCOPE_CREDENTIAL"]; token != "" {
				return token
			}
		}
	}
	t.Fatal("reviewer launch environment has no session credential")
	return ""
}

func TestOuterM3ReviewResultRotatesThroughNotify(t *testing.T) {
	f, launcher, spec := m3ReviewFixture(t)
	ctx := context.Background()
	engine := reviewcore.New(reviewcore.Deps{Store: f.st, Sessions: f.st, PRs: f.st, Projects: f.st, Launcher: launcher})
	svc := reviewsvc.New(engine, f.st)
	reviews := &m3ResultReviewService{Service: svc}
	f.outer.SetReviews(reviews)
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer, Conversations: f.chat, Reviews: svc}, httpd.ControlDeps{})
	submit := func(token string, run domain.ReviewRun, want int) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"reviews": []map[string]string{{"runId": run.ID, "verdict": "approved", "body": "exact head reviewed"}}})
		r := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/"+string(spec.SessionID)+"/reviews/submit", bytes.NewReader(body))
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("X-AO-Scope-Credential", token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatal("result status", w.Code, "want", want, w.Body.String())
		}
	}

	worker, _, err := f.st.GetSession(ctx, spec.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.provision(ctx, ports.SpawnConfig{ProjectID: "a", Kind: domain.KindWorker}, false)
	if err != nil {
		t.Fatal(err)
	}
	workerToken, err := f.st.IssueOuterCaller(ctx, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherToken, err := f.st.IssueOuterCaller(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	readers := map[domain.SessionID]string{worker.ID: workerToken, other.ID: otherToken}
	worker.ReviewerHarness, worker.ReviewerConfig = domain.ReviewerCodex, spec.Config
	if err := f.st.UpdateSession(ctx, worker); err != nil {
		t.Fatal(err)
	}
	// Start the owned process with M3's environment-only credential. Later
	// approved heads must reuse it without delivering any new capability.
	initialPlan := f.propose(spec)
	f.approve(initialPlan)
	if reviews.triggerErr != nil {
		t.Fatal(reviews.triggerErr)
	}
	runs, err := f.st.ListReviewRunsBySession(ctx, spec.SessionID)
	if err != nil || len(runs) != 1 {
		t.Fatal("initial M3 run", err)
	}
	initial := runs[0]
	p := f.providers[domain.SessionID("review-"+initial.ReviewID)]
	if texts := p.sentTexts(); len(texts) != 1 || strings.Contains(texts[0], "AO_SCOPE_CREDENTIAL=") {
		t.Fatal("reviewer received a credential in model input")
	}
	launchToken := m3ResultCredential(t, f, initial)
	if _, err := f.st.AuthenticateOuterCaller(ctx, launchToken); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("launch credential has result authority before native acceptance", err)
	}
	conversation, err := f.st.ConversationForReview(ctx, initial.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	waitM2(t, func() bool { messages, _ := f.st.ConversationMessages(ctx, conversation.ID); return len(messages) > 0 })
	messages, _ := f.st.ConversationMessages(ctx, conversation.ID)
	initialTurn := messages[0].TurnID
	waitM2(t, func() bool { r, _ := f.st.GetOuterRequest(ctx, initial.BatchID); return !r.SubmittedAt.IsZero() })
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", NativeAcceptance: true})
	waitM2(t, func() bool { r, _ := f.st.GetOuterRequest(ctx, initial.BatchID); return !r.AcceptedAt.IsZero() })
	assertM3ResultCredentialConfined(t, f, router, initial, readers)
	submit(launchToken, initial, http.StatusOK)
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted, NativeSettlement: true})
	waitM2(t, func() bool {
		turn, _ := f.st.TurnByID(ctx, initialTurn)
		capacity, _ := f.st.OuterCapacity(ctx)
		return turn.State == domain.TurnStateCompleted && len(capacity) == 0
	})
	// The fixture omits daemon harness hooks. Supply their idle observation only
	// after native completion, so admission sees an idle reusable reviewer.
	recordIdle := func() {
		t.Helper()
		r, _, err := f.st.GetReviewByID(ctx, initial.ReviewID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.st.UpdateReviewActivity(ctx, r.ID, domain.ActivityIdle, "", r.ReviewerLaunchID); err != nil {
			t.Fatal(err)
		}
	}
	recordIdle()
	reviewer, _, _ := f.st.GetReviewByID(ctx, initial.ReviewID)

	db, err := sql.Open("sqlite", filepath.Join(f.dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	legacyToken := strings.Repeat("z", 43)
	legacyVerifier := sha256.Sum256([]byte(legacyToken))
	var previousToken string
	var previousRun domain.ReviewRun
	var previousCaller domain.OuterCaller
	for i, head := range []string{"b", "c", "d"} {
		pr, _, err := f.st.GetPR(ctx, spec.Review.PRURL)
		if err != nil {
			t.Fatal(err)
		}
		pr.HeadSHA = strings.Repeat(head, 40)
		if err := f.st.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatal(err)
		}
		spec.Review.HeadSHA = pr.HeadSHA
		plan := f.propose(spec)
		approved := f.approve(plan)
		if reviews.triggerErr != nil {
			t.Fatalf("approved head %d trigger: %v", i, reviews.triggerErr)
		}
		runs, err := f.st.ListReviewRunsBySession(ctx, spec.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		var run domain.ReviewRun
		for _, candidate := range runs {
			if candidate.BatchID == plan.Plan.Actions[0].ID {
				run = candidate
			}
		}
		if run.ID == "" || run.ReviewID != initial.ReviewID || launcher.starts != 1 || launcher.notifies != i+1 {
			audit, _ := f.st.PageOuterAudit(ctx, 0, 100)
			for _, event := range audit {
				if event.State == "held" || event.State == "held_or_unknown" {
					t.Log(event.Operation, event.State, event.Reason)
				}
			}
			t.Log("action receipts", approved.Actions)
			t.Fatalf("approved head %d did not reuse the live reviewer through Notify: run=%q starts=%d notifies=%d", i, run.ID, launcher.starts, launcher.notifies)
		}
		current, _, _ := f.st.GetReviewByID(ctx, run.ReviewID)
		if current.ControllerGeneration != reviewer.ControllerGeneration || current.ProviderConversationID != reviewer.ProviderConversationID || current.AgentSessionID != reviewer.AgentSessionID {
			t.Fatal("reuse replaced the controller")
		}
		token := m3ResultCredential(t, f, run)
		turn := "provider-turn-" + strconv.Itoa(i+2)
		p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turn, NativeAcceptance: true})
		waitM2(t, func() bool { r, _ := f.st.GetOuterRequest(ctx, run.BatchID); return !r.AcceptedAt.IsZero() })
		capacity, _ := f.st.OuterCapacity(ctx)
		if len(capacity) != 1 {
			t.Fatal("Notify did not reserve exactly one reviewer station")
		}
		caller, err := f.st.AuthenticateOuterCaller(ctx, token)
		if err != nil || caller.ReviewResult == nil || caller.ReviewResult.RunID != run.ID || caller.ReviewResult.HeadSHA != run.TargetSHA {
			t.Fatal("fresh credential not bound to this run/head", err)
		}
		if i == 0 {
			// A persisted prompt-issued token from the old implementation must
			// remain denied even with an otherwise valid exact run/head scope.
			document, _ := json.Marshal(caller.ReviewResult)
			if _, err := db.Exec("INSERT INTO outer_callers(verifier,session_id,project_id,generation,outer_scope) VALUES(?,?,?,?,0)", hex.EncodeToString(legacyVerifier[:]), string(worker.ID), string(worker.ProjectID), "review:"+string(document)); err != nil {
				t.Fatal(err)
			}
		}
		submit(legacyToken, run, http.StatusConflict)
		assertM3ResultCredentialConfined(t, f, router, run, readers, legacyToken)
		for _, participantToken := range readers {
			submit(participantToken, run, http.StatusConflict)
		}
		submit("", run, http.StatusConflict)
		if previousToken != "" {
			if token != previousToken || token != launchToken {
				t.Fatal("Notify replaced the launch credential")
			}
			submit(token, previousRun, 409)
			submit(previousToken, previousRun, 409)
			stale := domain.WithOuterCaller(ctx, previousCaller)
			if _, err := f.st.UpdateReviewRunResult(stale, previousRun.ID, domain.ReviewRunComplete, domain.VerdictApproved, "exact head reviewed", "", false); !errors.Is(err, domain.ErrOuterHeld) {
				t.Fatal("already authenticated revoked context passed the final writer", err)
			}
		}
		if i < 2 {
			submit(token, run, 200)
			stored, _, _ := f.st.GetReviewRun(ctx, run.ID)
			if stored.Status != domain.ReviewRunComplete || stored.Verdict != domain.VerdictApproved || stored.AutoInjectReview {
				t.Fatal("Notify result was not recorded without feedback")
			}
		} else {
			cancel := spec
			cancel.Operation = "review.cancel"
			copy := *spec.Review
			copy.RunID = run.ID
			cancel.Review = &copy
			f.approve(f.propose(cancel))
			submit(token, run, 409)
			if _, err := f.st.AuthenticateOuterCaller(ctx, token); !errors.Is(err, domain.ErrOuterHeld) {
				t.Fatal("cancelled result credential still authenticates", err)
			}
			if _, err := f.st.UpdateReviewRunResult(domain.WithOuterCaller(ctx, caller), run.ID, domain.ReviewRunComplete, domain.VerdictApproved, "late", "", false); !errors.Is(err, domain.ErrOuterHeld) {
				t.Fatal("cancelled context passed final writer", err)
			}
			verifier := sha256.Sum256([]byte(token))
			var document string
			if err := db.QueryRow("SELECT generation FROM outer_callers WHERE verifier=?", hex.EncodeToString(verifier[:])).Scan(&document); err != nil {
				t.Fatal(err)
			}
			var binding domain.OuterReviewResultScope
			if err := json.Unmarshal([]byte(strings.TrimPrefix(document, "review-session:")), &binding); err != nil || binding.RunID != "" || binding.HeadSHA != "" {
				t.Fatal("cancellation retained an active result binding", err)
			}
			stored, _, _ := f.st.GetReviewRun(ctx, run.ID)
			if launcher.cancels != 1 || stored.Status != domain.ReviewRunCancelled || stored.Verdict != domain.VerdictNone {
				t.Fatal("late receipt changed the cancelled run")
			}
		}
		capacity, _ = f.st.OuterCapacity(ctx)
		if len(capacity) != 1 {
			t.Fatal("result/cancel released capacity without native settlement")
		}
		p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: turn, TurnState: domain.TurnStateCompleted, NativeSettlement: true})
		waitM2(t, func() bool { capacity, _ := f.st.OuterCapacity(ctx); return len(capacity) == 0 })
		recordIdle()
		previousToken, previousRun, previousCaller = token, run, caller
	}
	if launcher.starts != 1 || launcher.notifies != 3 || p.sendCallCount() != 4 || f.providers[spec.SessionID].sendCallCount() != 0 {
		t.Fatal("result handling launched extra work or feedback")
	}
}
