package httpd

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func submitOuterRead(t *testing.T, router http.Handler, key []byte, in nativeOuterRead) (int, []byte) {
	t.Helper()
	in.Nonce, in.Expires = uuid.NewString(), time.Now().Add(9*time.Second).UnixMilli()
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	return sendOuterPrivate(t, router, key, "read", "outer-read-v1:", body)
}

func sendOuterPrivate(t *testing.T, router http.Handler, key []byte, endpoint, purpose string, body []byte) (int, []byte) {
	t.Helper()
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(append([]byte(purpose), body...))
	proof := hex.EncodeToString(mac.Sum(nil))
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/outer/"+endpoint, strings.NewReader(string(body)))
	req.RemoteAddr = "127.0.0.1:23456"
	req.Header.Set("X-AO-Delegation-MAC", proof)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code == http.StatusOK {
		responseMAC := hmac.New(sha256.New, key)
		_, _ = responseMAC.Write([]byte("journal-response-v1:" + proof + ":" + response.Body.String()))
		if response.Header().Get("X-AO-Delegation-Response-MAC") != hex.EncodeToString(responseMAC.Sum(nil)) {
			t.Fatal("desktop read response was not bound to its exact request")
		}
	}
	return response.Code, response.Body.Bytes()
}

func TestOuterDesktopReadsHaveDistinctAuthorityAndCannotIssueHumanRequests(t *testing.T) {
	router, st, svc, anchor, _, key := outerHTTPFixture(t)
	for _, query := range []nativeOuterRead{{Projection: "view"}, {Projection: "facts", ProjectID: "selected", Kind: "sessions", Limit: 20}, {Projection: "audit", Limit: 100}} {
		if status, body := submitOuterRead(t, router, key, query); status != http.StatusOK || !strings.Contains(string(body), `"projection":"`+query.Projection+`"`) {
			t.Fatal("trusted desktop observation failed", query, status, string(body))
		}
	}
	if _, err := svc.View(context.Background()); err == nil {
		t.Fatal("internal anonymous caller inherited desktop read authority")
	}
	if _, err := svc.Audit(context.Background(), 0, 10); err == nil {
		t.Fatal("internal anonymous audit inherited desktop authority")
	}
	if _, err := svc.Read(context.Background(), "selected", "reports", 1); err == nil {
		t.Fatal("internal anonymous facts inherited desktop authority")
	}
	input := nativeOuterRead{Projection: "view", Nonce: uuid.NewString(), Expires: time.Now().Add(9 * time.Second).UnixMilli()}
	body, _ := json.Marshal(input)
	if status, _ := sendOuterPrivate(t, router, key, "read", "outer-native-v1:", body); status != http.StatusConflict {
		t.Fatal("mutating request purpose authenticated a passive read")
	}
	if status, _ := sendOuterPrivate(t, router, key, "native", "outer-read-v1:", body); status != http.StatusConflict {
		t.Fatal("read purpose authenticated a mutating request")
	}
	if status, _ := sendOuterPrivate(t, router, key, "read", "outer-read-v1:", body); status != http.StatusOK {
		t.Fatal("valid exact desktop read held")
	}
	if status, _ := sendOuterPrivate(t, router, key, "read", "outer-read-v1:", body); status != http.StatusConflict {
		t.Fatal("private read nonce replayed")
	}
	for _, query := range []nativeOuterRead{{Projection: "facts", ProjectID: "other", Kind: "sessions", Limit: 1}, {Projection: "facts", ProjectID: "selected", Kind: "sessions", Limit: 51}, {Projection: "audit", Limit: 101}, {Projection: "view", ProjectID: "selected"}, {Projection: "send"}} {
		if status, _ := submitOuterRead(t, router, key, query); status != http.StatusConflict {
			t.Fatal("unbounded or unsupported desktop projection accepted", query, status)
		}
	}
	if requests, err := st.ListOuterHostRequests(context.Background()); err != nil || len(requests) != 0 {
		t.Fatal("passive reads minted human authority", requests, err)
	}
	if capacity, err := st.OuterCapacity(context.Background()); err != nil || len(capacity) != 0 {
		t.Fatal("passive reads admitted computation", capacity, err)
	}
	if rec, found, err := st.GetSession(context.Background(), anchor); err != nil || !found || rec.Metadata.ControllerGeneration != "outer-live" {
		t.Fatal("passive read replaced or resumed the outer", rec, err)
	}
}

