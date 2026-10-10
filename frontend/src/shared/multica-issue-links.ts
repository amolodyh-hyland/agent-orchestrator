// Shared contract and pure helpers for links between Multica issues and AO
// sessions. Kept free of Electron and DOM types for main, preload and renderer.

export const MULTICA_LINKS_LIST_CHANNEL = "multicaLinks:list";
export const MULTICA_LINKS_ADD_CHANNEL = "multicaLinks:add";
export const MULTICA_LINKS_REMOVE_CHANNEL = "multicaLinks:remove";
export const MULTICA_LINKS_OPEN_ISSUE_CHANNEL = "multicaLinks:openIssue";
export const MULTICA_LINKS_CHANGED_CHANNEL = "multicaLinks:changed";
export const MULTICA_LINKS_OPEN_SESSION_CHANNEL = "multicaLinks:openSession";

/** Mirrors STANDALONE_WORKSPACE_ID in renderer/types/workspace.ts. */
export const STANDALONE_PROJECT_ID = "__standalone__";
export const MAX_MULTICA_ISSUE_LINKS = 1000;
/** Version 2 adds the stable ids of the issue; version 1 files are still read. */
export const MULTICA_ISSUE_LINKS_FILE_VERSION = 2;

export type MulticaIssueLink = {
	sessionId: string;
	projectId: string;
	workspaceSlug: string;
	issueIdentifier: string;
	createdAt: string;
	/** Key of the Multica server the issue lives on (`MulticaServer.key`). Absent on links made before servers could be switched. */
	serverKey?: string;
	/**
	 * UUIDs of the issue's workspace and of the issue, filled in the first time the issue is read
	 * (version 2). The slug and identifier can change; these cannot. Both are present or neither is.
	 */
	workspaceId?: string;
	issueId?: string;
};

export type MulticaIssueRef = { workspaceSlug: string; issueIdentifier: string };
export type MulticaIssueLinkAddRequest = { sessionId: string; projectId: string; issue: string };
export type MulticaIssueLinkAddResult =
	| { ok: true; links: MulticaIssueLink[] }
	| { ok: false; reason: "invalid_issue" | "invalid_session" | "save_failed" };
export type MulticaIssueLinkRemoveRequest = { sessionId: string; workspaceSlug: string; issueIdentifier: string };
export type MulticaIssueLinkOpenRequest = MulticaIssueRef;
export type MulticaOpenSessionTarget = { projectId: string; sessionId: string };
export type MulticaLinksBridge = {
	list: () => Promise<MulticaIssueLink[]>;
	add: (request: MulticaIssueLinkAddRequest) => Promise<MulticaIssueLinkAddResult>;
	remove: (request: MulticaIssueLinkRemoveRequest) => Promise<MulticaIssueLink[]>;
	openIssue: (request: MulticaIssueLinkOpenRequest) => Promise<boolean>;
	onChanged: (listener: (links: MulticaIssueLink[]) => void) => () => void;
	onOpenSession: (listener: (target: MulticaOpenSessionTarget) => void) => () => void;
};

const ISSUE_IDENTIFIER_PATTERN = "[A-Za-z0-9]{1,10}-[1-9][0-9]{0,8}";
const UPPERCASE_ISSUE_IDENTIFIER_PATTERN = ISSUE_IDENTIFIER_PATTERN.replace("A-Za-z0-9", "A-Z0-9");
const ISSUE_IDENTIFIER = new RegExp(`^${ISSUE_IDENTIFIER_PATTERN}$`);
const UPPERCASE_ISSUE_IDENTIFIER = new RegExp(`^${UPPERCASE_ISSUE_IDENTIFIER_PATTERN}$`);
const MULTICA_ISSUE_PATH_PATTERN = new RegExp(`^/([a-z0-9][a-z0-9_-]{0,62})/issues/${UPPERCASE_ISSUE_IDENTIFIER_PATTERN}$`);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AO_SESSION_PREFIX = "ao://sessions/";

/** Parses a Multica issue URL, path or workspace-relative route. */
export function parseMulticaIssueRef(input: unknown): MulticaIssueRef | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	if (!trimmed || trimmed.length > 2048) return null;

	let path: string;
	if (/^https?:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
		path = url.pathname;
	} else {
		if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null;
		const suffixIndex = trimmed.search(/[?#]/);
		path = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
	}

	if (path.endsWith("/")) path = path.slice(0, -1);
	const segments = path.split("/");
	if (segments[0] === "") segments.shift();
	if (segments.length !== 3) return null;

	let [rawSlug, rawSection, rawIdentifier] = segments;
	try {
		rawSlug = decodeURIComponent(rawSlug);
		rawSection = decodeURIComponent(rawSection);
		rawIdentifier = decodeURIComponent(rawIdentifier);
	} catch {
		return null;
	}
	if (rawSection !== "issues") return null;
	const workspaceSlug = rawSlug.toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workspaceSlug) || !ISSUE_IDENTIFIER.test(rawIdentifier)) return null;
	return { workspaceSlug, issueIdentifier: rawIdentifier.toUpperCase() };
}

