import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALLOWED_READ_PATHS,
	MAX_BACKOFF_MS,
	MIN_BACKOFF_MS,
	READ_CLIENT_METHODS,
	TransportError,
	createFetchTransport,
	createMulticaReadClient,
	createReadBudget,
	isAllowedReadPath,
	isAllowedReadQuery,
	isAllowedReadRequest,
	parseRetryAfter,
	type FetchLike,
	type RawResponse,
	type ReadRequest,
	type ReadTransport,
} from "./multica-read-client";
import { createFakeScheduler } from "./test-support/fake-scheduler";
import { createFakeMulticaServer, fakeIssue, fakeTask, type FakeMulticaServer } from "./test-support/multica-fake-server";

const TOKEN = "mul_FIXTUREreadClientTOKEN01";
const WS = { id: "ws-1" };

describe("read client surface", () => {
	const client = createMulticaReadClient({ transport: async () => ({ status: 200, body: "{}" }) });

	it("exposes no write method", () => {
		expect(Object.keys(client).sort()).toEqual([...READ_CLIENT_METHODS].sort());
		for (const name of Object.keys(client)) {
			expect(name).not.toMatch(/^(post|put|patch|delete|write|create|update|set|cancel|assign|comment|send|remove|add|request|fetch|call)/i);
		}
	});

	it("has no generic request entry point", () => {
		const loose = client as unknown as Record<string, unknown>;
		for (const name of ["request", "fetch", "get", "post", "put", "patch", "delete", "send", "call"]) expect(loose[name]).toBeUndefined();
	});
});

describe("allow-list", () => {
	it("accepts exactly the P1 GET templates", () => {
		for (const path of [
			"/api/me",
			"/api/workspaces",
			"/api/agent-task-snapshot",
			"/api/agents",
			"/api/runtimes",
			"/api/issues",
			"/api/issues/MUL-12",
			"/api/issues/3f1c2b7a-0000-4000-8000-000000000001",
			"/api/issues/MUL-12/task-runs",
			"/api/issues/MUL-12/active-task",
		]) {
			expect(isAllowedReadPath(path), path).toBe(true);
		}
		expect(ALLOWED_READ_PATHS).toHaveLength(8);
	});

	it("refuses every write, daemon, token and management route and path tricks", () => {
		for (const path of [
			"/api/issues/MUL-12/comments",
			"/api/issues/MUL-12/tasks/t1/cancel",
			"/api/issues/MUL-12/metadata/ao_sync",
			"/api/issues/preview-trigger/extra",
			"/api/issues/query",
			"/api/daemon/register",
			"/api/daemon/tasks/claim",
			"/api/personal-access-tokens",
			"/api/agents/a1",
			"/api/workspaces/ws-1",
			"/api/members",
			"/api/me/tokens",
			"/api/issues/../me",
			"/api/issues/MUL-12/../../me",
			"//evil.example/api/me",
			"https://evil.example/api/me",
			"/api/issues/MUL 12",
			"/api/issues/",
			"/ws",
		]) {
			expect(isAllowedReadPath(path), path).toBe(false);
		}
	});

	it("allows only the known query names with plain values", () => {
		expect(isAllowedReadQuery("")).toBe(true);
		expect(isAllowedReadQuery("?limit=100&offset=0&ids=a,b&sort=updated_at&direction=desc&open_only=true&assignee_types=agent,squad")).toBe(true);
		expect(isAllowedReadQuery("?token=abc")).toBe(false);
		expect(isAllowedReadQuery("?limit=100&callback=x")).toBe(false);
		expect(isAllowedReadQuery("?ids=a%0d%0aX-Injected:1")).toBe(false);
		expect(isAllowedReadQuery("limit=1")).toBe(false);
	});

	it("requires a workspace for workspace routes and none for me and workspaces", () => {
		expect(isAllowedReadRequest({ path: "/api/me", query: "", workspace: null })).toBe(true);
		expect(isAllowedReadRequest({ path: "/api/agents", query: "", workspace: null })).toBe(false);
		expect(isAllowedReadRequest({ path: "/api/agents", query: "", workspace: { id: "ws 1" } })).toBe(false);
		expect(isAllowedReadRequest({ path: "/api/agents", query: "", workspace: { slug: "acme" } })).toBe(true);
	});

	it("never calls the transport for a request outside the list", async () => {
		const transport = vi.fn<ReadTransport>(async () => ({ status: 200, body: "{}" }));
		const client = createMulticaReadClient({ transport });
		expect(await client.getIssue(WS, "../../me")).toMatchObject({ ok: false, kind: "bad_response" });
		expect(await client.taskRuns(WS, "MUL-1/../x")).toMatchObject({ ok: false });
		expect(await client.activeTask(WS, "a b")).toMatchObject({ ok: false });
		expect(transport).not.toHaveBeenCalled();
	});

	it("covers every client method with a request the allow-list accepts", async () => {
		const seen: ReadRequest[] = [];
		const client = createMulticaReadClient({
			transport: async (request) => {
				seen.push(request);
				return { status: 200, body: "{}" };
			},
			scheduler: createFakeScheduler(),
		});
		await client.me();
		await client.workspaces();
		await client.taskSnapshot(WS);
		await client.agents(WS);
		await client.runtimes(WS);
		await client.listIssues(WS, { limit: 100, offset: 100, ids: ["a", "b"], assigneeIds: ["u"], assigneeTypes: ["agent", "squad"], openOnly: true, sort: "updated_at", direction: "desc" });
		await client.getIssue(WS, "MUL-1");
		await client.taskRuns(WS, "MUL-1", { active: true, scope: "family" });
		await client.activeTask(WS, "MUL-1");
		expect(seen).toHaveLength(9);
		for (const request of seen) expect(isAllowedReadRequest(request), JSON.stringify(request)).toBe(true);
		expect(seen[5].query).toBe("?limit=100&offset=100&ids=a%2Cb&assignee_ids=u&assignee_types=agent%2Csquad&open_only=true&sort=updated_at&direction=desc");
		expect(seen[7].query).toBe("?active=true&scope=family");
	});
});

