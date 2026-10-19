import type { InspectorView, FileDisplayMode, SettingsModal } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceDiffScope } from "../hooks/useSessionWorkspaceFiles";

const NAVIGATION_STATE_KEY = "__aoNavigation";
const NAVIGATION_STATE_VERSION = 1;
const SUPPRESSED_MULTICA_CHANGE_TTL_MS = 5000;

export type SessionNavigationTarget =
	| TerminalTarget
	| { kind: "reviewer-chat"; reviewId: string }
	| {
			kind: "file";
			path: string;
			request?: {
				commitSha?: string;
				editing: boolean;
				line?: number;
				mode: FileDisplayMode;
				scope?: WorkspaceDiffScope;
			};
	  };

export type SessionNavigationLocation = {
	sessionKey: string;
	sessionId: string;
	hostId?: string;
	target: SessionNavigationTarget;
	inspectorView: InspectorView;
	inspectorOpen: boolean;
};

export type AONavigationLocation = {
	version: typeof NAVIGATION_STATE_VERSION;
	href: string;
	settingsModal: SettingsModal | null;
	multicaActive: boolean;
	sessionView?: SessionNavigationLocation;
};

export type HistoryLocationLike = {
	href: string;
	state: Record<string, unknown>;
};

export type NavigationHistoryLike = {
	location: HistoryLocationLike;
	push: (href: string, state?: Record<string, unknown>) => void;
	replace: (href: string, state?: Record<string, unknown>) => void;
};

export type NavigationRestoreListener = (location: AONavigationLocation) => void;

const restoreListeners = new Set<NavigationRestoreListener>();
const closedTopbarSessionIds = new Set<string>();
const suppressedMulticaChanges: { active: boolean; expiresAt: number }[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function isSettingsModal(value: unknown): value is SettingsModal | null {
	return value === null || (isRecord(value) && (value.scope === "global" || value.scope === "project"));
}

function isInspectorView(value: unknown): value is InspectorView {
	return value === "summary" || value === "reviews" || value === "browser" || value === "sideChat" || value === "files" || value === "artifacts";
}

function isWorkspaceDiffScope(value: unknown): value is WorkspaceDiffScope {
	return value === "combined" || value === "committed" || value === "staged" || value === "unstaged" || value === "untracked";
}

function isSessionNavigationTarget(value: unknown): value is SessionNavigationTarget {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "worker") return true;
	if (value.kind === "reviewer") {
		return typeof value.handleId === "string" && typeof value.harness === "string" && typeof value.sessionId === "string";
	}
	if (value.kind === "shell") {
		return typeof value.handleId === "string" && typeof value.generation === "string" && typeof value.title === "string";
	}
	if (value.kind === "reviewer-chat") return typeof value.reviewId === "string";
	if (value.kind !== "file" || typeof value.path !== "string") return false;
	if (value.request === undefined) return true;
	return isRecord(value.request) && typeof value.request.editing === "boolean" &&
		(value.request.commitSha === undefined || typeof value.request.commitSha === "string") &&
		(value.request.line === undefined || typeof value.request.line === "number") &&
		(value.request.mode === "diff" || value.request.mode === "file" || value.request.mode === "rendered") &&
		(value.request.scope === undefined || isWorkspaceDiffScope(value.request.scope));
}

function isSessionNavigationLocation(value: unknown): value is SessionNavigationLocation {
	return isRecord(value) &&
		typeof value.sessionKey === "string" &&
		typeof value.sessionId === "string" &&
		(value.hostId === undefined || typeof value.hostId === "string") &&
		isSessionNavigationTarget(value.target) &&
		isInspectorView(value.inspectorView) &&
		typeof value.inspectorOpen === "boolean";
}

export function readAONavigationLocation(state: unknown): AONavigationLocation | null {
	if (!isRecord(state)) return null;
	const value = state[NAVIGATION_STATE_KEY];
	if (!isRecord(value) || value.version !== NAVIGATION_STATE_VERSION || typeof value.href !== "string") return null;
	if (!isSettingsModal(value.settingsModal) || typeof value.multicaActive !== "boolean") return null;
	const sessionView = value.sessionView;
	if (sessionView !== undefined && !isSessionNavigationLocation(sessionView)) return null;
	return {
		version: NAVIGATION_STATE_VERSION,
		href: value.href,
		settingsModal: value.settingsModal,
		multicaActive: value.multicaActive,
		...(sessionView ? { sessionView } : {}),
	};
}

export function readAONavigationLocationForHref(state: unknown, href: string): AONavigationLocation | null {
	const location = readAONavigationLocation(state);
	return location?.href === href ? location : null;
}

