import { createMulticaDelegationCoordinator, type DelegationJournal, type DelegationRecord } from "./multica-delegation-coordinator";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMulticaServer, type MulticaServer } from "../shared/multica";
import { createMulticaCredentials, MULTICA_CREDENTIALS_FILE, type SecretVault } from "./multica-credentials";
import { createMulticaPublicApi, type PublicApiOptions } from "./multica-public-api";

const TOKEN = "mul_FIXTUREpublicPAT0001";
const OTHER_TOKEN = "mul_FIXTUREpublicPAT0002";
const W = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000002";
const R = "30000000-0000-4000-8000-000000000003";
const D = "40000000-0000-4000-8000-000000000004";
const T = "50000000-0000-4000-8000-000000000005";
const FOREIGN = "90000000-0000-4000-8000-000000000009";
const profile = { agent_id: A, workspace_id: W, name: "Reviewer", runtime_id: R, runtime_bound: true, permission_mode: "private", can_invoke: true, invocation_targets: [{ target_type: "workspace", target_id: null }], archived: false, availability: "online" };
const machine = { runtime_id: R, workspace_id: W, availability: "online" };
const accepted = { delegation_id: D, task_id: T, workspace_id: W, agent_id: A, runtime_id: R, status: "queued", created_at: "2026-10-20T12:00:00Z", terminal: false, revision: "a".repeat(64) };
const intent = { agent_id: A, expected_runtime_id: R, source: { system: "ao", project_id: "project-1", task_id: "task-1" }, task: { title: "Review", instructions: "Review the approved change" } };
const problem = (status: number, code: string) => ({ type: `urn:multica:problem:${code}`, title: "Request failed", status, code, detail: TOKEN, request_id: TOKEN, error: TOKEN });
const vault: SecretVault = {
	isProtected: () => true,
	encrypt: (plain) => Buffer.from(plain.split("").reverse().join("")),
	decrypt: (blob) => blob.toString().split("").reverse().join(""),
};

let dir: string;
let http: Server;
let server: MulticaServer;
let configured: MulticaServer | null;
let calls: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
let reply: (request: IncomingMessage, response: ServerResponse) => void;
let options: PublicApiOptions;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-public-api-"));
	calls = [];
	reply = (req, res) => {
		const url = req.url ?? "";
		const data = url.startsWith("/api/v1/agents/") ? profile : url.startsWith("/api/v1/agents") ? { agents: [profile] }
			: url.startsWith("/api/v1/runtimes/") ? machine : url.startsWith("/api/v1/runtimes") ? { runtimes: [machine] } : accepted;
		res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
		res.end(JSON.stringify(data));
	};
	http = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			reply(req, res);
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	server = resolveMulticaServer({ mode: "local", customUrl: origin, apiUrl: origin })!;
	configured = server;
	options = {
		server, workspaceId: W, getConfiguredServer: () => configured,
		credentials: createMulticaCredentials({ stateDir: dir, vault, readProfileConfig: async () => { throw new Error("must not read profiles"); } }),
	};
});

