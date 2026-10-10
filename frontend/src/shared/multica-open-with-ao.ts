import { MULTICA_STATUS_TONES, MULTICA_STATUS_TONE_ORDER, type MulticaStatusTone } from "./multica-session-status";
import type { MulticaSyncLinkView, MulticaSyncReason } from "./multica-status-sync";

export const MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL = "multicaOpenWithAo:publish";
export const OPEN_WITH_AO_ACTION_PREFIX = "ao://multica/open-with-ao/";
// This is the single place to rename the Open in AO control.
export const OPEN_WITH_AO_LABEL = "Open in AO";
// Fixed cap for about 10 rows of 28px in the dropdown and every submenu; panels scroll inside and clamp to the viewport.
export const MENU_MAX_HEIGHT_PX = 283;
// Hairline border, ring, and separator width on standard-density displays.
export const MENU_BORDER_WIDTH = "1px";
// Hairline border, ring, and separator width on displays with >= 2 device pixels per CSS pixel.
export const MENU_BORDER_WIDTH_HIDPI = "0.5px";
// Share of the Multica border token kept by the border color mix; the rest is transparent.
export const MENU_BORDER_COLOR_MIX_PERCENT = 55;
// Dropdown option text size, independent of page token lookups.
export const OPTION_FONT_SIZE = "12px";
// Dropdown option text weight.
export const OPTION_FONT_WEIGHT = "400";
// Dropdown option line box height.
export const OPTION_LINE_HEIGHT = "16px";
// Vertical padding for 28px dropdown rows with the option line height.
export const OPTION_PADDING_Y = "6px";
export const OPEN_WITH_AO_STYLE = {
	borderWidth: MENU_BORDER_WIDTH,
	borderWidthHiDpi: MENU_BORDER_WIDTH_HIDPI,
	borderColorMixPercent: MENU_BORDER_COLOR_MIX_PERCENT,
	menuFontSize: OPTION_FONT_SIZE,
	menuFontWeight: OPTION_FONT_WEIGHT,
	menuLineHeight: OPTION_LINE_HEIGHT,
	menuRowPaddingY: OPTION_PADDING_Y,
	menuStateFontSize: "11px",
	menuLabelFontSize: "11px",
	menuMaxHeightPx: MENU_MAX_HEIGHT_PX,
} as const;
export type OpenWithAoStyleTokens = {
	[K in keyof typeof OPEN_WITH_AO_STYLE]: (typeof OPEN_WITH_AO_STYLE)[K] extends number ? number : string;
};
export const MAX_OPEN_WITH_AO_PROJECTS = 50;
export const MAX_OPEN_WITH_AO_SESSIONS = 40;
export const MAX_OPEN_WITH_AO_ID = 200;
export const MAX_OPEN_WITH_AO_NAME = 100;
export const MAX_OPEN_WITH_AO_STATE_LABEL = 60;
export const MAX_OPEN_WITH_AO_DETAIL = 240;
export const OPEN_WITH_AO_DAEMON_STATES = ["ready", "starting", "stopped", "error"] as const;
export type OpenWithAoDaemonState = (typeof OPEN_WITH_AO_DAEMON_STATES)[number];

export type OpenWithAoSession = {
	id: string;
	projectId: string;
	label: string;
	tone: MulticaStatusTone;
	stateLabel: string;
	detail: string;
	stale: boolean;
	terminated: boolean;
	updatedAt: number;
};
export type OpenWithAoProject = {
	id: string;
	name: string;
	orchestrator: OpenWithAoSession | null;
	sessions: OpenWithAoSession[];
	moreCount: number;
};
export type OpenWithAoSnapshot = { daemon: OpenWithAoDaemonState; stale: boolean; projects: OpenWithAoProject[] };
export type OpenWithAoPublishResult = { ok: boolean };
export type AoMulticaOpenWithAoBridge = { publish: (snapshot: OpenWithAoSnapshot) => Promise<OpenWithAoPublishResult> };

const SNAPSHOT_KEYS = ["daemon", "stale", "projects"];
const PROJECT_KEYS = ["id", "name", "orchestrator", "sessions", "moreCount"];
const SESSION_KEYS = ["id", "projectId", "label", "tone", "stateLabel", "detail", "stale", "terminated", "updatedAt"];
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

