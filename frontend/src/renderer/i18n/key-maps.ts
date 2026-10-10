import type { AppShortcutId, ShortcutCategory } from "../../shared/shortcuts";
import type { MulticaSyncReason, MulticaSyncState } from "../../shared/multica-status-sync";
import type { MulticaStatusCategory } from "../../shared/multica-status-writer";
import type { components } from "../../api/schema";
import type { MessageKey } from "./messages";

/** Exhaustive mappings keep dynamic domain identifiers inside the typed catalog. */
export const shortcutLabelKeys: Record<AppShortcutId, MessageKey> = {
	"new-session": "shortcut.new-session",
	"new-shell-terminal": "shortcut.new-shell-terminal",
	"close-shell-terminal": "shortcut.close-shell-terminal",
	"keyboard-shortcuts": "shortcut.keyboard-shortcuts",
	"command-palette": "shortcut.command-palette",
	"open-settings": "shortcut.open-settings",
	"toggle-sidebar": "shortcut.toggle-sidebar",
	"open-project": "shortcut.open-project",
	"previous-session": "shortcut.previous-session",
	"next-session": "shortcut.next-session",
	"previous-tab": "shortcut.previous-tab",
	"next-tab": "shortcut.next-tab",
	"toggle-inspector": "shortcut.toggle-inspector",
	"focus-terminal": "shortcut.focus-terminal",
	"toggle-browser-devtools": "titlebar.devtools",
	"toggle-multica": "shortcut.toggle-multica",
};

export const shortcutCategoryLabelKeys: Record<ShortcutCategory, MessageKey> = {
	General: "shortcut.category.general",
	Navigation: "shortcut.category.navigation",
	Session: "shortcut.category.session",
};

export type AgentSwitchErrorCode = NonNullable<components["schemas"]["AgentSwitch"]["errorCode"]>;

/** Exhaustive known-code mapping with a separate runtime fallback for newer daemons. */
export const agentSwitchErrorLabelKeys: Record<AgentSwitchErrorCode, MessageKey> = {
	daemon_restart_pre_stop: "switchAgent.error.daemonRestartPreStop",
	daemon_restart_post_stop: "switchAgent.error.daemonRestartPostStop",
	daemon_restart_unrecoverable_target: "switchAgent.error.daemonRestartUnrecoverableTarget",
	daemon_restart_before_delivery: "switchAgent.error.daemonRestartBeforeDelivery",
	delivery_unconfirmed: "switchAgent.error.deliveryUnconfirmed",
	source_session_terminated: "switchAgent.error.sourceSessionTerminated",
	source_stop_unconfirmed: "switchAgent.error.sourceStopUnconfirmed",
	target_binary_missing: "switchAgent.error.targetBinaryMissing",
	target_agent_unauthorized: "switchAgent.error.targetAgentUnauthorized",
	request_cancelled: "switchAgent.error.requestCancelled",
	source_blocked: "switchAgent.error.sourceBlocked",
	failed_pre_stop: "switchAgent.error.failedPreStop",
	failed_post_stop: "switchAgent.error.failedPostStop",
	target_ready_failed: "switchAgent.error.targetReadyFailed",
	delivery_failed: "switchAgent.error.deliveryFailed",
	switch_failed: "switchAgent.error.switchFailed",
	target_start_unconfirmed: "switchAgent.error.targetStartUnconfirmed",
	source_restore_unconfirmed: "switchAgent.sourceRecovery.description",
};

export const multicaSyncStateKeys: Record<MulticaSyncState, MessageKey> = {
	off: "multica.sync.state.off",
	synced: "multica.sync.state.synced",
	pending: "multica.sync.state.pending",
	paused: "multica.sync.state.paused",
	refused: "multica.sync.state.refused",
	error: "multica.sync.state.error",
};

export const multicaSyncReasonKeys: Record<MulticaSyncReason, MessageKey> = {
	master_off: "multica.sync.reason.master_off",
	kill_switch: "multica.sync.reason.kill_switch",
	changed_in_multica: "multica.sync.reason.changed_in_multica",
	closed_in_multica: "multica.sync.reason.closed_in_multica",
	blocked_in_multica: "multica.sync.reason.blocked_in_multica",
	driven_by_multica: "multica.sync.reason.driven_by_multica",
	triage: "multica.sync.reason.triage",
	identity_changed: "multica.sync.reason.identity_changed",
	would_start_run: "multica.sync.reason.would_start_run",
	secondary_link: "multica.sync.reason.secondary_link",
	signed_out: "multica.sync.reason.signed_out",
	unavailable: "multica.sync.reason.unavailable",
	unreachable: "multica.sync.reason.unreachable",
	no_access: "multica.sync.reason.no_access",
	orphaned: "multica.sync.reason.orphaned",
	rate_limited: "multica.sync.reason.rate_limited",
	ao_offline: "multica.sync.reason.ao_offline",
};

/** The seven built-in Multica statuses; a custom status has no entry and is shown by its own name. */
export const multicaSyncStatusKeys: Record<MulticaStatusCategory, MessageKey> = {
	backlog: "multica.sync.status.backlog",
	todo: "multica.sync.status.todo",
	in_progress: "multica.sync.status.in_progress",
	in_review: "multica.sync.status.in_review",
	done: "multica.sync.status.done",
	blocked: "multica.sync.status.blocked",
	cancelled: "multica.sync.status.cancelled",
};