afterEach(async () => {
	http.closeAllConnections();
	await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function connected(overrides: Partial<PublicApiOptions> = {}) {
	const client = createMulticaPublicApi({ ...options, ...overrides });
	expect(await client.setToken(TOKEN)).toEqual({ ok: true, data: null });
	return client;
}

function respond(status: number, value: unknown, headers: Record<string, string> = {}) {
	reply = (_req, res) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
}

describe("Public API connection binding", () => {
	it("uses member PAT and exact workspace headers only on the configured /api/v1 origin", async () => {
		const client = await connected();
		expect(await client.getAgent(A)).toEqual({ ok: true, data: profile });
		expect(await client.getRuntime(R)).toEqual({ ok: true, data: machine });
		expect((await client.listAgents({ limit: 10, cursor: "opaque/?&=next", includeArchived: true })).ok).toBe(true);
		expect((await client.listRuntimes({ limit: 20 })).ok).toBe(true);
		expect(calls.map((c) => c.url)).toEqual([`/api/v1/agents/${A}`, `/api/v1/runtimes/${R}`, "/api/v1/agents?limit=10&cursor=opaque%2F%3F%26%3Dnext&include_archived=true", "/api/v1/runtimes?limit=20"]);
		for (const call of calls) {
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.headers["x-workspace-id"]).toBe(W);
			expect(call.headers.cookie).toBeUndefined();
		}
	});

	it("keeps Public PATs separate from legacy credentials, other workspaces and other origins", async () => {
		await options.credentials.setPasted(server.key, OTHER_TOKEN);
		const client = createMulticaPublicApi(options);
		expect(await client.listAgents()).toEqual({ ok: false, code: "no_token" });
		await client.setToken(TOKEN);
		const otherWorkspace = createMulticaPublicApi({ ...options, workspaceId: FOREIGN });
		expect(await otherWorkspace.listAgents()).toEqual({ ok: false, code: "no_token" });
		const otherServer = { ...server, config: { ...server.config, apiUrl: "http://127.0.0.1:2" } };
		configured = otherServer;
		const other = createMulticaPublicApi({ ...options, server: otherServer });
		expect(await other.listAgents()).toEqual({ ok: false, code: "no_token" });
		expect(await client.listAgents()).toEqual({ ok: false, code: "connection_changed" });
		expect(calls).toHaveLength(0);
	});

	it("persists encrypted tokens through the existing vault and exposes only safe state", async () => {
		const client = await connected();
		const stored = await readFile(path.join(dir, MULTICA_CREDENTIALS_FILE), "utf8");
		expect(stored).not.toContain(TOKEN);
		const restarted = createMulticaPublicApi({ ...options, credentials: createMulticaCredentials({ stateDir: dir, vault, readProfileConfig: async () => null }) });
		expect(await restarted.getState()).toEqual({ ...client.binding, tokenConfigured: true, persistent: true });
		expect((await restarted.listAgents()).ok).toBe(true);
		expect(await restarted.clearToken()).toEqual({ ok: true, data: null });
		expect(await client.listAgents()).toEqual({ ok: false, code: "no_token" });
		expect(JSON.stringify(client)).not.toContain(TOKEN);
	});

	it("holds the token only in memory when protected storage is unavailable", async () => {
		const credentials = createMulticaCredentials({ stateDir: dir, vault: { ...vault, isProtected: () => false }, readProfileConfig: async () => null });
		const client = await connected({ credentials });
		expect((await client.getState()).persistent).toBe(false);
		expect((await client.listAgents()).ok).toBe(true);
		await expect(readFile(path.join(dir, MULTICA_CREDENTIALS_FILE), "utf8")).rejects.toThrow();
		await client.clearToken();
		expect((await client.getState()).tokenConfigured).toBe(false);
	});

	it("reports a failed token removal and rechecks the configured server after credential resolution", async () => {
		const credentials = { ...options.credentials, clearPasted: async () => undefined };
		const client = await connected({ credentials });
		expect(await client.clearToken()).toEqual({ ok: false, code: "storage_unavailable" });
		const changed = createMulticaPublicApi({ ...options, credentials: {
			...options.credentials,
			resolve: async () => { configured = null; return { ok: true as const, token: TOKEN }; },
		} });
		expect(await changed.listAgents()).toEqual({ ok: false, code: "connection_changed" });
		expect(calls).toHaveLength(0);
	});

	it("rejects unsupported credentials and invalid connection configuration without echoing input", async () => {
		const client = createMulticaPublicApi(options);
		for (const token of ["mpi_example", "mpc_example", "mat_example", "mcn_example", "ey.JWT", "mul_x\r\nInjected: x", ""]) expect(await client.setToken(token)).toEqual({ ok: false, code: "invalid_request" });
		for (const apiUrl of ["https://user:secret@example.com", "https://example.com/path", "http://example.com", "https://example.com/?key=secret"]) {
			expect(() => createMulticaPublicApi({ ...options, server: { ...server, config: { ...server.config, apiUrl } } })).toThrow("Invalid Multica connection");
		}
	});

	it("does not follow redirects, including cross-origin redirects", async () => {
		let leaked = 0;
		const destination = createServer((_req, res) => { leaked++; res.end(); });
		await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
		try {
			const client = await connected();
			for (const target of [`http://127.0.0.1:${(destination.address() as AddressInfo).port}/api/v1/agents`, `${client.binding.origin}/api/v1/runtimes`]) {
				reply = (_req, res) => { res.writeHead(307, { location: target }); res.end(); };
				expect(await client.listAgents()).toEqual({ ok: false, code: "redirect", status: 307 });
			}
			expect(leaked).toBe(0);
			expect(calls).toHaveLength(2);
		} finally { await new Promise<void>((resolve) => destination.close(() => resolve())); }
	});

	it("rejects untrusted path IDs and safely encodes opaque cursors", async () => {
		const client = await connected();
		for (const id of ["//evil.example/agents", "../runtimes", `${A}?url=https://evil.example`, "00000000-0000-0000-0000-000000000000"]) expect(await client.getAgent(id)).toEqual({ ok: false, code: "invalid_request" });
		expect(await client.listAgents({ limit: 201 })).toEqual({ ok: false, code: "invalid_request" });
		expect(calls).toHaveLength(0);
	});
});

describe("safe projections and malformed responses", () => {
	it("drops configuration, instructions, environment, results and error text from successful responses", async () => {
		const client = await connected({ delegationsEnabled: true });
		respond(200, { ...profile, env: { TOKEN }, instructions: TOKEN, mcp: TOKEN });
		expect(await client.getAgent(A)).toEqual({ ok: true, data: profile });
		respond(200, { ...machine, device: TOKEN, daemon: TOKEN, tokens: [TOKEN] });
		expect(await client.getRuntime(R)).toEqual({ ok: true, data: machine });
		respond(202, { ...accepted, result: TOKEN, error: TOKEN, work_dir: TOKEN });
		expect(await client.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: true, data: accepted });
	});

	it("rejects wrong workspace and resource identities, malformed fields and secret-bearing safe fields", async () => {
		const client = await connected();
		for (const data of [null, [], {}, { ...profile, workspace_id: FOREIGN }, { ...profile, agent_id: FOREIGN }, { ...profile, can_invoke: "yes" }, { ...profile, availability: "busy" }, { ...profile, invocation_targets: [{}] }, { ...profile, name: TOKEN }, { ...profile, name: OTHER_TOKEN }]) {
			respond(200, data);
			expect(await client.getAgent(A)).toEqual({ ok: false, code: "bad_response" });
		}
		respond(200, { agents: [profile, { ...profile, workspace_id: FOREIGN }] });
		expect(await client.listAgents()).toEqual({ ok: false, code: "bad_response" });
		respond(200, { ...machine, runtime_id: FOREIGN });
		expect(await client.getRuntime(R)).toEqual({ ok: false, code: "bad_response" });
	});

	it("rejects invalid JSON, HTML, invalid pagination and malformed errors", async () => {
		const client = await connected();
		for (const [type, body] of [["application/json", "{broken"], ["text/html", "<html>secret</html>"]]) {
			reply = (_req, res) => { res.writeHead(200, { "content-type": type }); res.end(body); };
			expect(await client.listAgents()).toEqual({ ok: false, code: "bad_response" });
		}
		respond(200, { agents: [], next_cursor: { token: TOKEN } });
		expect(await client.listAgents()).toEqual({ ok: false, code: "bad_response" });
		respond(403, { ...problem(403, "forbidden"), status: 200 });
		expect(await client.listAgents()).toEqual({ ok: false, code: "bad_response" });
	});

	it("rejects otherwise-valid JSON over 1 MiB and cancels its stream", async () => {
		const payload = JSON.stringify({ agents: [], ignored: "x".repeat(1024 * 1024) });
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => controller.enqueue(new TextEncoder().encode(payload)),
			pull: (controller) => controller.close(),
			cancel,
		}, { highWaterMark: 0 });
		const client = await connected({ fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }) });
		expect(await client.listAgents()).toEqual({ ok: false, code: "bad_response" });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(stream.locked).toBe(false);
	});

	it("never exposes remote problem detail, request IDs, raw transport errors or credential errors", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
		const client = await connected();
		for (const code of ["insufficient_scope", "scoped_token_required", "invalid_token"]) {
			respond(403, problem(403, code), { "content-type": "application/problem+json" });
			expect(await client.listAgents()).toEqual({ ok: false, code, status: 403 });
		}
		respond(500, problem(500, TOKEN));
		expect(await client.listAgents()).toEqual({ ok: false, code: "server_error", status: 500 });
		const network = await connected({ fetch: async () => { throw new Error(TOKEN); } });
		expect(await network.listAgents()).toEqual({ ok: false, code: "unreachable" });
		const broken = createMulticaPublicApi({ ...options, credentials: { ...options.credentials, resolve: async () => { throw new Error(TOKEN); } } });
		expect(await broken.listAgents()).toEqual({ ok: false, code: "credential_unavailable" });
		for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
	});

	it("times out a stalled response and refuses results after the configured server changes", async () => {
		const client = await connected({ timeoutMs: 20 });
		reply = () => undefined;
		expect(await client.listAgents()).toEqual({ ok: false, code: "timeout" });
		reply = (_req, res) => { configured = null; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(profile)); };
		expect(await client.getAgent(A)).toEqual({ ok: false, code: "connection_changed" });
	});
});

