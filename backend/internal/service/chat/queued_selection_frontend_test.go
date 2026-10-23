package chat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func TestQueuedSelectionFrontendRegression(t *testing.T) {
	if os.Getenv("AO_QUEUED_SELECTION_FRONTEND") != "1" {
		t.Skip("run npm --prefix frontend run test:queued-selection-integration")
	}
	ctx := context.Background()
	provider := &skillfulConversation{fakeConversation: newFakeConversation(), skills: []ports.ChatSkill{
		{Name: "review", Token: "$review", Transport: "native_skill", CanInvoke: true, NativePath: "/owned/a/SKILL.md"},
		{Name: "review", Token: "$review", Transport: "native_skill", CanInvoke: true, NativePath: "/owned/b/SKILL.md"},
	}}
	h := newHarnessWithConversation(t, provider)
	first, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "first", ClientMessageID: "first"})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := h.svc.SkillCatalog(ctx, testSession, false, "")
	if err != nil {
		t.Fatal(err)
	}
	row := catalog.Skills[0]
	selection := &ports.ChatSkillSelection{Token: row.Token, BindingRef: row.BindingRef, CatalogRevision: row.CatalogRevision, ControllerGeneration: row.ControllerGeneration, EntryID: row.EntryID, SnapshotID: row.SnapshotID}
	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "$review original.ts", ClientMessageID: "queued", Content: []ports.ChatContent{{Type: "skill_selection", Internal: true, SkillSelection: selection}}})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	controller := &controllers.ConversationsController{Svc: h.svc}
	router.Route("/api/v1", controller.Register)
	snapshot := httptest.NewRecorder()
	router.ServeHTTP(snapshot, httptest.NewRequest("GET", "/api/v1/sessions/"+string(testSession)+"/conversation", nil))
	if snapshot.Code != 200 {
		t.Fatalf("snapshot: %d %s", snapshot.Code, snapshot.Body)
	}
	fmt.Printf("QUEUED_SELECTION_SNAPSHOT:%s\n", snapshot.Body.Bytes())
	var payload json.RawMessage
	if err := json.NewDecoder(os.Stdin).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/sessions/"+string(testSession)+"/conversation/turns/"+queued.ID+"/queue/edit", bytes.NewReader(payload)))
	if response.Code != 204 {
		t.Fatalf("edit: %d %s", response.Code, response.Body)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["$review original.ts --focus edited"] == domain.TurnStateRunning
	})
	messages := provider.sentMessages()
	if len(messages) != 2 || messages[1].Text != "$review original.ts --focus edited" || len(messages[1].NativeSkills) != 1 || messages[1].NativeSkills[0].Path != "/owned/a/SKILL.md" {
		t.Fatalf("original selection lost: %+v", messages)
	}
}