describe("against a fake Multica server", () => {
	let server: FakeMulticaServer;
	beforeEach(async () => {
		server = await createFakeMulticaServer();
		server.addWorkspace({ id: "ws-1", slug: "acme", name: "Acme" });
		server.addUser(TOKEN, { id: "user-1", name: "Fixture", workspaceIds: ["ws-1"] });
		server.setIssues("ws-1", [fakeIssue()]);
		server.setTasks("ws-1", [fakeTask()]);
	});
	afterEach(async () => {
		await server.close();
	});

	const make = (token: string | null = TOKEN, apiOrigin = () => server.origin) =>
		createMulticaReadClient({
			transport: createFetchTransport({ apiOrigin: apiOrigin(), getToken: () => token, fetch: fetch as unknown as FetchLike }),
		});

	it("reads every route with GET and never writes", async () => {
		const client = make();
		expect(await client.me()).toMatchObject({ ok: true, data: { id: "user-1" } });
		expect(await client.workspaces()).toMatchObject({ ok: true });
		expect(await client.taskSnapshot({ slug: "acme" })).toMatchObject({ ok: true });
		expect(await client.agents(WS)).toMatchObject({ ok: true });
		expect(await client.runtimes(WS)).toMatchObject({ ok: true });
		expect(await client.listIssues(WS, { limit: 100 })).toMatchObject({ ok: true });
		expect(await client.getIssue(WS, "MUL-1")).toMatchObject({ ok: true, data: { identifier: "MUL-1" } });
		expect(await client.taskRuns(WS, "iss-1", { active: true })).toMatchObject({ ok: true });
		expect(await client.activeTask(WS, "iss-1")).toMatchObject({ ok: true });
		expect(server.requests.length).toBeGreaterThanOrEqual(9);
		expect(server.requests.every((request) => request.method === "GET")).toBe(true);
		expect(server.writes()).toEqual([]);
	});

	it("sends the bearer token and the workspace headers, and no origin header", async () => {
		await make().taskSnapshot({ slug: "acme" });
		await make().agents(WS);
		const [bySlug, byId] = server.requestsTo("/api/");
		expect(bySlug.authorization).toBe(`Bearer ${TOKEN}`);
		expect(bySlug.workspaceSlug).toBe("acme");
		expect(byId.workspaceId).toBe("ws-1");
		expect(bySlug.origin).toBeUndefined();
	});

	it("maps 401, 403 and 404 to failure kinds", async () => {
		expect(await make("mul_WRONG0000000000").me()).toMatchObject({ ok: false, kind: "unauthorized", status: 401 });
		server.addUser(TOKEN, { id: "user-1", name: "Fixture", workspaceIds: [] });
		expect(await make().agents(WS)).toMatchObject({ ok: false, kind: "not_found" });
		server.failNext("/api/me", { status: 403 });
		expect(await make().me()).toMatchObject({ ok: false, kind: "forbidden" });
	});

	it("does not call the server without a token", async () => {
		expect(await make(null).me()).toMatchObject({ ok: false, kind: "unreachable" });
		expect(server.requests).toHaveLength(0);
	});

	it("reports an unreachable server", async () => {
		const dead = await createFakeMulticaServer();
		const origin = dead.origin;
		await dead.close();
		const client = createMulticaReadClient({
			transport: createFetchTransport({ apiOrigin: origin, getToken: () => TOKEN, fetch: fetch as unknown as FetchLike }),
			scheduler: createFakeScheduler(),
		});
		expect(await client.me()).toMatchObject({ ok: false, kind: "unreachable" });
	});
});

