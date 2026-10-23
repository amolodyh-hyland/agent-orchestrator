package chat_test

import (
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// skillfulConversation is a provider double that can enumerate skills.
type skillfulConversation struct {
	*fakeConversation
	skills []ports.ChatSkill
	err    error
	calls  int
}

func (c *skillfulConversation) ListSkills(context.Context) ([]ports.ChatSkill, error) {
	c.calls++
	if c.err != nil {
		return nil, c.err
	}
	return c.skills, nil
}

func TestSkillsComeFromTheLiveConversation(t *testing.T) {
	conv := &skillfulConversation{
		fakeConversation: newFakeConversation(),
		skills: []ports.ChatSkill{
			{Name: "review", DisplayName: "review", Description: "Look at the diff", Source: "repo"},
		},
	}
	h := newHarnessWithConversation(t, conv)

	skills, err := h.svc.Skills(context.Background(), testSession)
	if err != nil {
		t.Fatalf("Skills: %v", err)
	}
	if len(skills) != 1 || skills[0].Name != "review" {
		t.Fatalf("got %+v, want the provider's own list", skills)
	}
	if conv.calls != 1 {
		t.Errorf("provider asked %d times, want 1: the list must not be served from a table in AO", conv.calls)
	}
}

// A driver that cannot enumerate skills has to be distinguishable from one that
// reported none, because only the first is permanent.
func TestSkillsReportsUnsupportedForADriverThatCannotList(t *testing.T) {
	h := newHarness(t)

	_, err := h.svc.Skills(context.Background(), testSession)
	if !errorsIs(err, chatsvc.ErrSkillsUnsupported) {
		t.Fatalf("err = %v, want ErrSkillsUnsupported", err)
	}
}

// Without a controller there is no provider to ask. Reporting that plainly is what
// lets a client explain the state instead of showing an empty menu.
func TestSkillsRequiresALiveController(t *testing.T) {
	h := newHarness(t)
	if err := h.svc.Stop(context.Background(), testSession); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	_, err := h.svc.Skills(context.Background(), testSession)
	if !errorsIs(err, chatsvc.ErrNoController) {
		t.Fatalf("err = %v, want ErrNoController", err)
	}
}

func TestSkillSelectionSurvivesQueueAndTokenEditsClearIt(t *testing.T) {
	ctx := context.Background()
	provider := &skillfulConversation{fakeConversation: newFakeConversation(), skills: []ports.ChatSkill{{Name: "review", Transport: "native_skill", Token: "$review", CanInvoke: true, NativePath: "/owned/SKILL.md"}}}
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
	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "$review args", ClientMessageID: "queued", Content: []ports.ChatContent{{Type: "skill_selection", Internal: true, SkillSelection: &ports.ChatSkillSelection{Token: row.Token, BindingRef: row.BindingRef, CatalogRevision: row.CatalogRevision, ControllerGeneration: row.ControllerGeneration}}}})
	if err != nil || queued.State != domain.TurnStateQueued {
		t.Fatalf("queue: %+v %v", queued, err)
	}
	conversation, err := h.st.ConversationForSession(ctx, testSession)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := h.st.QueuedTurnMessage(ctx, conversation.ID, queued.ID)
	if err != nil || !strings.Contains(stored.DeliveryContentJSON, "skillSelection") {
		t.Fatalf("selection lost: %+v %v", stored, err)
	}
	if err := h.svc.EditQueuedTurn(ctx, testSession, queued.ID, chatsvc.QueuedMessageEdit{Text: "edited ordinary message"}); err != nil {
		t.Fatal(err)
	}
	stored, err = h.st.QueuedTurnMessage(ctx, conversation.ID, queued.ID)
	if err != nil || strings.Contains(stored.DeliveryContentJSON, "skillSelection") {
		t.Fatalf("edit retained hidden binding: %+v %v", stored, err)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return turnStateByText(t, s)["edited ordinary message"] == domain.TurnStateRunning
	})
	messages := provider.sentMessages()
	if len(messages) != 2 || messages[1].Text != "edited ordinary message" || len(messages[1].NativeSkills) != 0 || len(messages[1].Content) != 0 {
		t.Fatalf("hidden invocation on queue drain: %+v", messages)
	}
}

