package chat_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type m2Fixture struct {
	*outerDesktopFixture
	mu               sync.Mutex
	clock            time.Time
	spawned          int
	stopped          int
	beforeSpawnWrite func(domain.SessionID)
	beforeStopWrite  func(int)
}

func (f *m2Fixture) now() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.clock }
func (f *m2Fixture) advance() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clock = f.clock.Add(3 * time.Minute)
}

func newM2Fixture(t *testing.T, wrap ...func(ports.ChatStartConfig, *outerDesktopConversation) ports.ChatConversation) *m2Fixture {
	t.Helper()
	f := &m2Fixture{outerDesktopFixture: &outerDesktopFixture{t: t, dir: t.TempDir(), providers: map[domain.SessionID]*outerDesktopConversation{}}, clock: time.Now().UTC()}
	var err error
	f.st, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(wrap) > 0 {
		f.providerWrap = wrap[0]
	}
	f.wire()
	f.outer = outer.New(f.st, projectsvc.New(f.st), f, outer.WithActionsEnabled(true), outer.WithClock(f.now))
	f.outer.SetTransport(f.chat)
	f.chat.SetOuterAdmission(f.outer)
	ctx := context.Background()
	if _, err := f.outer.Ensure(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.setup"}), domain.AgentConfig{}); err != nil {
		t.Fatal(err)
	}
	if err := f.st.UpsertProject(ctx, domain.ProjectRecord{ID: "a", DisplayName: "Project A", Kind: domain.ProjectKindSingleRepo, Path: f.dir, RegisteredAt: f.now()}); err != nil {
		t.Fatal(err)
	}
	b, _, _ := f.outer.Binding(ctx)
	if _, err := f.outer.SetScope(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.scope"}), b.Revision, []string{"a"}, false, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for id := range f.providers {
			_ = f.chat.Stop(context.Background(), id)
		}
		_ = f.st.Close()
	})
	return f
}

func (f *m2Fixture) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	if cfg.OuterActionID == "" {
		return f.outerDesktopFixture.Spawn(ctx, cfg)
	}
	if err := domain.CheckOuterOperation(ctx, f.st, "spawn", cfg.ProjectID, ""); err != nil {
		return domain.Session{}, 0, 0, err
	}
	if cfg.Async || cfg.Prompt != "" || cfg.NameFromPrompt || cfg.Kind != domain.KindWorker || cfg.Harness != domain.HarnessCodex {
		return domain.Session{}, 0, 0, domain.ErrOuterHeld
	}
	f.spawned++
	r, err := f.provision(ctx, cfg, true)
	return domain.Session{SessionRecord: r}, 0, 0, err
}

func (f *m2Fixture) provision(ctx context.Context, cfg ports.SpawnConfig, enroll bool) (domain.SessionRecord, error) {
	path := f.t.TempDir()
	if err := os.WriteFile(filepath.Join(path, "preserve.txt"), []byte("work and artifacts"), 0600); err != nil {
		return domain.SessionRecord{}, err
	}
	r, err := f.st.CreateSession(ctx, domain.SessionRecord{ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: domain.HarnessCodex, Mode: domain.SessionModeChat, Metadata: domain.SessionMetadata{Branch: cfg.Branch, WorkspacePath: path, Model: cfg.AgentConfig.Model, Effort: cfg.AgentConfig.Effort, Permissions: cfg.AgentConfig.Permissions}, Activity: domain.Activity{State: domain.ActivityIdle}, CreatedAt: f.now(), UpdatedAt: f.now()})
	if err != nil {
		return r, err
	}
	if enroll {
		e, _ := domain.OuterExecutionFrom(ctx)
		if err := f.st.EnrollOuterParticipant(ctx, e.PlanID, e.ActionID, r.ID, f.now()); err != nil {
			return r, err
		}
	}
	c, err := f.chat.Start(ctx, chatsvc.StartConfig{SessionID: r.ID, ProjectID: r.ProjectID, Kind: r.Kind, Harness: r.Harness, WorkspacePath: path, Model: cfg.AgentConfig.Model, Effort: cfg.AgentConfig.Effort, Permissions: cfg.AgentConfig.Permissions})
	if err != nil {
		return r, err
	}
	r, _, err = f.st.GetSession(ctx, r.ID)
	if err != nil {
		return r, err
	}
	r.Metadata.ControllerGeneration = c.Generation()
	r.Metadata.ProviderConversationID = c.ProviderConversationID()
	r.Metadata.WorkspacePath = path
	r.Metadata.Branch = cfg.Branch
	if err := f.st.UpdateSession(ctx, r); err != nil {
		return r, err
	}
	if enroll && f.beforeSpawnWrite != nil {
		f.beforeSpawnWrite(r.ID)
	}
	f.providers[r.ID].emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerReady})
	waitM2(f.t, func() bool { return c.State() == ports.ChatControllerReady })
	return r, nil
}

