package httpd

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentcreds"
)

type fakeDelegationJournal struct{ calls []string }

func (s *fakeDelegationJournal) GetMulticaDelegation(_ context.Context, id string) (domain.MulticaDelegationRecord, error) {
	s.calls = append(s.calls, "get:"+id)
	return domain.MulticaDelegationRecord{}, sql.ErrNoRows
}
func (s *fakeDelegationJournal) FindMulticaDelegation(_ context.Context, p, t string) (domain.MulticaDelegationRecord, error) {
	s.calls = append(s.calls, "find:"+p+":"+t)
	return domain.MulticaDelegationRecord{}, sql.ErrNoRows
}
func (s *fakeDelegationJournal) ReserveMulticaDelegation(_ context.Context, r domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error) {
	s.calls = append(s.calls, "reserve")
	return r, domain.ErrDelegationConflict
}
func (s *fakeDelegationJournal) SaveMulticaDelegation(_ context.Context, r domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error) {
	s.calls = append(s.calls, "save")
	return r, domain.ErrDelegationInvalid
}

func TestMulticaJournalInternalBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, host, origin, body string
		status                   int
		calls                    int
	}{
		{"read", "127.0.0.1:9999", "", `{"operation":"get","requestId":"request-1"}`, 200, 1},
		{"find", "127.0.0.1:9999", "", `{"operation":"find","projectId":"p","taskId":"t"}`, 200, 1},
		{"conflict", "127.0.0.1:9999", "", `{"operation":"reserve","record":{}}`, 403, 0},
		{"invalid", "127.0.0.1:9999", "", `{"operation":"save","record":{}}`, 400, 1},
		{"renderer cannot confirm", "127.0.0.1:9999", "http://localhost:5173", `{"operation":"reserve"}`, 403, 0},
		{"remote host", "evil.example", "", `{"operation":"get"}`, 403, 0},
		{"unknown field", "127.0.0.1:9999", "", `{"operation":"get","token":"secret"}`, 400, 0},
		{"multiple documents", "127.0.0.1:9999", "", `{"operation":"get"} {}`, 400, 0},
		{"oversized body", "127.0.0.1:9999", "", strings.Repeat("x", 100001), 403, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			journal := &fakeDelegationJournal{}
			r := chi.NewRouter()
			authority, err := delegationauth.New(bytes.Repeat([]byte{7}, 32))
			if err != nil {
				t.Fatal(err)
			}
			mountMulticaDelegationJournal(r, journal, authority, nil)
			requestBody := tc.body
			if strings.HasPrefix(requestBody, "{") {
				requestBody = `{"requestNonce":"test-nonce",` + requestBody[1:]
			}
			req := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/internal/multica-delegation-journal", bytes.NewBufferString(requestBody))
			mac := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
			_, _ = mac.Write([]byte("journal-v1:" + requestBody))
			req.Header.Set("X-AO-Delegation-MAC", hex.EncodeToString(mac.Sum(nil)))
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != tc.status || len(journal.calls) != tc.calls {
				t.Fatalf("status=%d body=%s calls=%v", w.Code, w.Body, journal.calls)
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if tc.status == 200 && body["record"] != nil {
				t.Fatal("missing record should be null")
			}
		})
	}
}

func TestMulticaPolicyUsesExistingPrivateBoundary(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, code, origin string
		signed             bool
		status             int
		want               string
	}{
		{"absent", "policy_absent", "", true, 200, "policy_absent"},
		{"allow", "policy_allowed", "", true, 200, "policy_allowed"},
		{"deny", "policy_denied", "", true, 200, "policy_denied"},
		{"unavailable", "policy_unavailable", "", true, 200, "policy_unavailable"},
		{"unknown redacted", "private-policy-content", "", true, 200, "policy_unavailable"},
		{"unsigned", "policy_allowed", "", false, 403, ""},
		{"renderer", "policy_allowed", "http://localhost:5173", true, 403, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			router := chi.NewRouter()
			mountMulticaDelegationJournal(router, &fakeDelegationJournal{}, authority, func(_ context.Context, req agentcreds.DelegationPolicyRequest) agentcreds.DelegationPolicyDecision {
				calls++
				if req.Action != "delegate" || req.RuntimeClass != "remote" {
					t.Fatal("missing policy metadata")
				}
				return agentcreds.DelegationPolicyDecision{Code: tc.code}
			})
			body := `{"operation":"evaluatePolicy","requestNonce":"test","policyRequest":{"action":"delegate","runtimeClass":"remote"}}`
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:9999/internal/multica-delegation-journal", strings.NewReader(body))
			if tc.signed {
				mac := hmac.New(sha256.New, key)
				_, _ = mac.Write([]byte("journal-v1:" + body))
				req.Header.Set("X-AO-Delegation-MAC", hex.EncodeToString(mac.Sum(nil)))
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status=%d", w.Code)
			}
			if tc.status == 200 {
				if calls != 1 || w.Body.String() != `{"record":{"code":"`+tc.want+`"}}`+"\n" {
					t.Fatalf("unsafe result: %s", w.Body.String())
				}
				if w.Header().Get("X-AO-Delegation-Response-MAC") != authority.ResponseMAC(w.Body.Bytes(), req.Header.Get("X-AO-Delegation-MAC")) {
					t.Fatal("unauthenticated policy response")
				}
			} else if calls != 0 {
				t.Fatal("unauthorized policy evaluation")
			}
		})
	}
}
