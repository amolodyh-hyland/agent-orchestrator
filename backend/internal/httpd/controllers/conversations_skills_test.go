package controllers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

func skillsRequest(t *testing.T, svc controllers.ConversationService) (int, []byte) {
	t.Helper()
	r := chi.NewRouter()
	(&controllers.ConversationsController{Svc: svc}).Register(r)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sessions/p1-1/conversation/skills", nil))
	return rec.Code, rec.Body.Bytes()
}

func decodeSkills(t *testing.T, body []byte) controllers.ConversationSkillsResponse {
	t.Helper()
	var out controllers.ConversationSkillsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out
}

func TestSkillsRouteReturnsTheProvidersList(t *testing.T) {
	status, body := skillsRequest(t, &fakeConversationService{
		skills: []ports.ChatSkill{
			{Name: "review", DisplayName: "Review", Description: "Look at the diff", InputHint: "<branch>", Source: "repo"},
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", status, body)
	}
	got := decodeSkills(t, body)
	if len(got.Skills) != 1 {
		t.Fatalf("skills = %+v, want 1", got.Skills)
	}
	if got.Skills[0] != (controllers.ConversationSkillResponse{
		Name: "review", DisplayName: "Review", Description: "Look at the diff", InputHint: "<branch>", Source: "repo",
	}) {
		t.Errorf("skill = %+v", got.Skills[0])
	}
}

// A driver that cannot enumerate skills is not a failure. The composer keys `/` off
// an empty list, so an error here would leave the slash looking broken rather than
// simply unavailable.
func TestSkillsRouteAnswersEmptyWhenTheDriverCannotList(t *testing.T) {
	status, body := skillsRequest(t, &fakeConversationService{skillErr: chatsvc.ErrSkillsUnsupported})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", status, body)
	}
	got := decodeSkills(t, body)
	if got.Skills == nil {
		t.Fatal("skills is null; an absent catalog must encode as [] so a client can iterate it")
	}
	if len(got.Skills) != 0 {
		t.Errorf("skills = %+v, want empty", got.Skills)
	}
}

// A session with no controller is a state to explain, not an empty menu to show.
func TestSkillsRouteReportsAMissingController(t *testing.T) {
	status, body := skillsRequest(t, &fakeConversationService{skillErr: chatsvc.ErrNoController})
	if status != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", status, body)
	}
	var envelope struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &envelope)
	if envelope.Code != "" && envelope.Code != "CHAT_CONTROLLER_NOT_READY" {
		t.Errorf("code = %q", envelope.Code)
	}
}

// A nil service keeps the route registered and answers from the spec, so the
// OpenAPI contract and the router never disagree about which paths exist.
func TestSkillsRouteIsNotImplementedWithoutAService(t *testing.T) {
	status, _ := skillsRequest(t, nil)
	if status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", status)
	}
}

type liveCatalogService struct {
	fakeConversationService
	catalog           ports.ChatSkillCatalog
	reload            bool
	requestedSnapshot string
}

func (f *liveCatalogService) SkillCatalog(_ context.Context, _ domain.SessionID, reload bool, snapshot string) (ports.ChatSkillCatalog, error) {
	f.reload = reload
	f.requestedSnapshot = snapshot
	return f.catalog, nil
}

func TestSkillsWireCarriesCatalogIdentityWithoutBackendPaths(t *testing.T) {
	svc := &liveCatalogService{catalog: ports.ChatSkillCatalog{Status: "ready", SessionID: "p1-1", SnapshotID: "snapshot", ControllerGeneration: "generation", CatalogRevision: "catalog", ProviderID: "codex", TrustEpoch: 3, Skills: []ports.ChatSkill{{Name: "review", ObservationID: "observation", BindingRef: "binding", TrustState: "native_unverified", Transport: "native_skill", Token: "$review", NativePath: "/private/never-send/SKILL.md", CanInvoke: true}}}}
	status, body := skillsRequest(t, svc)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	got := decodeSkills(t, body)
	if got.Status != "ready" || got.SnapshotID != "snapshot" || got.ControllerGeneration != "generation" || got.CatalogRevision != "catalog" || got.TrustEpoch != 3 || len(got.Skills) != 1 || got.Skills[0].BindingRef != "binding" || got.Skills[0].TrustState != "native_unverified" || got.Skills[0].Token != "$review" {
		t.Fatalf("wire identity missing: %s", body)
	}
	if bytes.Contains(body, []byte("/private/")) {
		t.Fatalf("backend path leaked: %s", body)
	}
}

func TestSkillsRefreshUsesExistingSessionAndReportsSuccessor(t *testing.T) {
	svc := &liveCatalogService{catalog: ports.ChatSkillCatalog{Status: "restart_required", ReasonCode: "snapshot_change_requires_successor", SnapshotID: "pinned", PendingSelectionID: "pending", NextAction: "start_successor_session"}}
	r := chi.NewRouter()
	(&controllers.ConversationsController{Svc: svc}).Register(r)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sessions/p1-1/conversation/skills/refresh", strings.NewReader(`{"snapshotId":"pending"}`)))
	got := decodeSkills(t, rec.Body.Bytes())
	if rec.Code != http.StatusOK || !svc.reload || svc.requestedSnapshot != "pending" || got.Status != "restart_required" || got.SnapshotID != "pinned" || got.NextAction != "start_successor_session" {
		t.Fatalf("refresh lost transition: %s", rec.Body)
	}
}

func TestSkillsUnsupportedListingHasExplicitStatus(t *testing.T) {
	_, body := skillsRequest(t, &fakeConversationService{skillErr: chatsvc.ErrSkillsUnsupported})
	got := decodeSkills(t, body)
	if got.Status != "unsupported_provider" || got.ReasonCode != "listing_unsupported" {
		t.Fatalf("unsupported reads as empty ready: %s", body)
	}
}

func TestSkillSendAcceptsOpaqueSelectionAndIgnoresForgedPaths(t *testing.T) {
	svc := &fakeConversationService{}
	r := chi.NewRouter()
	(&controllers.ConversationsController{Svc: svc}).Register(r)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sessions/p1-1/conversation/messages", strings.NewReader(`{"text":"$review args","skillSelection":{"bindingRef":"opaque","catalogRevision":"revision","controllerGeneration":"generation","token":"$review","path":"/forged/SKILL.md"},"nativeSkills":[{"name":"review","path":"/forged/SKILL.md"}]}`)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("send: %d %s", rec.Code, rec.Body)
	}
	if len(svc.sent.NativeSkills) != 0 || len(svc.sent.Content) != 1 || !svc.sent.Content[0].Internal || svc.sent.Content[0].SkillSelection == nil || svc.sent.Content[0].SkillSelection.BindingRef != "opaque" {
		t.Fatalf("opaque selection not preserved: %+v", svc.sent)
	}
	encoded, _ := json.Marshal(svc.sent.Content)
	if bytes.Contains(encoded, []byte("/forged/")) {
		t.Fatalf("client locator became authority: %s", encoded)
	}
}
