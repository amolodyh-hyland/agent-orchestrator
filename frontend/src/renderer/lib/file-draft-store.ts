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
/** The other sessions' drafts are evicted, oldest first, beyond these. */
export const MAX_FILE_DRAFTS = 20;
export const MAX_FILE_DRAFT_TOTAL_CHARS = 4_000_000;

// Insertion order is write order: a write re-inserts its entry, so the first key is the oldest.
const drafts = new Map<string, FileDraft>();
let revisionCounter = 0;
let unstoredDrafts = new Set<string>();

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
 * Stores the draft being edited. The entry just written is never evicted; older ones are
 * dropped to fit the limits. Returns the new revision, or null when the draft is too large to
 * keep (it is then recorded as unstored so leaving can say so). `content: null` clears it.
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
	if (content.length > MAX_FILE_DRAFT_CHARS) {
		// A stale stored version must not come back as if it were the current text.
		drafts.delete(key);
		unstoredDrafts.add(key);
		return null;
	}
	unstoredDrafts.delete(key);
	const base = drafts.get(key)?.baseFingerprint ?? baseFingerprint;
	drafts.delete(key);
	const revision = ++revisionCounter;
	drafts.set(key, { content, baseFingerprint: base, revision });
	for (const oldest of drafts.keys()) {
		if (drafts.size <= MAX_FILE_DRAFTS && totalChars() <= MAX_FILE_DRAFT_TOTAL_CHARS) break;
		if (oldest === key) break;
		drafts.delete(oldest);
	}
	return revision;
}

/** True while an open draft was too large to keep: leaving would lose it. */
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
	for (const key of [...drafts.keys(), ...unstoredDrafts]) {
		if (key.startsWith(`${sessionKey}${SEPARATOR}`) || key.startsWith(`${sessionKey}:`)) {
			drafts.delete(key);
			unstoredDrafts.delete(key);
		}
	}
}

export function resetFileDraftsForTests(): void {
	drafts.clear();
	unstoredDrafts = new Set();
	revisionCounter = 0;
}
