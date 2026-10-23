package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The menu is built from this list, so what it drops matters as much as what it
// keeps: a disabled skill would render as a command the provider then refuses to
// run, and a skill reachable from two roots would appear twice.
func TestListSkillsRetainsPathDistinctNamesAndDropsDisabled(t *testing.T) {
	d, srv := newTestDriver(t)
	// Scripted before Start: the server goroutine reads this map, so writing it
	// afterwards would race the connection it is already serving. Kept on one line
	// because the transport is line-delimited JSON — a wrapped literal would never
	// parse as a frame and the request would simply never return.
	srv.reply("skills/list", `{"data":[{"cwd":"/tmp/ws","errors":[],"skills":[{"name":"review","description":"Long trigger text for the model","enabled":true,"scope":"repo","path":"/tmp/ws/.codex/skills/review/SKILL.md"},{"name":"switched-off","description":"never offered","enabled":false,"scope":"user","path":"/u/SKILL.md"},{"name":"","description":"nameless","enabled":true,"scope":"user","path":"/u/SKILL.md"}]},{"cwd":"/tmp/other","errors":[],"skills":[{"name":"review","description":"same skill from another root","enabled":true,"scope":"user","path":"/u/review/SKILL.md"},{"name":"ship","description":"legacy long text","shortDescription":"Ship it","enabled":true,"scope":"user","path":"/u/ship/SKILL.md"}]}]}`)

	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	lister, ok := conv.(ports.ChatSkillLister)
	if !ok {
		t.Fatal("conversation does not implement ChatSkillLister")
	}

	skills, err := lister.ListSkills(context.Background())
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}
	if len(skills) != 3 {
		t.Fatalf("got %d skills, want both review paths and ship: %+v", len(skills), skills)
	}
	if skills[0].Name != "review" || skills[1].Name != "review" || skills[2].Name != "ship" {
		t.Errorf("provider order not preserved: %+v", skills)
	}
	if skills[0].Source != "repo" {
		t.Errorf("scope not carried through: %q, want repo", skills[0].Source)
	}
	// shortDescription is what fits a menu row; the full description is written for
	// the model and runs long.
	if skills[2].Description != "Ship it" {
		t.Errorf("shortDescription did not win: %q", skills[2].Description)
	}
	if skills[0].NativePath == skills[1].NativePath || skills[0].ObservationID == skills[1].ObservationID {
		t.Fatal("path identities collapsed")
	}
	frame := srv.awaitFrame(func(f frame) bool { return f.Method == "skills/list" })
	var req struct {
		CWDs []string `json:"cwds"`
	}
	if err := json.Unmarshal(frame.Params, &req); err != nil || len(req.CWDs) != 1 || req.CWDs[0] != "/tmp/ws" {
		t.Fatalf("wrong lookup scope: %s", frame.Params)
	}

}

// SKILL.json's interface block supersedes the top-level fields. Reading only the
// legacy fields would label a skill with text its author replaced.
func TestListSkillsPrefersTheInterfaceBlock(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.reply("skills/list", `{"data":[{"cwd":"/tmp/ws","errors":[],"skills":[{"name":"deploy","description":"legacy long text","shortDescription":"legacy short","enabled":true,"scope":"repo","path":"/tmp/ws/SKILL.md","interface":{"displayName":"Deploy to prod","shortDescription":"Ships the current branch"}}]}]}`)

	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	skills, err := conv.(ports.ChatSkillLister).ListSkills(context.Background())
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("got %d skills, want 1: %+v", len(skills), skills)
	}
	// The name stays the invocable one; only the label changes.
	if skills[0].Name != "deploy" {
		t.Errorf("name = %q, want the invocable name deploy", skills[0].Name)
	}
	if skills[0].DisplayName != "Deploy to prod" {
		t.Errorf("displayName = %q", skills[0].DisplayName)
	}
	if skills[0].Description != "Ships the current branch" {
		t.Errorf("description = %q", skills[0].Description)
	}
}

// A provider that reports nothing is a real answer, not a failure: the composer
// has to be able to tell "no skills" from "the call broke" so `/` can stay an
// ordinary character.
func TestListSkillsReportsAnEmptyListRatherThanNil(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.reply("skills/list", `{"data":[]}`)

	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	skills, err := conv.(ports.ChatSkillLister).ListSkills(context.Background())
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}
	if skills == nil {
		t.Fatal("ListSkills returned nil; an empty catalog must encode as []")
	}
	if len(skills) != 0 {
		t.Errorf("got %d skills, want none: %+v", len(skills), skills)
	}
}

func TestNativeSkillSubmissionContainsRawTextAndStructuredPath(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatal(err)
	}
	defer conv.Close()
	text := "$review main --keep-arguments"
	_, err = conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: text, NativeSkills: []ports.ChatNativeSkill{{Name: "review", Path: "/owned/review/SKILL.md"}}})
	if err != nil {
		t.Fatal(err)
	}
	sent := srv.awaitFrame(func(f frame) bool { return f.Method == "turn/start" })
	var params struct {
		Input []struct{ Type, Text, Name, Path string } `json:"input"`
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatal(err)
	}
	if len(params.Input) != 2 || params.Input[0].Type != "text" || params.Input[0].Text != text || params.Input[1].Type != "skill" || params.Input[1].Name != "review" || params.Input[1].Path != "/owned/review/SKILL.md" {
		t.Fatalf("wrong native payload: %s", sent.Params)
	}
}

func TestSkillReloadUsesForceReloadAndPreservesLookupScope(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.reply("skills/list", `{"data":[]}`)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatal(err)
	}
	defer conv.Close()
	if _, err := conv.(ports.ChatSkillReloader).ReloadSkills(context.Background()); err != nil {
		t.Fatal(err)
	}
	sent := srv.awaitFrame(func(f frame) bool { return f.Method == "skills/list" })
	var params struct {
		CWDs        []string `json:"cwds"`
		ForceReload bool     `json:"forceReload"`
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatal(err)
	}
	if !params.ForceReload || len(params.CWDs) != 1 || params.CWDs[0] != "/tmp/ws" {
		t.Fatalf("wrong reload: %s", sent.Params)
	}
}

func TestSkillCatalogAbsenceIsNotEmpty(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.reply("skills/list", `{}`)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatal(err)
	}
	defer conv.Close()
	if _, err := conv.(ports.ChatSkillLister).ListSkills(context.Background()); !errors.Is(err, ports.ErrChatSkillsNotReady) {
		t.Fatalf("catalog absence: %v", err)
	}
}

func TestSkillCatalogScanErrorsDiscardPartialSameNameEntries(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.reply("skills/list", `{"data":[{"cwd":"/tmp/ws","errors":[],"skills":[{"name":"review","enabled":true,"scope":"repo","path":"/first/SKILL.md"},{"name":"review","enabled":true,"scope":"user","path":"/second/SKILL.md"}]},{"cwd":"/tmp/other","errors":[{"path":"/broken/SKILL.md","message":"scan failed"}],"skills":[]}]}`)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatal(err)
	}
	defer conv.Close()
	rows, err := conv.(ports.ChatSkillLister).ListSkills(context.Background())
	if !errors.Is(err, ports.ErrChatSkillsNotReady) || len(rows) != 0 {
		t.Fatalf("partial catalog accepted: %+v %v", rows, err)
	}
}
