// The only module that builds Multica requests for awareness, and it builds
// GETs only. Every request goes through one allow-list of path templates and
// query names; the transport has no way to express another method. The token is
// sent only to the origin derived from the server it belongs to, redirects are
// not followed, and reads share one budget so a busy workspace cannot flood the
// server.

import { MULTICA_ISSUE_REF_SOURCE, isMulticaIssueId } from "../shared/multica-awareness";

export type ReadFailureKind =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "server_error"
	| "unreachable"
	| "timeout"
	| "redirect"
	| "bad_response"
	/** The connection was stopped while the read was queued. */
	| "cancelled";

export type ReadResult = { ok: true; data: unknown } | { ok: false; kind: ReadFailureKind; status?: number; retryAfterMs?: number };

export type WorkspaceRef = { id: string } | { slug: string };

/** What a transport is asked to fetch. There is deliberately no method field: it is always GET. */
export type ReadRequest = { path: string; query: string; workspace: WorkspaceRef | null };

export type RawResponse = { status: number; body: string; retryAfterMs?: number };

/** Performs one GET. Throws `TransportError` for a network failure, a timeout or a redirect. */
export type ReadTransport = (request: ReadRequest) => Promise<RawResponse>;

export class TransportError extends Error {
	constructor(readonly kind: "unreachable" | "timeout" | "redirect") {
		super(kind);
	}
}

// Allow-list

/** The GET path templates awareness may use (design section 7.2, phase P1). */
export const ALLOWED_READ_PATHS: readonly RegExp[] = [
	/^\/api\/me$/,
	/^\/api\/workspaces$/,
	/^\/api\/agent-task-snapshot$/,
	/^\/api\/agents$/,
	/^\/api\/runtimes$/,
	/^\/api\/issues$/,
	new RegExp(`^/api/issues/${MULTICA_ISSUE_REF_SOURCE}$`),
	new RegExp(`^/api/issues/${MULTICA_ISSUE_REF_SOURCE}/(?:task-runs|active-task)$`),
];

export const ALLOWED_QUERY_NAMES: readonly string[] = [
	"limit",
	"offset",
	"ids",
	"assignee_ids",
	"assignee_types",
	"open_only",
	"sort",
	"direction",
	"active",
	"scope",
];

const QUERY_VALUE = /^[A-Za-z0-9_,.-]{1,4000}$/;

export function isAllowedReadPath(path: string): boolean {
	return ALLOWED_READ_PATHS.some((pattern) => pattern.test(path));
}

/** True when `query` (a leading-`?` string or empty) holds only allow-listed names with plain values. */
export function isAllowedReadQuery(query: string): boolean {
	if (query === "") return true;
	if (!query.startsWith("?")) return false;
	const params = new URLSearchParams(query.slice(1));
	for (const [name, value] of params) {
		if (!ALLOWED_QUERY_NAMES.includes(name) || !QUERY_VALUE.test(value)) return false;
	}
	return true;
}

export function isAllowedReadRequest(request: ReadRequest): boolean {
	if (!isAllowedReadPath(request.path) || !isAllowedReadQuery(request.query)) return false;
	if (request.workspace === null) return request.path === "/api/me" || request.path === "/api/workspaces";
	const reference = "id" in request.workspace ? request.workspace.id : request.workspace.slug;
	return typeof reference === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(reference);
}

// Budget

export type Scheduler = {
	now: () => number;
	setTimeout: (callback: () => void, delayMs: number) => unknown;
	clearTimeout: (handle: unknown) => void;
};

export const systemScheduler: Scheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_READS_PER_MINUTE = 60;
export const DEFAULT_READ_BURST = 10;
export const MIN_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

export type ReadBudget = {
	/** Runs `task` when a read token is available. Tasks run one at a time, in order. */
	schedule: <T>(task: () => Promise<T>) => Promise<T>;
	/** Holds every queued read for `delayMs` (a 429 `Retry-After`, or a back-off after a failure). */
	pause: (delayMs: number) => void;
	/** Drops everything still queued; the pending promises reject. */
	cancel: () => void;
};

/**
 * A token bucket (`perMinute` refill, `burst` capacity) in front of a single
 * FIFO queue. Reads never overlap, so a slow server sees one request at a time.
 */