func (f *m2Fixture) StopOuterWorker(ctx context.Context, id domain.SessionID, admit func(context.Context) (func(), error)) error {
	e, _ := domain.OuterExecutionFrom(ctx)
	p, err := f.st.GetOuterPlan(ctx, e.PlanID)
	if err != nil {
		return err
	}
	op := ""
	for _, a := range p.Plan.Actions {
		if a.ID == e.ActionID {
			op = a.Spec.Operation
		}
	}
	if err := domain.CheckOuterOperation(ctx, f.st, op, "", id); err != nil {
		return err
	}
	f.stopped++
	count := 0
	return f.chat.StopChatWithAdmission(ctx, id, func(writeCtx context.Context) (func(), error) {
		count++
		if f.beforeStopWrite != nil {
			f.beforeStopWrite(count)
		}
		return admit(writeCtx)
	})
}

func waitM2(t *testing.T, predicate func() bool) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		if predicate() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("M2 observation did not arrive")
}

func (f *m2Fixture) request() string {
	f.t.Helper()
	v, err := f.outer.View(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"}))
	if err != nil {
		f.t.Fatal(err)
	}
	id := uuid.NewString()
	c := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.send", SessionID: v.Binding.SessionID, RequestID: id, Expected: &domain.OuterSendExpectation{BindingRevision: v.Binding.Revision, ScopeRevision: v.Binding.ScopeRevision, ControllerGeneration: v.Session.ControllerGeneration, SettingsDigest: v.Session.SettingsDigest}})
	if _, err := f.outer.Send(c, "Perform the exact listed action, then stop"); err != nil {
		f.t.Fatal(err)
	}
	f.settle(v.Binding.SessionID)
	return id
}

func (f *m2Fixture) settle(id domain.SessionID) {
	p := f.providers[id]
	p.mu.Lock()
	turn := p.turnSeq
	p.mu.Unlock()
	providerTurn := "provider-turn-" + strconv.Itoa(turn)
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: providerTurn, NativeAcceptance: true})
	p.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: providerTurn, TurnState: domain.TurnStateCompleted, NativeSettlement: true})
	waitM2(f.t, func() bool {
		r, err := f.st.ListOuterRequests(context.Background(), id)
		return err == nil && len(r) > 0 && r[0].State == "settled"
	})
}

