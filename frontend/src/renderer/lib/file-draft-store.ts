// Unsaved file edits outlive the pane that holds them: leaving a session (a board route, Back,
// Forward) unmounts the editor, and the draft comes back when the file is reopened. Only a save
// or an explicit discard clears an entry.
const drafts = new Map<string, string>();

const SEPARATOR = "\u0000";

export function cloudDraftSessionKey(orgId: string, sessionId: string): string {
	return `cloud:${orgId}:${sessionId}`;
}

function draftKey(sessionKey: string, path: string): string {
	return `${sessionKey}${SEPARATOR}${path}`;
}

export function getFileDraft(sessionKey: string, path: string | null | undefined): string | undefined {
	return path ? drafts.get(draftKey(sessionKey, path)) : undefined;
}

export function setFileDraft(sessionKey: string, path: string | null | undefined, content: string | null): void {
	if (!path) return;
	if (content === null) drafts.delete(draftKey(sessionKey, path));
	else drafts.set(draftKey(sessionKey, path), content);
}

export function draftedFilePaths(sessionKey: string): string[] {
	const prefix = `${sessionKey}${SEPARATOR}`;
	return [...drafts.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

export function resetFileDraftsForTests(): void {
	drafts.clear();
}