export function isOpenWithAoSnapshot(value: unknown): value is OpenWithAoSnapshot {
	if (!isPlainObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return false;
	const snapshot = value as Record<string, unknown>;
	if (
			typeof snapshot.daemon !== "string" ||
				!OPEN_WITH_AO_DAEMON_STATES.includes(snapshot.daemon as OpenWithAoDaemonState) ||
			typeof snapshot.stale !== "boolean" ||
				!Array.isArray(snapshot.projects) ||
				!isDenseArray(snapshot.projects) ||
				snapshot.projects.length > MAX_OPEN_WITH_AO_PROJECTS
	) {
		return false;
	}

	const seenProjectIds = new Set<string>();
	const seenSessionIds = new Set<string>();
	for (const value of snapshot.projects) {
		if (!isPlainObject(value) || !hasExactKeys(value, PROJECT_KEYS)) return false;
		const project = value as Record<string, unknown>;
		if (
			typeof project.id !== "string" ||
				!isBoundedText(project.id, 1, MAX_OPEN_WITH_AO_ID) ||
				seenProjectIds.has(project.id) ||
				typeof project.name !== "string" ||
				!isBoundedText(project.name, 1, MAX_OPEN_WITH_AO_NAME) ||
				!Array.isArray(project.sessions) ||
				!isDenseArray(project.sessions) ||
				project.sessions.length > MAX_OPEN_WITH_AO_SESSIONS ||
				!Number.isSafeInteger(project.moreCount) ||
				(project.moreCount as number) < 0 ||
				(project.orchestrator !== null && !isPlainObject(project.orchestrator))
		) {
			return false;
		}
		seenProjectIds.add(project.id);

		if (project.orchestrator !== null) {
			if (!isOpenWithAoSession(project.orchestrator, project.id, seenSessionIds)) return false;
		}
		for (const session of project.sessions) {
			if (!isOpenWithAoSession(session, project.id, seenSessionIds)) return false;
		}
	}
	return true;
}

function isOpenWithAoSession(value: unknown, projectId: string, seenSessionIds: Set<string>): value is OpenWithAoSession {
	if (!isPlainObject(value) || !hasExactKeys(value, SESSION_KEYS)) return false;
	const session = value as Record<string, unknown>;
	if (
		typeof session.id !== "string" ||
			!isBoundedText(session.id, 1, MAX_OPEN_WITH_AO_ID) ||
			seenSessionIds.has(session.id) ||
		typeof session.projectId !== "string" ||
			session.projectId !== projectId ||
		typeof session.label !== "string" ||
			!isBoundedText(session.label, 1, MAX_OPEN_WITH_AO_NAME) ||
		typeof session.tone !== "string" ||
			!MULTICA_STATUS_TONES.includes(session.tone as MulticaStatusTone) ||
		typeof session.stateLabel !== "string" ||
			!isBoundedText(session.stateLabel, 1, MAX_OPEN_WITH_AO_STATE_LABEL) ||
		typeof session.detail !== "string" ||
			!isBoundedText(session.detail, 0, MAX_OPEN_WITH_AO_DETAIL) ||
		typeof session.stale !== "boolean" ||
		typeof session.terminated !== "boolean" ||
			!Number.isSafeInteger(session.updatedAt) ||
			(session.updatedAt as number) < 0
	) {
		return false;
	}
	seenSessionIds.add(session.id);
	return true;
}

function isBoundedText(value: string, min: number, max: number): boolean {
	const length = codePointLength(value);
	return length >= min && length <= max;
}

function codePointLength(value: string): number {
	return Array.from(value).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: object, expected: string[]): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isDenseArray(value: unknown[]): boolean {
	const keys = new Set(Reflect.ownKeys(value));
	if (keys.size !== value.length + 1 || !keys.has("length")) return false;
	for (let index = 0; index < value.length; index += 1) {
		if (!keys.has(String(index))) return false;
	}
	return true;
}

export const OPEN_WITH_AO_SYNC_ACTIONS = ["enable", "disable", "resume"] as const;
export type OpenWithAoSyncAction = (typeof OPEN_WITH_AO_SYNC_ACTIONS)[number];

export type OpenWithAoAction =
	| { kind: "open"; projectId: string; sessionId: string; nonce: string; workspaceSlug?: string }
	| { kind: "new-task"; projectId: string; nonce: string }
	| { kind: "sync"; syncAction: OpenWithAoSyncAction; projectId: string; sessionId: string; nonce: string };

const OPEN_WITH_AO_WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isOpenWithAoNonce(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9-]{16,64}$/.test(value);
}

