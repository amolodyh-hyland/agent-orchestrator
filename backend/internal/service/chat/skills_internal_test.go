package chat

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	librarysvc "github.com/aoagents/agent-orchestrator/backend/internal/service/library"
)

type catalogConversation struct {
	fakeSender
	rows      []ports.ChatSkill
	err       error
	reloadErr error
	listed    chan struct{}
	resume    chan struct{}
}

func (p *catalogConversation) ListSkills(ctx context.Context) ([]ports.ChatSkill, error) {
	if p.listed != nil {
		close(p.listed)
		select {
		case <-p.resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return append([]ports.ChatSkill(nil), p.rows...), p.err
}
func (p *catalogConversation) ReloadSkills(context.Context) ([]ports.ChatSkill, error) {
	return append([]ports.ChatSkill(nil), p.rows...), p.reloadErr
}

func catalogController(p ports.ChatConversation, generation string) *Controller {
	return newController("session", domain.SessionConversationOwner("session"), domain.ConversationRecord{}, generation, domain.HarnessCodex, p, noopSettingsStore{}, nil, slog.New(slog.DiscardHandler), func() string { return "id" }, time.Now, nil, nil, nil)
}
func nativeSkill(path string) ports.ChatSkill {
	return ports.ChatSkill{Name: "review", DisplayName: "Review", Transport: "native_skill", Token: "$review", CanInvoke: true, NativePath: path, ObservationID: skillDigest(path)}
}
func selectionMessage(row ports.ChatSkill) ports.ChatUserMessage {
	return ports.ChatUserMessage{Text: row.Token + " keep arguments", Content: []ports.ChatContent{{Type: "skill_selection", Internal: true, SkillSelection: &ports.ChatSkillSelection{EntryID: row.EntryID, SnapshotID: row.SnapshotID, ControllerGeneration: row.ControllerGeneration, CatalogRevision: row.CatalogRevision, BindingRef: row.BindingRef, Token: row.Token}}}}
}

func TestCatalogPathDistinctSelectionAndManualAmbiguity(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/first/SKILL.md"), nativeSkill("/second/SKILL.md")}}
	c := catalogController(p, "generation")
	catalog, err := c.loadSkillCatalog(context.Background(), false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Skills) != 2 || catalog.Skills[0].BindingRef == catalog.Skills[1].BindingRef {
		t.Fatalf("identities collapsed: %+v", catalog)
	}
	if _, err := c.resolveSkillMessage(context.Background(), ports.ChatUserMessage{Text: "$review args"}); err == nil {
		t.Fatal("ambiguous manual token accepted")
	}
	msg, err := c.resolveSkillMessage(context.Background(), selectionMessage(catalog.Skills[1]))
	if err != nil {
		t.Fatal(err)
	}
	if msg.Text != "$review keep arguments" || len(msg.Content) != 0 || !reflect.DeepEqual(msg.NativeSkills, []ports.ChatNativeSkill{{Name: "review", Path: "/second/SKILL.md"}}) {
		t.Fatalf("bad resolved message: %+v", msg)
	}
}

func TestCatalogRejectsForgedStaleAndCrossControllerBindings(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}}
	c := catalogController(p, "host-one-generation")
	catalog, _ := c.loadSkillCatalog(context.Background(), false, "")
	for _, change := range []func(*ports.ChatSkillSelection){
		func(s *ports.ChatSkillSelection) { s.BindingRef = "forged" },
		func(s *ports.ChatSkillSelection) { s.CatalogRevision = "old" },
		func(s *ports.ChatSkillSelection) { s.SnapshotID = "other" },
		func(s *ports.ChatSkillSelection) { s.ControllerGeneration = "host-two-generation" },
		func(s *ports.ChatSkillSelection) { s.EntryID = "forged" },
	} {
		msg := selectionMessage(catalog.Skills[0])
		change(msg.Content[0].SkillSelection)
		if _, err := c.resolveSkillMessage(context.Background(), msg); err == nil {
			t.Fatal("forged selection accepted")
		}
	}
	other := catalogController(p, "other-host-generation")
	if _, err := other.resolveSkillMessage(context.Background(), selectionMessage(catalog.Skills[0])); err == nil {
		t.Fatal("remote host catalog reused")
	}
	c.harness = domain.HarnessClaudeCode
	if _, err := c.resolveSkillMessage(context.Background(), selectionMessage(catalog.Skills[0])); err == nil {
		t.Fatal("provider switch reused catalog")
	}
}

func TestEditedSkillTokenDropsHiddenSelection(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}}
	c := catalogController(p, "generation")
	catalog, _ := c.loadSkillCatalog(context.Background(), false, "")
	for _, text := range []string{"ordinary message", "$different arguments", "$review-edited args"} {
		msg := selectionMessage(catalog.Skills[0])
		msg.Text = text
		got, err := c.resolveSkillMessage(context.Background(), msg)
		if err != nil || got.Text != text || len(got.NativeSkills) != 0 || len(got.Content) != 0 {
			t.Fatalf("edited token retained binding: %+v %v", got, err)
		}
	}
}