export function createReadBudget(options: { perMinute?: number; burst?: number; scheduler?: Scheduler } = {}): ReadBudget {
	const perMinute = options.perMinute ?? DEFAULT_READS_PER_MINUTE;
	const burst = options.burst ?? DEFAULT_READ_BURST;
	const scheduler = options.scheduler ?? systemScheduler;
	const refillMs = 60_000 / perMinute;
	let tokens = burst;
	let lastRefill = scheduler.now();
	let blockedUntil = 0;
	let running = false;
	let timer: unknown = null;
	let cancelled = false;
	const queue: Array<{ run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];

	const refill = (): void => {
		const now = scheduler.now();
		const gained = (now - lastRefill) / refillMs;
		if (gained >= 1) {
			tokens = Math.min(burst, tokens + Math.floor(gained));
			lastRefill += Math.floor(gained) * refillMs;
			// A full bucket earns no credit while idle.
			if (tokens >= burst) lastRefill = now;
		}
	};

	const pump = (): void => {
		if (running || timer !== null || queue.length === 0) return;
		refill();
		const now = scheduler.now();
		const wait = Math.max(blockedUntil - now, tokens >= 1 ? 0 : lastRefill + refillMs - now);
		if (wait > 0) {
			timer = scheduler.setTimeout(() => {
				timer = null;
				pump();
			}, wait);
			return;
		}
		const next = queue.shift();
		if (!next) return;
		tokens -= 1;
		running = true;
		next.run().then(next.resolve, next.reject).finally(() => {
			running = false;
			pump();
		});
	};

	return {
		schedule: (task) =>
			new Promise((resolve, reject) => {
				if (cancelled) {
					reject(new Error("read budget cancelled"));
					return;
				}
				queue.push({ run: task, resolve: resolve as (value: unknown) => void, reject });
				pump();
			}),
		pause: (delayMs) => {
			blockedUntil = Math.max(blockedUntil, scheduler.now() + Math.max(0, delayMs));
		},
		cancel: () => {
			cancelled = true;
			if (timer !== null) scheduler.clearTimeout(timer);
			timer = null;
			for (const item of queue.splice(0)) item.reject(new Error("read budget cancelled"));
		},
	};
}

// Transport (token over HTTP)

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<{
	status: number;
	headers: { get: (name: string) => string | null };
	text: () => Promise<string>;
}>;

export const READ_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds, capped. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (/^\d{1,6}$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return undefined;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - nowMs));
}

/**
 * Sends GETs with a bearer token to `apiOrigin` and nowhere else. The URL is
 * rebuilt and checked against the origin before every call, `redirect: manual`
 * keeps the Authorization header from following a redirect, and a 3xx answer is
 * reported as a failure.
 */
export function createFetchTransport(options: {
	apiOrigin: string;
	getToken: () => string | null;
	fetch: FetchLike;
	timeoutMs?: number;
	now?: () => number;
}): ReadTransport {
	const origin = new URL(options.apiOrigin).origin;
	const now = options.now ?? (() => Date.now());
	return async (request) => {
		if (!isAllowedReadRequest(request)) throw new Error("request is not on the read allow-list");
		const url = new URL(`${request.path}${request.query}`, origin);
		if (url.origin !== origin || url.pathname !== request.path) throw new Error("request does not stay on the server origin");
		const token = options.getToken();
		if (token === null) throw new TransportError("unreachable");
		const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
		if (request.workspace && "id" in request.workspace) headers["X-Workspace-ID"] = request.workspace.id;
		else if (request.workspace) headers["X-Workspace-Slug"] = request.workspace.slug;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? READ_TIMEOUT_MS);
		try {
			const response = await options.fetch(url.href, { method: "GET", headers, redirect: "manual", signal: controller.signal });
			if (response.status >= 300 && response.status < 400) throw new TransportError("redirect");
			const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
			const body = await response.text();
			if (body.length > MAX_RESPONSE_BYTES) return { status: 502, body: "" };
			return { status: response.status, body, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
		} catch (error) {
			if (error instanceof TransportError) throw error;
			if (controller.signal.aborted) throw new TransportError("timeout");
			throw new TransportError("unreachable");
		} finally {
			clearTimeout(timeout);
		}
	};
}

// Client

export type ListIssuesQuery = {
	limit?: number;
	offset?: number;
	ids?: readonly string[];
	assigneeIds?: readonly string[];
	assigneeTypes?: ReadonlyArray<"member" | "agent" | "squad">;
	openOnly?: boolean;
	sort?: "updated_at";
	direction?: "asc" | "desc";
};

/**
 * Read-only by construction: the methods below are the whole surface, every one
 * is a GET, and the object exposes nothing that could send another method.
 */
export type MulticaReadClient = {
	me: () => Promise<ReadResult>;
	workspaces: () => Promise<ReadResult>;
	taskSnapshot: (workspace: WorkspaceRef) => Promise<ReadResult>;
	agents: (workspace: WorkspaceRef) => Promise<ReadResult>;
	runtimes: (workspace: WorkspaceRef) => Promise<ReadResult>;
	listIssues: (workspace: WorkspaceRef, query?: ListIssuesQuery) => Promise<ReadResult>;
	getIssue: (workspace: WorkspaceRef, issue: string) => Promise<ReadResult>;
	taskRuns: (workspace: WorkspaceRef, issueId: string, options?: { active?: boolean; scope?: "family" }) => Promise<ReadResult>;
	activeTask: (workspace: WorkspaceRef, issueId: string) => Promise<ReadResult>;
	/** Cancels queued reads; used when the server is turned off or its credential changes. */
	dispose: () => void;
};

