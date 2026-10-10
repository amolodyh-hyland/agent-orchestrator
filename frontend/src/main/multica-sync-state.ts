import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MULTICA_SYNC_SETTINGS, isMulticaSyncLinkRef, type MulticaSyncSettings } from "../shared/multica-status-sync";
import {
	isMulticaWritableStatus,
	type LastKnownStatus,
	type MulticaWritableStatus,
	type PauseReason,
} from "../shared/multica-status-writer";

// What status sync remembers between runs, apart from the links themselves:
// the settings, which links the user turned on, and per issue the last status
// AO wrote or saw (the pause fence needs it) and whether it is paused. No
// token, title, description or any text from Multica is stored. Kept out of the
// links file so that file's contract stays as it is.

export const MULTICA_SYNC_STATE_FILE = "multica-sync-state.json";
export const MAX_MULTICA_SYNC_LINKS = 1000;
export const MAX_MULTICA_SYNC_ISSUES = 1000;

export type PersistedSyncLink = { serverKey: string; sessionId: string; workspaceSlug: string; issueIdentifier: string };

export type PersistedPause = {
	reason: PauseReason;
	/** The status AO wanted when it paused; a different one lets AO look again. */
	target: MulticaWritableStatus | null;
	/** The status key Multica showed when AO paused. */
	observedStatus: string;
	at: string;
};

/** A status write AO is about to send; kept until the answer is known, so a lost answer is still recognised as AO's own write. */
export type PersistedWriteIntent = { status: string; category: string; revBefore: number; at: string };

export type PersistedIssueState = {
	serverKey: string;
	workspaceSlug: string;
	issueIdentifier: string;
	lastKnown: LastKnownStatus | null;
	pause: PersistedPause | null;
	lastSyncAt: string | null;
	/** The issue answered 404: deleted, or moved out of reach. Writes stop until the user syncs again. */
	orphaned: boolean;
	intent?: PersistedWriteIntent | null;
};

export type MulticaSyncStateFile = {
	settings: MulticaSyncSettings;
	links: PersistedSyncLink[];
	issues: PersistedIssueState[];
};

export type MulticaSyncStateStore = {
	load: () => Promise<MulticaSyncStateFile>;
	save: (file: MulticaSyncStateFile) => Promise<void>;
};

