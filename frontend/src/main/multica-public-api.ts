import type { DelegationConfirmationGuard, DelegationSendGuard } from "./multica-delegation-policy";
import { createHash } from "node:crypto";
import { validateMulticaServerUrl, type MulticaServer } from "../shared/multica";
import { normalizeToken, type MulticaCredentials } from "./multica-credentials";
import { agent, array, createDelegation, delegation, object, runtime, text, uuid, type CreatePublicDelegation } from "./multica-public-api-model";

export type PublicApiFailureCode =
	| "invalid_request" | "connection_changed" | "no_token" | "credential_unavailable" | "storage_unavailable"
	| "delegations_disabled" | "confirmation_required" | "policy_denied" | "policy_unavailable" | "policy_runtime_unknown" | "policy_location_unsafe"
	| "credential_required" | "unsupported_credential" | "invalid_token" | "scoped_token_required" | "insufficient_scope"
	| "workspace_binding_required" | "workspace_id_required" | "not_found" | "unauthorized" | "forbidden"
	| "runtime_binding_changed" | "idempotency_conflict" | "revision_conflict" | "target_unavailable" | "runtime_unsupported" | "invocation_not_allowed" | "feature_disabled"
	| "rate_limited" | "server_error" | "request_failed" | "redirect" | "bad_response" | "timeout" | "unreachable";

export type PublicApiResult<T> = { ok: true; data: T } | { ok: false; code: PublicApiFailureCode; status?: number; retryAfterMs?: number };
export type PublicApiPage = { limit?: number; cursor?: string };
export type PublicDelegationQuery = PublicApiPage & { idempotencyKey?: string; delegationId?: string };
export type PublicApiBinding = Readonly<{ serverKey: string; origin: string; workspaceId: string }>;
export type PublicApiOptions = {
	server: MulticaServer;
	workspaceId: string;
	getConfiguredServer: () => MulticaServer | null;
	credentials: MulticaCredentials;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => number;
	delegationsEnabled?: boolean | (() => boolean);
	policy?: (binding: PublicApiBinding & { action: "delegate"; agentId: string; runtimeId: string }) => Promise<boolean>;
};

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60_000;
const REMOTE_CODES: readonly PublicApiFailureCode[] = [
	"invalid_request", "credential_required", "unsupported_credential", "invalid_token", "scoped_token_required", "insufficient_scope",
	"workspace_binding_required", "workspace_id_required", "not_found", "unauthorized", "forbidden", "runtime_binding_changed",
	"idempotency_conflict", "revision_conflict", "target_unavailable", "runtime_unsupported", "invocation_not_allowed", "feature_disabled",
];

function failure(code: PublicApiFailureCode): { ok: false; code: PublicApiFailureCode } {
	return { ok: false, code };
}

function origin(server: MulticaServer): string {
	const result = validateMulticaServerUrl(server.config.apiUrl);
	if (!result.ok || new URL(server.config.apiUrl).hash) throw new Error("Invalid Multica connection");
	return result.origin;
}

function pageQuery(page: PublicApiPage, includeArchived?: boolean): string {
	const params = new URLSearchParams();
	if (page.limit !== undefined) {
		if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200) throw new Error("invalid limit");
		params.set("limit", String(page.limit));
	}
	if (page.cursor !== undefined) params.set("cursor", text(page.cursor, 1024));
	if (includeArchived !== undefined) {
		if (typeof includeArchived !== "boolean") throw new Error("invalid filter");
		params.set("include_archived", String(includeArchived));
	}
	return params.size ? `?${params}` : "";
}

function key(value: unknown): string {
	const result = text(value, 255);
	if (!/^[\x21-\x7e]+$/.test(result)) throw new Error("invalid key");
	return result;
}

function retryAfter(value: string | null, now: number): number {
	if (value === null) return 5000;
	if (/^\d+$/.test(value.trim())) return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
	const ms = Date.parse(value) - now;
	return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 5000;
}

