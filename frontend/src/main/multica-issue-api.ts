import {
	isMulticaStatusCategory,
	isMulticaWritableStatus,
	type MulticaIssueObservation,
	type MulticaWritableStatus,
} from "../shared/multica-status-writer";
import type { MulticaViewHost } from "./multica-view-host";

// The only requests AO sends to a Multica server for status sync. Every request
// is built here from validated fields and runs inside the embedded Multica page
// with the signed-in member's own token (the page's `multica_token`), so the
// token never reaches the main process and no new secret is stored. A request
// that is not on this list cannot be produced.

export const MULTICA_ISSUE_API_TIMEOUT_MS = 6000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
const MIN_RETRY_AFTER_MS = 1000;

export type MulticaApiRequest =
	| { kind: "get_issue"; workspaceSlug: string; identifier: string }
	| { kind: "get_parent"; workspaceSlug: string; issueId: string }
	| { kind: "put_status"; workspaceSlug: string; issueId: string; status: MulticaWritableStatus; expectedRevision: number }
	| { kind: "preview_trigger"; workspaceSlug: string; issueId: string; status: MulticaWritableStatus };

export type MulticaApiAllowEntry = { method: "GET" | "PUT" | "POST"; pathTemplate: string; bodyFields: readonly string[] };

/** Exactly what status sync may send. A property test asserts nothing outside it can be built. */
export const MULTICA_ISSUE_API_ALLOW_LIST: Record<MulticaApiRequest["kind"], MulticaApiAllowEntry> = {
	get_issue: { method: "GET", pathTemplate: "/api/issues/{identifier}", bodyFields: [] },
	// Read only, to see who owns the parent of a sub-issue before writing the sub-issue's status.
	get_parent: { method: "GET", pathTemplate: "/api/issues/{id}", bodyFields: [] },
	// `suppress_run` is always true: the change applies but never starts a Multica agent run.
	put_status: { method: "PUT", pathTemplate: "/api/issues/{id}", bodyFields: ["status", "expected_revision", "suppress_run"] },
	preview_trigger: { method: "POST", pathTemplate: "/api/issues/preview-trigger", bodyFields: ["issue_ids", "status"] },
};

export type PreparedMulticaRequest = {
	kind: MulticaApiRequest["kind"];
	method: "GET" | "PUT" | "POST";
	pathTemplate: string;
	path: string;
	workspaceSlug: string;
	body: Record<string, unknown> | null;
};

