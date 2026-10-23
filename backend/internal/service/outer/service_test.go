package outer_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type launcher struct {
	store    *store.Store
	calls    int
	config   ports.SpawnConfig
	returned *domain.Session
}

func (l *launcher) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	l.calls++
	l.config = cfg
	if l.returned != nil {
		return *l.returned, 0, 0, nil
	}
	r, err := l.store.CreateSession(ctx, domain.SessionRecord{ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: cfg.Harness, Mode: cfg.RequestedMode, Metadata: domain.SessionMetadata{OuterGeneration: cfg.OuterGeneration}, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	return domain.Session{SessionRecord: r}, 0, 0, err
}

func TestOuterReducedScopeRequiresVerifiedFreshConversation(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	l := &launcher{store: st}
	svc := outer.New(st, projectsvc.New(st), l)
	b, err := svc.Ensure(action("outer.setup"), domain.AgentConfig{})
	if err != nil {
		t.Fatal(err)
	}
	old, _, err := st.GetSession(ctx, b.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	old.Metadata.ProviderConversationID = "original-native-history"
	if err := st.UpdateSession(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "a", Kind: domain.ProjectKindScratch, RegisteredAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	b, err = svc.SetScope(action("outer.scope"), b.Revision, []string{"a"}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	b, err = svc.SetScope(action("outer.scope"), b.Revision, []string{}, false, true)
	if err != nil || !b.HistoryHeld {
		t.Fatal("scope reduction did not hold history", b, err)
	}
	assertHeld := func(t *testing.T, returned domain.SessionRecord) {
		t.Helper()
		l.returned = &domain.Session{SessionRecord: returned}
		if _, err := svc.Ensure(action("outer.setup"), domain.AgentConfig{}); !errors.Is(err, domain.ErrOuterHeld) {
			t.Fatal("unverified conversation reopened", err)
		}
		current, found, err := svc.Binding(ctx)
		if err != nil || !found || !current.HistoryHeld || current.SessionID != old.ID || current.Revision != b.Revision {
			t.Fatal("rejected launch changed the binding", current, err)
		}
	}
	t.Run("existing active session", func(t *testing.T) { assertHeld(t, old) })
	t.Run("forged returned generation", func(t *testing.T) {
		forged := old
		forged.Metadata.OuterGeneration = b.Generation
		assertHeld(t, forged)
	})
	t.Run("unrecorded replacement", func(t *testing.T) {
		forged := old
		forged.ID = "unrecorded-new-session"
		forged.Metadata.OuterGeneration = b.Generation
		assertHeld(t, forged)
	})
	native := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "spawn", ProjectID: old.ProjectID})
	fresh, err := st.CreateSession(native, domain.SessionRecord{ProjectID: old.ProjectID, Kind: old.Kind, Harness: old.Harness, Mode: old.Mode, Metadata: domain.SessionMetadata{OuterGeneration: b.Generation, ProviderConversationID: old.Metadata.ProviderConversationID}, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("reused native history", func(t *testing.T) { assertHeld(t, fresh) })
	fresh.Metadata.ProviderConversationID = "fresh-native-history"
	if err := st.UpdateSession(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	l.returned = &domain.Session{SessionRecord: fresh}
	current, err := svc.Ensure(action("outer.setup"), domain.AgentConfig{})
	if err != nil || current.HistoryHeld || current.SessionID != fresh.ID {
		t.Fatal("verified fresh conversation stayed held", current, err)
	}
	if receipt, found, err := st.GetSession(ctx, fresh.ID); err != nil || !found || receipt.Metadata.OuterGeneration != b.Generation {
		t.Fatal("replacement generation was not durable", receipt, err)
	}
}
func action(op string) context.Context {
	return domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: op})
}

func TestOuterSetupSingletonAndReducedScope(t *testing.T) {
	st, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	l := &launcher{store: st}
	svc := outer.New(st, projectsvc.New(st), l)
	if _, err := svc.Ensure(context.Background(), domain.AgentConfig{}); err == nil {
		t.Fatal("unbound setup admitted")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if _, err := svc.Ensure(action("outer.setup"), domain.AgentConfig{Model: "chosen", Effort: "high", Permissions: domain.PermissionModeDefault}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	b, found, err := svc.Binding(context.Background())
	if err != nil || !found || l.calls != 1 {
		t.Fatalf("binding %+v calls %d err %v", b, l.calls, err)
	}
	p, found, err := st.GetProject(context.Background(), b.AnchorProjectID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if p.Kind != domain.ProjectKindScratch || p.Path != "" || p.RepoOriginURL != "" || !p.Instructions.IsZero() || len(p.Config.PostCreate) > 0 || p.Config.TrackerIntake.Enabled {
		t.Fatalf("anchor inherited context: %+v", p)
	}
	if p.Config.Orchestrator.AgentConfig.Model != "chosen" || l.config.Harness != domain.HarnessCodex || l.config.RequestedMode != domain.SessionModeChat || l.config.Prompt != "" {
		t.Fatalf("launch %+v config %+v", l.config, p.Config)
	}
	for _, id := range []string{"a", "b"} {
		if err := st.UpsertProject(context.Background(), domain.ProjectRecord{ID: id, RegisteredAt: time.Now(), Kind: domain.ProjectKindScratch}); err != nil {
			t.Fatal(err)
		}
	}
	b, err = svc.SetScope(action("outer.scope"), b.Revision, []string{"a", "b"}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetScope(action("outer.scope"), b.Revision-1, []string{"a"}, false, true); err == nil {
		t.Fatal("stale scope update")
	}
	b, err = svc.SetScope(action("outer.scope"), b.Revision, []string{"b"}, false, true)
	if err != nil || !b.HistoryHeld || b.Generation != 2 {
		t.Fatalf("reduced scope %+v %v", b, err)
	}
	old := b.SessionID
	b, err = svc.Ensure(action("outer.setup"), domain.AgentConfig{})
	if err != nil || b.HistoryHeld || old == b.SessionID || l.calls != 2 {
		t.Fatalf("fresh conversation %+v %v", b, err)
	}
	if ok, err := st.IsOuterSession(context.Background(), old); err != nil || !ok {
		t.Fatal("historical target lost its guard", err)
	}
	if err := st.CheckOuterOperation(context.Background(), "send", "", old); err == nil {
		t.Fatal("historical outer accepted unbound operation")
	}
	if err := st.CheckOuterOperation(context.Background(), "spawn", "a", ""); err != nil {
		t.Fatal("removed project workflow changed", err)
	}
	events, err := svc.Audit(context.Background(), 0, 1000)
	if err != nil || len(events) < 5 {
		t.Fatal("audit", events, err)
	}
}