export function multicaIssuePath(ref: MulticaIssueRef): string {
	return `/${ref.workspaceSlug}/issues/${ref.issueIdentifier}`;
}

export function isMulticaIssuePath(path: unknown): boolean {
	if (typeof path !== "string") return false;
	return MULTICA_ISSUE_PATH_PATTERN.test(path);
}

export function parseMulticaIssueTitle(title: unknown): string | null {
	if (typeof title !== "string") return null;
	const titlePattern = new RegExp(`^(${ISSUE_IDENTIFIER_PATTERN}): `);
	const match = titlePattern.exec(title);
	return match ? match[1].toUpperCase() : null;
}

export function aoSessionUrl(projectId: string, sessionId: string): string {
	return `${AO_SESSION_PREFIX}${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`;
}

export function parseAoSessionUrl(url: unknown): MulticaOpenSessionTarget | null {
	if (typeof url !== "string" || !url.startsWith(AO_SESSION_PREFIX) || url.includes("?") || url.includes("#")) return null;
	const segments = url.slice(AO_SESSION_PREFIX.length).split("/");
	if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) return null;
	try {
		const [projectId, sessionId] = segments.map(decodeURIComponent);
		if (!projectId.trim() || !sessionId.trim() || projectId.includes("/") || sessionId.includes("/")) return null;
		return { projectId, sessionId };
	} catch {
		return null;
	}
}

export function isMulticaIssueLink(value: unknown): value is MulticaIssueLink {
	if (!value || typeof value !== "object") return false;
	const link = value as Record<string, unknown>;
	if (!isSessionIdentifier(link.sessionId) || !isSessionIdentifier(link.projectId)) return false;
	if (typeof link.workspaceSlug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(link.workspaceSlug)) return false;
	if (typeof link.issueIdentifier !== "string" || !UPPERCASE_ISSUE_IDENTIFIER.test(link.issueIdentifier)) return false;
	if (link.serverKey !== undefined && !isServerKey(link.serverKey)) return false;
	if ((link.workspaceId === undefined) !== (link.issueId === undefined)) return false;
	if (link.workspaceId !== undefined && (!isMulticaUuid(link.workspaceId) || !isMulticaUuid(link.issueId))) return false;
	return typeof link.createdAt === "string" && !Number.isNaN(Date.parse(link.createdAt));
}

/** The links that belong to one server, or to none yet (made before servers could be switched). */
export function linksForServer(links: MulticaIssueLink[], serverKey: string): MulticaIssueLink[] {
	return links.filter((link) => link.serverKey === serverKey);
}

export function coerceMulticaIssueLinks(raw: unknown): MulticaIssueLink[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const file = raw as Record<string, unknown>;
	// Version 1 has no issue ids; they are added in place the first time an issue is read.
	if ((file.version !== 1 && file.version !== MULTICA_ISSUE_LINKS_FILE_VERSION) || !Array.isArray(file.links)) return [];

	const links: MulticaIssueLink[] = [];
	const seen = new Set<string>();
	for (const entry of file.links) {
		// A damaged id pair must not cost the user the link: drop the ids, keep the link.
		const value = withoutInvalidIds(entry);
		if (!isMulticaIssueLink(value)) continue;
		const key = JSON.stringify([value.sessionId, value.workspaceSlug, value.issueIdentifier, value.serverKey ?? null]);
		if (seen.has(key)) continue;
		seen.add(key);
		links.push({
			sessionId: value.sessionId,
			projectId: value.projectId,
			workspaceSlug: value.workspaceSlug,
			issueIdentifier: value.issueIdentifier,
			createdAt: value.createdAt,
			...(value.serverKey !== undefined ? { serverKey: value.serverKey } : {}),
			...(value.workspaceId !== undefined && value.issueId !== undefined ? { workspaceId: value.workspaceId, issueId: value.issueId } : {}),
		});
	}
	return links.length > MAX_MULTICA_ISSUE_LINKS ? links.slice(-MAX_MULTICA_ISSUE_LINKS) : links;
}

function withoutInvalidIds(entry: unknown): unknown {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
	const { workspaceId, issueId, ...rest } = entry as Record<string, unknown>;
	return isMulticaUuid(workspaceId) && isMulticaUuid(issueId) ? entry : rest;
}

export function isMulticaUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function isServerKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 300 && !CONTROL_CHARACTERS.test(value);
}

function isSessionIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim().length > 0 &&
		!value.includes("/") &&
		!CONTROL_CHARACTERS.test(value)
	);
}
