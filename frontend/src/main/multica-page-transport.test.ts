import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { TransportError } from "./multica-read-client";
import { buildPageReadScript, createPageTransport, parsePageReadResult } from "./multica-page-transport";

const API = "https://api.multica.ai";
const FAKE_PAGE_TOKEN = "mul_FIXTUREpageTOKEN0001";

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; credentials: string; redirect: string } };

/** Runs the generated script in a sandbox that stands in for the Multica page. */
async function runInFakePage(script: string, page: { token: string | null; response?: { status: number; body: string; headers?: Record<string, string> } }) {
	const calls: FetchCall[] = [];
	const context = vm.createContext({
		localStorage: { getItem: (key: string) => (key === "multica_token" ? page.token : null) },
		fetch: async (url: string, init: FetchCall["init"]) => {
			calls.push({ url, init });
			const response = page.response ?? { status: 200, body: "{}" };
			return { status: response.status, text: async () => response.body, headers: { get: (name: string) => response.headers?.[name] ?? null } };
		},
		AbortController,
		setTimeout,
		clearTimeout,
		JSON,
	});
	const result = await vm.runInContext(script, context);
	return { result, calls };
}

describe("page read script", () => {
	it("does not contain a token and is bound to the server origin", () => {
		const script = buildPageReadScript({ apiOrigin: API, request: { path: "/api/issues", query: "?limit=100", workspace: { slug: "acme" } } });
		expect(script).not.toMatch(/mul_|Bearer [A-Za-z0-9]/);
		expect(script).toContain('"https://api.multica.ai/api/issues?limit=100"');
	});

	it("reads with GET, the page token, credentials omitted and redirects not followed", async () => {
		const script = buildPageReadScript({ apiOrigin: API, request: { path: "/api/agents", query: "", workspace: { slug: "acme" } } });
		const { result, calls } = await runInFakePage(script, { token: FAKE_PAGE_TOKEN, response: { status: 200, body: "[]" } });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.multica.ai/api/agents");
		expect(calls[0].init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
		expect(calls[0].init.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${FAKE_PAGE_TOKEN}`, "X-Workspace-Slug": "acme" });
		expect(parsePageReadResult(result, 0)).toEqual({ status: 200, body: "[]" });
	});

	it("sends a workspace id header and no workspace header for me", async () => {
		const byId = await runInFakePage(buildPageReadScript({ apiOrigin: API, request: { path: "/api/runtimes", query: "", workspace: { id: "ws-1" } } }), { token: FAKE_PAGE_TOKEN });
		expect(byId.calls[0].init.headers["X-Workspace-ID"]).toBe("ws-1");
		const me = await runInFakePage(buildPageReadScript({ apiOrigin: API, request: { path: "/api/me", query: "", workspace: null } }), { token: FAKE_PAGE_TOKEN });
		expect(Object.keys(me.calls[0].init.headers).sort()).toEqual(["Accept", "Authorization"]);
	});

	it("answers 401 without a request when the page holds no token", async () => {
		const script = buildPageReadScript({ apiOrigin: API, request: { path: "/api/me", query: "", workspace: null } });
		const { result, calls } = await runInFakePage(script, { token: null });
		expect(calls).toHaveLength(0);
		expect(parsePageReadResult(result, 0)).toEqual({ status: 401, body: "" });
	});

	it("passes Retry-After through", async () => {
		const script = buildPageReadScript({ apiOrigin: API, request: { path: "/api/me", query: "", workspace: null } });
		const { result } = await runInFakePage(script, { token: FAKE_PAGE_TOKEN, response: { status: 429, body: "", headers: { "retry-after": "12" } } });
		expect(parsePageReadResult(result, 0)).toEqual({ status: 429, body: "", retryAfterMs: 12_000 });
	});

	it("refuses to build a script for a request outside the allow-list", () => {
		for (const request of [
			{ path: "/api/issues/MUL-1/comments", query: "", workspace: { slug: "acme" } },
			{ path: "/api/daemon/claim", query: "", workspace: { slug: "acme" } },
			{ path: "//evil.example/api/me", query: "", workspace: null },
			{ path: "/api/me", query: "?token=x", workspace: null },
		]) {
			expect(() => buildPageReadScript({ apiOrigin: API, request })).toThrow();
		}
	});
});

describe("page read results", () => {
	it("treats anything unexpected as an unreachable server", () => {
		for (const raw of [undefined, 5, "not json", "[]", JSON.stringify({ status: 0, body: "" }), JSON.stringify({ status: "200", body: "" }), JSON.stringify({ status: 200 })]) {
			expect(() => parsePageReadResult(raw, 0)).toThrow(TransportError);
		}
		expect(() => parsePageReadResult(JSON.stringify({ status: 0, body: "", redirect: true }), 0)).toThrow(expect.objectContaining({ kind: "redirect" }));
	});

	it("is unreachable when no view is loaded for the server", async () => {
		const evaluate = vi.fn(async () => undefined);
		const transport = createPageTransport({ host: () => ({ evaluateInPage: evaluate }), serverKey: "cloud", apiOrigin: API });
		await expect(transport({ path: "/api/me", query: "", workspace: null })).rejects.toMatchObject({ kind: "unreachable" });
		expect(evaluate).toHaveBeenCalledWith(expect.any(String), "cloud");
		const none = createPageTransport({ host: () => undefined, serverKey: "cloud", apiOrigin: API });
		await expect(none({ path: "/api/me", query: "", workspace: null })).rejects.toMatchObject({ kind: "unreachable" });
	});
});
