package chat_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"

	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestOuterM2RoutesSeparateScopeProposalAndNativeExecution(t *testing.T) {
	f := newM2Fixture(t)
	key := bytes.Repeat([]byte{13}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer, Conversations: f.chat, DelegationAuth: authority}, httpd.ControlDeps{})
	target, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindOrchestrator}, false)
	if err != nil {
		t.Fatal(err)
	}
	request := f.request()
	b, _, _ := f.outer.Binding(context.Background())
	token, err := f.st.IssueOuterCaller(context.Background(), b.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	call := func(path, body, credential, proof string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1"+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:23456"
		req.Header.Set("X-AO-Scope-Credential", credential)
		req.Header.Set("X-AO-Delegation-MAC", proof)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	spec := domain.OuterActionSpec{Operation: "send", ProjectID: "a", SessionID: target.ID, Text: "Exact route continuation"}
	raw, _ := json.Marshal(domain.OuterPlanProposal{RequestID: request, SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
	for _, cred := range []string{"", "forged"} {
		if w := call("/api/v1/outer/plans", string(raw), cred, ""); w.Code != 409 {
			t.Fatal("unbound proposal", w.Code, w.Body.String())
		}
	}
	w := call("/api/v1/outer/plans", string(raw), token, "")
	if w.Code != 200 {
		t.Fatal("scoped proposal", w.Code, w.Body.String())
	}
	var plan domain.OuterPlanReceipt
	if err := json.Unmarshal(w.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if f.providers[target.ID].sendCalls != 0 {
		t.Fatal("proposal executed")
	}
	submit := func(digest string, sign bool) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"operation": "plan", "planId": plan.Plan.ID, "digest": digest, "id": uuid.NewString(), "nonce": uuid.NewString(), "expires": time.Now().Add(9 * time.Second).UnixMilli()})
		proof := "forged"
		if sign {
			mac := hmac.New(sha256.New, key)
			_, _ = mac.Write(append([]byte("outer-native-v1:"), body...))
			proof = hex.EncodeToString(mac.Sum(nil))
		}
		return call("/internal/outer/native", string(body), token, proof)
	}
	if w := submit(plan.Digest, false); w.Code != 409 {
		t.Fatal("scoped caller minted approval", w.Code)
	}
	if w := submit(strings.Repeat("0", 64), true); w.Code != 409 {
		t.Fatal("tampered plan digest", w.Code)
	}
	if w := submit(plan.Digest, true); w.Code != 200 {
		t.Fatal("exact native plan held", w.Code, w.Body.String())
	}
	if w := submit(plan.Digest, true); w.Code != 409 {
		t.Fatal("native approval replay", w.Code)
	}
	for _, path := range []string{"/send", "/conversation/messages", "/conversation/steer", "/conversation/steer-or-send", "/restore", "/resume-agent", "/kill"} {
		for _, cred := range []string{"", token} {
			w := call("/api/v1/sessions/"+string(target.ID)+path, `{"text":"forged","message":"forged","userAuthored":true,"senderSessionId":"human","requestId":"`+request+`"}`, cred, "")
			if w.Code != 409 {
				t.Fatal("legacy participant route", path, w.Code, w.Body.String())
			}
		}
	}
	f.providers[target.ID].mu.Lock()
	calls := f.providers[target.ID].sendCalls
	f.providers[target.ID].mu.Unlock()
	if calls != 1 {
		t.Fatal("duplicate transport calls", calls)
	}
}