describe("confirmed delegation and rate limits", () => {
	it("reconciles by the original key and reads status without creating work", async () => {
		const client = await connected();
		respond(200, { delegations: [{ ...accepted, result: TOKEN, error: TOKEN }], next_cursor: "next-page" });
		expect(await client.listDelegations({ idempotencyKey: "request/?&=1", delegationId: D, limit: 1, cursor: "opaque" })).toEqual({ ok: true, data: { delegations: [accepted], next_cursor: "next-page" } });
		expect(calls[0].url).toBe(`/api/v1/delegations?limit=1&cursor=opaque&idempotency_key=request%2F%3F%26%3D1&delegation_id=${D}`);
		respond(200, { ...accepted, source: TOKEN, context: TOKEN });
		expect(await client.getDelegation(D)).toEqual({ ok: true, data: accepted });
		expect(calls.every((call) => call.method === "GET" && call.body === "")).toBe(true);
		respond(200, { delegations: [] });
		expect(await client.listDelegations({ idempotencyKey: "unknown-key" })).toEqual({ ok: true, data: { delegations: [] } });
	});

	it("projects every lifecycle state and stable failure reason with terminal semantics", async () => {
		const client = await connected();
		for (const status of ["queued", "deferred", "dispatched", "waiting_local_directory", "running", "completed", "failed", "cancelled", "unavailable"]) {
			const value = { ...accepted, status, terminal: ["completed", "failed", "cancelled"].includes(status) };
			respond(200, value);
			expect(await client.getDelegation(D)).toEqual({ ok: true, data: value });
		}
		for (const failure_reason of ["access_revoked", "target_unavailable", "timeout", "runtime_unavailable", "execution_failed", "execution_cancelled", "execution_unavailable"]) {
			const value = { ...accepted, status: "failed", terminal: true, failure_reason };
			respond(200, value);
			expect(await client.getDelegation(D)).toEqual({ ok: true, data: value });
		}
	});

	it("requires explicit cancellation, supports If-Match, and preserves the authoritative winner", async () => {
		const client = await connected();
		expect(await client.cancelDelegation(D, false)).toEqual({ ok: false, code: "confirmation_required" });
		expect(calls).toHaveLength(0);
		const cancelled = { ...accepted, status: "cancelled", terminal: true };
		respond(200, cancelled);
		expect(await client.cancelDelegation(D, true, accepted.revision)).toEqual({ ok: true, data: cancelled });
		expect(calls[0].url).toBe(`/api/v1/delegations/${D}/cancel`);
		expect(calls[0].headers["if-match"]).toBe(`"${accepted.revision}"`);
		expect(calls[0].headers["idempotency-key"]).toBeUndefined();
		expect(calls[0].body).toBe("");
		expect(await client.cancelDelegation(D, true)).toEqual({ ok: true, data: cancelled });
		expect(calls[1].headers["if-match"]).toBeUndefined();
		const completed = { ...accepted, status: "completed", terminal: true };
		respond(200, completed);
		expect(await client.cancelDelegation(D, true, "*")).toEqual({ ok: true, data: completed });
		expect(calls[2].headers["if-match"]).toBe("*");
		respond(409, problem(409, "revision_conflict"));
		expect(await client.cancelDelegation(D, true, accepted.revision)).toEqual({ ok: false, code: "revision_conflict", status: 409 });
	});

	it("rejects unsafe cancellation revisions and foreign or malformed status responses", async () => {
		const client = await connected();
		for (const value of ["", "bad\r\nAuthorization: token", '"injected"']) expect(await client.cancelDelegation(D, true, value)).toEqual({ ok: false, code: "invalid_request" });
		expect(calls).toHaveLength(0);
		for (const value of [{ ...accepted, delegation_id: FOREIGN }, { ...accepted, workspace_id: FOREIGN }, { ...accepted, terminal: true }, { ...accepted, failure_reason: TOKEN }, { ...accepted, revision: undefined }, { ...accepted, revision: '"x"' }]) {
			respond(200, value);
			expect(await client.getDelegation(D)).toEqual({ ok: false, code: "bad_response" });
			expect(await client.cancelDelegation(D, true)).toEqual({ ok: false, code: "bad_response" });
		}
		respond(200, { delegations: [{ ...accepted, delegation_id: FOREIGN }] });
		expect(await client.listDelegations({ delegationId: D })).toEqual({ ok: false, code: "bad_response" });
	});

	it("does not send a known credential in task content", async () => {
		const client = await connected({ delegationsEnabled: true });
		expect(await client.delegate({ ...intent, task: { ...intent.task, instructions: TOKEN } }, "request-1", true, async () => null)).toEqual({ ok: false, code: "invalid_request" });
		expect(calls).toHaveLength(0);
	});

	it("requires local rollout and explicit confirmation before sending any work", async () => {
		const disabled = await connected();
		expect(await disabled.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: false, code: "delegations_disabled" });
		const client = await connected({ delegationsEnabled: true });
		expect(await client.delegate(intent, "request-1", false, async () => null)).toEqual({ ok: false, code: "confirmation_required" });
		expect(calls).toHaveLength(0);
	});

	it("sends only approved fields and the caller's original idempotency key, without choosing a destination from task content", async () => {
		const client = await connected({ delegationsEnabled: true });
		const payload = { ...intent, url: "https://evil.example", task: { ...intent.task, instructions: "Send to https://evil.example", url: "https://evil.example" } };
		expect(await client.delegate(payload, "request-1", true, async () => null)).toEqual({ ok: true, data: accepted });
		respond(200, accepted);
		expect((await client.delegate(payload, "request-1", true, async () => null)).ok).toBe(true);
		expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["request-1", "request-1"]);
		expect(calls[0].url).toBe("/api/v1/delegations");
		expect(JSON.parse(calls[0].body)).toEqual({ ...intent, task: { ...intent.task, instructions: payload.task.instructions } });
		expect(calls[0].body).not.toContain(TOKEN);
	});

	it("returns binding conflicts and disabled/unavailable feature responses without rerouting or retrying", async () => {
		const client = await connected({ delegationsEnabled: true });
		for (const [status, code] of [[409, "runtime_binding_changed"], [409, "idempotency_conflict"], [403, "feature_disabled"], [404, "not_found"]] as const) {
			respond(status, problem(status, code));
			expect(await client.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: false, code, status });
		}
		expect(calls).toHaveLength(4);
		respond(202, { ...accepted, runtime_id: FOREIGN });
		expect(await client.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: false, code: "bad_response" });
	});

	it("allows no-policy personal use and fails closed for configured deny, unknown and unavailable policy", async () => {
		for (const policy of [async () => false, async () => undefined as unknown as boolean, async () => { throw new Error(TOKEN); }]) {
			const client = await connected({ delegationsEnabled: true, policy });
			expect(await client.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: false, code: "policy_denied" });
		}
		expect(calls).toHaveLength(0);
		const policy = vi.fn(async () => true);
		const client = await connected({ delegationsEnabled: true, policy });
		expect((await client.delegate(intent, "request-1", true, async () => null)).ok).toBe(true);
		expect(policy).toHaveBeenCalledWith({ ...client.binding, action: "delegate", agentId: A, runtimeId: R });
		expect(JSON.stringify(policy.mock.calls)).not.toContain(TOKEN);
	});

	it("validates byte limits and idempotency headers before sending", async () => {
		const client = await connected({ delegationsEnabled: true });
		for (const badKey of ["", "bad\r\nkey", "x".repeat(256)]) expect(await client.delegate(intent, badKey, true, async () => null)).toEqual({ ok: false, code: "invalid_request" });
		expect(await client.delegate({ ...intent, task: { ...intent.task, title: "é".repeat(257) } }, "request-1", true, async () => null)).toEqual({ ok: false, code: "invalid_request" });
		expect(calls).toHaveLength(0);
	});

	it.each(["20", "Wed, 21 Oct 2026 00:00:20 GMT"])("honors Retry-After %s across reads and writes without automatic resubmission", async (header) => {
		let time = Date.parse("2026-10-21T00:00:00Z");
		const client = await connected({ delegationsEnabled: true, now: () => time });
		respond(429, problem(429, "rate_limited"), { "retry-after": header });
		expect(await client.listAgents()).toEqual({ ok: false, code: "rate_limited", status: 429, retryAfterMs: 20000 });
		expect(await client.delegate(intent, "request-1", true, async () => null)).toEqual({ ok: false, code: "rate_limited", retryAfterMs: 20000 });
		expect(calls).toHaveLength(1);
		time += 20001;
		respond(200, { agents: [] });
		expect(await client.listAgents()).toEqual({ ok: true, data: { agents: [] } });
	});

	it.each(["315360000", "Wed, 21 Oct 2037 00:00:00 GMT", "9".repeat(400)])("caps Retry-After %s so reconciliation and cancellation resume within 60 seconds", async (header) => {
		let time = Date.parse("2026-10-21T00:00:00Z");
		const client = await connected({ now: () => time });
		respond(429, problem(429, "rate_limited"), { "retry-after": header });
		expect(await client.listAgents()).toEqual({ ok: false, code: "rate_limited", status: 429, retryAfterMs: 60000 });
		expect(await client.listDelegations({ idempotencyKey: "request-1" })).toEqual({ ok: false, code: "rate_limited", retryAfterMs: 60000 });
		expect(await client.getDelegation(D)).toEqual({ ok: false, code: "rate_limited", retryAfterMs: 60000 });
		time += 59999;
		expect(await client.cancelDelegation(D, true)).toEqual({ ok: false, code: "rate_limited", retryAfterMs: 1 });
		expect(calls).toHaveLength(1);
		time += 1;
		const cancelled = { ...accepted, status: "cancelled", terminal: true };
		respond(200, cancelled);
		expect(await client.cancelDelegation(D, true)).toEqual({ ok: true, data: cancelled });
		expect(await client.getDelegation(D)).toEqual({ ok: true, data: cancelled });
		respond(200, { delegations: [cancelled] });
		expect(await client.listDelegations({ idempotencyKey: "request-1" })).toEqual({ ok: true, data: { delegations: [cancelled] } });
		expect(calls).toHaveLength(4);
	});

	it("applies a rate-limit response to already queued requests", async () => {
		const client = await connected();
		respond(429, {}, { "retry-after": "5" });
		const results = await Promise.all([client.listAgents(), client.listRuntimes()]);
		expect(results.every((result) => !result.ok && result.code === "rate_limited")).toBe(true);
		expect(calls).toHaveLength(1);
	});
});

