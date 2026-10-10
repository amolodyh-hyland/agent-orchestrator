// Contract between the main process, the preload bridge and the renderer for
// writing AO session progress to Multica issue statuses. Free of Electron and
// DOM types. Everything is off by default: the master switch, then each link.

import {
	SYNC_ACTIVITIES,
	SYNC_KANBAN_COLUMNS,
	SYNC_PR_STATES,
	SYNC_PROVISIONING,
	type MulticaWritableStatus,
	type SyncSessionFacts,
} from "./multica-status-writer";

export const MULTICA_SYNC_GET_STATE_CHANNEL = "multicaSync:getState";
export const MULTICA_SYNC_SET_SETTINGS_CHANNEL = "multicaSync:setSettings";
export const MULTICA_SYNC_SET_LINK_CHANNEL = "multicaSync:setLink";
export const MULTICA_SYNC_RESUME_CHANNEL = "multicaSync:resume";
export const MULTICA_SYNC_REOPEN_CHANNEL = "multicaSync:reopen";
export const MULTICA_SYNC_SYNC_NOW_CHANNEL = "multicaSync:syncNow";
export const MULTICA_SYNC_PUBLISH_FACTS_CHANNEL = "multicaSync:publishFacts";
export const MULTICA_SYNC_CHANGED_CHANNEL = "multicaSync:changed";

/** Environment switch for operators and tests: `AO_MULTICA_SYNC=0` forces every write off. */
export const MULTICA_SYNC_KILL_SWITCH_ENV = "AO_MULTICA_SYNC";

export function isMulticaSyncKilled(env: Record<string, string | undefined>): boolean {
	return ["0", "false", "off"].includes(env[MULTICA_SYNC_KILL_SWITCH_ENV]?.trim().toLowerCase() ?? "");
}

export type MulticaSyncSettings = {
	/** Master switch. With it off no code path writes to Multica. */
	enabled: boolean;
	/** Starting a session on a Backlog issue moves it to In Progress (answer Q1 in the docs). Off by default. */
	moveOutOfBacklog: boolean;
};

// Both off: a card in Backlog is never moved unless the user turns that on explicitly. A card in Triage can look like
// Backlog (Multica gives AO no way to tell them apart), so the safe default is to leave Backlog alone.
export const DEFAULT_MULTICA_SYNC_SETTINGS: MulticaSyncSettings = { enabled: false, moveOutOfBacklog: false };

export type MulticaSyncLinkRef = { sessionId: string; workspaceSlug: string; issueIdentifier: string };

/** The UI states of one link: off, on (synced or pending), paused, refused, error. */
export type MulticaSyncState = "off" | "synced" | "pending" | "paused" | "refused" | "error";

export type MulticaSyncReason =
	// off
	| "master_off"
	| "kill_switch"
	// paused
	| "changed_in_multica"
	| "closed_in_multica"
	| "blocked_in_multica"
	// refused
	| "driven_by_multica"
	| "triage"
	| "identity_changed"
	| "would_start_run"
	| "secondary_link"
	| "sub_issue_parent"
	// error
	| "signed_out"
	| "unavailable"
	| "unreachable"
	| "no_access"
	| "orphaned"
	| "rate_limited"
	| "ao_offline";

export type MulticaSyncLinkView = MulticaSyncLinkRef & {
	enabled: boolean;
	state: MulticaSyncState;
	reason: MulticaSyncReason | null;
	/** The status key Multica last showed for the issue, when AO has read it. */
	multicaStatus: string | null;
	/** The status AO would write for the facts it has now; null when AO has nothing to say. */
	aoStatus: MulticaWritableStatus | null;
	lastSyncAt: string | null;
	/** True when the link is paused and the user may let AO take over again. */
	canResume: boolean;
	/** True when the issue is closed or blocked in Multica and the user may confirm reopening it. */
	canReopen: boolean;
};

export type MulticaSyncSnapshot = {
	settings: MulticaSyncSettings;
	/** True when `AO_MULTICA_SYNC=0` forces writes off whatever the settings say. */
	killSwitch: boolean;
	links: MulticaSyncLinkView[];
};

