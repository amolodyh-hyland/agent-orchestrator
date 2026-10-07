package daemon

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/persistenthost"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// chatServiceDeps is what the daemon wires into the Chat service. The Session
// Manager and the agent service are built after it, so they are read through getters
// when a hook fires instead of being captured as nil.
type chatServiceDeps struct {
	Store        *sqlite.Store
	DataDir      string
	Drivers      ports.ChatDriverRegistry
	Activity     *lifecycle.Manager
	Log          *slog.Logger
	AgentService func() *agentsvc.Service
	Sessions     func() sessionLifecycle
}

// newChatServiceOptions builds the Chat service's options. It is a function, not an
// inline literal in Run, so a test can prove the hooks that write to session records
// (the model and permission hooks) are actually wired and reach the Session Manager.
func newChatServiceOptions(ctx context.Context, deps chatServiceDeps) chatsvc.Options {
	return chatsvc.Options{
		Store:    deps.Store,
		Sessions: deps.Store,
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
			agentSvc := deps.AgentService()
			if harness != domain.HarnessCodex || agentSvc == nil || agentSvc.CodexAccountSwitchInProgress() {
				return
			}
			rec, ok, readErr := deps.Store.GetSession(ctx, sessionID)
			if readErr == nil && ok && rec.Harness == domain.HarnessCodex && rec.Metadata.ControllerGeneration == generation {
				agentSvc.InvalidateCodexAccountAuthentication()
			}
		},
		OnCodexCapacityChanged: func(sessionID domain.SessionID, generation string, observation ports.CodexCapacityObservation) {
			agentSvc := deps.AgentService()
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
			sessMgr := deps.Sessions()
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
			if sessions := deps.Sessions(); sessions != nil {
				return sessions
			}
			return nil
		}, deps.Log),
	}
}