async function readBody(response: Response): Promise<string> {
	if (!response.body) throw new Error("missing body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) throw new Error("response too large");
			chunks.push(value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export function createMulticaPublicApi(options: PublicApiOptions) {
	const delegationsEnabled = () => (typeof options.delegationsEnabled === "function" ? options.delegationsEnabled() : options.delegationsEnabled) === true;
	const binding: PublicApiBinding = Object.freeze({ serverKey: options.server.key, origin: origin(options.server), workspaceId: uuid(options.workspaceId) });
	const credentialKey = `public-api-v1:${createHash("sha256").update(JSON.stringify([binding.origin, binding.workspaceId])).digest("hex")}`;
	const credentialServer = { ...options.server, key: credentialKey };
	const credentials = options.credentials;
	const fetchRequest = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	let blockedUntil = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const current = (): boolean => {
		try {
			const configured = options.getConfiguredServer();
			return configured !== null && configured.key === binding.serverKey && origin(configured) === binding.origin;
		} catch { return false; }
	};

	async function request<T>(method: "GET" | "POST", path: string, parse: (value: unknown) => T, body?: CreatePublicDelegation, idempotencyKey?: string, ifMatch?: string, beforeSend?: DelegationSendGuard, confirmationCurrent?: DelegationConfirmationGuard): Promise<PublicApiResult<T>> {
		if (!current()) return failure("connection_changed");
		if (blockedUntil > now()) return { ...failure("rate_limited"), retryAfterMs: blockedUntil - now() };
		let token: string;
		try {
			const credential = await credentials.resolve(credentialServer, "pasted", false);
			if (!credential.ok) return failure("no_token");
			const normalized = normalizeToken(credential.token);
			if (!normalized || !/^mul_[A-Za-z0-9_-]+$/.test(normalized)) return failure("no_token");
			token = normalized;
		} catch { return failure("credential_unavailable"); }
		if (!current()) return failure("connection_changed");
		const serializedBody = body === undefined ? undefined : JSON.stringify(body);
		if (serializedBody?.includes(token) || /(?:mul_|mat_|mcn_|mpi_|mpc_)[A-Za-z0-9_-]+/.test(serializedBody ?? "")) return failure("invalid_request");
		const url = new URL(`/api/v1${path}`, binding.origin);
		if (url.origin !== binding.origin || !/^\/api\/v1\/(agents|runtimes|delegations)(\/|\?|$)/.test(url.pathname)) return failure("invalid_request");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
		let received = false;
		try {
			const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}`, "X-Workspace-ID": binding.workspaceId };
			if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
			if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
			if (body) headers["Content-Type"] = "application/json";
			if (body) {
				let code: unknown;
				try { code = await beforeSend?.(); } catch { code = "policy_unavailable"; }
				if (code !== null) return failure(code === "policy_denied" || code === "policy_runtime_unknown" || code === "policy_location_unsafe" ? code : "policy_unavailable");
				if (!current()) return failure("connection_changed");
				if (controller.signal.aborted) return failure("timeout");
				if (!delegationsEnabled()) return failure("delegations_disabled");
			}
			if (confirmationCurrent) {
				try { if (confirmationCurrent() !== true) return failure("confirmation_required"); }
				catch { return failure("confirmation_required"); }
			}
			const response = await fetchRequest(url.href, { method, headers, redirect: "manual", credentials: "omit", signal: controller.signal, ...(serializedBody === undefined ? {} : { body: serializedBody }) });
			received = true;
			if (!current()) { await response.body?.cancel(); return failure("connection_changed"); }
			if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { ...failure("redirect"), status: response.status }; }
			if (response.status === 429) {
				const retryAfterMs = retryAfter(response.headers.get("retry-after"), now());
				blockedUntil = Math.max(blockedUntil, now() + retryAfterMs);
				await response.body?.cancel();
				return { ...failure("rate_limited"), status: 429, retryAfterMs };
			}
			const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
			if (contentType !== "application/json" && contentType !== "application/problem+json") { await response.body?.cancel(); return failure("bad_response"); }
			const value: unknown = JSON.parse(await readBody(response));
			if (!current()) return failure("connection_changed");
			if (response.status < 200 || response.status >= 300) {
				const problem = object(value);
				if (problem.status !== response.status || !["type", "title", "code", "detail", "request_id", "error"].every((field) => typeof problem[field] === "string")) return failure("bad_response");
				const code = REMOTE_CODES.includes(problem.code as PublicApiFailureCode) ? problem.code as PublicApiFailureCode : response.status >= 500 ? "server_error" : "request_failed";
				return { ...failure(code), status: response.status };
			}
			if (response.status !== 200 && !(method === "POST" && path === "/delegations" && response.status === 202)) return failure("bad_response");
			const data = parse(value);
			const serialized = JSON.stringify(data);
			if (serialized.includes(token) || /(?:mul_|mat_|mcn_|mpi_|mpc_)[A-Za-z0-9_-]+/.test(serialized)) return failure("bad_response");
			return { ok: true, data };
		} catch {
			return failure(controller.signal.aborted ? "timeout" : received ? "bad_response" : "unreachable");
		} finally { clearTimeout(timeout); }
	}

	function run<T>(operation: () => Promise<PublicApiResult<T>>): Promise<PublicApiResult<T>> {
		const next = queue.then(operation).catch(() => failure("invalid_request"));
		queue = next;
		return next;
	}

	return {
		binding,
		setToken: async (raw: string): Promise<PublicApiResult<null>> => {
			if (!current()) return failure("connection_changed");
			const token = normalizeToken(raw);
			if (!token || !/^mul_[A-Za-z0-9_-]+$/.test(token)) return failure("invalid_request");
			try { return await credentials.setPasted(credentialKey, token) ? { ok: true, data: null } : failure("storage_unavailable"); }
			catch { return failure("storage_unavailable"); }
		},
		clearToken: async (): Promise<PublicApiResult<null>> => {
			try {
				await credentials.clearPasted(credentialKey);
				return await credentials.hasPasted(credentialKey) ? failure("storage_unavailable") : { ok: true, data: null };
			}
			catch { return failure("storage_unavailable"); }
		},
		getState: async () => {
			try { return { ...binding, tokenConfigured: await credentials.hasPasted(credentialKey), persistent: credentials.canPersist() }; }
			catch { return { ...binding, tokenConfigured: false, persistent: false }; }
		},
		listAgents: (page: PublicApiPage & { includeArchived?: boolean } = {}) => run(async () => request("GET", `/agents${pageQuery(page, page.includeArchived)}`, (v) => {
			const data = object(v);
			return { agents: array(data.agents, (item) => agent(item, binding.workspaceId)), ...(data.next_cursor === undefined ? {} : { next_cursor: text(data.next_cursor, 1024) }) };
		})),
		getAgent: (id: string) => run(async () => {
			const expected = uuid(id);
			return request("GET", `/agents/${expected}`, (v) => {
				const result = agent(v, binding.workspaceId);
				if (result.agent_id !== expected) throw new Error("identity mismatch");
				return result;
			});
		}),
		listRuntimes: (page: PublicApiPage = {}) => run(async () => request("GET", `/runtimes${pageQuery(page)}`, (v) => {
			const data = object(v);
			return { runtimes: array(data.runtimes, (item) => runtime(item, binding.workspaceId)), ...(data.next_cursor === undefined ? {} : { next_cursor: text(data.next_cursor, 1024) }) };
		})),
		getRuntime: (id: string) => run(async () => {
			const expected = uuid(id);
			return request("GET", `/runtimes/${expected}`, (v) => {
				const result = runtime(v, binding.workspaceId);
				if (result.runtime_id !== expected) throw new Error("identity mismatch");
				return result;
			});
		}),
		listDelegations: (query: PublicDelegationQuery = {}) => run(async () => {
			const params = new URLSearchParams(pageQuery(query));
			if (query.idempotencyKey !== undefined) params.set("idempotency_key", key(query.idempotencyKey));
			const expectedId = query.delegationId === undefined ? undefined : uuid(query.delegationId);
			if (expectedId !== undefined) params.set("delegation_id", expectedId);
			return request("GET", `/delegations${params.size ? `?${params}` : ""}`, (v) => {
				const data = object(v);
				const delegations = array(data.delegations, (item) => delegation(item, binding.workspaceId));
				if (expectedId !== undefined && delegations.some((item) => item.delegation_id !== expectedId)) throw new Error("identity mismatch");
				return { delegations, ...(data.next_cursor === undefined ? {} : { next_cursor: text(data.next_cursor, 1024) }) };
			});
		}),
		getDelegation: (id: string) => run(async () => {
			const expected = uuid(id);
			return request("GET", `/delegations/${expected}`, (v) => {
				const result = delegation(v, binding.workspaceId);
				if (result.delegation_id !== expected) throw new Error("identity mismatch");
				return result;
			});
		}),
		cancelDelegation: (id: string, confirmed: boolean, revision?: string, confirmationCurrent?: DelegationConfirmationGuard) => run(async () => {
			if (confirmed !== true) return failure("confirmation_required");
			const expected = uuid(id);
			let ifMatch: string | undefined;
			if (revision !== undefined) {
				const value = text(revision, 255);
				if (!/^[\x21\x23-\x7e]+$/.test(value)) return failure("invalid_request");
				ifMatch = value === "*" ? "*" : `"${value}"`;
			}
			return request("POST", `/delegations/${expected}/cancel`, (v) => {
				const result = delegation(v, binding.workspaceId);
				if (result.delegation_id !== expected) throw new Error("identity mismatch");
				return result;
			}, undefined, undefined, ifMatch, undefined, confirmationCurrent);
		}),
		delegate: (input: CreatePublicDelegation, idempotencyKey: string, confirmed: boolean, beforeSend: DelegationSendGuard, confirmationCurrent?: DelegationConfirmationGuard) => run(async () => {
			if (!delegationsEnabled()) return failure("delegations_disabled");
			if (confirmed !== true) return failure("confirmation_required");
			const body = createDelegation(input);
			const requestKey = key(idempotencyKey);
			if (options.policy) {
				try { if (await options.policy({ ...binding, action: "delegate", agentId: body.agent_id, runtimeId: body.expected_runtime_id }) !== true) return failure("policy_denied"); }
				catch { return failure("policy_denied"); }
			}
			return request("POST", "/delegations", (v) => {
				const result = delegation(v, binding.workspaceId);
				if (result.agent_id !== body.agent_id || result.runtime_id !== body.expected_runtime_id) throw new Error("identity mismatch");
				return result;
			}, body, requestKey, undefined, beforeSend, confirmationCurrent);
		}),
	};
}
