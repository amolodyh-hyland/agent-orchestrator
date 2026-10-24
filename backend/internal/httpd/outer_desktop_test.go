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
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestOuterDesktopCatalogCoversProtectedRoutes(t *testing.T) {
	for key := range outerMutationManifest {
		route, ok := outerDesktopRoutes[key]
		if !ok || route.Operation == "" || (route.Mode != "held" && route.Mode != "confirm") {
			t.Errorf("unmigrated desktop route: %s", key)
		}
	}
	for key := range outerDesktopRoutes {
		if _, found := outerMutationManifest[key]; !found {
			t.Errorf("desktop capability absent from protected inventory: %s", key)
		}
	}
}

func TestOuterDesktopJournalBindsExactRequestWithoutCopyingCredentials(t *testing.T) {
	in := nativeOuterInput{ID: "exact-native-approval-id", Operation: "control", Control: &nativeOuterControl{Action: "desktop.control", Body: json.RawMessage(`{"route":"PUT /api/v1/github/pat","parameters":[],"query":"","payload":{"pat":"test-private-credential","refreshToken":"test-private-refresh"},"attachmentUpload":false}`)}}
	raw, _ := json.Marshal(in)
	journal := outerNativeJournal(in, raw)
	if strings.Contains(string(journal), "test-private-") {
		t.Fatal("desktop credential copied into native journal")
	}
	var retained map[string]string
	if err := json.Unmarshal(journal, &retained); err != nil {
		t.Fatal(err)
	}
	if retained["id"] != in.ID || retained["route"] != "PUT /api/v1/github/pat" || retained["requestDigest"] != domain.OuterDigest(string(raw)) || retained["controlDigest"] != domain.OuterDigest(in.Control) {
		t.Fatal("exact desktop action binding lost", retained)
	}
	in.Operation = "send"
	if string(outerNativeJournal(in, raw)) != string(raw) {
		t.Fatal("dedicated outer request journal was changed")
	}
}

func TestOuterDesktopNativeRouteCoverageAndAnchorHold(t *testing.T) {
	_, st, svc, anchor, worker, key := outerHTTPFixture(t)
	ids := seedOuterRouteOwners(t, st, worker)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(outerGuard(router, svc))
	effects := 0
	for key := range outerMutationManifest {
		method, path, _ := strings.Cut(key, " ")
		router.MethodFunc(method, path, func(w http.ResponseWriter, r *http.Request) {
			effects++
			if r.Header.Get("X-AO-Attachment-Upload") != "1" || r.Header.Get("X-AO-Scope-Credential") != "" {
				t.Error("desktop header allowlist was not preserved")
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"accepted":true}`)
		})
	}
	mountOuterNative(router, svc, authority)
	call := func(t *testing.T, request outerDesktopRequest) *httptest.ResponseRecorder {
		t.Helper()
		payload, _ := json.Marshal(request)
		in := nativeOuterInput{ID: uuid.NewString(), Operation: "control", Control: &nativeOuterControl{Action: "desktop.control", Body: payload}, Nonce: uuid.NewString(), Expires: time.Now().Add(9 * time.Second).UnixMilli()}
		raw, _ := json.Marshal(in)
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(append([]byte("outer-native-v1:"), raw...))
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/outer/native", strings.NewReader(string(raw)))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-AO-Delegation-MAC", hex.EncodeToString(mac.Sum(nil)))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	for key, spec := range outerDesktopRoutes {
		t.Run(key, func(t *testing.T) {
			_, template, _ := strings.Cut(key, " ")
			actual := outerOwnershipPath(template, ids)
			parameters := []string{}
			for i, part := range strings.Split(template, "/") {
				if strings.HasPrefix(part, "{") {
					parameters = append(parameters, strings.Split(actual, "/")[i])
				}
			}
			request := outerDesktopRequest{Route: key, Parameters: parameters, Payload: json.RawMessage(outerOwnerBody(ids, false)), AttachmentUpload: true}
			before := effects
			response := call(t, request)
			if spec.Mode == "held" {
				if response.Code != http.StatusConflict || effects != before {
					t.Fatal("unsupported interface escaped hold", response.Code, response.Body.String())
				}
				return
			}
			if response.Code != http.StatusOK || effects != before+1 || !strings.Contains(response.Body.String(), `"status":202`) {
				t.Fatal("exact native desktop request did not reach its route", response.Code, response.Body.String())
			}
		})
	}
	for _, request := range []outerDesktopRequest{
		{Route: "POST /api/v1/sessions/{sessionId}/conversation/messages", Parameters: []string{string(anchor)}, Payload: json.RawMessage(`{"text":"forged human"}`)},
		{Route: "POST /api/v1/orchestrators/delegate", Parameters: []string{}, Payload: json.RawMessage(`{"projectId":"` + func() string { b, _, _ := svc.Binding(context.Background()); return b.AnchorProjectID }() + `","brief":"forged human"}`)},
		{Route: "POST https://example.invalid/send", Payload: json.RawMessage(`{}`)},
		{Route: "POST /api/v1/sessions/{sessionId}/send", Parameters: []string{"../" + string(worker)}, Payload: json.RawMessage(`{}`)},
	} {
		before := effects
		if response := call(t, request); response.Code != http.StatusConflict || effects != before {
			t.Fatal("desktop widened outer or route authority", response.Code, response.Body.String())
		}
	}
	if err := svc.AuthorizeOperation(domain.WithOuterCaller(context.Background(), domain.OuterCaller{SessionID: anchor, Outer: true}), "native_only", "selected", ""); err == nil {
		t.Fatal("outer-origin adapter enabled")
	}
}
