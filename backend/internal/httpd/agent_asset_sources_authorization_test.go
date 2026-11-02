package httpd

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
)

func TestAgentAssetSourcesRequireExactNativeConfirmationWithOuterBinding(t *testing.T) {
	_, store, svc, anchor, worker, key := outerHTTPFixture(t)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	const path = "/api/v1/settings/agent-asset-sources"
	const body = `{"agentAssetSources":["/live/.claude"]}`
	router := chi.NewRouter()
	router.Use(outerGuard(router, svc))
	effects := 0
	router.Patch(path, func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil || string(payload) != body || r.Header.Get("X-AO-Scope-Credential") != "" {
			t.Errorf("confirmed payload=%s scope=%q err=%v", payload, r.Header.Get("X-AO-Scope-Credential"), err)
		}
		effects++
		w.WriteHeader(http.StatusAccepted)
	})
	mountOuterNative(router, svc, authority)
	workerToken, err := store.IssueOuterCaller(context.Background(), worker)
	if err != nil {
		t.Fatal(err)
	}
	outerToken, err := store.IssueOuterCaller(context.Background(), anchor)
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", workerToken, outerToken} {
		request := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(body))
		request.Header.Set("X-AO-Scope-Credential", token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusConflict || effects != 0 {
			t.Fatalf("ordinary/scoped request escaped hold: status=%d effects=%d", response.Code, effects)
		}
	}
	payload, err := json.Marshal(outerDesktopRequest{Route: http.MethodPatch + " " + path, Parameters: []string{}, Payload: json.RawMessage(body)})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(nativeOuterInput{ID: "asset-source-confirmation", Operation: "control", Control: &nativeOuterControl{Action: "desktop.control", Body: payload}, Nonce: "asset-source-confirmation-nonce", Expires: time.Now().Add(9 * time.Second).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(append([]byte("outer-native-v1:"), raw...))
	proof := hex.EncodeToString(mac.Sum(nil))
	for _, tc := range []struct {
		proof   string
		status  int
		effects int
	}{{"forged", http.StatusConflict, 0}, {proof, http.StatusOK, 1}, {proof, http.StatusConflict, 1}} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/outer/native", strings.NewReader(string(raw)))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("X-AO-Delegation-MAC", tc.proof)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != tc.status || effects != tc.effects {
			t.Fatalf("native confirmation status=%d want=%d effects=%d body=%s", response.Code, tc.status, effects, response.Body.String())
		}
	}
}
