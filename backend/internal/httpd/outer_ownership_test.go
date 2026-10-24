package httpd

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	automationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/automation"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func seedOuterRouteOwners(t *testing.T, st *sqlite.Store, worker domain.SessionID) map[string]string {
	t.Helper()
	ctx, now := context.Background(), time.Now()
	other, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "other", Kind: domain.KindWorker, Mode: domain.SessionModeChat, Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{ControllerGeneration: "other-live"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateAutomation(ctx, domain.Automation{ID: "selected-automation", ProjectID: "selected", DisplayName: "selected", Prompt: "inert", Kind: domain.KindWorker, RRuleText: "FREQ=DAILY", Timezone: "UTC", CreatedAt: now, UpdatedAt: now, NextRunAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertCue(ctx, domain.Cue{ID: "selected-cue", ProjectID: "selected", Name: "selected", Type: domain.CueTypeAgent, Prompt: "inert", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateReport(ctx, domain.ReportRecord{ID: "selected-report", SessionID: worker, ProjectID: "selected", State: domain.ReportNeedsInput, Note: "inert", CreatedAt: now, AvailableAt: now, DeliveryState: domain.ReportPending, RepeatCount: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertReview(ctx, domain.Review{ID: "selected-review", SessionID: worker, ProjectID: "selected", Harness: domain.ReviewerCodex, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveFactoryRun(ctx, domain.FactoryRun{ID: "selected-run", ProjectID: "selected", SessionID: worker, TaskID: "task", Stage: "design", CreatedAt: now}, domain.RunEvidence{ID: "selected-created", RunID: "selected-run", Kind: "created", RecordedAt: now}, true); err != nil {
		t.Fatal(err)
	}
	if err := st.WritePR(ctx, domain.PullRequest{URL: "https://github.com/test/selected/pull/41", Number: 41, SessionID: worker, UpdatedAt: now}, nil, nil); err != nil {
		t.Fatal(err)
	}
	document, _ := json.Marshal(domain.AwakeDocument{Sessions: []domain.AwakeSession{{ID: "selected-awake", Scope: "session", SessionID: string(worker)}}})
	if err := st.SaveAwake(ctx, string(document)); err != nil {
		t.Fatal(err)
	}
	return map[string]string{"sessionId": string(worker), "projectId": "selected", "reviewId": "selected-review", "reviewSessionID": "selected-review", "runId": "selected-run", "automationId": "selected-automation", "cueId": "selected-cue", "reportId": "selected-report", "awakeId": "selected-awake", "handleId": string(worker), "otherSession": string(other.ID)}
}

func outerOwnershipPath(pattern string, ids map[string]string) string {
	for key, id := range ids {
		pattern = strings.ReplaceAll(pattern, "{"+key+"}", id)
	}
	id := "opaque-resource"
	if strings.HasPrefix(pattern, "/api/v1/projects/") {
		id = "selected"
	} else if strings.HasPrefix(pattern, "/api/v1/prs/") {
		id = "41"
	}
	pattern = strings.ReplaceAll(pattern, "{id}", id)
	for strings.Contains(pattern, "{") {
		start := strings.Index(pattern, "{")
		end := strings.Index(pattern[start:], "}") + start
		pattern = pattern[:start] + "opaque-resource" + pattern[end+1:]
	}
	return strings.ReplaceAll(pattern, "*", "opaque-resource")
}

func outerOwnerBody(ids map[string]string, forged bool) string {
	project, session, parent := "selected", ids["sessionId"], ids["sessionId"]
	if forged {
		project, session, parent = "other", ids["otherSession"], ids["otherSession"]
	}
	body, _ := json.Marshal(map[string]any{"projectId": project, "sessionId": session, "parentSessionId": parent, "scope": "session", "prUrl": "https://github.com/test/selected/pull/41", "userAuthored": true, "senderSessionId": "human"})
	return string(body)
}

func TestOuterEveryMutationRouteRejectsOmittedAndForgedOwnership(t *testing.T) {
	_, st, svc, anchor, worker, _ := outerHTTPFixture(t)
	ids := seedOuterRouteOwners(t, st, worker)
	router := chi.NewRouter()
	router.Use(outerGuard(router, svc))
	effects := 0
	for key := range outerMutationManifest {
		method, path, _ := strings.Cut(key, " ")
		router.MethodFunc(method, path, func(w http.ResponseWriter, _ *http.Request) { effects++; w.WriteHeader(http.StatusNoContent) })
	}
	outerToken, err := st.IssueOuterCaller(context.Background(), anchor)
	if err != nil {
		t.Fatal(err)
	}
	wrongToken, err := st.IssueOuterCaller(context.Background(), domain.SessionID(ids["otherSession"]))
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(outerMutationManifest))
	for key := range outerMutationManifest {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		t.Run(key, func(t *testing.T) {
			method, pattern, _ := strings.Cut(key, " ")
			path := outerOwnershipPath(pattern, ids)
			for _, attempt := range []struct{ name, body, token string }{
				{"omitted credential", outerOwnerBody(ids, false), ""},
				{"forged ownership", outerOwnerBody(ids, true), ""},
				{"outer credential", outerOwnerBody(ids, true), outerToken},
				{"wrong project credential", outerOwnerBody(ids, false), wrongToken},
			} {
				// Creation's actual destination is selected; an unrelated sessionId
				// must not replace its projectId as the guard's target.
				if attempt.name == "forged ownership" && (pattern == "/api/v1/sessions" || pattern == "/api/v1/orchestrators" || pattern == "/api/v1/orchestrators/delegate" || pattern == "/api/v1/automations") {
					attempt.body = strings.ReplaceAll(attempt.body, `"projectId":"other"`, `"projectId":"selected"`)
				}
				if attempt.name == "forged ownership" && (pattern == "/api/v1/reports" || pattern == "/api/v1/runs" || pattern == "/api/v1/awake/sessions") {
					attempt.body = strings.ReplaceAll(attempt.body, `"sessionId":"`+ids["otherSession"]+`"`, `"sessionId":"`+ids["sessionId"]+`"`)
				}
				before := effects
				req := httptest.NewRequest(method, path, strings.NewReader(attempt.body))
				req.Header.Set("X-AO-Scope-Credential", attempt.token)
				response := httptest.NewRecorder()
				router.ServeHTTP(response, req)
				if response.Code != http.StatusConflict || effects != before {
					t.Fatalf("%s reached mutation: %d %s", attempt.name, response.Code, response.Body.String())
				}
			}
		})
	}
}

func TestOuterAutomationDeletionUsesActualOwnerAndNativeOnlyNeverEscapesScope(t *testing.T) {
	_, st, svc, _, worker, _ := outerHTTPFixture(t)
	seedOuterRouteOwners(t, st, worker)
	automations := automationsvc.New(automationsvc.Deps{Store: st})
	router := NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, APIDeps{Outer: svc, Automations: automations}, ControlDeps{})
	for _, body := range []string{`{"projectId":"other"}`, `{"sessionId":"other-1","projectId":"other"}`, `{}`} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/v1/automations/selected-automation", strings.NewReader(body)))
		if response.Code != http.StatusConflict {
			t.Fatal("ownership claim bypassed automation guard", response.Code, response.Body.String())
		}
	}
	if err := automations.Delete(context.Background(), "selected-automation"); err == nil {
		t.Fatal("direct service deletion bypassed native-only policy")
	}
	if _, found, err := st.GetAutomation(context.Background(), "selected-automation"); err != nil || !found {
		t.Fatal("held automation was deleted", found, err)
	}
	if err := svc.AuthorizeOperation(context.Background(), "native_only", "other", ""); err == nil {
		t.Fatal("unselected Project bypassed native-only policy")
	}
}

func TestOuterPRMergeOwnershipUsesTheExactTrackedURL(t *testing.T) {
	_, st, svc, _, worker, _ := outerHTTPFixture(t)
	ids := seedOuterRouteOwners(t, st, worker)
	other := domain.SessionID(ids["otherSession"])
	if err := st.WritePR(context.Background(), domain.PullRequest{URL: "https://github.com/test/other/pull/41", Number: 41, SessionID: other, UpdatedAt: time.Now().Add(time.Minute)}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.ResolveTarget(context.Background(), "pr", "41"); err == nil {
		t.Fatal("ambiguous numeric PR identity was accepted")
	}
	router := chi.NewRouter()
	router.Use(outerGuard(router, svc))
	effects := 0
	router.Post("/api/v1/prs/{id}/merge", func(w http.ResponseWriter, _ *http.Request) { effects++; w.WriteHeader(http.StatusNoContent) })
	for _, caller := range []domain.SessionID{"", other, worker} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/prs/41/merge", strings.NewReader(outerOwnerBody(ids, true)))
		if caller != "" {
			token, err := st.IssueOuterCaller(context.Background(), caller)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-AO-Scope-Credential", token)
		}
		before := effects
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if caller == worker {
			if response.Code != http.StatusNoContent || effects != before+1 {
				t.Fatal("actual PR owner could not reach its own target", response.Code)
			}
		} else if response.Code != http.StatusConflict || effects != before {
			t.Fatal("numeric or body claims substituted another PR owner", caller, response.Code)
		}
	}
}

func TestOuterNativeRelayAndLocalCredentialsResolveTheSameStoredOwners(t *testing.T) {
	_, st, svc, _, worker, key := outerHTTPFixture(t)
	ids := seedOuterRouteOwners(t, st, worker)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(outerGuard(router, svc))
	var reached string
	for key := range outerMutationManifest {
		method, path, _ := strings.Cut(key, " ")
		router.MethodFunc(method, path, func(w http.ResponseWriter, r *http.Request) {
			reached = r.Method + " " + r.URL.Path
			w.Header().Set("content-type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
		})
	}
	mountOuterNative(router, svc, authority)
	for action, route := range outerNativeControls {
		t.Run(action, func(t *testing.T) {
			target := ids["sessionId"]
			switch route.Owner {
			case "project", "body":
				target = "selected"
			case "run":
				target = "selected-run"
			case "pr":
				target = "41"
			}
			control := &nativeOuterControl{Action: action, TargetID: target, PendingID: "pending", Generation: "worker-live", Body: json.RawMessage(outerOwnerBody(ids, false))}
			input := nativeOuterInput{ID: uuid.NewString(), Operation: "control", Control: control, Nonce: uuid.NewString(), Expires: time.Now().Add(9 * time.Second).UnixMilli()}
			body, _ := json.Marshal(input)
			mac := hmac.New(sha256.New, key)
			_, _ = mac.Write(append([]byte("outer-native-v1:"), body...))
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/outer/native", strings.NewReader(string(body)))
			req.RemoteAddr = "127.0.0.1:12345"
			req.Header.Set("X-AO-Delegation-MAC", hex.EncodeToString(mac.Sum(nil)))
			response := httptest.NewRecorder()
			reached = ""
			router.ServeHTTP(response, req)
			if response.Code != http.StatusOK || reached == "" {
				t.Fatal("supported exact native caller did not reach its route", response.Code, response.Body.String())
			}
		})
	}
	token, err := st.IssueOuterCaller(context.Background(), worker)
	if err != nil {
		t.Fatal(err)
	}
	for key, operation := range outerMutationManifest {
		t.Run("scoped "+key, func(t *testing.T) {
			method, pattern, _ := strings.Cut(key, " ")
			path := outerOwnershipPath(pattern, ids)
			owned := false
			for _, owner := range outerResourceRoutes {
				owned = owned || pattern == owner.Prefix || strings.HasPrefix(pattern, owner.Prefix+"/")
			}
			creation := key == "POST /api/v1/sessions" || key == "POST /api/v1/runs" || key == "POST /api/v1/reports" || key == "POST /api/v1/awake/sessions" || key == "POST /api/v1/orchestrators" || key == "POST /api/v1/orchestrators/delegate"
			allowed := (owned || creation) && operation != "native_only"
			body := outerOwnerBody(ids, !creation)
			req := httptest.NewRequest(method, path, strings.NewReader(body))
			req.Header.Set("X-AO-Scope-Credential", token)
			reached = ""
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if allowed && (response.Code != http.StatusOK || reached != method+" "+path) {
				t.Fatal("legitimate project-local caller was not preserved", response.Code, reached)
			}
			if !allowed && (response.Code != http.StatusConflict || reached != "") {
				t.Fatal("unsupported local control bypassed its hold", response.Code, reached)
			}
		})
	}
}
