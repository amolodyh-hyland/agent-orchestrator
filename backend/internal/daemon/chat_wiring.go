package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/persistenthost"
	"github.com/aoagents/agent-orchestrator/backend/internal/attachmentstore"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// chatServiceDeps is what the daemon wires into the Chat service directly. The Session
// Manager and the agent service are built after it, so they reach the hooks through
// chatLateBindings instead.
type chatServiceDeps struct {
	Store              *sqlite.Store
	DataDir            string
	HibernationEnabled func() bool
	Drivers            ports.ChatDriverRegistry
	Activity           *lifecycle.Manager
	Log                *slog.Logger
}

// chatAgentService is what the Codex account hooks need from the agent service.
type chatAgentService interface {
	CodexAccountSwitchInProgress() bool
	InvalidateCodexAccountAuthentication()
	ObserveActiveCodexAccountCapacity(ports.CodexCapacityObservation)
}

var _ chatAgentService = (*agentsvc.Service)(nil)

// chatLateBindings hands the Chat service's hooks the services that are built after
// it. Each is nil until Run calls it, and a hook that fires before then does nothing.
type chatLateBindings struct {
	Sessions func(sessionLifecycle)
	Agents   func(chatAgentService)
}

// newChatServiceOptions builds the Chat service's options. It is a function, not an
// inline literal in Run, so a test can prove the hooks that write to session records
// (the model and permission hooks) and the Codex account hooks are actually wired and
// reach the services they act on.
//
// Those services are built after the Chat service, so the hooks read them through the
// bindings returned alongside the options. Handing the caller the bind functions,
// instead of asking it for getters, means Run cannot leave a hook pointing at nothing
// by omitting a field: the binding lives here, under test, and Run's calls to it are
// checked from its source (see run_wiring_test.go).
func newChatServiceOptions(ctx context.Context, deps chatServiceDeps) (chatsvc.Options, chatLateBindings) {
	var (
		mu       sync.RWMutex
		sessions sessionLifecycle
		agents   chatAgentService
	)
	bindings := chatLateBindings{
		Sessions: func(manager sessionLifecycle) {
			mu.Lock()
			defer mu.Unlock()
			sessions = manager
		},
		Agents: func(service chatAgentService) {
			mu.Lock()
			defer mu.Unlock()
			agents = service
		},
	}
	currentSessions := func() sessionLifecycle {
		mu.RLock()
		defer mu.RUnlock()
		return sessions
	}
	currentAgents := func() chatAgentService {
		mu.RLock()
		defer mu.RUnlock()
		return agents
	}
	return chatsvc.Options{
		Store:               deps.Store,
		Sessions:            deps.Store,
		Renders:             attachmentstore.New(deps.DataDir),
		DataDir:             deps.DataDir,
		ReconcileOutputType: deps.Activity.ReconcileSessionOutputType,
		HibernationEnabled:  deps.HibernationEnabled,
		StopProviderHost: func(ctx context.Context, id domain.SessionID) error {
			return persistenthost.Shutdown(ctx, deps.DataDir, string(id))
		},
		// Adapts the store's own snapshot type, so the chat service never has to
		// import the storage layer.
		Reader: chatsvc.SnapshotReaderFunc(func(ctx context.Context, conversationID string) (chatsvc.ConversationRows, error) {
			rows, err := deps.Store.LoadConversationSnapshot(ctx, conversationID)
			if err != nil {
				return chatsvc.ConversationRows{}, err
			}
			return chatsvc.ConversationRows{
				Conversation:                     rows.Conversation,
				ActiveBranch:                     rows.ActiveBranch,
				EditFloorSequence:                rows.EditFloorSequence,
				NativeForkAvailableAfterSequence: rows.NativeForkAvailableAfterSequence,
				Turns:                            rows.Turns,
				Messages:                         rows.Messages,
				Activities:                       rows.Activities,
				BranchPoints:                     rows.BranchPoints,
				BranchedFromEarlierMessage:       rows.BranchedFromEarlierMessage,
			}, nil
		}),
		PageReader: chatsvc.SnapshotPageReaderFunc(func(ctx context.Context, conversationID string, beforeSequence, limit int64) (chatsvc.ConversationRows, error) {
			rows, err := deps.Store.LoadConversationSnapshotPage(ctx, conversationID, beforeSequence, limit)
			if err != nil {
				return chatsvc.ConversationRows{}, err
			}
			return chatsvc.ConversationRows{
				Conversation:                     rows.Conversation,
				ActiveBranch:                     rows.ActiveBranch,
				EditFloorSequence:                rows.EditFloorSequence,
				NativeForkAvailableAfterSequence: rows.NativeForkAvailableAfterSequence,
				Turns:                            rows.Turns,
				Messages:                         rows.Messages,
				Activities:                       rows.Activities,
				BranchPoints:                     rows.BranchPoints,
				BranchedFromEarlierMessage:       rows.BranchedFromEarlierMessage,
				OldestSequence:                   rows.OldestSequence,
				HasMoreBefore:                    rows.HasMoreBefore,
			}, nil
		}),
		Drivers: deps.Drivers,
		// The LCM satisfies ActivityRecorder directly: a chat turn is a pure
		// lifecycle reduction, same as a hook signal from a terminal session.
		Activity: deps.Activity,
		Log:      deps.Log,
		NewID:    uuid.NewString,
		OnAccountChanged: func(sessionID domain.SessionID, generation string, harness domain.AgentHarness) {
			agentSvc := currentAgents()
			if harness != domain.HarnessCodex || agentSvc == nil || agentSvc.CodexAccountSwitchInProgress() {
				return
			}
			rec, ok, readErr := deps.Store.GetSession(ctx, sessionID)
			if readErr == nil && ok && rec.Harness == domain.HarnessCodex && rec.Metadata.ControllerGeneration == generation {
				agentSvc.InvalidateCodexAccountAuthentication()
			}
		},
		OnCodexCapacityChanged: func(sessionID domain.SessionID, generation string, observation ports.CodexCapacityObservation) {
			agentSvc := currentAgents()
			if agentSvc == nil || agentSvc.CodexAccountSwitchInProgress() {
				return
			}
			rec, ok, readErr := deps.Store.GetSession(ctx, sessionID)
			if readErr != nil || !ok || rec.Harness != domain.HarnessCodex || rec.Metadata.ControllerGeneration != generation {
				return
			}
			agentSvc.ObserveActiveCodexAccountCapacity(observation)
		},
		// Sync ChatUI's model choice, including clearing its override, before a
		// later TUI rebuild reads the session metadata.
		OnModelChanged: func(sessionID domain.SessionID, model string) {
			sessMgr := currentSessions()
			if sessMgr == nil {
				return
			}
			if err := sessMgr.PersistChatModel(ctx, sessionID, model); err != nil {
				deps.Log.Warn("persist ChatUI model on session failed; a TUI rebuild may resume with a different model",
					"sessionID", sessionID, "model", model, "error", err)
			}
		},
		// Record the mode a session really runs with after the permission
		// fallback lowered it, so session reads and a later restore agree. The
		// Session Manager is built after the Chat service, so it is read when the
		// hook fires.
		OnPermissionsChanged: chatPermissionsRecorder(ctx, func() chatPermissionsPersister {
			if manager := currentSessions(); manager != nil {
				return manager
			}
			return nil
		}, deps.Log),
	}, bindings
}
