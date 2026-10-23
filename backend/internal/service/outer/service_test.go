package outer_test

import (
	"context"
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
	store  *store.Store
	calls  int
	config ports.SpawnConfig
}

func (l *launcher) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	l.calls++
	l.config = cfg
	r, err := l.store.CreateSession(ctx, domain.SessionRecord{ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: cfg.Harness, Mode: cfg.RequestedMode, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	return domain.Session{SessionRecord: r}, 0, 0, err
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