export function buildOpenWithAoActionUrl(action: OpenWithAoAction): string {
	if (!isOpenWithAoNonce(action.nonce) || !isValidActionId(action.projectId)) throw new Error("invalid open-with-ao action");
	try {
		if (action.kind === "open" && isValidActionId(action.sessionId)) {
			if (action.workspaceSlug !== undefined && !isValidOpenWithAoWorkspaceSlug(action.workspaceSlug)) {
				throw new Error("invalid open-with-ao action");
			}
			const workspaceQuery = action.workspaceSlug === undefined ? "" : `&w=${encodeURIComponent(action.workspaceSlug)}`;
			return `${OPEN_WITH_AO_ACTION_PREFIX}open/${encodeURIComponent(action.projectId)}/${encodeURIComponent(action.sessionId)}?n=${action.nonce}${workspaceQuery}`;
		}
		if (action.kind === "new-task") {
			return `${OPEN_WITH_AO_ACTION_PREFIX}new-task/${encodeURIComponent(action.projectId)}?n=${action.nonce}`;
		}
		if (action.kind === "sync" && isValidActionId(action.sessionId) && (OPEN_WITH_AO_SYNC_ACTIONS as readonly string[]).includes(action.syncAction)) {
			return `${OPEN_WITH_AO_ACTION_PREFIX}sync/${action.syncAction}/${encodeURIComponent(action.projectId)}/${encodeURIComponent(action.sessionId)}?n=${action.nonce}`;
		}
	} catch {
		throw new Error("invalid open-with-ao action");
	}
	throw new Error("invalid open-with-ao action");
}

export function parseOpenWithAoActionUrl(url: unknown): OpenWithAoAction | null {
	if (typeof url !== "string" || !url.startsWith(OPEN_WITH_AO_ACTION_PREFIX) || url.includes("#")) return null;
	const queryIndex = url.indexOf("?");
	if (queryIndex === -1) return null;
	const path = url.slice(OPEN_WITH_AO_ACTION_PREFIX.length, queryIndex);
	const query = url.slice(queryIndex + 1);
	const queryMatch = /^n=([A-Za-z0-9-]{16,64})(?:&w=([a-z0-9][a-z0-9_-]{0,62}))?$/.exec(query);
	if (!queryMatch || !isOpenWithAoNonce(queryMatch[1])) return null;
	const workspaceSlug = queryMatch[2];

	const segments = path.split("/");
	if (segments.some((segment) => segment.length === 0)) return null;
	if (segments[0] === "open" && segments.length === 3) {
		const projectId = decodeActionId(segments[1]);
		const sessionId = decodeActionId(segments[2]);
		if (projectId === null || sessionId === null) return null;
		return {
			kind: "open",
			projectId,
			sessionId,
			nonce: queryMatch[1],
			...(workspaceSlug === undefined ? {} : { workspaceSlug }),
		};
	}
	if (segments[0] === "sync" && segments.length === 4) {
		if (workspaceSlug !== undefined) return null;
		const syncAction = segments[1];
		if (!(OPEN_WITH_AO_SYNC_ACTIONS as readonly string[]).includes(syncAction)) return null;
		const projectId = decodeActionId(segments[2]);
		const sessionId = decodeActionId(segments[3]);
		if (projectId === null || sessionId === null) return null;
		return { kind: "sync", syncAction: syncAction as OpenWithAoSyncAction, projectId, sessionId, nonce: queryMatch[1] };
	}
	if (segments[0] === "new-task" && segments.length === 2) {
		if (workspaceSlug !== undefined) return null;
		const projectId = decodeActionId(segments[1]);
		if (projectId === null) return null;
		return { kind: "new-task", projectId, nonce: queryMatch[1] };
	}
	return null;
}

function isValidOpenWithAoWorkspaceSlug(value: unknown): value is string {
	return typeof value === "string" && OPEN_WITH_AO_WORKSPACE_SLUG_PATTERN.test(value);
}