func TestQueuedEditReplacesOrClearsSameTokenSelection(t *testing.T) {
	for _, action := range []string{"replace", "clear", "preserve", "contradictory"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			provider := &skillfulConversation{fakeConversation: newFakeConversation(), skills: []ports.ChatSkill{
				{Name: "review", Transport: "native_skill", Token: "$review", CanInvoke: true, NativePath: "/owned/a/SKILL.md"},
				{Name: "review", Transport: "native_skill", Token: "$review", CanInvoke: true, NativePath: "/owned/b/SKILL.md"},
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
			selection := func(index int) *ports.ChatSkillSelection {
				row := catalog.Skills[index]
				return &ports.ChatSkillSelection{Token: row.Token, EntryID: row.EntryID, SnapshotID: row.SnapshotID, BindingRef: row.BindingRef, CatalogRevision: row.CatalogRevision, ControllerGeneration: row.ControllerGeneration}
			}
			queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "$review original", ClientMessageID: "queued", Content: []ports.ChatContent{{Type: "skill_selection", Internal: true, SkillSelection: selection(0)}}})
			if err != nil {
				t.Fatal(err)
			}
			zero := int64(0)
			edit := chatsvc.QueuedMessageEdit{Text: "$review edited", ClientMessageID: "edit-receipt", ExpectedRevision: &zero, RetainedContent: &[]int{}}
			if action == "replace" || action == "contradictory" {
				edit.SkillSelection = selection(1)
			}
			if action == "clear" || action == "contradictory" {
				edit.ClearSkillSelection = true
			}
			err = h.svc.EditQueuedTurn(ctx, testSession, queued.ID, edit)
			if action == "contradictory" {
				if !errorsIs(err, chatsvc.ErrQueuedContentInvalid) {
					t.Fatalf("contradictory update: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := h.svc.EditQueuedTurn(ctx, testSession, queued.ID, edit); err != nil {
				t.Fatalf("exact retry: %v", err)
			}
			changed := edit
			changed.SkillSelection, changed.ClearSkillSelection = selection(0), false
			if action == "preserve" {
				changed.ClearSkillSelection, changed.SkillSelection = true, nil
			}
			if err := h.svc.EditQueuedTurn(ctx, testSession, queued.ID, changed); !errorsIs(err, store.ErrQueuedEditDeliveryConflict) {
				t.Fatalf("selection changed under same receipt: %v", err)
			}
			conversation, err := h.st.ConversationForSession(ctx, testSession)
			if err != nil {
				t.Fatal(err)
			}
			stored, err := h.st.QueuedTurnMessage(ctx, conversation.ID, queued.ID)
			if err != nil {
				t.Fatal(err)
			}
			if action == "clear" && strings.Contains(stored.DeliveryContentJSON, "skillSelection") {
				t.Fatalf("clear retained binding: %s", stored.DeliveryContentJSON)
			}
			provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted})
			wantState := domain.TurnStateRunning
			if action == "clear" {
				wantState = domain.TurnStateFailed
			}
			h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return turnStateByText(t, s)[edit.Text] == wantState })
			messages := provider.sentMessages()
			if action == "clear" {
				if len(messages) != 1 {
					t.Fatalf("ambiguous cleared token reached provider: %+v", messages)
				}
				return
			}
			wantPath := "/owned/a/SKILL.md"
			if action == "replace" {
				wantPath = "/owned/b/SKILL.md"
			}
			if len(messages) != 2 || messages[1].Text != edit.Text || len(messages[1].NativeSkills) != 1 || messages[1].NativeSkills[0].Path != wantPath {
				t.Fatalf("dispatch: %+v, want %s", messages, wantPath)
			}
		})
	}
}
