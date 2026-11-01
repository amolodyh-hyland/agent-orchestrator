package chat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

// Read the capability actually delivered to the provider, rather than assuming
// that starting a process delivered a credential for every later Notify turn.
func m3ResultCredential(t *testing.T, f *m2Fixture, run domain.ReviewRun) string {
	t.Helper()
	p := f.providers[domain.SessionID("review-"+run.ReviewID)]
	var text string
	waitM2(t, func() bool {
		texts := p.sentTexts()
		if len(texts) == 0 {
			return false
		}
		text = texts[len(texts)-1]
		return strings.Contains(text, run.TargetSHA)
	})
	_, suffix, found := strings.Cut(text, "AO_SCOPE_CREDENTIAL=")
	if !found || len(suffix) < 43 {
		t.Fatal("approved reviewer turn has no result credential")
	}
	r, err := f.st.GetOuterRequest(context.Background(), run.BatchID)
	if err != nil || r.Request.Payload != text {
		t.Fatal("result credential was not sealed into the admitted payload", err)
	}
	return suffix[:43]
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
	worker.ReviewerHarness, worker.ReviewerConfig = domain.ReviewerCodex, spec.Config
	if err := f.st.UpdateSession(ctx, worker); err != nil {
		t.Fatal(err)
	}
	// Establish an idle reviewer created outside M3. It has no result scope and
	// must remain the same live process when the first approved M3 head arrives.
	if _, err := engine.TriggerWithOptions(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "review.trigger", ProjectID: "a", SessionID: spec.SessionID}), spec.SessionID, reviewcore.TriggerOptions{Harness: domain.ReviewerCodex, Config: spec.Config, InterfaceMode: domain.ReviewerInterfaceChat, PRURL: spec.Review.PRURL, Source: domain.ReviewTriggerManual}); err != nil {
		t.Fatal(err)
	}
	runs, err := f.st.ListReviewRunsBySession(ctx, spec.SessionID)
	if err != nil || len(runs) != 1 {
		t.Fatal("pre-M3 run", err)
	}
	initial := runs[0]
	p := f.providers[domain.SessionID("review-"+initial.ReviewID)]
	if texts := p.sentTexts(); len(texts) != 1 || strings.Contains(texts[0], "AO_SCOPE_CREDENTIAL=") {
		t.Fatal("pre-M3 reviewer unexpectedly has per-turn result authority")
	}
	for _, start := range f.starts {
		if start.SessionID == domain.SessionID("review-"+initial.ReviewID) && start.Env["AO_SCOPE_CREDENTIAL"] != "" {
			t.Fatal("reviewer inherited a worker credential")
		}
	}
	conversation, err := f.st.ConversationForReview(ctx, initial.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	waitM2(t, func() bool { messages, _ := f.st.ConversationMessages(ctx, conversation.ID); return len(messages) > 0 })
	messages, _ := f.st.ConversationMessages(ctx, conversation.ID)
	initialTurn := messages[0].TurnID
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", NativeAcceptance: true})
	if _, err := svc.Submit(ctx, spec.SessionID, initial.ID, domain.VerdictApproved, "pre-M3 result", ""); err != nil {
		t.Fatal(err)
	}
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted, NativeSettlement: true})
	waitM2(t, func() bool {
		turn, _ := f.st.TurnByID(ctx, initialTurn)
		return turn.State == domain.TurnStateCompleted
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
		if previousToken != "" {
			if token == previousToken {
				t.Fatal("Notify reused the previous credential")
			}
			submit(token, previousRun, 409)
			submit(previousToken, run, 409)
			submit(previousToken, previousRun, 409)
			if _, err := f.st.AuthenticateOuterCaller(ctx, previousToken); !errors.Is(err, domain.ErrOuterHeld) {
				t.Fatal("previous credential still authenticates", err)
			}
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
