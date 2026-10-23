package httpd

import (
	"bytes"
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

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type confirmedRunService struct{ calls int }

func (*confirmedRunService) List(context.Context, string) ([]domain.FactoryRun, error) {
	return nil, nil
}
func (*confirmedRunService) Get(context.Context, string) (domain.RunDetail, error) {
	return domain.RunDetail{}, nil
}
func (*confirmedRunService) Create(context.Context, factoryrun.CreateInput) (domain.RunDetail, error) {
	return domain.RunDetail{}, nil
}
func (*confirmedRunService) Record(context.Context, string, factoryrun.RecordInput) (domain.RunDetail, error) {
	return domain.RunDetail{}, nil
}
func (*confirmedRunService) Advance(context.Context, string, factoryrun.AdvanceInput) (domain.RunDetail, error) {
	return domain.RunDetail{}, nil
}
func (s *confirmedRunService) Preview(context.Context, string, string) (factoryrun.ConfirmationPreview, error) {
	s.calls++
	return factoryrun.ConfirmationPreview{}, nil
}
func (s *confirmedRunService) Confirm(context.Context, string, string, int64, string) (domain.RunDetail, error) {
	s.calls++
	return domain.RunDetail{}, nil
}

func TestFactoryRunConfirmationPrivateAuthority(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	svc := &confirmedRunService{}
	router := chi.NewRouter()
	mountFactoryRunConfirmation(router, svc, authority)
	raw, _ := json.Marshal(map[string]any{"operation": "confirm", "runId": "run", "action": "advance", "expectedVersion": 7, "digest": strings.Repeat("a", 64), "nonce": "single-use-native-confirmation", "expires": time.Now().Add(9 * time.Second).UnixMilli()})
	sign := func(namespace string, body []byte) string {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(append([]byte(namespace), body...))
		return hex.EncodeToString(mac.Sum(nil))
	}
	invoke := func(body []byte, proof, origin string) int {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:9999/internal/factory-run-confirmation", bytes.NewReader(body))
		request.Header.Set("X-AO-Delegation-MAC", proof)
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response.Code
	}
	for _, proof := range []string{"", strings.Repeat("a", 64), sign("journal-v1:", raw)} {
		if invoke(raw, proof, "") != 403 {
			t.Fatal("accepted forged/cross-purpose proof")
		}
	}
	proof := sign("factory-run-v1:", raw)
	if invoke(raw, proof, "http://localhost:5173") != 403 {
		t.Fatal("accepted renderer request")
	}
	modified := bytes.Replace(raw, []byte(`"expectedVersion":7`), []byte(`"expectedVersion":8`), 1)
	if invoke(modified, proof, "") != 403 {
		t.Fatal("accepted altered signed version")
	}
	if invoke(raw, proof, "") != 200 || svc.calls != 1 {
		t.Fatal("native request rejected")
	}
	if invoke(raw, proof, "") != 403 || svc.calls != 1 {
		t.Fatal("accepted replay")
	}
	expired := bytes.Replace(raw, []byte(`"single-use-native-confirmation"`), []byte(`"different-native-confirmation"`), 1)
	var fields map[string]any
	_ = json.Unmarshal(expired, &fields)
	fields["expires"] = time.Now().Add(-time.Second).UnixMilli()
	expired, _ = json.Marshal(fields)
	if invoke(expired, sign("factory-run-v1:", expired), "") != 403 {
		t.Fatal("accepted expired request")
	}
}
