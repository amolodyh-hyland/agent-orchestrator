// Contract for Multica awareness (read-only): what the main process projects out
// of Multica's REST and WebSocket traffic, the watch configuration, and the IPC
// surface. Shared by main, preload and renderer; free of Electron and DOM types.
//
// The projected types deliberately hold no issue description, comment, task
// result or error text, work directory, trigger comment or credential field:
// the projection happens at the parse boundary in the main process.

import type { MulticaStatusTone } from "./multica-session-status";

export const MULTICA_AWARENESS_STATE_CHANNEL = "multicaAwareness:state";
export const MULTICA_AWARENESS_GET_STATE_CHANNEL = "multicaAwareness:getState";
export const MULTICA_AWARENESS_COMMAND_CHANNEL = "multicaAwareness:command";
export const MULTICA_AWARENESS_OPEN_ISSUE_CHANNEL = "multicaAwareness:openIssue";

/** Hard ceiling for the number of WebSockets (one per watched workspace). */
export const MULTICA_MAX_SOCKETS = 8;
export const MULTICA_MAX_ISSUES_PER_SERVER = 2000;
export const MULTICA_MAX_RUNS_PER_SERVER = 500;
export const MULTICA_TITLE_MAX = 200;

export const MULTICA_TASK_STATUSES = [
	"queued",
	"deferred",
	"dispatched",
	"waiting_local_directory",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export type MulticaTaskStatus = (typeof MULTICA_TASK_STATUSES)[number];

/** The statuses that mean an agent holds the issue right now. */
export const MULTICA_ACTIVE_TASK_STATUSES: readonly MulticaTaskStatus[] = ["queued", "dispatched", "waiting_local_directory", "running"];
export const MULTICA_TERMINAL_TASK_STATUSES: readonly MulticaTaskStatus[] = ["completed", "failed", "cancelled"];

/** Order used to refuse a frame that would move a task backwards. Terminal states are sticky. */
export const MULTICA_TASK_STATUS_RANK: Record<MulticaTaskStatus, number> = {
	queued: 0,
	deferred: 0,
	dispatched: 1,
	waiting_local_directory: 2,
	running: 3,
	completed: 4,
	failed: 4,
	cancelled: 4,
};

export function isMulticaTaskStatus(value: unknown): value is MulticaTaskStatus {
	return typeof value === "string" && (MULTICA_TASK_STATUSES as readonly string[]).includes(value);
}

export function isActiveMulticaTaskStatus(status: MulticaTaskStatus): boolean {
	return MULTICA_ACTIVE_TASK_STATUSES.includes(status);
}

export type MulticaAssigneeType = "member" | "agent" | "squad";

export type AwarenessIssue = {
	id: string;
	workspaceId: string;
	identifier: string;
	/** Plain text, at most {@link MULTICA_TITLE_MAX} characters. */
	title: string;
	status: string;
	statusCategory: string;
	assigneeType: MulticaAssigneeType | null;
	assigneeId: string | null;
	parentIssueId: string | null;
	projectId: string | null;
	revision: number;
	updatedAt: string;
};

export type AwarenessRun = {
	id: string;
	workspaceId: string;
	issueId: string;
	agentId: string;
	status: MulticaTaskStatus;
	failureReason: string | null;
	retryPending: boolean;
	/** The run was active when a reconcile no longer listed it, and its outcome has not been read yet. */
	outcomeUnknown: boolean;
	startedAt: string | null;
	/** When the run ended: the server's completion time when it sent one, else the time AO saw the end. */
	endedAt: string | null;
	isLeaderTask: boolean;
	autopilotRunId: string | null;
	parentTaskId: string | null;
	runtimeId: string | null;
};

export type AwarenessAgent = { id: string; workspaceId: string; name: string; runtimeId: string | null };
export type AwarenessRuntime = { id: string; workspaceId: string; provider: string; daemonId: string | null; status: string };

export type MulticaCredentialSource = "profile" | "pasted" | "page";
export const MULTICA_CREDENTIAL_SOURCES: readonly MulticaCredentialSource[] = ["profile", "pasted", "page"];

export type MulticaServerStatus = "off" | "no_credential" | "connecting" | "live" | "degraded" | "signed_out" | "unreachable" | "paused";
export type MulticaWorkspaceWatchState = "idle" | "connecting" | "authenticating" | "live" | "backoff" | "no_access" | "gone";

export type AwarenessWorkspaceState = {
	workspaceId: string;
	slug: string;
	name: string;
	/** True when the user switched this workspace on. Everything is off by default. */
	watch: boolean;
	state: MulticaWorkspaceWatchState;
	/** Reconnect attempt number while in `backoff`. */
	attempt: number;
	/** True when the interest set hit its page cap, so the lists are not complete. */
	partial: boolean;
	transport: "socket" | "page";
};

export type AwarenessServerState = {
	serverKey: string;
	label: string;
	mode: "cloud" | "local";
	customUrl: string;
	apiUrl: string;
	enabled: boolean;
	credentialSource: MulticaCredentialSource;
	/** The user agreed to AO reading this server's Multica CLI profile token. */
	consentGranted: boolean;
	/** A pasted token is stored for this server (never the token itself). */
	hasPastedToken: boolean;
	status: MulticaServerStatus;
	meId: string | null;
	workspaces: AwarenessWorkspaceState[];
};

export type AwarenessState = {
	/** `AO_MULTICA_WATCH=0` forces everything off regardless of the settings. */
	killSwitch: boolean;
	masterEnabled: boolean;
	maxSockets: number;
	servers: AwarenessServerState[];
	issues: Array<AwarenessIssue & { serverKey: string }>;
	runs: Array<AwarenessRun & { serverKey: string }>;
	agents: Array<AwarenessAgent & { serverKey: string }>;
	runtimes: Array<AwarenessRuntime & { serverKey: string }>;
};

export const EMPTY_AWARENESS_STATE: AwarenessState = {
	killSwitch: false,
	masterEnabled: false,
	maxSockets: MULTICA_MAX_SOCKETS,
	servers: [],
	issues: [],
	runs: [],
	agents: [],
	runtimes: [],
};

export type AwarenessCommand =
	| { type: "setMaster"; enabled: boolean }
	| { type: "addServer"; mode: "cloud" | "local"; customUrl: string; apiUrl: string }
	| { type: "removeServer"; serverKey: string }
	| { type: "setServerEnabled"; serverKey: string; enabled: boolean }
	| { type: "setCredentialSource"; serverKey: string; source: MulticaCredentialSource }
	| { type: "grantConsent"; serverKey: string }
	| { type: "revokeConsent"; serverKey: string }
	| { type: "setToken"; serverKey: string; token: string }
	| { type: "clearToken"; serverKey: string }
	| { type: "setWorkspaceWatch"; serverKey: string; workspaceId: string; watch: boolean }
	| { type: "refreshWorkspaces"; serverKey: string }
	| { type: "setMaxSockets"; value: number };

export type AwarenessCommandFailure =
	| "invalid_request"
	| "kill_switch"
	| "unknown_server"
	| "invalid_server"
	| "consent_required"
	| "token_storage_unavailable"
	| "socket_cap"
	| "save_failed";

export type AwarenessCommandResult = { ok: true; state: AwarenessState } | { ok: false; reason: AwarenessCommandFailure };

export type MulticaAwarenessBridge = {
	getState: () => Promise<AwarenessState>;
	command: (command: AwarenessCommand) => Promise<AwarenessCommandResult>;
	openIssue: (request: { serverKey: string; workspaceSlug: string; identifier: string }) => Promise<boolean>;
	onState: (listener: (state: AwarenessState) => void) => () => void;
};

// Run cards: how a Multica task status is shown on the "Run by Multica" strip.

export type MulticaRunLane = "attention" | "running" | "queued" | "recent";
export const MULTICA_RUN_LANES: readonly MulticaRunLane[] = ["attention", "running", "queued", "recent"];

export type MulticaRunCardState =
	| "queued"
	| "starting"
	| "running"
	| "waiting_folder"
	| "retrying"
	| "finished"
	| "ended"
	| "failed"
	| "cancelled";

export type MulticaRunCardView = { state: MulticaRunCardState; lane: MulticaRunLane; tone: MulticaStatusTone };

/** Finished and cancelled runs stay on the strip for this long. */
export const MULTICA_RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A failed run waiting for Multica's automatic retry reads as "retrying" for this long, then as a failure. */
export const MULTICA_RETRY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Maps a task to a card state, lane and tone. Returns null for a finished or
 * cancelled run older than the recent window.
 */
export function multicaRunCardView(
	run: Pick<AwarenessRun, "status" | "retryPending" | "endedAt"> & { outcomeUnknown?: boolean },
	nowMs: number,
): MulticaRunCardView | null {
	if (run.outcomeUnknown) return isRecent(run.endedAt, nowMs) ? { state: "ended", lane: "recent", tone: "done" } : null;
	switch (run.status) {
		case "queued":
		case "deferred":
			return { state: "queued", lane: "queued", tone: "pending" };
		case "dispatched":
			return { state: "starting", lane: "running", tone: "working" };
		case "running":
			return { state: "running", lane: "running", tone: "working" };
		case "waiting_local_directory":
			return { state: "waiting_folder", lane: "running", tone: "pending" };
		case "failed":
			// A failed run that Multica is about to retry is still in flight, not an alarm.
			if (run.retryPending && isWithin(run.endedAt, nowMs, MULTICA_RETRY_WINDOW_MS)) {
				return { state: "retrying", lane: "running", tone: "pending" };
			}
			return isRecent(run.endedAt, nowMs) ? { state: "failed", lane: "attention", tone: "attention" } : null;
		case "completed":
			return isRecent(run.endedAt, nowMs) ? { state: "finished", lane: "recent", tone: "done" } : null;
		case "cancelled":
			return isRecent(run.endedAt, nowMs) ? { state: "cancelled", lane: "recent", tone: "done" } : null;
	}
}

function isRecent(endedAt: string | null, nowMs: number): boolean {
	return isWithin(endedAt, nowMs, MULTICA_RECENT_RUN_WINDOW_MS);
}

function isWithin(endedAt: string | null, nowMs: number, windowMs: number): boolean {
	if (endedAt === null) return true;
	const ended = Date.parse(endedAt);
	return Number.isNaN(ended) || nowMs - ended <= windowMs;
}

/** Key that joins a Multica issue to an AO link: `serverKey`, workspace slug, upper-case identifier. */
export function multicaIssueJoinKey(serverKey: string, workspaceSlug: string, identifier: string): string {
	return `${serverKey}|${workspaceSlug.toLowerCase()}|${identifier.toUpperCase()}`;
}

/** A UUID, or a display identifier such as `MUL-12`. Words like `query` or `preview-trigger` are neither. */
export const MULTICA_ISSUE_REF_SOURCE =
	"(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9]{1,10}-[1-9][0-9]{0,8})";
const ISSUE_REF_PATTERN = new RegExp(`^${MULTICA_ISSUE_REF_SOURCE}$`);
export function isMulticaIssueId(value: unknown): value is string {
	return typeof value === "string" && ISSUE_REF_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validates an IPC command from the renderer. Anything unexpected is refused. */
export function isAwarenessCommand(value: unknown): value is AwarenessCommand {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const text = (key: string, max = 300) => typeof value[key] === "string" && (value[key] as string).length > 0 && (value[key] as string).length <= max;
	const keys = Object.keys(value);
	const only = (...allowed: string[]) => keys.every((key) => key === "type" || allowed.includes(key));
	switch (value.type) {
		case "setMaster":
			return only("enabled") && typeof value.enabled === "boolean";
		case "addServer":
			return (
				only("mode", "customUrl", "apiUrl") &&
				(value.mode === "cloud" || value.mode === "local") &&
				typeof value.customUrl === "string" &&
				value.customUrl.length <= 2048 &&
				typeof value.apiUrl === "string" &&
				value.apiUrl.length <= 2048
			);
		case "removeServer":
		case "refreshWorkspaces":
		case "grantConsent":
		case "revokeConsent":
		case "clearToken":
			return only("serverKey") && text("serverKey");
		case "setServerEnabled":
			return only("serverKey", "enabled") && text("serverKey") && typeof value.enabled === "boolean";
		case "setCredentialSource":
			return only("serverKey", "source") && text("serverKey") && (MULTICA_CREDENTIAL_SOURCES as readonly unknown[]).includes(value.source);
		case "setToken":
			return only("serverKey", "token") && text("serverKey") && text("token", 4096);
		case "setWorkspaceWatch":
			return only("serverKey", "workspaceId", "watch") && text("serverKey") && text("workspaceId", 80) && typeof value.watch === "boolean";
		case "setMaxSockets":
			return only("value") && typeof value.value === "number" && Number.isInteger(value.value) && value.value >= 1 && value.value <= MULTICA_MAX_SOCKETS;
		default:
			return false;
	}
}

export function isOpenMulticaIssueRequest(value: unknown): value is { serverKey: string; workspaceSlug: string; identifier: string } {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		typeof value.serverKey === "string" &&
		typeof value.workspaceSlug === "string" &&
		typeof value.identifier === "string"
	);
}