func (f *m2Fixture) propose(spec domain.OuterActionSpec) domain.OuterPlanReceipt {
	f.t.Helper()
	p, err := f.outer.ProposePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"}), domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
	if err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *m2Fixture) approve(p domain.OuterPlanReceipt) domain.OuterPlanReceipt {
	f.t.Helper()
	r, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func workerSpec() domain.OuterActionSpec {
	return domain.OuterActionSpec{Operation: "spawn", ProjectID: "a", Branch: "feat/exact-worker", Text: "Implement this exact task", Config: domain.AgentConfig{Model: "chosen", Permissions: domain.PermissionModeDefault}}
}

func TestOuterM2CoordinatorAndSpawnActualWriteAuthority(t *testing.T) {
	for _, op := range []string{"send", "spawn"} {
		for _, mode := range []string{"once", "expiry", "unknown"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				f := newM2Fixture(t)
				spec := workerSpec()
				var target domain.SessionID
				if op == "send" {
					rec, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindOrchestrator}, false)
					if err != nil {
						t.Fatal(err)
					}
					target = rec.ID
					spec = domain.OuterActionSpec{Operation: "send", ProjectID: "a", SessionID: target, Text: "Exact coordinator continuation"}
				}
				p := f.propose(spec)
				if _, err := f.outer.ApprovePlan(context.Background(), p.Plan.ID, p.Digest); err == nil {
					t.Fatal("omitted approval")
				}
				setup := func(id domain.SessionID) {
					provider := f.providers[id]
					if mode == "expiry" {
						provider.beforeWrite = f.advance
					}
					if mode == "unknown" {
						provider.mu.Lock()
						provider.sendErr = errors.New("native result unknown")
						provider.mu.Unlock()
					}
				}
				if op == "spawn" {
					f.beforeSpawnWrite = setup
				} else {
					setup(target)
				}
				result := f.approve(p)
				target = result.Actions[0].SessionID
				provider := f.providers[target]
				provider.mu.Lock()
				calls := provider.sendCalls
				provider.mu.Unlock()
				if mode == "expiry" && calls != 0 {
					t.Fatal("expired authority crossed write", calls)
				}
				if mode != "expiry" && calls != 1 {
					t.Fatal("approved exact turn missing", calls, result)
				}
				if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest); err == nil {
					t.Fatal("approval replay")
				}
				for _, message := range []ports.ChatUserMessage{{Text: spec.Text, Origin: domain.MessageOriginHuman, ClientMessageID: uuid.NewString()}, {Text: "feedback", Origin: domain.MessageOriginAutomation}, {Text: spec.Text, Origin: domain.MessageOriginHuman, ClientMessageID: p.Plan.Actions[0].ID}} {
					if _, err := f.chat.Send(context.Background(), target, message); err == nil {
						t.Fatal("unapproved continuation")
					}
				}
				if _, err := f.chat.SteerOrSend(context.Background(), target, ports.ChatUserMessage{Text: "steer"}, false); err == nil {
					t.Fatal("participant steer enabled")
				}
				if mode == "once" {
					f.settle(target)
				}
				if mode == "unknown" {
					r, err := f.st.GetOuterRequest(context.Background(), p.Plan.Actions[0].ID)
					if err != nil || r.AttemptedAt.IsZero() || !r.AcceptedAt.IsZero() {
						t.Fatal("unknown receipt lost", r, err)
					}
					capacity, err := f.st.OuterCapacity(context.Background())
					if err != nil || len(capacity) != 1 {
						t.Fatal("unknown capacity released", capacity, err)
					}
				}
			})
		}
	}
}

func TestOuterM2PreservingWorkerStopAndHeldAdapters(t *testing.T) {
	for _, op := range []string{"kill", "retire"} {
		t.Run(op, func(t *testing.T) {
			f := newM2Fixture(t)
			spawned := f.approve(f.propose(workerSpec()))
			id := spawned.Actions[0].SessionID
			f.settle(id)
			rec, _, _ := f.st.GetSession(context.Background(), id)
			for _, held := range []string{"restore", "resume", "delegate", "ensure", "terminal.send", "steer", "review.trigger", "cleanup"} {
				if _, err := f.outer.ProposePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"}), domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{{Operation: held, ProjectID: "a", SessionID: id}}}); err == nil {
					t.Fatal("held adapter enabled", held)
				}
			}
			p := f.propose(domain.OuterActionSpec{Operation: op, ProjectID: "a", SessionID: id})
			f.approve(p)
			if f.stopped != 1 {
				t.Fatal("stop count", f.stopped)
			}
			if content, err := os.ReadFile(filepath.Join(rec.Metadata.WorkspacePath, "preserve.txt")); err != nil || string(content) != "work and artifacts" {
				t.Fatal("worker evidence lost", err)
			}
		})
	}
}