func TestCatalogDistinguishesUnsupportedEmptyAndWarming(t *testing.T) {
	for _, tt := range []struct {
		name   string
		p      ports.ChatConversation
		status string
	}{
		{"unsupported", &fakeSender{}, "unsupported_provider"},
		{"empty", &catalogConversation{rows: []ports.ChatSkill{}}, "ready"},
		{"warming", &catalogConversation{err: ports.ErrChatSkillsNotReady}, "controller_not_ready"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := catalogController(tt.p, "generation")
			got, err := c.loadSkillCatalog(context.Background(), false, "")
			if err != nil || got.Status != tt.status || got.Skills == nil {
				t.Fatalf("bad catalog: %+v %v", got, err)
			}
		})
	}
}

func TestCatalogDiscardsOldControllerResponses(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}, listed: make(chan struct{}), resume: make(chan struct{})}
	c := catalogController(p, "generation")
	var mu sync.Mutex
	current := true
	c.skillCurrent = func(context.Context, *Controller) bool { mu.Lock(); defer mu.Unlock(); return current }
	done := make(chan error, 1)
	go func() { _, err := c.loadSkillCatalog(context.Background(), false, ""); done <- err }()
	<-p.listed
	mu.Lock()
	current = false
	mu.Unlock()
	close(p.resume)
	if err := <-done; err == nil || !strings.Contains(err.Error(), "stale_controller") {
		t.Fatalf("old response accepted: %v", err)
	}
}

func TestCatalogSameSnapshotReloadAndSuccessor(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}}
	c := catalogController(p, "generation")
	view := librarysvc.Result{TrustEpoch: 1, Snapshot: &domain.LibrarySnapshot{SnapshotID: "pinned", RegistryRevision: 1}}
	c.skillView = func(context.Context, domain.SessionID) (librarysvc.Result, error) { return view, nil }
	before, err := c.loadSkillCatalog(context.Background(), false, "")
	if err != nil {
		t.Fatal(err)
	}
	after, err := c.loadSkillCatalog(context.Background(), true, "pinned")
	if err != nil || before.CatalogRevision != after.CatalogRevision || after.SnapshotID != "pinned" {
		t.Fatalf("reload changed selection: %+v %v", after, err)
	}
	next, err := c.loadSkillCatalog(context.Background(), true, "new-snapshot")
	if err != nil || next.Status != "restart_required" || next.SnapshotID != "pinned" || next.PendingSelectionID != "new-snapshot" || next.NextAction != "start_successor_session" || len(next.Skills) != 0 {
		t.Fatalf("snapshot mutated: %+v %v", next, err)
	}
	p.reloadErr = errors.New("reload broke")
	failed, err := c.loadSkillCatalog(context.Background(), true, "pinned")
	if err != nil || failed.Status != "restart_required" || failed.ReasonCode != "reload_failed" || len(failed.Skills) != 0 {
		t.Fatalf("failed reload advertised readiness: %+v %v", failed, err)
	}
	unsupported := catalogController(&fakeSender{}, "g")
	got, err := unsupported.loadSkillCatalog(context.Background(), true, "")
	if err != nil || got.ReasonCode != "listing_unsupported" {
		t.Fatalf("unsupported reload: %+v %v", got, err)
	}
}

func TestLibraryRowsRemainInertAndBlockNativeNameCollisions(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/uncontrolled/SKILL.md")}}
	c := catalogController(p, "generation")
	entry := domain.LibrarySnapshotEntry{Entry: domain.LibraryEntry{EntryID: "entry", SourceID: "source", DisplayName: "Edited label", Kind: "skill", EntryPoint: "review/SKILL.md", ContentHash: "approved-hash"}, ApprovalID: "approval", Status: "ready", Content: map[string]string{"review/SKILL.md": "---\nname: review\n---\nselected bytes"}}
	view := librarysvc.Result{TrustEpoch: 3, Snapshot: &domain.LibrarySnapshot{SnapshotID: "pinned", Entries: []domain.LibrarySnapshotEntry{entry}}}
	c.skillView = func(context.Context, domain.SessionID) (librarysvc.Result, error) { return view, nil }
	got, err := c.loadSkillCatalog(context.Background(), false, "")
	if err != nil || len(got.Skills) != 2 {
		t.Fatalf("catalog: %+v %v", got, err)
	}
	if got.Skills[0].CanInvoke || got.Skills[0].Status != "conflict" || got.Skills[1].CanInvoke || got.Skills[1].Status != "unsupported_provider" || got.Skills[1].TrustState != "approved" {
		t.Fatalf("unproved readiness: %+v", got)
	}
	for _, text := range []string{"$review args", "/review args", "$Edited label"} {
		if _, err := c.resolveSkillMessage(context.Background(), ports.ChatUserMessage{Text: text}); err == nil && text != "$Edited label" {
			t.Fatalf("manual library bypass: %s", text)
		}
	}
	view.RuntimeBindings = []domain.LibraryRuntimeBinding{{EntryID: "entry", Status: "revoked", ReasonCode: "revoked"}}
	got, err = c.loadSkillCatalog(context.Background(), false, "")
	if err != nil || got.Skills[1].Status != "revoked" || got.Skills[1].TrustState != "revoked" {
		t.Fatalf("revocation hidden: %+v %v", got, err)
	}
}

