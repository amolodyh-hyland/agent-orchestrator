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

// An edit launches a replacement provider conversation, by a fresh start when the first
// prompt is edited and by resuming a fork otherwise. If the provider refuses that launch
// over the permission mode, nothing was delivered, so the edit settles as a definitive
// refusal, the source branch is restored, and a delivery handle is spent.
func TestEditLaunchRefusedOverThePermissionModeSettlesDefinitively(t *testing.T) {
	for name, refusal := range permissionRefusals() {
		for _, route := range []string{"fresh start", "fork resume"} {
			for _, handle := range []string{"edit-launch-refused", ""} {
				label := name + "/" + route + "/with a handle"
				if handle == "" {
					label = name + "/" + route + "/without a handle"
				}
				t.Run(label, func(t *testing.T) {
					h, _, driver := newEditHarness(t, false)
					ctx := context.Background()
					first := completeTurn(t, h, "A", "provider-turn-1")
					h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
					target := first
					if route == "fork resume" {
						target = completeTurn(t, h, "B", "provider-turn-2")
						h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })
					}
					before, err := h.svc.Snapshot(ctx, testSession)
					if err != nil {
						t.Fatalf("Snapshot: %v", err)
					}

					driver.mu.Lock()
					if route == "fresh start" {
						driver.startErr = refusal
					} else {
						driver.beforeResume = func(cfg ports.ChatResumeConfig) error {
							if cfg.ProviderConversationID == "thread-forked" {
								return refusal
							}
							return nil
						}
					}
					driver.mu.Unlock()
					msg := ports.ChatUserMessage{Text: "edited", ClientMessageID: handle, Origin: domain.MessageOriginHuman}

					_, err = h.svc.EditMessage(ctx, testSession, target, msg)
					if errors.Is(err, chatsvc.ErrEditDeliveryUncertain) {
						t.Fatalf("EditMessage error = %v; a refused launch delivered nothing, so it must not be uncertain", err)
					}
					if !errors.Is(err, ports.ErrPermissionRejected) || !errors.Is(err, chatsvc.ErrProviderRefused) {
						t.Fatalf("EditMessage error = %v, want a definitive permission refusal", err)
					}

					// The source branch was restored and still takes messages.
					driver.mu.Lock()
					lastResume := driver.resumeCalls[len(driver.resumeCalls)-1].ProviderConversationID
					driver.mu.Unlock()
					if lastResume != "thread-1" {
						t.Fatalf("last provider resume = %q, want the source thread-1 restored", lastResume)
					}
					after, err := h.svc.Snapshot(ctx, testSession)
					if err != nil {
						t.Fatalf("Snapshot: %v", err)
					}
					if after.ActiveBranch.ID != before.ActiveBranch.ID {
						t.Fatalf("active branch after a refused launch = %q, want the source %q", after.ActiveBranch.ID, before.ActiveBranch.ID)
					}
					if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "source remains usable"}); err != nil {
						t.Fatalf("Send on the restored source: %v", err)
					}
					if handle == "" {
						return
					}

					// The handle is spent: replaying it, here or after a restart, launches nothing.
					driver.mu.Lock()
					driver.startErr, driver.beforeResume = nil, nil
					startCalls, resumeCalls := driver.startCalls, len(driver.resumeCalls)
					driver.mu.Unlock()
					if _, err := h.svc.EditMessage(ctx, testSession, target, msg); !errors.Is(err, chatsvc.ErrProviderRefused) {
						t.Fatalf("same-controller replay error = %v, want the stored refusal", err)
					}
					restarted, restartedProvider := restartEditService(t, h)
					if _, err := restarted.EditMessage(ctx, testSession, target, msg); !errors.Is(err, chatsvc.ErrProviderRefused) {
						t.Fatalf("restart replay error = %v, want the stored refusal", err)
					}
					driver.mu.Lock()
					defer driver.mu.Unlock()
					if driver.startCalls != startCalls || len(driver.resumeCalls) != resumeCalls {
						t.Fatalf("replay launched again: starts %d→%d, resumes %d→%d",
							startCalls, driver.startCalls, resumeCalls, len(driver.resumeCalls))
					}
					if restartedProvider.sendCallCount() != 0 {
						t.Fatalf("restarted provider received %d sends for a refused edit replay", restartedProvider.sendCallCount())
					}
				})
			}
		}
	}
}

// Once a turn has stepped down to a lower mode, that is the mode the conversation runs
// with, so the replacement an edit launches must ask for it. Asking for the mode the
// provider already refused would have the edit relaunch at a posture the conversation
// no longer has, and fail outright wherever the provider validates a launch.
func TestEditLaunchUsesTheModeAStepDownSettledOn(t *testing.T) {
	for _, route := range []string{"fresh start", "fork resume"} {
		t.Run(route, func(t *testing.T) {
			h, source, driver := newEditHarnessWithOptions(t, false,
				func(st *store.Store) chatsvc.Store { return st },
				func(reader chatsvc.SnapshotReader) chatsvc.SnapshotReader { return reader }, nil,
				func(cfg *chatsvc.StartConfig) { cfg.Permissions = ports.PermissionModeBypassPermissions })
			ctx := context.Background()
			source.mu.Lock()
			source.refuseApproval = map[ports.PermissionMode]error{
				ports.PermissionModeBypassPermissions: &ports.PermissionRejectedError{
					Mode: ports.PermissionModeBypassPermissions, Reason: "`DangerFullAccess` is not in the allowed set"},
			}
			source.mu.Unlock()
			first := completeTurn(t, h, "A", "provider-turn-1")
			h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
			target := first
			if route == "fork resume" {
				target = completeTurn(t, h, "B", "provider-turn-2")
				h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })
			}
			// The turn stepped down from bypass-permissions to auto and said so.
			if got := h.ctrl.Settings().ApprovalMode; got != ports.PermissionModeAuto {
				t.Fatalf("conversation mode after the step-down = %q, want auto", got)
			}

			if _, err := h.svc.EditMessage(ctx, testSession, target, ports.ChatUserMessage{
				Text: "edited", ClientMessageID: "edit-after-step-down", Origin: domain.MessageOriginHuman,
			}); err != nil {
				t.Fatalf("EditMessage: %v", err)
			}

			driver.mu.Lock()
			defer driver.mu.Unlock()
			var launched ports.PermissionMode
			if route == "fresh start" {
				launched = driver.startConfigs[len(driver.startConfigs)-1].Permissions
			} else {
				launched = driver.resumeCalls[0].Permissions
			}
			if launched != ports.PermissionModeAuto {
				t.Fatalf("the edit launched its replacement with %q, want auto, the mode the conversation settled on", launched)
			}
		})
	}
}
