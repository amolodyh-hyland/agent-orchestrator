// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { checkMulticaServer, classifyMulticaFetchError, createMulticaCheckGet, type MulticaCheckGet } from "./multica-server-check";

const CONFIG = JSON.stringify({ allow_signup: true, cdn_domain: "" });

function serve(routes: Record<string, { status: number; body: string } | Error>): MulticaCheckGet & ReturnType<typeof vi.fn> {
	return vi.fn(async (url: string) => {
		const route = routes[url];
		if (!route) throw new Error("net::ERR_CONNECTION_REFUSED");
		if (route instanceof Error) throw route;
		return route;
	}) as unknown as MulticaCheckGet & ReturnType<typeof vi.fn>;
}

describe("checkMulticaServer", () => {
	it("accepts a server whose derived API origin serves Multica's config", async () => {
		const get = serve({ "http://localhost:8080/api/config": { status: 200, body: CONFIG } });
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get)).toEqual({
			ok: true,
			apiUrl: "http://localhost:8080",
		});
	});

	it("finds a same-origin deployment when no api.<host> exists", async () => {
		const get = serve({ "https://multica.example.com/api/config": { status: 200, body: CONFIG } });
		expect(await checkMulticaServer({ customUrl: "https://multica.example.com", apiUrl: "" }, get)).toEqual({
			ok: true,
			apiUrl: "https://multica.example.com",
		});
	});

	it("tries only the explicit API origin when one is given", async () => {
		const get = serve({ "https://api.example.com/api/config": { status: 200, body: CONFIG } });
		expect(await checkMulticaServer({ customUrl: "https://multica.example.com", apiUrl: "https://api.example.com" }, get)).toEqual({
			ok: true,
			apiUrl: "https://api.example.com",
		});
		expect(get).toHaveBeenCalledTimes(2);
		expect(get.mock.calls.map((call) => call[0])).toEqual(["https://api.example.com/api/config", "https://api.example.com/healthz"]);
	});

	it("does not mistake another web server for Multica", async () => {
		const get = serve({
			"http://localhost:8080/api/config": { status: 200, body: "<html>hi</html>" },
			"http://localhost:3000/api/config": { status: 404, body: "" },
		});
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get)).toEqual({ ok: false, error: "not_multica" });
	});

	it("treats a redirect as not Multica instead of following it", async () => {
		const get = serve({ "http://localhost:8080/api/config": { status: 302, body: "" } });
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get)).toEqual({ ok: false, error: "not_multica" });
	});

	it("reports the first candidate's error when nothing answers", async () => {
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, serve({}))).toEqual({ ok: false, error: "unreachable" });
	});

	it("reports an up server whose database is not ready", async () => {
		const get = serve({
			"http://localhost:8080/api/config": { status: 200, body: CONFIG },
			"http://localhost:8080/healthz": { status: 503, body: "" },
		});
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get)).toEqual({ ok: false, error: "not_ready" });
	});

	it("rejects invalid and insecure URLs before any request", async () => {
		const get = serve({});
		expect(await checkMulticaServer({ customUrl: "ftp://x", apiUrl: "" }, get)).toEqual({ ok: false, error: "invalid_url" });
		expect(await checkMulticaServer({ customUrl: "http://multica.example.com", apiUrl: "" }, get)).toEqual({ ok: false, error: "insecure_http" });
		expect(await checkMulticaServer({ customUrl: "https://multica.example.com/app", apiUrl: "" }, get)).toEqual({ ok: false, error: "path_not_allowed" });
		expect(await checkMulticaServer({ customUrl: "https://multica.example.com", apiUrl: "http://api.example.com" }, get)).toEqual({
			ok: false,
			error: "insecure_http",
		});
		expect(get).not.toHaveBeenCalled();
	});

	it.each([
		[500, "server error"],
		[404, "not found"],
		[204, "no content"],
	])("does not accept status %i even when the body looks like Multica's config", async (status) => {
		const get = serve({
			"http://localhost:8080/api/config": { status, body: CONFIG },
			"http://localhost:3000/api/config": { status, body: CONFIG },
		});
		expect(await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get)).toEqual({ ok: false, error: "not_multica" });
	});

	it("gives up on a server that never answers after five seconds", async () => {
		vi.useFakeTimers();
		try {
			const get: MulticaCheckGet = (_url, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
				});
			const pending = checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "http://localhost:8080" }, get);

			await vi.advanceTimersByTimeAsync(4999);
			let settled = false;
			void pending.then(() => (settled = true));
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			expect(await pending).toEqual({ ok: false, error: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("never puts the URL or the transport message in the result", async () => {
		const get = serve({ "http://localhost:8080/api/config": new Error("connect ECONNREFUSED http://localhost:8080 token=secret") });
		const result = await checkMulticaServer({ customUrl: "http://localhost:3000", apiUrl: "" }, get);
		expect(JSON.stringify(result)).not.toMatch(/secret|8080/);
	});
});

describe("classifyMulticaFetchError", () => {
	it.each([
		[Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
		[new Error("net::ERR_CERT_AUTHORITY_INVALID"), "tls"],
		[new Error("net::ERR_SSL_PROTOCOL_ERROR"), "tls"],
		[new Error("net::ERR_CONNECTION_TIMED_OUT"), "timeout"],
		[new Error("net::ERR_NAME_NOT_RESOLVED"), "unreachable"],
		["boom", "unreachable"],
	])("%s", (error, expected) => {
		expect(classifyMulticaFetchError(error)).toBe(expected);
	});
});

describe("createMulticaCheckGet", () => {
	it("does not follow redirects, omits credentials and caps the body", async () => {
		const fetchImpl = vi.fn(async () => new Response("x".repeat(200_000), { status: 200 }));
		const get = createMulticaCheckGet(fetchImpl);
		const result = await get("https://multica.example.com/api/config", new AbortController().signal);
		expect(fetchImpl).toHaveBeenCalledWith("https://multica.example.com/api/config", expect.objectContaining({ redirect: "manual", credentials: "omit" }));
		expect(result.status).toBe(200);
		expect(result.body.length).toBeLessThanOrEqual(64 * 1024);
	});
});
