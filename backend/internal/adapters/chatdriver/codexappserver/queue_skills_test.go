package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type queueSkillRegistry struct{ driver ports.ChatDriver }

func (r queueSkillRegistry) Driver(domain.AgentHarness) (ports.ChatDriver, error) {
	return r.driver, nil
}
func (queueSkillRegistry) SupportsChat(h domain.AgentHarness) bool { return h == domain.HarnessCodex }

type queueSkillDriver struct{ *Driver }

func (queueSkillDriver) Probe(context.Context) (ports.ChatCapabilities, error) {
	return capabilities(), nil
}

func nativeSkillQueue(t *testing.T) (*chatsvc.Service, *sqlite.Store, *chatsvc.Controller, *scriptedServer, []ports.ChatSkill) {
	t.Helper()
	ctx := context.Background()
	driver, server := newTestDriver(t)
	server.reply("skills/list", `{"data":[{"cwd":"/tmp/ws","errors":[],"skills":[{"name":"review","enabled":true,"scope":"repo","path":"/first/SKILL.md"},{"name":"review","enabled":true,"scope":"user","path":"/second/SKILL.md"}]}]}`)
	server.reply("turn/steer", `{"turnId":"turn-1"}`)
	server.respondSequence("turn/start",
		`{"turn":{"id":"turn-1"}}`, `{"turn":{"id":"turn-2"}}`,
		`{"turn":{"id":"turn-3"}}`, `{"turn":{"id":"turn-4"}}`,
		`{"turn":{"id":"turn-5"}}`, `{"turn":{"id":"turn-6"}}`)
	st := sqlitetest.MustOpen(t)
	now := time.Now().UTC()
	if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "p1", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateSession(ctx, domain.SessionRecord{
		ID: "p1-1", ProjectID: "p1", Kind: domain.KindOrchestrator, Harness: domain.HarnessCodex,
		Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	var ids atomic.Int64
	svc := chatsvc.New(chatsvc.Options{Store: st, Sessions: st, Drivers: queueSkillRegistry{queueSkillDriver{driver}},
		NewID: func() string { return fmt.Sprintf("queue-skill-%d", ids.Add(1)) }})
	ctrl, err := svc.Start(ctx, chatsvc.StartConfig{SessionID: "p1-1", ProjectID: "p1", Harness: domain.HarnessCodex, WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Stop(ctx, "p1-1") })
	if _, err := svc.Send(ctx, "p1-1", ports.ChatUserMessage{Text: "active", ClientMessageID: "active"}); err != nil {
		t.Fatal(err)
	}
	server.push(`{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}`)
	catalog, err := svc.SkillCatalog(ctx, "p1-1", false, "")
	if err != nil || len(catalog.Skills) != 2 {
		t.Fatalf("catalog: %+v, %v", catalog, err)
	}
	return svc, st, ctrl, server, catalog.Skills
}

func queuedSkillMessage(row ports.ChatSkill, id string) ports.ChatUserMessage {
	return ports.ChatUserMessage{Text: "$review " + id, ClientMessageID: id, Content: []ports.ChatContent{{
		Type: "skill_selection", Internal: true, SkillSelection: &ports.ChatSkillSelection{
			Token: row.Token, BindingRef: row.BindingRef, CatalogRevision: row.CatalogRevision, ControllerGeneration: row.ControllerGeneration,
		},
	}}}
}

func queuedSkillTurn(t *testing.T, server *scriptedServer, clientID string) []struct{ Type, Text, Name, Path string } {
	t.Helper()
	sent := server.awaitFrame(func(f frame) bool {
		var p struct {
			ClientID string `json:"clientUserMessageId"`
		}
		return f.Method == "turn/start" && json.Unmarshal(f.Params, &p) == nil && p.ClientID == clientID
	})
	var params struct {
		Input []struct{ Type, Text, Name, Path string }
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatal(err)
	}
	return params.Input
}

func completeQueuedSkillTurn(server *scriptedServer, id int) {
	server.push(fmt.Sprintf(`{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-%d","status":"completed","items":[]}}}`, id))
}

func TestQueuedNativeSkillsKeepCodexBindingsAcrossMultipleMessages(t *testing.T) {
	svc, _, _, server, skills := nativeSkillQueue(t)
	ctx := context.Background()
	for _, msg := range []ports.ChatUserMessage{
		{Text: "ordinary prefix one", ClientMessageID: "prefix-one"},
		{Text: "ordinary prefix two", ClientMessageID: "prefix-two"},
		queuedSkillMessage(skills[0], "first-skill"),
		{Text: "between skills", ClientMessageID: "between"},
		queuedSkillMessage(skills[1], "second-skill"),
		{Text: "ordinary tail one", ClientMessageID: "tail-one"},
		{Text: "ordinary tail two", ClientMessageID: "tail-two"},
	} {
		turn, err := svc.Send(ctx, "p1-1", msg)
		if err != nil || turn.State != domain.TurnStateQueued {
			t.Fatalf("queue %s: %+v, %v", msg.ClientMessageID, turn, err)
		}
	}
	for i, want := range []struct {
		id, text, path string
		batch          []string
	}{
		{id: "prefix-one", batch: []string{"ordinary prefix one", "ordinary prefix two"}},
		{id: "first-skill", text: "$review first-skill", path: "/first/SKILL.md"},
		{id: "between", text: "between skills"},
		{id: "second-skill", text: "$review second-skill", path: "/second/SKILL.md"},
		{id: "tail-one", batch: []string{"ordinary tail one", "ordinary tail two"}},
	} {
		completeQueuedSkillTurn(server, i+1)
		input := queuedSkillTurn(t, server, want.id)
		if want.path != "" {
			if len(input) != 2 || input[0].Type != "text" || input[0].Text != want.text || input[1].Type != "skill" || input[1].Name != "review" || input[1].Path != want.path {
				t.Fatalf("native binding: %+v", input)
			}
		} else if len(input) != 1 || (want.text != "" && input[0].Text != want.text) {
			t.Fatalf("ordinary input: %+v", input)
		} else {
			for _, text := range want.batch {
				if !strings.Contains(input[0].Text, text) {
					t.Fatalf("ordinary messages no longer batch: %+v", input)
				}
			}
		}
	}
}

func TestSteerKeepsQueuedNativeSkillForCodexTurnStart(t *testing.T) {
	for _, steerOrSend := range []bool{false, true} {
		t.Run(fmt.Sprintf("steer-or-send-%v", steerOrSend), func(t *testing.T) {
			svc, st, ctrl, server, skills := nativeSkillQueue(t)
			ctx := context.Background()
			queued, err := svc.Send(ctx, "p1-1", queuedSkillMessage(skills[1], "queued-skill"))
			if err != nil || queued.State != domain.TurnStateQueued {
				t.Fatalf("queue: %+v, %v", queued, err)
			}
			guidance := ports.ChatUserMessage{Text: "ordinary steer", ClientMessageID: "guidance"}
			if steerOrSend {
				_, err = svc.SteerOrSend(ctx, "p1-1", guidance, false)
			} else {
				_, err = svc.Steer(ctx, "p1-1", guidance)
			}
			if !errors.Is(err, chatsvc.ErrSteerContentUnsupported) {
				t.Fatalf("steer: %v, want unsupported native content", err)
			}
			if server.sentMethod("turn/steer") {
				t.Fatal("skill-bearing queue reached Codex steering")
			}
			if steerOrSend {
				_, err = svc.SteerOrSend(ctx, "p1-1", guidance, false)
			} else {
				_, err = svc.Steer(ctx, "p1-1", guidance)
			}
			if !errors.Is(err, chatsvc.ErrSteerContentUnsupported) {
				t.Fatalf("replayed refusal: %v", err)
			}
			pending, err := st.NextQueuedTurn(ctx, ctrl.ConversationID())
			if err != nil || pending.TurnID != queued.ID || !strings.Contains(pending.DeliveryContentJSON, "skillSelection") {
				t.Fatalf("queued selection consumed: %+v, %v", pending, err)
			}
			completeQueuedSkillTurn(server, 1)
			input := queuedSkillTurn(t, server, "queued-skill")
			if len(input) != 2 || input[0].Text != "$review queued-skill" || input[1].Type != "skill" || input[1].Path != "/second/SKILL.md" {
				t.Fatalf("binding after refused steer: %+v", input)
			}
		})
	}
}

func TestCodexSteerRejectsNativeBindingsInsteadOfDroppingThem(t *testing.T) {
	_, err := steerInput(ports.ChatUserMessage{Text: "$review args", NativeSkills: []ports.ChatNativeSkill{{Name: "review", Path: "/first/SKILL.md"}}})
	if !errors.Is(err, ports.ErrChatSteerContentUnsupported) {
		t.Fatalf("native skill silently dropped: %v", err)
	}
}