const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ISSUE_IDENTIFIER = /^[A-Z0-9]{1,10}-[1-9][0-9]{0,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a request and turns it into method, path and body. Throws on anything that is not allowed. */
export function prepareMulticaRequest(request: MulticaApiRequest): PreparedMulticaRequest {
	if (typeof request.workspaceSlug !== "string" || !WORKSPACE_SLUG.test(request.workspaceSlug)) throw new Error("invalid workspace");
	const allowed = MULTICA_ISSUE_API_ALLOW_LIST[request.kind];
	if (!allowed) throw new Error("request not allowed");
	if (request.kind === "get_issue") {
		if (typeof request.identifier !== "string" || !ISSUE_IDENTIFIER.test(request.identifier)) throw new Error("invalid issue identifier");
		return {
			kind: request.kind,
			method: allowed.method,
			pathTemplate: allowed.pathTemplate,
			path: `/api/issues/${request.identifier}`,
			workspaceSlug: request.workspaceSlug,
			body: null,
		};
	}
	if (typeof request.issueId !== "string" || !UUID.test(request.issueId)) throw new Error("invalid issue id");
	if (request.kind === "get_parent") {
		return {
			kind: request.kind,
			method: allowed.method,
			pathTemplate: allowed.pathTemplate,
			path: `/api/issues/${request.issueId}`,
			workspaceSlug: request.workspaceSlug,
			body: null,
		};
	}
	if (!isMulticaWritableStatus(request.status)) throw new Error("status not allowed");
	if (request.kind === "put_status") {
		if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new Error("invalid revision");
		return {
			kind: request.kind,
			method: allowed.method,
			pathTemplate: allowed.pathTemplate,
			path: `/api/issues/${request.issueId}`,
			workspaceSlug: request.workspaceSlug,
			body: { status: request.status, expected_revision: request.expectedRevision, suppress_run: true },
		};
	}
	return {
		kind: request.kind,
		method: allowed.method,
		pathTemplate: allowed.pathTemplate,
		path: "/api/issues/preview-trigger",
		workspaceSlug: request.workspaceSlug,
		body: { issue_ids: [request.issueId], status: request.status },
	};
}

/**
 * The script run in the Multica page. It reads the page's token, sends one
 * prepared request with `credentials: "omit"` and without following redirects,
 * and hands back only a fixed set of scalar fields: never the token, the
 * description, comments or an error sentence.
 */
export function buildMulticaRequestScript(input: { apiUrl: string; request: PreparedMulticaRequest }): string {
	const { request } = input;
	return `(async () => {
	try {
		const apiUrl = ${JSON.stringify(input.apiUrl)};
		const kind = ${JSON.stringify(request.kind)};
		const method = ${JSON.stringify(request.method)};
		const path = ${JSON.stringify(request.path)};
		const slug = ${JSON.stringify(request.workspaceSlug)};
		const body = ${JSON.stringify(request.body)};
		const token = localStorage.getItem("multica_token");
		if (!token) return JSON.stringify({ ok: false, reason: "signed_out" });
		const text = (value) => (typeof value === "string" ? value.slice(0, 200) : null);
		const projectIssue = (data) => {
			if (!data || typeof data !== "object") return null;
			return {
				id: text(data.id),
				workspace_id: text(data.workspace_id),
				identifier: text(data.identifier),
				status: text(data.status),
				status_category: text(data.status_category),
				revision: typeof data.revision === "number" ? data.revision : null,
				assignee_type: text(data.assignee_type),
				parent_issue_id: text(data.parent_issue_id),
				triage_state: data.triage_state === undefined || data.triage_state === null || data.triage_state === false || data.triage_state === "" ? null : true,
			};
		};
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ${MULTICA_ISSUE_API_TIMEOUT_MS});
		try {
			const headers = { Authorization: "Bearer " + token, "X-Workspace-Slug": slug };
			const init = { method, headers, credentials: "omit", redirect: "error", signal: controller.signal };
			if (body !== null) {
				headers["Content-Type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await fetch(apiUrl.replace(/\\/+$/, "") + path, init);
			if (response.status === 401) return JSON.stringify({ ok: false, reason: "signed_out" });
			let data = null;
			try {
				data = await response.json();
			} catch {
				data = null;
			}
			const retryAfter = response.headers && typeof response.headers.get === "function" ? response.headers.get("Retry-After") : null;
			let projected = null;
			if (response.ok) {
				if (kind === "preview_trigger") projected = { total_count: data && typeof data.total_count === "number" ? data.total_count : null };
				else projected = projectIssue(data);
			} else if (data && typeof data === "object") {
				projected = { code: text(data.code), actual_revision: typeof data.actual_revision === "number" ? data.actual_revision : null };
			}
			return JSON.stringify({ ok: true, status: response.status, retry_after: text(retryAfter), body: projected });
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		return JSON.stringify({ ok: false, reason: error && error.name === "AbortError" ? "timeout" : "unreadable" });
	}
})()`;
}

export type MulticaApiFailureKind =
	| "unavailable"
	| "signed_out"
	| "not_found"
	| "forbidden"
	| "conflict"
	| "in_triage"
	| "rate_limited"
	| "timeout"
	| "server_error"
	| "unreadable"
	| "rejected";

export type MulticaApiFailure = {
	ok: false;
	kind: MulticaApiFailureKind;
	httpStatus?: number;
	code?: string;
	retryAfterMs?: number;
	actualRevision?: number;
};

export type MulticaIssueResult = { ok: true; issue: MulticaIssueObservation } | MulticaApiFailure;
export type MulticaPreviewResult = { ok: true; triggers: number } | MulticaApiFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfter(value: unknown): number {
	const seconds = typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(seconds) || seconds < 0) return MIN_RETRY_AFTER_MS * 5;
	return Math.min(Math.max(Math.round(seconds * 1000), MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

function projectIssue(value: unknown): MulticaIssueObservation | null {
	if (!isRecord(value)) return null;
	const { id, workspace_id: workspaceId, identifier, status, revision } = value;
	if (typeof id !== "string" || !UUID.test(id) || typeof workspaceId !== "string" || !UUID.test(workspaceId)) return null;
	if (typeof identifier !== "string" || typeof status !== "string" || status.length === 0) return null;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
	const rawCategory = typeof value.status_category === "string" ? value.status_category : "";
	const category = rawCategory !== "" ? rawCategory : isMulticaStatusCategory(status) ? status : "";
	return {
		id,
		workspaceId,
		identifier,
		status,
		category,
		revision,
		assigneeType: typeof value.assignee_type === "string" ? value.assignee_type : null,
		inTriage: value.triage_state === true,
		parentIssueId: typeof value.parent_issue_id === "string" && UUID.test(value.parent_issue_id) ? value.parent_issue_id : null,
	};
}

type RawOutcome = { failure: MulticaApiFailure } | { status: number; retryAfter: unknown; body: unknown };

function parseRaw(raw: unknown): RawOutcome {
	if (typeof raw !== "string") return { failure: { ok: false, kind: "unavailable" } };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { failure: { ok: false, kind: "unreadable" } };
	}
	if (!isRecord(parsed)) return { failure: { ok: false, kind: "unreadable" } };
	if (parsed.ok === false) {
		const reason = parsed.reason;
		if (reason === "signed_out" || reason === "timeout") return { failure: { ok: false, kind: reason } };
		return { failure: { ok: false, kind: "unreadable" } };
	}
	if (parsed.ok !== true || typeof parsed.status !== "number") return { failure: { ok: false, kind: "unreadable" } };
	return { status: parsed.status, retryAfter: parsed.retry_after, body: parsed.body };
}

function failureForStatus(status: number, retryAfter: unknown, body: unknown): MulticaApiFailure {
	const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
	const base = { ok: false as const, httpStatus: status, ...(code !== undefined ? { code } : {}) };
	if (status === 403) return { ...base, kind: "forbidden" };
	if (status === 404) return { ...base, kind: "not_found" };
	if (status === 409 && code === "revision_conflict") {
		const actual = isRecord(body) && typeof body.actual_revision === "number" ? body.actual_revision : undefined;
		return { ...base, kind: "conflict", ...(actual !== undefined ? { actualRevision: actual } : {}) };
	}
	if (status === 400 && code === "issue_in_triage") return { ...base, kind: "in_triage" };
	if (status === 429) return { ...base, kind: "rate_limited", retryAfterMs: parseRetryAfter(retryAfter) };
	if (status >= 500) return { ...base, kind: "server_error" };
	return { ...base, kind: "rejected" };
}

export function parseMulticaIssueResponse(raw: unknown): MulticaIssueResult {
	const outcome = parseRaw(raw);
	if ("failure" in outcome) return outcome.failure;
	if (outcome.status >= 200 && outcome.status < 300) {
		const issue = projectIssue(outcome.body);
		return issue ? { ok: true, issue } : { ok: false, kind: "unreadable", httpStatus: outcome.status };
	}
	return failureForStatus(outcome.status, outcome.retryAfter, outcome.body);
}

export function parseMulticaPreviewResponse(raw: unknown): MulticaPreviewResult {
	const outcome = parseRaw(raw);
	if ("failure" in outcome) return outcome.failure;
	if (outcome.status >= 200 && outcome.status < 300) {
		const total = isRecord(outcome.body) ? outcome.body.total_count : undefined;
		return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
			? { ok: true, triggers: total }
			: { ok: false, kind: "unreadable", httpStatus: outcome.status };
	}
	return failureForStatus(outcome.status, outcome.retryAfter, outcome.body);
}

export type MulticaIssueApi = {
	getIssue: (serverKey: string, input: { workspaceSlug: string; identifier: string }) => Promise<MulticaIssueResult>;
	/** Reads the parent of a sub-issue by its UUID. */
	getParent: (serverKey: string, input: { workspaceSlug: string; issueId: string }) => Promise<MulticaIssueResult>;
	putStatus: (
		serverKey: string,
		input: { workspaceSlug: string; issueId: string; status: MulticaWritableStatus; expectedRevision: number },
	) => Promise<MulticaIssueResult>;
	previewTrigger: (
		serverKey: string,
		input: { workspaceSlug: string; issueId: string; status: MulticaWritableStatus },
	) => Promise<MulticaPreviewResult>;
};

export type MulticaIssueApiOptions = {
	getHost: () => Pick<MulticaViewHost, "evaluateInPage" | "getServer"> | undefined;
	timeoutMs?: number;
};

export function createMulticaIssueApi(options: MulticaIssueApiOptions): MulticaIssueApi {
	const timeoutMs = options.timeoutMs ?? MULTICA_ISSUE_API_TIMEOUT_MS + 2000;

	const run = async (serverKey: string, request: MulticaApiRequest): Promise<unknown> => {
		const host = options.getHost();
		// The server comes from the live view and the script is bound to it, so a switch
		// while this runs cannot send one server's token to another server's API.
		const server = host?.getServer();
		if (!host || !server || server.key !== serverKey) return undefined;
		let prepared: PreparedMulticaRequest;
		try {
			prepared = prepareMulticaRequest(request);
		} catch {
			return JSON.stringify({ ok: false, reason: "rejected" });
		}
		const script = buildMulticaRequestScript({ apiUrl: server.config.apiUrl, request: prepared });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			});
			return await Promise.race([host.evaluateInPage(script, server.key), timeout]);
		} catch {
			return undefined;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	return {
		getIssue: async (serverKey, input) => parseMulticaIssueResponse(await run(serverKey, { kind: "get_issue", ...input })),
		getParent: async (serverKey, input) => parseMulticaIssueResponse(await run(serverKey, { kind: "get_parent", ...input })),
		putStatus: async (serverKey, input) => parseMulticaIssueResponse(await run(serverKey, { kind: "put_status", ...input })),
		previewTrigger: async (serverKey, input) => parseMulticaPreviewResponse(await run(serverKey, { kind: "preview_trigger", ...input })),
	};
}