func TestNativeDispatchRechecksTrustAtSend(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}}
	c := catalogController(p, "generation")
	admission := &libraryAdmissionStub{}
	c.libraryInput = func(ctx context.Context, _ domain.SessionID, text string) (func(), error) {
		return admission.AcquireChatInput(ctx, "session", text)
	}
	got, _ := c.loadSkillCatalog(context.Background(), false, "")
	admission.denied = true
	if _, err := c.sendTurn(context.Background(), selectionMessage(got.Skills[0])); err == nil || len(p.modes) != 0 {
		t.Fatalf("revoked send reached transport: %v", err)
	}
}

func TestPendingLibraryRevisionDoesNotRewriteSnapshot(t *testing.T) {
	selected := domain.LibrarySnapshotEntry{Entry: domain.LibraryEntry{EntryID: "entry", ContentHash: "old"}, BindingIDs: []string{"binding"}, BindingRevisions: []int64{1}}
	snapshot := &domain.LibrarySnapshot{SnapshotID: "pinned", Entries: []domain.LibrarySnapshotEntry{selected}}
	view := librarysvc.Result{Revision: 2, Snapshot: snapshot, Entries: []domain.LibraryEntry{{EntryID: "entry", ContentHash: "new"}}, Bindings: []domain.LibraryBinding{{BindingID: "binding", Revision: 1}}}
	c := catalogController(&catalogConversation{}, "generation")
	c.skillView = func(context.Context, domain.SessionID) (librarysvc.Result, error) { return view, nil }
	got, err := c.loadSkillCatalog(context.Background(), false, "")
	if err != nil || got.PendingSelectionID == "" || got.NextAction != "start_successor_session" || got.SnapshotID != "pinned" || snapshot.Entries[0].Entry.ContentHash != "old" {
		t.Fatalf("active snapshot changed: %+v %v", got, err)
	}
}

func TestSkillSteeringRefusesStructuredNativeInvocation(t *testing.T) {
	p := &catalogConversation{rows: []ports.ChatSkill{nativeSkill("/owned/SKILL.md")}}
	c := catalogController(p, "generation")
	if _, err := c.steerLocked(context.Background(), ports.ChatUserMessage{Text: "$review args"}); !errors.Is(err, ErrSteerContentUnsupported) {
		t.Fatalf("structured skill steer: %v", err)
	}
	if len(p.modes) != 0 {
		t.Fatal("unsupported steer reached provider")
	}
}

func TestCatalogPrivateReplacementRequiresDurableGeneration(t *testing.T) {
	ctx := context.Background()
	source := catalogController(&catalogConversation{}, "source")
	replacement := catalogController(&catalogConversation{}, "replacement")
	svc := &Service{ownerControllers: map[domain.ConversationOwner]*Controller{source.owner(): source}, sessions: steerSessionReaderStub{found: true}}
	if !svc.skillControllerCurrent(ctx, source) || svc.skillControllerCurrent(ctx, replacement) {
		t.Fatal("unpublished controller admitted without handoff")
	}
	source.handoff = controllerHandoffIdleBranch
	if svc.skillControllerCurrent(ctx, source) || svc.skillControllerCurrent(ctx, replacement) {
		t.Fatal("old generation admitted during handoff")
	}
	rec := domain.SessionRecord{}
	rec.Metadata.ControllerGeneration = "replacement"
	svc.sessions = steerSessionReaderStub{found: true, record: rec}
	if !svc.skillControllerCurrent(ctx, replacement) {
		t.Fatal("committed private replacement refused")
	}
	rec.Metadata.ControllerGeneration = "next"
	svc.sessions = steerSessionReaderStub{found: true, record: rec}
	if svc.skillControllerCurrent(ctx, replacement) {
		t.Fatal("stale private generation admitted")
	}
}

func TestLibraryCollisionTokensFollowNativeNames(t *testing.T) {
	command := domain.LibrarySnapshotEntry{Entry: domain.LibraryEntry{Kind: "prompt_command", EntryPoint: "review/branch.md", DisplayName: "caption"}, Content: map[string]string{"review/branch.md": "---\nname: header-label\n---\ntext"}}
	skill := domain.LibrarySnapshotEntry{Entry: domain.LibraryEntry{Kind: "skill", EntryPoint: "folder/SKILL.md", DisplayName: "caption"}, Content: map[string]string{"folder/SKILL.md": "---\nname: native-name\n---\ntext"}}
	for _, tt := range []struct {
		entry domain.LibrarySnapshotEntry
		token string
	}{{command, "/review:branch"}, {skill, "$native-name"}, {skill, "$folder"}} {
		if !skillTokenPresent(strings.Join(libraryTokens(tt.entry), " "), tt.token) {
			t.Fatalf("native name lost: %s", tt.token)
		}
	}
}