func TestOuterScopedAuditExcludesOtherProjectsAndRemovedSources(t *testing.T) {
	_, st, svc, anchor, _, _ := outerHTTPFixture(t)
	ctx := context.Background()
	for _, event := range []domain.OuterAudit{
		{Operation: "selected-visible", ProjectID: "selected", State: "held"},
		{Operation: "other-private", ProjectID: "other", State: "held"},
		{Operation: "other-private", ProjectID: "other", SessionID: anchor, State: "held"},
		{Operation: "old-source-private", SessionID: anchor, State: "observed", Sources: []domain.OuterSource{{ProjectID: "other", Sources: []string{"other"}}}},
		{Operation: "old-source-private", SessionID: anchor, State: "observed", ProjectIDs: []string{"other"}},
	} {
		if err := st.AppendOuterAudit(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	token, err := st.IssueOuterCaller(ctx, anchor)
	if err != nil {
		t.Fatal(err)
	}
	caller, err := st.AuthenticateOuterCaller(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := svc.Audit(domain.WithOuterCaller(ctx, caller), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range rows {
		if event.Operation == "other-private" || event.Operation == "old-source-private" {
			t.Fatal("scoped outer obtained unrelated retained context", event)
		}
		found = found || event.Operation == "selected-visible"
	}
	if !found {
		t.Fatal("current selected-project audit was unavailable")
	}
}

func TestOuterAffectedProjectTimelineSurvivesScopeRemovalOnTrustedDesktopOnly(t *testing.T) {
	router, st, svc, anchor, _, key := outerHTTPFixture(t)
	ctx := context.Background()
	if err := st.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "selected-held-action", ProjectID: "selected", SessionID: anchor, State: "held"}); err != nil {
		t.Fatal(err)
	}
	if err := st.AppendOuterAudit(ctx, domain.OuterAudit{Operation: "unrelated-private", ProjectID: "other", State: "held"}); err != nil {
		t.Fatal(err)
	}
	b, _, err := svc.Binding(ctx)
	if err != nil {
		t.Fatal(err)
	}
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.scope", ActionID: "scope-removal"})
	if _, err := svc.SetScope(native, b.Revision, []string{}, false, true); err != nil {
		t.Fatal(err)
	}
	status, body := submitOuterRead(t, router, key, nativeOuterRead{Projection: "audit", ProjectID: "selected", Limit: 100})
	if status != http.StatusOK || !strings.Contains(string(body), "selected-held-action") || !strings.Contains(string(body), "scope-removal") || strings.Contains(string(body), "unrelated-private") {
		t.Fatal("affected Project lost retained events or received unrelated events", status, string(body))
	}
	for _, path := range []string{"/api/v1/outer/audit?projectId=selected", "/api/v1/outer/audit?projectId=other"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusConflict {
			t.Fatal("Project filter bypassed read authority", path, response.Code)
		}
	}
	if _, err := svc.AuditProject(ctx, "selected", 0, 100); err == nil {
		t.Fatal("anonymous internal Project read inherited desktop authority")
	}
	if requests, err := st.ListOuterHostRequests(ctx); err != nil || len(requests) != 0 {
		t.Fatal("timeline navigation issued a human request", requests, err)
	}
	if capacity, err := st.OuterCapacity(ctx); err != nil || len(capacity) != 0 {
		t.Fatal("timeline navigation admitted computation", capacity, err)
	}
}