export function writeAONavigationLocation(
	history: NavigationHistoryLike,
	patch: Partial<Omit<AONavigationLocation, "version" | "href" | "sessionView">> & { sessionView?: SessionNavigationLocation | null },
	mode: "push" | "replace" = "push",
): boolean {
	const href = history.location.href;
	const currentForHref = readAONavigationLocationForHref(history.location.state, href);
	const current = currentForHref ?? {
		version: NAVIGATION_STATE_VERSION,
		href,
		settingsModal: null,
		multicaActive: false,
	};
	const { sessionView: sessionViewPatch, ...patchWithoutSessionView } = patch;
	const next: AONavigationLocation = {
		...current,
		...patchWithoutSessionView,
		version: NAVIGATION_STATE_VERSION,
		href,
	};
	if (sessionViewPatch === null) delete next.sessionView;
	else if (sessionViewPatch !== undefined) next.sessionView = sessionViewPatch;
	if (currentForHref && JSON.stringify(current) === JSON.stringify(next)) return false;
	const state = { ...history.location.state, [NAVIGATION_STATE_KEY]: next };
	history[mode](href, state);
	return true;
}

export function subscribeNavigationRestore(listener: NavigationRestoreListener): () => void {
	restoreListeners.add(listener);
	return () => restoreListeners.delete(listener);
}

export function notifyNavigationRestore(location: AONavigationLocation): void {
	for (const listener of restoreListeners) listener(location);
}

export function markTopbarSessionClosed(sessionId: string): void {
	closedTopbarSessionIds.add(sessionId);
}

export function markTopbarSessionOpened(sessionId: string): void {
	closedTopbarSessionIds.delete(sessionId);
}

export function isTopbarSessionClosed(sessionId: string): boolean {
	return closedTopbarSessionIds.has(sessionId);
}

export function sessionIdFromHistoryHref(href: string): string | null {
	const hashIndex = href.indexOf("#");
	const route = (hashIndex >= 0 ? href.slice(hashIndex + 1) : href).split(/[?#]/, 1)[0];
	const segments = route.split("/").filter(Boolean).map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
	const sessionIndex = Math.max(segments.lastIndexOf("session"), segments.lastIndexOf("sessions"));
	return sessionIndex >= 0 ? segments[sessionIndex + 1] ?? null : null;
}

export function historyIndex(state: unknown): number | null {
	if (!isRecord(state)) return null;
	const index = state.__TSR_index;
	return typeof index === "number" && Number.isInteger(index) ? index : null;
}

export function suppressNextMulticaHistoryChange(active: boolean): void {
	suppressedMulticaChanges.push({ active, expiresAt: Date.now() + SUPPRESSED_MULTICA_CHANGE_TTL_MS });
}

export function consumeSuppressedMulticaHistoryChange(active: boolean): boolean {
	const now = Date.now();
	for (let index = suppressedMulticaChanges.length - 1; index >= 0; index -= 1) {
		const pending = suppressedMulticaChanges[index];
		if (pending.expiresAt <= now) {
			suppressedMulticaChanges.splice(index, 1);
			continue;
		}
		if (pending.active !== active) continue;
		suppressedMulticaChanges.splice(index, 1);
		return true;
	}
	return false;
}

let unsavedLeaveGuard: (() => string | null) | null = null;
let knownHistoryTip: number | null = null;

/** Registers the check that says whether leaving the current view would lose unsaved edits. */
export function setUnsavedLeaveGuard(guard: (() => string | null) | null): () => void {
	unsavedLeaveGuard = guard;
	return () => {
		if (unsavedLeaveGuard === guard) unsavedLeaveGuard = null;
	};
}

export function confirmLeaveUnsavedWork(): boolean {
	const message = unsavedLeaveGuard?.();
	return message ? window.confirm(message) : true;
}

/** The shell's sync reports the highest entry reachable with Forward; null while unknown. */
export function reportHistoryTip(tip: number | null): void {
	knownHistoryTip = tip;
}

type TraversableHistory = { location: { state: unknown }; back: () => void; forward: () => void };

/**
 * Asks before the shell's own Back/Forward move, and does nothing when the history cannot move.
 * Unsaved edits survive the move (see file-draft-store); the question lets the user stay put.
 * Pops the shell did not start (mouse button, OS shortcut) simply navigate.
 */
export function traverseHistory(history: TraversableHistory, direction: "back" | "forward"): void {
	const from = historyIndex(history.location.state);
	if (from !== null) {
		if (direction === "back" ? from <= 0 : knownHistoryTip !== null && from >= knownHistoryTip) return;
	}
	if (confirmLeaveUnsavedWork()) history[direction]();
}

export function resetNavigationHistoryForTests(): void {
	unsavedLeaveGuard = null;
	knownHistoryTip = null;
	restoreListeners.clear();
	closedTopbarSessionIds.clear();
	suppressedMulticaChanges.length = 0;
}
