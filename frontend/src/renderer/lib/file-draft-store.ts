// Unsaved file edits outlive the pane that holds them: leaving a session (a board route, Back,
// Forward) unmounts the editor, and the draft comes back when the file is reopened. Only a save
// or an explicit discard clears an entry, and a save only clears the revision it saved.
//
// Every edited file keeps a small record (base fingerprint, revision, why its text is missing)
// whether or not its text could be retained: the limits below apply to the text only, so a save
// is always checked against the fingerprint the edit started from.
export type UnstoredDraftReason = "size" | "capacity";

export type FileDraft = {
	/** The draft text; null when it was too large or there was no room to keep it. */
	content: string | null;
	/** Why the text is not kept, or null when it is. */
	reason: UnstoredDraftReason | null;
	/** The saved file's fingerprint the draft was started from; a save sends it as the expected one. */
	baseFingerprint: string | undefined;
	/** Bumped by every write, so a finished save can tell whether newer edits arrived meanwhile. */
	revision: number;
};

/** A draft larger than this is not kept past its pane. */
export const MAX_FILE_DRAFT_CHARS = 1_000_000;
/** Beyond these, a new draft's text is refused; texts already kept are never dropped to make room. */
export const MAX_FILE_DRAFTS = 20;
export const MAX_FILE_DRAFT_TOTAL_CHARS = 4_000_000;

/** A base that matches no file: a save sent with it always takes the normal conflict path. */
export const UNKNOWN_FILE_BASE = "\u0000unknown-base";

const records = new Map<string, FileDraft>();
let revisionCounter = 0;

const SEPARATOR = "\u0000";

export function cloudDraftSessionKey(orgId: string, sessionId: string): string {
	return `cloud:${orgId}:${sessionId}`;
}

function draftKey(sessionKey: string, path: string): string {
	return `${sessionKey}${SEPARATOR}${path}`;
}

export function getFileDraft(sessionKey: string, path: string | null | undefined): FileDraft | undefined {
	return path ? records.get(draftKey(sessionKey, path)) : undefined;
}

/**
 * Records the edit in progress. The record (base fingerprint, revision) is always kept; the text
 * is kept unless it is too large or would pass the count or total limit, in which case the
 * record says why and its older text is dropped (it would restore stale). Other files' texts are
 * never dropped to make room. `content: null` clears the record. Returns the new revision.
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
		records.delete(key);
		return null;
	}
	const existing = records.get(key);
	let othersWithText = 0;
	let othersChars = 0;
	for (const [otherKey, record] of records) {
		if (otherKey === key || record.content === null) continue;
		othersWithText += 1;
		othersChars += record.content.length;
	}
	let reason: UnstoredDraftReason | null = null;
	if (content.length > MAX_FILE_DRAFT_CHARS) reason = "size";
	else if (othersWithText + 1 > MAX_FILE_DRAFTS || othersChars + content.length > MAX_FILE_DRAFT_TOTAL_CHARS) reason = "capacity";
	const revision = ++revisionCounter;
	records.delete(key);
	records.set(key, {
		content: reason ? null : content,
		reason,
		baseFingerprint: existing?.baseFingerprint ?? baseFingerprint,
		revision,
	});
	return revision;
}

/** Why this file's draft text could not be kept, or null when it is kept (or not being edited). */
export function unstoredFileDraftReasonFor(sessionKey: string, path: string | null | undefined): UnstoredDraftReason | null {
	return getFileDraft(sessionKey, path)?.reason ?? null;
}

/** Clears the record only if no edit has been written since `revision` (a finished save's). */
export function clearFileDraftIfRevision(sessionKey: string, path: string | null | undefined, revision: number | undefined): void {
	if (!path || revision === undefined) return;
	const key = draftKey(sessionKey, path);
	if (records.get(key)?.revision === revision) records.delete(key);
}

/** After a save moved the file to `to`, newer edits typed on top of it are based on it. */
export function rebaseFileDraft(sessionKey: string, path: string | null | undefined, from: string | undefined, to: string | undefined): void {
	if (!path) return;
	const key = draftKey(sessionKey, path);
	const record = records.get(key);
	if (record && record.baseFingerprint === from) records.set(key, { ...record, baseFingerprint: to });
}

/** Files whose text is kept, to be reopened when the session view mounts again. */
export function draftedFilePaths(sessionKey: string): string[] {
	const prefix = `${sessionKey}${SEPARATOR}`;
	return [...records].filter(([key, record]) => key.startsWith(prefix) && record.content !== null).map(([key]) => key.slice(prefix.length));
}

/** Drops every record of a session (and its artifact variant) once the session is gone. */
export function clearSessionFileDrafts(sessionKey: string): void {
	for (const key of [...records.keys()]) {
		if (key.startsWith(`${sessionKey}${SEPARATOR}`) || key.startsWith(`${sessionKey}:`)) records.delete(key);
	}
}

export function resetFileDraftsForTests(): void {
	records.clear();
	revisionCounter = 0;
}