describe("token binding and redirects", () => {
	const okResponse = { status: 200, headers: { get: () => null }, text: async () => "{}" };

	it("sends the token only to the origin of the server and rebuilds the URL", async () => {
		const urls: string[] = [];
		const transport = createFetchTransport({
			apiOrigin: "https://api.multica.ai",
			getToken: () => TOKEN,
			fetch: async (url) => {
				urls.push(url);
				return okResponse;
			},
		});
		await transport({ path: "/api/me", query: "", workspace: null });
		await transport({ path: "/api/issues", query: "?limit=1", workspace: { id: "ws-1" } });
		expect(urls).toEqual(["https://api.multica.ai/api/me", "https://api.multica.ai/api/issues?limit=1"]);
	});

	it("refuses to send a request that is off the allow-list or off the origin", async () => {
		const fetchSpy = vi.fn<FetchLike>(async () => okResponse);
		const transport = createFetchTransport({ apiOrigin: "https://api.multica.ai", getToken: () => TOKEN, fetch: fetchSpy });
		for (const path of ["//evil.example/api/me", "https://evil.example/api/me", "/api/daemon/claim", "/api/issues/a/comments"]) {
			await expect(transport({ path, query: "", workspace: null })).rejects.toThrow();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not follow redirects and reports them without forwarding the token", async () => {
		const calls: Array<{ url: string; redirect: string }> = [];
		const client = createMulticaReadClient({
			transport: createFetchTransport({
				apiOrigin: "https://api.multica.ai",
				getToken: () => TOKEN,
				fetch: async (url, init) => {
					calls.push({ url, redirect: init.redirect });
					return { status: 302, headers: { get: (name) => (name === "location" ? "https://evil.example/" : null) }, text: async () => "" };
				},
			}),
			scheduler: createFakeScheduler(),
		});
		expect(await client.me()).toMatchObject({ ok: false, kind: "redirect" });
		expect(calls).toEqual([{ url: "https://api.multica.ai/api/me", redirect: "manual" }]);
	});

	it("turns an aborted request into a timeout", async () => {
		const transport = createFetchTransport({
			apiOrigin: "https://api.multica.ai",
			getToken: () => TOKEN,
			timeoutMs: 10,
			fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
		});
		await expect(transport({ path: "/api/me", query: "", workspace: null })).rejects.toMatchObject({ kind: "timeout" });
	});
});

describe("response size cap", () => {
	it("refuses a body over 8 MiB as a server error and does not parse it", async () => {
		const transport = createFetchTransport({
			apiOrigin: "https://api.multica.ai",
			getToken: () => TOKEN,
			fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => "x".repeat(8 * 1024 * 1024 + 1) }),
		});
		await expect(transport({ path: "/api/me", query: "", workspace: null })).resolves.toEqual({ status: 502, body: "" });
		const client = createMulticaReadClient({ transport, scheduler: createFakeScheduler() });
		expect(await client.me()).toMatchObject({ ok: false, kind: "server_error" });
	});

	it("accepts a body at the cap", async () => {
		const transport = createFetchTransport({
			apiOrigin: "https://api.multica.ai",
			getToken: () => TOKEN,
			fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => "x".repeat(8 * 1024 * 1024) }),
		});
		expect((await transport({ path: "/api/me", query: "", workspace: null })).status).toBe(200);
	});
});

