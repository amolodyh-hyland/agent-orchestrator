package daemon

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type recordingAgentService struct {
	switching     bool
	invalidations int
	observations  []ports.CodexCapacityObservation
}

func (r *recordingAgentService) CodexAccountSwitchInProgress() bool { return r.switching }
func (r *recordingAgentService) InvalidateCodexAccountAuthentication() {
	r.invalidations++
}
func (r *recordingAgentService) ObserveActiveCodexAccountCapacity(observation ports.CodexCapacityObservation) {
	r.observations = append(r.observations, observation)
}

const hookGeneration = "gen-1"

// agentHooks builds the Chat service's options over a real store holding one Codex
// session, and returns the two hooks that reach the agent service and the function
// that binds it, as the daemon does once the agent service exists.
func agentHooks(t *testing.T, harness domain.AgentHarness) (
	account func(domain.SessionID, string, domain.AgentHarness),
	capacity func(domain.SessionID, string, ports.CodexCapacityObservation),
	bind func(chatAgentService),
) {
	t.Helper()
	ctx := context.Background()
	store := sqlitetest.MustOpen(t)
	seedHookSession(t, store, harness)
	opts, bindings := newChatServiceOptions(ctx, chatServiceDeps{Store: store, Log: slog.New(slog.DiscardHandler)})
	if opts.OnAccountChanged == nil || opts.OnCodexCapacityChanged == nil || bindings.Agents == nil {
		t.Fatalf("agent hooks missing: account=%t capacity=%t bind=%t",
			opts.OnAccountChanged != nil, opts.OnCodexCapacityChanged != nil, bindings.Agents != nil)
	}
	return opts.OnAccountChanged, opts.OnCodexCapacityChanged, bindings.Agents
}

func seedHookSession(t *testing.T, store *sqlite.Store, harness domain.AgentHarness) {
	t.Helper()
	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID: "p1", Path: t.TempDir(), RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := store.CreateSession(ctx, domain.SessionRecord{
		ID: "p1-1", ProjectID: "p1", Kind: domain.KindWorker, Harness: harness, Mode: domain.SessionModeChat,
		Metadata:  domain.SessionMetadata{ControllerGeneration: hookGeneration},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
}

// The agent service is built after the Chat service, so the account hooks reach it
// only through the binding. A hook that never sees it, or fires before it exists,
// silently stops Codex account sign-out and capacity events from being noticed.
func TestChatAccountHooksReachTheBoundAgentService(t *testing.T) {
	account, capacity, bind := agentHooks(t, domain.HarnessCodex)

	// Before the agent service exists both hooks are quiet no-ops.
	account("p1-1", hookGeneration, domain.HarnessCodex)
	capacity("p1-1", hookGeneration, ports.CodexCapacityObservation{Partial: true})

	agents := &recordingAgentService{}
	bind(agents)

	account("p1-1", hookGeneration, domain.HarnessCodex)
	if agents.invalidations != 1 {
		t.Fatalf("account hook invalidated %d times, want 1", agents.invalidations)
	}
	observation := ports.CodexCapacityObservation{Partial: true, ObservedAt: time.Unix(1700000000, 0).UTC()}
	capacity("p1-1", hookGeneration, observation)
	if len(agents.observations) != 1 || agents.observations[0].ObservedAt != observation.ObservedAt || !agents.observations[0].Partial {
		t.Fatalf("capacity hook observed %+v, want the observation it was given", agents.observations)
	}
}

// A signal from a controller that is no longer the session's current one, from another
// harness, from an unknown session, or during an account switch says nothing about the
// device's account and must not touch it.
func TestChatAccountHooksIgnoreSignalsThatAreNotTheCurrentCodexControllers(t *testing.T) {
	for _, tc := range []struct {
		name        string
		sessionID   domain.SessionID
		generation  string
		harness     domain.AgentHarness // what the event claims
		stored      domain.AgentHarness // what the session record says
		switching   bool
		accountOnly bool // the capacity hook is not told the event's harness
	}{
		{"an older controller generation", "p1-1", "gen-0", domain.HarnessCodex, domain.HarnessCodex, false, false},
		{"an event from another harness", "p1-1", hookGeneration, domain.HarnessClaudeCode, domain.HarnessCodex, false, true},
		{"a session recorded for another harness", "p1-1", hookGeneration, domain.HarnessCodex, domain.HarnessClaudeCode, false, false},
		{"an unknown session", "p1-9", hookGeneration, domain.HarnessCodex, domain.HarnessCodex, false, false},
		{"an account switch in progress", "p1-1", hookGeneration, domain.HarnessCodex, domain.HarnessCodex, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			account, capacity, bind := agentHooks(t, tc.stored)
			agents := &recordingAgentService{switching: tc.switching}
			bind(agents)

			account(tc.sessionID, tc.generation, tc.harness)
			if !tc.accountOnly {
				capacity(tc.sessionID, tc.generation, ports.CodexCapacityObservation{Partial: true})
			}

			if agents.invalidations != 0 || len(agents.observations) != 0 {
				t.Fatalf("hooks reached the agent service: %d invalidations, %d observations",
					agents.invalidations, len(agents.observations))
			}
		})
	}
}

// Each daemon builds its own options, so an agent service bound for one must not leak
// into another's hooks.
func TestChatAgentServiceBindingIsPerInstance(t *testing.T) {
	account, _, bind := agentHooks(t, domain.HarnessCodex)
	otherAccount, _, _ := agentHooks(t, domain.HarnessCodex)
	agents := &recordingAgentService{}
	bind(agents)

	otherAccount("p1-1", hookGeneration, domain.HarnessCodex)
	if agents.invalidations != 0 {
		t.Fatal("a hook from an instance that was never bound reached another instance's agent service")
	}
	account("p1-1", hookGeneration, domain.HarnessCodex)
	if agents.invalidations != 1 {
		t.Fatalf("bound instance invalidated %d times, want 1", agents.invalidations)
	}
}