func TestOuterM2DeferredWriteRevalidatesEachExactTurn(t *testing.T) {
	for _, op := range []string{"send", "spawn"} {
		for _, mode := range []string{"expiry", "pause", "settings", "generation", "restart"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				var deferred *outerDeferredConversation
				f := newM2Fixture(t, func(cfg ports.ChatStartConfig, base *outerDesktopConversation) ports.ChatConversation {
					if !strings.HasPrefix(string(cfg.SessionID), "a-") {
						return base
					}
					deferred = &outerDeferredConversation{reportDeferredConversation: &reportDeferredConversation{fakeConversation: base.fakeConversation}}
					return deferred
				})
				spec := workerSpec()
				if op == "send" {
					r, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindOrchestrator}, false)
					if err != nil {
						t.Fatal(err)
					}
					spec = domain.OuterActionSpec{Operation: "send", ProjectID: "a", SessionID: r.ID, Text: "Exact delayed continuation"}
				}
				plan := f.approve(f.propose(spec))
				id := plan.Actions[0].SessionID
				if deferred == nil || deferred.acquire == nil || deferred.starts.Load() != 0 {
					t.Fatal("deferred transport was not fenced")
				}
				switch mode {
				case "expiry":
					f.advance()
				case "pause":
					b, _, _ := f.outer.Binding(context.Background())
					if _, err := f.outer.SetScope(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.scope"}), b.Revision, b.ProjectIDs, true, b.ForegroundReserve); err != nil {
						t.Fatal(err)
					}
				case "settings":
					c, err := f.st.ConversationForSession(context.Background(), id)
					if err != nil {
						t.Fatal(err)
					}
					if err := f.st.SetConversationSettings(context.Background(), c.ID, domain.ConversationSettings{Model: "changed"}, time.Now()); err != nil {
						t.Fatal(err)
					}
				case "generation":
					r, _, _ := f.st.GetSession(context.Background(), id)
					r.Metadata.ControllerGeneration = "replacement"
					if err := f.st.UpdateSession(context.Background(), r); err != nil {
						t.Fatal(err)
					}
				case "restart":
					f.chat.SetOuterAdmission(outer.New(f.st, nil, f, outer.WithActionsEnabled(true), outer.WithClock(f.now)))
				}
				if release, err := deferred.acquire(context.Background()); err == nil {
					release()
					t.Fatal("stale deferred authority wrote bytes")
				}
				if deferred.starts.Load() != 0 {
					t.Fatal("held deferred start executed")
				}
				receipt, err := f.st.GetOuterRequest(context.Background(), plan.Plan.Actions[0].ID)
				if err != nil || !receipt.AttemptedAt.IsZero() {
					t.Fatal("held deferred attempt consumed authority", receipt, err)
				}
			})
		}
	}
}

func TestOuterM2PreservingStopExpiresAtFinalNativeClose(t *testing.T) {
	for _, op := range []string{"kill", "retire"} {
		t.Run(op, func(t *testing.T) {
			f := newM2Fixture(t)
			worker := f.approve(f.propose(workerSpec()))
			id := worker.Actions[0].SessionID
			f.settle(id)
			p := f.propose(domain.OuterActionSpec{Operation: op, ProjectID: "a", SessionID: id})
			closed := false
			f.providers[id].onClose = func() { closed = true }
			f.beforeStopWrite = func(count int) {
				if count == 2 {
					f.advance()
				}
			}
			result := f.approve(p)
			if closed || !result.Actions[0].CompletedAt.IsZero() {
				t.Fatal("expired stop reached native close", result)
			}
			if _, err := f.chat.Controller(id); err != nil {
				t.Fatal("expiry discarded original controller", err)
			}
		})
	}
}