export const EMPTY_MULTICA_SYNC_SNAPSHOT: MulticaSyncSnapshot = {
	settings: DEFAULT_MULTICA_SYNC_SETTINGS,
	killSwitch: false,
	links: [],
};

/** What the renderer publishes about the linked sessions. `stale` is true while the AO daemon feed is down. */
export type MulticaSyncFacts = { stale: boolean; sessions: SyncSessionFacts[] };

export const MAX_MULTICA_SYNC_FACT_SESSIONS = 1000;
const MAX_ID_LENGTH = 200;
const MAX_PRS_PER_SESSION = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes("/") && !CONTROL_CHARACTERS.test(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isSyncSessionFacts(value: unknown): value is SyncSessionFacts {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value).sort().join(",");
	if (keys !== "activity,column,provisioning,prs,sessionId,terminated") return false;
	return (
		isIdentifier(value.sessionId) &&
		isOneOf(SYNC_PROVISIONING, value.provisioning) &&
		isOneOf(SYNC_KANBAN_COLUMNS, value.column) &&
		isOneOf(SYNC_ACTIVITIES, value.activity) &&
		typeof value.terminated === "boolean" &&
		Array.isArray(value.prs) &&
		value.prs.length <= MAX_PRS_PER_SESSION &&
		value.prs.every((state) => isOneOf(SYNC_PR_STATES, state))
	);
}

export function isMulticaSyncFacts(value: unknown): value is MulticaSyncFacts {
	if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "sessions,stale") return false;
	if (typeof value.stale !== "boolean" || !Array.isArray(value.sessions) || value.sessions.length > MAX_MULTICA_SYNC_FACT_SESSIONS) return false;
	const seen = new Set<string>();
	for (const session of value.sessions) {
		if (!isSyncSessionFacts(session) || seen.has(session.sessionId)) return false;
		seen.add(session.sessionId);
	}
	return true;
}

export function isMulticaSyncLinkRef(value: unknown): value is MulticaSyncLinkRef {
	return (
		isPlainObject(value) &&
		isIdentifier(value.sessionId) &&
		typeof value.workspaceSlug === "string" &&
		/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value.workspaceSlug) &&
		typeof value.issueIdentifier === "string" &&
		/^[A-Z0-9]{1,10}-[1-9][0-9]{0,8}$/.test(value.issueIdentifier)
	);
}

export type MulticaSyncSettingsPatch = Partial<MulticaSyncSettings>;

export function parseMulticaSyncSettingsPatch(value: unknown): MulticaSyncSettingsPatch | null {
	if (!isPlainObject(value)) return null;
	const patch: MulticaSyncSettingsPatch = {};
	for (const [key, entry] of Object.entries(value)) {
		if ((key !== "enabled" && key !== "moveOutOfBacklog") || typeof entry !== "boolean") return null;
		patch[key] = entry;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

export type MulticaStatusSyncBridge = {
	getState: () => Promise<MulticaSyncSnapshot>;
	setSettings: (patch: MulticaSyncSettingsPatch) => Promise<MulticaSyncSnapshot>;
	/** Turns the sync of one link on or off. */
	setLink: (request: MulticaSyncLinkRef & { enabled: boolean }) => Promise<MulticaSyncSnapshot>;
	/** Lets AO take over a paused link again. */
	resume: (request: MulticaSyncLinkRef) => Promise<MulticaSyncSnapshot>;
	/** Reopens a closed or blocked issue. `confirmed` must be true: the user has been asked. */
	reopen: (request: MulticaSyncLinkRef & { confirmed: true }) => Promise<MulticaSyncSnapshot>;
	syncNow: (request: MulticaSyncLinkRef) => Promise<MulticaSyncSnapshot>;
	publishFacts: (facts: MulticaSyncFacts) => Promise<{ ok: boolean }>;
	onChanged: (listener: (snapshot: MulticaSyncSnapshot) => void) => () => void;
};
