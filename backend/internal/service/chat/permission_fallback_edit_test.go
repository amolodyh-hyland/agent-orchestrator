package chat_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func permissionRefusals() map[string]error {
	rejected := &ports.PermissionRejectedError{Mode: ports.PermissionModeBypassPermissions, Reason: "`DangerFullAccess` is not in the allowed set"}
	return map[string]error{
		"single refusal": rejected,
		"every mode refused": &ports.PermissionFallbackExhaustedError{Rejected: []ports.PermissionRejection{
			{Mode: ports.PermissionModeBypassPermissions, Reason: "no full access"},
			{Mode: ports.PermissionModeAuto, Reason: "no reviewer"},
		}},
	}
}

// A refusal over the permission mode proves nothing was delivered, so an edit that
// carries a delivery handle must settle as rejected, not stay reserved. Otherwise the
// caller is told "uncertain", the handle can never be reused, and the source branch
// stays closed for a refusal that changed nothing.
func TestEditWithAHandleSettlesAPermissionRefusalDefinitively(t *testing.T) {
	for name, refusal := range permissionRefusals() {
		t.Run(name, func(t *testing.T) {
			h, _, driver := newEditHarness(t, false)
			ctx := context.Background()
			first := completeTurn(t, h, "A", "provider-turn-1")
			h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
			driver.fresh.mu.Lock()
			driver.fresh.sendErr = refusal
			driver.fresh.mu.Unlock()
			msg := ports.ChatUserMessage{
				Text: "A edited", ClientMessageID: "edit-permission-refused", Origin: domain.MessageOriginHuman,
			}

			_, err := h.svc.EditMessage(ctx, testSession, first, msg)
			if errors.Is(err, chatsvc.ErrEditDeliveryUncertain) {
				t.Fatalf("EditMessage error = %v; a refusal proves nothing was delivered, so it must not be uncertain", err)
			}
			if !errors.Is(err, ports.ErrPermissionRejected) || !errors.Is(err, chatsvc.ErrProviderRefused) {
				t.Fatalf("EditMessage error = %v, want a definitive permission refusal", err)
			}
			if calls := driver.fresh.sendCallCount(); calls != 1 {
				t.Fatalf("provider send calls after refusal = %d, want one", calls)
			}

			// The handle is settled: replaying it never reaches the provider again.
			driver.fresh.mu.Lock()
			driver.fresh.sendErr = nil
			driver.fresh.mu.Unlock()
			_, err = h.svc.EditMessage(ctx, testSession, first, msg)
			if !errors.Is(err, chatsvc.ErrProviderRefused) {
				t.Fatalf("same-controller replay error = %v, want the stored refusal", err)
			}
			if calls := driver.fresh.sendCallCount(); calls != 1 {
				t.Fatalf("provider send calls after replay = %d, want still one", calls)
			}
			restarted, restartedProvider := restartEditService(t, h)
			_, err = restarted.EditMessage(ctx, testSession, first, msg)
			if !errors.Is(err, chatsvc.ErrProviderRefused) {
				t.Fatalf("restart replay error = %v, want the stored refusal", err)
			}
			if calls := restartedProvider.sendCallCount(); calls != 0 {
				t.Fatalf("restarted provider received %d sends for a refused edit replay, want none", calls)
			}
		})
	}
}

// The same refusal restores the source branch and leaves the conversation usable,
// exactly as an ordinary provider refusal does.
func TestEditPermissionRefusalRestoresTheSourceBranch(t *testing.T) {
	for name, refusal := range permissionRefusals() {
		t.Run(name, func(t *testing.T) {
			h, _, driver := newEditHarness(t, false)
			ctx := context.Background()
			completeTurn(t, h, "A", "provider-turn-1")
			h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
			second := completeTurn(t, h, "B", "provider-turn-2")
			h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

			driver.mu.Lock()
			replacement := driver.resumed["thread-forked"]
			replacement.mu.Lock()
			replacement.sendErr = refusal
			replacement.mu.Unlock()
			driver.mu.Unlock()

			failed, err := h.svc.EditMessage(ctx, testSession, second, ports.ChatUserMessage{
				Text: "B edited", ClientMessageID: "edit-b-permission", Origin: domain.MessageOriginHuman,
			})
			if !errors.Is(err, ports.ErrPermissionRejected) {
				t.Fatalf("EditMessage error = %v, want a permission refusal", err)
			}
			snapshot, err := h.svc.Snapshot(ctx, testSession)
			if err != nil {
				t.Fatalf("Snapshot: %v", err)
			}
			if snapshot.ActiveBranch.ID != failed.SourceBranchID {
				t.Fatalf("active branch after a permission refusal = %q, want the source %q", snapshot.ActiveBranch.ID, failed.SourceBranchID)
			}
			if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "source remains usable"}); err != nil {
				t.Fatalf("Send on the restored source: %v", err)
			}
		})
	}
}
