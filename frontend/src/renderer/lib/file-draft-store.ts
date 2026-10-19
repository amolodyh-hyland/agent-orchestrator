// Unsaved file edits outlive the pane that holds them: leaving a session (a board route, Back,
// Forward) unmounts the editor, and the draft comes back when the file is reopened. Only a save
// or an explicit discard clears an entry, and a save only clears the revision it saved.
export type FileDraft = {
	content: string;
	/** The saved file's fingerprint the draft was started from; a save sends it as the expected one. */
	baseFingerprint: string | undefined;
	/** Bumped by every write, so a finished save can tell whether newer edits arrived meanwhile. */
	revision: number;
};

/** A draft larger than this is not kept past its pane. */
export const MAX_FILE_DRAFT_CHARS = 1_000_000;
/** Beyond these, a new draft is refused; drafts already kept are never dropped to make room. */
export const MAX_FILE_DRAFTS = 20;
export const MAX_FILE_DRAFT_TOTAL_CHARS = 4_000_000;

/** A base that matches no file: a save sent with it always takes the normal conflict path. */
export const UNKNOWN_FILE_BASE = "\u0000unknown-base";

export type UnstoredDraftReason = "size" | "capacity";

// Insertion order is write order: a write re-inserts its entry, so the first key is the oldest.
const drafts = new Map<string, FileDraft>();
let revisionCounter = 0;
let unstoredDrafts = new Map<string, UnstoredDraftReason>();

const SEPARATOR = "\u0000";

export function cloudDraftSessionKey(orgId: string, sessionId: string): string {
	return `cloud:${orgId}:${sessionId}`;
}

function draftKey(sessionKey: string, path: string): string {
	return `${sessionKey}${SEPARATOR}${path}`;
}

export function getFileDraft(sessionKey: string, path: string | null | undefined): FileDraft | undefined {
	return path ? drafts.get(draftKey(sessionKey, path)) : undefined;
}

function totalChars(): number {
	let total = 0;
	for (const draft of drafts.values()) total += draft.content.length;
	return total;
}

/**
 * Stores the draft being edited. A draft is never dropped to make room for another: one that is
 * too large, or that would pass the count or total limit, is refused and recorded as unstored
 * with its reason so the pane and the leave prompt can say so (its older stored version goes,
 * since it would come back stale). `content: null` clears it. Returns the new revision, or null.
 */
export function setFileDraft(
	sessionKey: string,
	path: string | null | undefined,
	content: string | null,
	baseFingerprint?: string,
): number | null {
	if (!path) return null;
	const key = draftKey(sessionKey, path);
	if (content === null) {
		drafts.delete(key);
		unstoredDrafts.delete(key);
		return null;
	}
	const existing = drafts.get(key);
	const refuse = (reason: UnstoredDraftReason): null => {
		drafts.delete(key);
		unstoredDrafts.set(key, reason);
		return null;
	};
	if (content.length > MAX_FILE_DRAFT_CHARS) return refuse("size");
	const othersCount = drafts.size - (existing ? 1 : 0);
	const othersChars = totalChars() - (existing?.content.length ?? 0);
	if (othersCount + 1 > MAX_FILE_DRAFTS || othersChars + content.length > MAX_FILE_DRAFT_TOTAL_CHARS) return refuse("capacity");
	unstoredDrafts.delete(key);
	const base = existing?.baseFingerprint ?? baseFingerprint;
	drafts.delete(key);
	const revision = ++revisionCounter;
	drafts.set(key, { content, baseFingerprint: base, revision });
	return revision;
}

/** Why an open draft could not be kept (so leaving would lose it), or null when all are kept. */
export function unstoredFileDraftReason(): UnstoredDraftReason | null {
	let reason: UnstoredDraftReason | null = null;
	for (const value of unstoredDrafts.values()) {
		if (value === "size") return "size";
		reason = value;
	}
	return reason;
}

/** Why this file's draft could not be kept, or null when it is kept (or not being edited). */
export function unstoredFileDraftReasonFor(sessionKey: string, path: string | null | undefined): UnstoredDraftReason | null {
	return path ? unstoredDrafts.get(draftKey(sessionKey, path)) ?? null : null;
}

export function hasUnstoredFileDraft(): boolean {
	return unstoredDrafts.size > 0;
}

/** Clears the draft only if no edit has been written since `revision` (a finished save's). */
export function clearFileDraftIfRevision(sessionKey: string, path: string | null | undefined, revision: number | undefined): void {
	if (!path || revision === undefined) return;
	const key = draftKey(sessionKey, path);
	if (drafts.get(key)?.revision === revision) drafts.delete(key);
}

/** After a save moved the file to `savedFingerprint`, newer edits typed on top of it are based on it. */
export function rebaseFileDraft(sessionKey: string, path: string | null | undefined, from: string | undefined, to: string | undefined): void {
	if (!path) return;
	const key = draftKey(sessionKey, path);
	const draft = drafts.get(key);
	if (draft && draft.baseFingerprint === from) drafts.set(key, { ...draft, baseFingerprint: to });
}

export function draftedFilePaths(sessionKey: string): string[] {
	const prefix = `${sessionKey}${SEPARATOR}`;
	return [...drafts.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/** Drops every draft of a session (and its artifact variant) once the session is gone. */
export function clearSessionFileDrafts(sessionKey: string): void {
	for (const key of [...drafts.keys(), ...unstoredDrafts.keys()]) {
		if (key.startsWith(`${sessionKey}${SEPARATOR}`) || key.startsWith(`${sessionKey}:`)) {
			drafts.delete(key);
			unstoredDrafts.delete(key);
		}
	}
}

export function resetFileDraftsForTests(): void {
	drafts.clear();
	unstoredDrafts = new Map();
	revisionCounter = 0;
}