func TestOuterM2WorkerOnlyPlanHoldsCoordinatorFeedbackAndLabelsDisclosure(t *testing.T) {
	f := newM2Fixture(t)
	coordinator, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindOrchestrator}, false)
	if err != nil {
		t.Fatal(err)
	}
	plan := f.approve(f.propose(workerSpec()))
	worker := plan.Actions[0].SessionID
	if held, err := f.st.FactoryFeedbackHeld(context.Background(), coordinator.ID); err != nil || !held {
		t.Fatal("report recipient was not enrolled", held, err)
	}
	if err := f.chat.DeliverFactoryFeedback(context.Background(), coordinator.ID, "worker finished; start another worker", uuid.NewString()); err == nil {
		t.Fatal("worker-only plan woke its coordinator")
	}
	token, err := f.st.IssueOuterCaller(context.Background(), coordinator.ID)
	if err != nil {
		t.Fatal(err)
	}
	caller, err := f.st.AuthenticateOuterCaller(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.st.CheckOuterOperation(domain.WithOuterCaller(context.Background(), caller), "spawn", "a", ""); err == nil {
		t.Fatal("coordinator inherited child-spawn authority")
	}
	provider := f.providers[worker]
	provider.mu.Lock()
	sent := append([]ports.ChatUserMessage{}, provider.sent...)
	provider.mu.Unlock()
	if len(sent) != 1 || sent[0].Text != workerSpec().Text || !strings.Contains(sent[0].SenderDisplayName, "Project A [a]") || !strings.Contains(sent[0].SenderDisplayName, plan.Plan.Actions[0].ID) || sent[0].SenderSessionID == "" {
		t.Fatal("disclosure attribution missing or payload changed", sent)
	}
	controller, err := f.chat.Controller(worker)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := f.st.LoadConversationSnapshot(context.Background(), controller.ConversationID())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, message := range rows.Messages {
		if message.ClientMessageID == plan.Plan.Actions[0].ID {
			found = message.SenderDisplayName == sent[0].SenderDisplayName && message.SenderSessionID == sent[0].SenderSessionID
		}
	}
	if !found {
		t.Fatal("recipient transcript lost source attribution")
	}
}

func TestOuterM2QueuedCoordinatorTurnKeepsExactAuthorityAndAttribution(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(strconv.FormatBool(expired), func(t *testing.T) {
			f := newM2Fixture(t)
			target, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindOrchestrator}, false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.chat.Send(context.Background(), target.ID, ports.ChatUserMessage{Text: "Earlier authorized local turn", Origin: domain.MessageOriginHuman}); err != nil {
				t.Fatal(err)
			}
			plan := f.approve(f.propose(domain.OuterActionSpec{Operation: "send", ProjectID: "a", SessionID: target.ID, Text: "Exact queued continuation"}))
			if receipt, err := f.st.GetOuterRequest(context.Background(), plan.Plan.Actions[0].ID); err != nil || receipt.State != "ao_queued" {
				t.Fatal("not queued", receipt, err)
			}
			if expired {
				f.advance()
			}
			provider := f.providers[target.ID]
			provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", TurnState: domain.TurnStateCompleted, NativeSettlement: true})
			waitM2(t, func() bool {
				r, err := f.st.GetOuterRequest(context.Background(), plan.Plan.Actions[0].ID)
				if err != nil {
					return false
				}
				if expired {
					return r.State == "held"
				}
				return !r.AttemptedAt.IsZero()
			})
			provider.mu.Lock()
			sent := append([]ports.ChatUserMessage{}, provider.sent...)
			provider.mu.Unlock()
			if expired && len(sent) != 1 {
				t.Fatal("expired queued turn wrote bytes", sent)
			}
			if !expired && (len(sent) != 2 || sent[1].Text != "Exact queued continuation" || sent[1].SenderDisplayName == "") {
				t.Fatal("queued payload or disclosure changed", sent)
			}
		})
	}
}