function gate() {
 let release!: () => void;
 const promise = new Promise<void>((resolve) => { release = resolve; });
 return { promise, release };
}

describe("coordinator policy at the HTTP send boundary", () => {
 for (const waitAt of ["coordinator hook", "client hook", "queue", "credentials"] as const) {
  it.each(["revocation", "expiry"])(`blocks %s during ${waitAt} without sending an admission`, async (change) => {
   const entered = gate(), resumed = gate(), attempted = gate();
   let waiting = false, revoked = false, clockNow = 0;
   const expiry = 100;
   const localHook = async () => { if (waiting) { entered.release(); await resumed.promise; } return true; };
   const client = await connected({ delegationsEnabled: true, ...(waitAt === "client hook" ? { policy: localHook } : {}) });
   let row: DelegationRecord | null = null;
   const journal: DelegationJournal = {
    evaluatePolicy: async () => ({ code: revoked ? "policy_denied" : clockNow >= expiry ? "policy_unavailable" : "policy_allowed" }),
    get: async () => structuredClone(row), find: async () => structuredClone(row),
    reserve: async (record) => { row = structuredClone(record); return structuredClone(row); },
    save: async (record) => { row = { ...structuredClone(record), version: record.version + 1 }; if (row.attempted) attempted.release(); return structuredClone(row); },
   };
   const services = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true,
    confirmations: createMainProcessDelegationAuthority(Buffer.alloc(32, 7)), resolveRuntimeClass: async () => "local",
    ...(waitAt === "coordinator hook" ? { policy: async () => { await localHook(); return { code: "policy_allowed" }; } } : {}),
   });
   const record = await services.human.confirmFromUserAction({ binding: client.binding, payload: intent }, { id: "human-policy", userId: "human", at: "2026-10-21T12:00:00Z" });
   waiting = true;
   let queuedRead: Promise<unknown> | undefined;
   if (waitAt === "queue") {
    reply = (_req, res) => { entered.release(); void resumed.promise.then(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ agents: [profile] })); }); };
    queuedRead = client.listAgents();
    await entered.promise;
   }
   if (waitAt === "credentials") {
    const resolve = options.credentials.resolve.bind(options.credentials);
    vi.spyOn(options.credentials, "resolve").mockImplementation(async (...args) => { entered.release(); await resumed.promise; return resolve(...args); });
   }
   const processing = services.taskOrchestrator.process(record.requestId);
   try {
    if (waitAt === "queue") await attempted.promise;
    else await entered.promise;
    if (change === "revocation") revoked = true;
    else clockNow = expiry;
   } finally { resumed.release(); }
   await queuedRead;
   expect(await processing).toMatchObject({ failureCode: change === "revocation" ? "policy_denied" : "policy_unavailable" });
   expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });
 }
 it("fails closed when a caller omits the required final guard", async () => {
  const client = await connected({ delegationsEnabled: true });
  // Exercise an untyped caller at runtime as well as the required TS argument.
  expect(await Reflect.apply(client.delegate, client, [intent, "missing-guard", true])).toEqual({ ok: false, code: "policy_unavailable" });
  expect(calls).toEqual([]);
 });
});