describe("failures, back-off and the read budget", () => {
	const responses = (...items: Array<RawResponse | TransportError>): ReadTransport => {
		const queue = [...items];
		return async () => {
			const next = queue.shift() ?? { status: 200, body: "{}" };
			if (next instanceof TransportError) throw next;
			return next;
		};
	};

	it("pauses every queued read for Retry-After after a 429", async () => {
		const scheduler = createFakeScheduler();
		const times: number[] = [];
		const transport: ReadTransport = async () => {
			times.push(scheduler.now());
			return times.length === 1 ? { status: 429, body: "", retryAfterMs: 20_000 } : { status: 200, body: "{}" };
		};
		const client = createMulticaReadClient({ transport, scheduler });
		const first = client.me();
		const second = client.me();
		await scheduler.advance(0);
		expect(await first).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 20_000 });
		await scheduler.advance(19_000);
		expect(times).toHaveLength(1);
		await scheduler.advance(2_000);
		expect(await second).toMatchObject({ ok: true });
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(20_000);
	});

	it("backs off 5 s doubling to 5 min after 5xx and timeouts, and resets after a success", async () => {
		const scheduler = createFakeScheduler();
		const stamps: number[] = [];
		const queue: Array<RawResponse | TransportError> = [
			{ status: 503, body: "" },
			new TransportError("timeout"),
			new TransportError("unreachable"),
			{ status: 200, body: "{}" },
			{ status: 500, body: "" },
			{ status: 200, body: "{}" },
		];
		const transport: ReadTransport = async () => {
			stamps.push(scheduler.now());
			const next = queue.shift()!;
			if (next instanceof TransportError) throw next;
			return next;
		};
		const client = createMulticaReadClient({ transport, scheduler });
		const results = Array.from({ length: 6 }, () => client.me());
		await scheduler.advance(60 * 60_000);
		await Promise.all(results);
		const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
		expect(gaps[0]).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
		expect(gaps[1]).toBeGreaterThanOrEqual(MIN_BACKOFF_MS * 2);
		expect(gaps[2]).toBeGreaterThanOrEqual(MIN_BACKOFF_MS * 4);
		// After the success the next failure starts again at the minimum.
		expect(gaps[4]).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
		expect(gaps[4]).toBeLessThan(MIN_BACKOFF_MS * 2);
		expect(MAX_BACKOFF_MS).toBe(300_000);
	});

	it("does not back off after a 401 or a redirect", async () => {
		const scheduler = createFakeScheduler();
		const client = createMulticaReadClient({
			transport: responses({ status: 401, body: "" }, new TransportError("redirect"), { status: 200, body: "{}" }),
			scheduler,
		});
		const all = [client.me(), client.me(), client.me()];
		await scheduler.advance(1000);
		expect((await Promise.all(all)).map((result) => result.ok)).toEqual([false, false, true]);
	});

	it("reports a body that is not JSON as a bad response", async () => {
		const client = createMulticaReadClient({ transport: responses({ status: 200, body: "<html>" }), scheduler: createFakeScheduler() });
		expect(await client.me()).toMatchObject({ ok: false, kind: "bad_response" });
	});

	it("parses Retry-After in seconds and as a date, capped at five minutes", () => {
		expect(parseRetryAfter("7", 0)).toBe(7000);
		expect(parseRetryAfter("99999", 0)).toBe(300_000);
		expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).toBe(60_000);
		expect(parseRetryAfter("soon", 0)).toBeUndefined();
		expect(parseRetryAfter(null, 0)).toBeUndefined();
	});

	it("allows a burst of 10 reads, then 60 per minute, one at a time and in order", async () => {
		const scheduler = createFakeScheduler();
		const budget = createReadBudget({ scheduler });
		const started: Array<[number, number]> = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		const jobs = Array.from({ length: 15 }, (_, index) =>
			budget.schedule(async () => {
				concurrent += 1;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				started.push([index, scheduler.now()]);
				await Promise.resolve();
				concurrent -= 1;
				return index;
			}),
		);
		await scheduler.advance(0);
		expect(started).toHaveLength(10);
		await scheduler.advance(5_000);
		expect(started).toHaveLength(15);
		expect((await Promise.all(jobs))).toEqual(Array.from({ length: 15 }, (_, index) => index));
		expect(started.map(([index]) => index)).toEqual(Array.from({ length: 15 }, (_, index) => index));
		expect(maxConcurrent).toBe(1);
		// Reads 11 to 15 wait one refill (1 s) each.
		expect(started[10][1] - started[9][1]).toBeGreaterThanOrEqual(1000);
		expect(started[14][1] - started[9][1]).toBeGreaterThanOrEqual(5000);
	});

	it("never exceeds 60 reads in any minute", async () => {
		const scheduler = createFakeScheduler();
		const budget = createReadBudget({ scheduler });
		const stamps: number[] = [];
		const jobs = Array.from({ length: 200 }, () => budget.schedule(async () => void stamps.push(scheduler.now())));
		await scheduler.advance(5 * 60_000);
		await Promise.all(jobs.slice(0, 100));
		for (const stamp of stamps) {
			const inWindow = stamps.filter((other) => other >= stamp && other < stamp + 60_000).length;
			expect(inWindow).toBeLessThanOrEqual(60 + 10);
		}
		expect(stamps.length).toBeLessThanOrEqual(10 + 5 * 60 + 1);
	});

	it("rejects queued reads when disposed", async () => {
		const scheduler = createFakeScheduler();
		const client = createMulticaReadClient({ transport: async () => ({ status: 200, body: "{}" }), scheduler });
		const jobs = Array.from({ length: 14 }, () => client.me());
		await scheduler.advance(0);
		client.dispose();
		const results = await Promise.all(jobs);
		expect(results.filter((result) => !result.ok && result.kind === "cancelled").length).toBeGreaterThan(0);
		expect(await client.me()).toEqual({ ok: false, kind: "cancelled" });
	});
});