export function emptyMulticaSyncStateFile(): MulticaSyncStateFile {
	return { settings: { ...DEFAULT_MULTICA_SYNC_SETTINGS }, links: [], issues: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

function isServerKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 300 && !CONTROL_CHARACTERS.test(value);
}

function isShortText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 200 && !CONTROL_CHARACTERS.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function coerceLastKnown(value: unknown): LastKnownStatus | null {
	if (!isRecord(value)) return null;
	if (!isShortText(value.status) || typeof value.category !== "string" || value.category.length > 200 || CONTROL_CHARACTERS.test(value.category)) return null;
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
	if ((value.source !== "write" && value.source !== "observed") || !isTimestamp(value.at)) return null;
	return { status: value.status, category: value.category, revision: value.revision, source: value.source, at: value.at };
}

function coerceIntent(value: unknown): PersistedWriteIntent | null {
	if (!isRecord(value) || !isShortText(value.status) || !isShortText(value.category)) return null;
	if (typeof value.revBefore !== "number" || !Number.isSafeInteger(value.revBefore) || value.revBefore < 1 || !isTimestamp(value.at)) return null;
	return { status: value.status, category: value.category, revBefore: value.revBefore, at: value.at };
}

function coercePause(value: unknown): PersistedPause | null {
	if (!isRecord(value)) return null;
	if (value.reason !== "changed_in_multica" && value.reason !== "closed_in_multica" && value.reason !== "blocked_in_multica") return null;
	if (value.target !== null && !isMulticaWritableStatus(value.target)) return null;
	if (!isShortText(value.observedStatus) || !isTimestamp(value.at)) return null;
	return { reason: value.reason, target: value.target, observedStatus: value.observedStatus, at: value.at };
}

export function coerceMulticaSyncStateFile(raw: unknown): MulticaSyncStateFile {
	const result = emptyMulticaSyncStateFile();
	if (!isRecord(raw) || raw.version !== 1) return result;

	if (isRecord(raw.settings)) {
		result.settings = {
			enabled: raw.settings.enabled === true,
			moveOutOfBacklog: raw.settings.moveOutOfBacklog !== false,
		};
	}

	const seenLinks = new Set<string>();
	if (Array.isArray(raw.links)) {
		for (const entry of raw.links) {
			if (!isRecord(entry) || !isServerKey(entry.serverKey) || !isMulticaSyncLinkRef(entry as unknown)) continue;
			const key = JSON.stringify([entry.serverKey, entry.sessionId, entry.workspaceSlug, entry.issueIdentifier]);
			if (seenLinks.has(key)) continue;
			seenLinks.add(key);
			result.links.push({
				serverKey: entry.serverKey,
				sessionId: entry.sessionId as string,
				workspaceSlug: entry.workspaceSlug as string,
				issueIdentifier: entry.issueIdentifier as string,
			});
		}
	}

	const seenIssues = new Set<string>();
	if (Array.isArray(raw.issues)) {
		for (const entry of raw.issues) {
			if (!isRecord(entry) || !isServerKey(entry.serverKey)) continue;
			if (!isMulticaSyncLinkRef({ sessionId: "x", workspaceSlug: entry.workspaceSlug, issueIdentifier: entry.issueIdentifier })) continue;
			const workspaceSlug = entry.workspaceSlug as string;
			const issueIdentifier = entry.issueIdentifier as string;
			const key = JSON.stringify([entry.serverKey, workspaceSlug, issueIdentifier]);
			if (seenIssues.has(key)) continue;
			seenIssues.add(key);
			result.issues.push({
				serverKey: entry.serverKey,
				workspaceSlug,
				issueIdentifier,
				lastKnown: coerceLastKnown(entry.lastKnown),
				pause: coercePause(entry.pause),
				lastSyncAt: isTimestamp(entry.lastSyncAt) ? entry.lastSyncAt : null,
				orphaned: entry.orphaned === true,
				...(coerceIntent(entry.intent) ? { intent: coerceIntent(entry.intent) } : {}),
			});
		}
	}

	result.links = result.links.slice(-MAX_MULTICA_SYNC_LINKS);
	result.issues = result.issues.slice(-MAX_MULTICA_SYNC_ISSUES);
	return result;
}

let stateOperationQueue: Promise<void> = Promise.resolve();

function runStateOperation<T>(operation: () => Promise<T>): Promise<T> {
	const queued = stateOperationQueue.then(operation, operation);
	stateOperationQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

export function createMulticaSyncStateStore(stateDir: string): MulticaSyncStateStore {
	return {
		load: () =>
			runStateOperation(async () => {
				try {
					return coerceMulticaSyncStateFile(JSON.parse(await readFile(path.join(stateDir, MULTICA_SYNC_STATE_FILE), "utf8")));
				} catch {
					return emptyMulticaSyncStateFile();
				}
			}),
		save: (file) =>
			runStateOperation(async () => {
				await mkdir(stateDir, { recursive: true, mode: 0o750 });
				const target = path.join(stateDir, MULTICA_SYNC_STATE_FILE);
				const temporary = path.join(stateDir, `.multica-sync-state-${process.pid}-${randomUUID()}.json`);
				try {
					await writeFile(temporary, `${JSON.stringify({ version: 1, ...coerceMulticaSyncStateFile({ version: 1, ...file }) }, null, 2)}\n`, {
						mode: 0o600,
					});
					await rename(temporary, target);
				} finally {
					await unlink(temporary).catch(() => undefined);
				}
			}),
	};
}