function decodeActionId(value: string): string | null {
	try {
		const decoded = decodeURIComponent(value);
		return isValidActionId(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

function isValidActionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
			value.trim().length > 0 &&
			!value.includes("/") &&
			!CONTROL_CHARACTERS.test(value) &&
			codePointLength(value) <= MAX_OPEN_WITH_AO_ID
	);
}

export type OpenWithAoDeduction = { projectId: string | null; reason: "linked" | "only-project" | null };

export function deduceOpenWithAoProject(input: { linkedProjectIds: readonly string[]; eligibleProjectIds: readonly string[] }): OpenWithAoDeduction {
	const eligibleProjectIds = new Set(input.eligibleProjectIds);
	const linkedProjectIds = new Set(input.linkedProjectIds);
	if (linkedProjectIds.size > 1) return { projectId: null, reason: null };
	if (linkedProjectIds.size === 1) {
		const projectId = linkedProjectIds.values().next().value ?? null;
		if (projectId !== null && eligibleProjectIds.has(projectId)) return { projectId, reason: "linked" };
	}
	if (eligibleProjectIds.size === 1) return { projectId: eligibleProjectIds.values().next().value ?? null, reason: "only-project" };
	return { projectId: null, reason: null };
}

export function sortOpenWithAoSessions<T extends { id: string; tone: MulticaStatusTone; terminated: boolean; updatedAt: number }>(
	sessions: readonly T[],
	linkedSessionIds: ReadonlySet<string>,
): T[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => {
			const leftLinked = linkedSessionIds.has(left.session.id);
			const rightLinked = linkedSessionIds.has(right.session.id);
			if (leftLinked !== rightLinked) return leftLinked ? -1 : 1;
			if (left.session.terminated !== right.session.terminated) return left.session.terminated ? 1 : -1;
			const toneOrder = MULTICA_STATUS_TONE_ORDER[left.session.tone] - MULTICA_STATUS_TONE_ORDER[right.session.tone];
			if (toneOrder !== 0) return toneOrder;
			if (left.session.updatedAt !== right.session.updatedAt) return right.session.updatedAt - left.session.updatedAt;
			const idOrder = compareStrings(left.session.id, right.session.id);
			return idOrder !== 0 ? idOrder : left.index - right.index;
		})
		.map(({ session }) => session);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** One info row above the projects: who is working the issue now. Built in the main process from the awareness read model. */
export type OpenWithAoExecutorLine = { display: "ao" | "multica-agent" | "human" | "contested"; text: string };
export const MAX_OPEN_WITH_AO_EXECUTOR_TEXT = 160;

/** The status-sync row shown under a linked session: what it says and what a click does. English, like the rest of the page menu. */
export type OpenWithAoSyncView = {
	tone: MulticaStatusTone;
	label: string;
	stateLabel: string;
	action: OpenWithAoSyncAction | null;
};
export type OpenWithAoSyncInput = { enabled: boolean; killSwitch: boolean; views: readonly MulticaSyncLinkView[] };

export type OpenWithAoPageSession = OpenWithAoSession & { linked: boolean; sync?: OpenWithAoSyncView | null };
export type OpenWithAoPageProject = {
	id: string;
	name: string;
	linked: boolean;
	orchestrator: OpenWithAoPageSession | null;
	sessions: OpenWithAoPageSession[];
	moreCount: number;
};
const SYNC_REASON_LABELS: Record<MulticaSyncReason, string> = {
	master_off: "Off in Settings",
	kill_switch: "Disabled",
	changed_in_multica: "Paused: changed in Multica",
	closed_in_multica: "Paused: closed in Multica",
	blocked_in_multica: "Paused: blocked in Multica",
	driven_by_multica: "Driven by Multica",
	triage: "In Triage",
	identity_changed: "Issue changed",
	would_start_run: "Would start a Multica run",
	secondary_link: "Updates go to the first linked ticket",
	sub_issue_parent: "Sub-issue: could wake the parent’s agent",
	signed_out: "Sign in to Multica",
	unavailable: "Open Multica to sync",
	unreachable: "Not synced, retrying",
	no_access: "No access",
	orphaned: "Issue not found",
	rate_limited: "Waiting (rate limit)",
	ao_offline: "AO offline",
};

/** One row of the page menu for the sync of a link; `view` is undefined for a link nothing is known about. */
export function buildOpenWithAoSyncView(view: MulticaSyncLinkView | undefined, input: Pick<OpenWithAoSyncInput, "enabled" | "killSwitch">): OpenWithAoSyncView {
	const on = view?.enabled === true;
	if (input.killSwitch) {
		return { tone: "unknown", label: "Ticket updates are disabled", stateLabel: "", action: on ? "disable" : null };
	}
	if (!on) {
		return input.enabled
			? { tone: "unknown", label: "Keep this ticket updated", stateLabel: "Off", action: "enable" }
			: { tone: "unknown", label: "Ticket updates are off in Settings", stateLabel: "", action: null };
	}
	const stopLabel = "Stop updating this ticket";
	if (!input.enabled) return { tone: "unknown", label: stopLabel, stateLabel: SYNC_REASON_LABELS.master_off, action: "disable" };
	const reasonLabel = view.reason === null ? "" : SYNC_REASON_LABELS[view.reason];
	switch (view.state) {
		case "synced":
			return { tone: "ready", label: stopLabel, stateLabel: "Synced", action: "disable" };
		case "pending":
			return { tone: "unknown", label: stopLabel, stateLabel: "Syncing…", action: "disable" };
		case "paused":
			return view.canResume
				? { tone: "pending", label: "Resume updating this ticket", stateLabel: reasonLabel, action: "resume" }
				: { tone: "pending", label: stopLabel, stateLabel: reasonLabel, action: "disable" };
		case "refused":
			return { tone: "pending", label: stopLabel, stateLabel: reasonLabel, action: "disable" };
		case "error":
			return {
				tone: view.reason === "rate_limited" || view.reason === "ao_offline" || view.reason === "unavailable" ? "pending" : "attention",
				label: stopLabel,
				stateLabel: reasonLabel,
				action: "disable",
			};
		default:
			return { tone: "unknown", label: stopLabel, stateLabel: "Off", action: "disable" };
	}
}

export type OpenWithAoPagePayload = {
	label: string;
	style: OpenWithAoStyleTokens;
	nonce: string;
	issue: { identifier: string; title: string } | null;
	/** Null when awareness knows nothing about the issue (not watched, or ambiguous). */
	executor: OpenWithAoExecutorLine | null;
	daemon: OpenWithAoDaemonState | "unknown";
	stale: boolean;
	deducedProjectId: string | null;
	deduction: "linked" | "only-project" | null;
	projects: OpenWithAoPageProject[];
};

export function buildOpenWithAoPagePayload(input: {
	snapshot: OpenWithAoSnapshot | null;
	links: ReadonlyArray<{ sessionId: string; issueIdentifier: string; projectId: string }>;
	issue: { identifier: string; title: string } | null;
	nonce: string;
	sync?: OpenWithAoSyncInput;
	executor?: OpenWithAoExecutorLine | null;
}): OpenWithAoPagePayload {
	const executor = input.executor ?? null;
	if (input.snapshot === null) {
		return {
			label: OPEN_WITH_AO_LABEL,
			style: OPEN_WITH_AO_STYLE,
			nonce: input.nonce,
			issue: input.issue,
			executor,
			daemon: "unknown",
			stale: false,
			deducedProjectId: null,
			deduction: null,
			projects: [],
		};
	}

	const issueLinks = input.issue === null ? [] : input.links.filter((link) => link.issueIdentifier === input.issue?.identifier);
	const linkedSessionIds = new Set(issueLinks.map((link) => link.sessionId));
	const orchestratorIds = new Set(
		input.snapshot.projects.flatMap((project) => (project.orchestrator === null ? [] : [project.orchestrator.id])),
	);
	const linkedProjectIds = new Set(issueLinks.filter((link) => !orchestratorIds.has(link.sessionId)).map((link) => link.projectId));
	const projects = input.snapshot.projects.map((project): OpenWithAoPageProject => {
		const linkedWorkerIds = new Set(project.sessions.filter((session) => linkedSessionIds.has(session.id)).map((session) => session.id));
		const sessions = sortOpenWithAoSessions(project.sessions, linkedSessionIds).map((session) => ({
			...session,
			linked: linkedWorkerIds.has(session.id),
			sync:
				input.sync !== undefined && input.issue !== null && linkedWorkerIds.has(session.id)
					? buildOpenWithAoSyncView(
							input.sync.views.find((view) => view.sessionId === session.id && view.issueIdentifier === input.issue?.identifier),
							input.sync,
						)
					: null,
		}));
		return {
			id: project.id,
			name: project.name,
			linked: linkedProjectIds.has(project.id),
			orchestrator: project.orchestrator === null ? null : { ...project.orchestrator, linked: false, sync: null },
			sessions,
			moreCount: project.moreCount,
		};
	});
	projects.sort((left, right) => {
		if (left.linked !== right.linked) return left.linked ? -1 : 1;
		const nameOrder = left.name.localeCompare(right.name, "en", { sensitivity: "base" });
		return nameOrder !== 0 ? nameOrder : compareStrings(left.id, right.id);
	});
	const deduction = deduceOpenWithAoProject({
		linkedProjectIds: [...linkedProjectIds],
		eligibleProjectIds: projects.map((project) => project.id),
	});
	return {
		label: OPEN_WITH_AO_LABEL,
		style: OPEN_WITH_AO_STYLE,
		nonce: input.nonce,
		issue: input.issue,
		executor,
		daemon: input.snapshot.daemon,
		stale: input.snapshot.stale,
		deducedProjectId: deduction.projectId,
		deduction: deduction.reason,
		projects,
	};
}