export const READ_CLIENT_METHODS = [
	"me",
	"workspaces",
	"taskSnapshot",
	"agents",
	"runtimes",
	"listIssues",
	"getIssue",
	"taskRuns",
	"activeTask",
	"dispose",
] as const;

function buildQuery(entries: Array<[string, string | number | boolean | undefined]>): string {
	const params = new URLSearchParams();
	for (const [name, value] of entries) if (value !== undefined) params.set(name, String(value));
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

export function createMulticaReadClient(options: { transport: ReadTransport; budget?: ReadBudget; scheduler?: Scheduler }): MulticaReadClient {
	const budget = options.budget ?? createReadBudget({ scheduler: options.scheduler });
	let failures = 0;

	const mapFailure = (status: number, retryAfterMs: number | undefined): ReadResult => {
		if (status === 401) return { ok: false, kind: "unauthorized", status };
		if (status === 403) return { ok: false, kind: "forbidden", status };
		if (status === 404) return { ok: false, kind: "not_found", status };
		if (status === 429) {
			const delay = retryAfterMs ?? MIN_BACKOFF_MS;
			budget.pause(delay);
			return { ok: false, kind: "rate_limited", status, retryAfterMs: delay };
		}
		if (status >= 500) return { ok: false, kind: "server_error", status };
		return { ok: false, kind: "bad_response", status };
	};

	const backOff = (): void => {
		failures += 1;
		budget.pause(Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (failures - 1)));
	};

	const get = (request: ReadRequest): Promise<ReadResult> => {
		if (!isAllowedReadRequest(request)) return Promise.resolve({ ok: false, kind: "bad_response" });
		const scheduled = budget.schedule(async (): Promise<ReadResult> => {
			let response: RawResponse;
			try {
				response = await options.transport(request);
			} catch (error) {
				// Network errors and timeouts back off; a redirect is a server answer, not an outage.
				const kind = error instanceof TransportError ? error.kind : "unreachable";
				if (kind !== "redirect") backOff();
				return { ok: false, kind };
			}
			if (response.status >= 200 && response.status < 300) {
				try {
					const data: unknown = response.body === "" ? null : JSON.parse(response.body);
					failures = 0;
					return { ok: true, data };
				} catch {
					return { ok: false, kind: "bad_response", status: response.status };
				}
			}
			const failure = mapFailure(response.status, response.retryAfterMs);
			if (!failure.ok && (failure.kind === "server_error" || failure.kind === "bad_response")) backOff();
			return failure;
		});
		// A read still queued when the client is disposed resolves as cancelled rather than rejecting.
		return scheduled.catch((): ReadResult => ({ ok: false, kind: "cancelled" }));
	};

	const issueRequest = (workspace: WorkspaceRef, issue: string, suffix: string, query = ""): ReadRequest | null =>
		isMulticaIssueId(issue) ? { path: `/api/issues/${issue}${suffix}`, query, workspace } : null;
	const refuse = (): Promise<ReadResult> => Promise.resolve({ ok: false, kind: "bad_response" });

	return {
		me: () => get({ path: "/api/me", query: "", workspace: null }),
		workspaces: () => get({ path: "/api/workspaces", query: "", workspace: null }),
		taskSnapshot: (workspace) => get({ path: "/api/agent-task-snapshot", query: "", workspace }),
		agents: (workspace) => get({ path: "/api/agents", query: "", workspace }),
		runtimes: (workspace) => get({ path: "/api/runtimes", query: "", workspace }),
		listIssues: (workspace, query = {}) =>
			get({
				path: "/api/issues",
				query: buildQuery([
					["limit", query.limit],
					["offset", query.offset],
					["ids", query.ids?.join(",")],
					["assignee_ids", query.assigneeIds?.join(",")],
					["assignee_types", query.assigneeTypes?.join(",")],
					["open_only", query.openOnly === undefined ? undefined : query.openOnly],
					["sort", query.sort],
					["direction", query.direction],
				]),
				workspace,
			}),
		getIssue: (workspace, issue) => {
			const request = issueRequest(workspace, issue, "");
			return request ? get(request) : refuse();
		},
		taskRuns: (workspace, issueId, runOptions = {}) => {
			const request = issueRequest(workspace, issueId, "/task-runs", buildQuery([["active", runOptions.active], ["scope", runOptions.scope]]));
			return request ? get(request) : refuse();
		},
		activeTask: (workspace, issueId) => {
			const request = issueRequest(workspace, issueId, "/active-task");
			return request ? get(request) : refuse();
		},
		dispose: () => budget.cancel(),
	};
}
