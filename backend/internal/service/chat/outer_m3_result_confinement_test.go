package chat_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func assertM3ResultCredentialConfined(t *testing.T, f *m2Fixture, router http.Handler, run domain.ReviewRun, readers map[domain.SessionID]string, extraSecrets ...string) {
	t.Helper()
	ctx := context.Background()
	secrets := append([]string{}, extraSecrets...)
	for _, start := range f.starts {
		if token := start.Env["AO_SCOPE_CREDENTIAL"]; token != "" {
			secrets = append(secrets, token)
		}
	}
	for _, token := range readers {
		secrets = append(secrets, token)
	}
	clean := func(surface string, value any) {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(surface, err)
		}
		for _, secret := range secrets {
			if strings.Contains(string(body), secret) {
				t.Fatal(surface + " exposed a capability token")
			}
		}
		if strings.Contains(string(body), "AO_SCOPE_CREDENTIAL=") {
			t.Fatal(surface + " contains a credential command prefix")
		}
	}
	p := f.providers[domain.SessionID("review-"+run.ReviewID)]
	clean("provider input and native command content", p.sentMessages())
	conversation, err := f.st.ConversationForReview(ctx, run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	messages, err := f.st.ConversationMessages(ctx, conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	clean("stored reviewer messages", messages)
	snapshot, err := f.chat.SnapshotForReview(ctx, run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	clean("reviewer snapshot and native history", snapshot)
	request, err := f.st.GetOuterRequest(ctx, run.BatchID)
	if err != nil {
		t.Fatal(err)
	}
	clean("native request journal", request)
	read := func(path, credential string) string {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("X-AO-Scope-Credential", credential)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatal("read surface unavailable", path, w.Code)
		}
		clean("public/participant API "+path, w.Body.String())
		return w.Body.String()
	}
	path := "/api/v1/reviews/" + run.ReviewID + "/conversation"
	if !strings.Contains(read(path, ""), "Review only") {
		t.Fatal("public API did not return the real review message")
	}
	for participant, credential := range readers {
		read(path, credential)
		read("/api/v1/sessions/"+string(participant)+"/conversation", credential)
	}
	view, err := f.outer.View(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.read"}))
	if err != nil {
		t.Fatal(err)
	}
	clean("outer projection", view)
	var after int64
	for {
		audit, err := f.st.PageOuterAudit(ctx, after, 100)
		if err != nil {
			t.Fatal(err)
		}
		clean("audit journal", audit)
		if len(audit) < 100 {
			break
		}
		after = audit[len(audit)-1].Sequence
	}
	f.logWriter.mu.Lock()
	logs := f.logs.String()
	f.logWriter.mu.Unlock()
	clean("daemon/controller logs", logs)
}
