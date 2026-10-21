import { createHmac } from "node:crypto";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { describe, expect, it, vi } from "vitest";
import { createDaemonDelegationJournal } from "./multica-delegation-journal";

const authority = createMainProcessDelegationAuthority(Buffer.alloc(32, 7));
describe("daemon delegation journal transport", () => {
	it("uses only the internal loopback path, without credentials or redirects", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const body = JSON.stringify({ record: null });
			const requestMAC = (init?.headers as Record<string, string>)["X-AO-Delegation-MAC"];
			const proof = createHmac("sha256", Buffer.alloc(32, 7)).update(`journal-response-v1:${requestMAC}:${body}`).digest("hex");
			return new Response(body, { status: 200, headers: { "X-AO-Delegation-Response-MAC": proof } });
		});
		const journal = createDaemonDelegationJournal(() => "http://127.0.0.1:4445", authority, fetcher);
		expect(await journal.get("request-1")).toBeNull();
		expect(await journal.find("project-1", "task-1")).toBeNull();
		expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:4445/internal/multica-delegation-journal");
		expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ operation: "get", requestId: "request-1", requestNonce: expect.any(String) });
		expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
	});
	it.each([null, "http://evil.example", "https://127.0.0.1", "http://user:password@127.0.0.1", "http://127.0.0.1/path"])("rejects an invalid daemon origin: %s", async (origin) => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(createDaemonDelegationJournal(() => origin, authority, fetcher).get("r")).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([409, 500])("fails closed on journal HTTP %s", async (status) => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
		await expect(createDaemonDelegationJournal(() => "http://127.0.0.1:4445", authority, fetcher).get("r")).rejects.toThrow(status === 409 ? "journal_conflict" : "journal_unavailable");
	});
	it("rejects a forged or replayed journal response before using a record", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ record: { requestId: "forged", version: 0 } }), { status: 200 }));
		await expect(createDaemonDelegationJournal(() => "http://127.0.0.1:4445", authority, fetcher).get("forged")).rejects.toThrow("journal_unavailable");
	});

	it("rejects a valid response MAC replayed for a different request nonce", async () => {
		let previous = "";
		const body = JSON.stringify({ record: null });
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const requestMAC = (init?.headers as Record<string, string>)["X-AO-Delegation-MAC"];
			if (!previous) previous = createHmac("sha256", Buffer.alloc(32, 7)).update(`journal-response-v1:${requestMAC}:${body}`).digest("hex");
			return new Response(body, { status: 200, headers: { "X-AO-Delegation-Response-MAC": previous } });
		});
		const journal = createDaemonDelegationJournal(() => "http://127.0.0.1:4445", authority, fetcher);
		expect(await journal.get("r")).toBeNull();
		await expect(journal.get("r")).rejects.toThrow("journal_unavailable");
	});
	it("bounds response bytes before trusting a loopback peer", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("x".repeat(129 * 1024), { status: 200, headers: { "X-AO-Delegation-Response-MAC": "0".repeat(64) } }));
		await expect(createDaemonDelegationJournal(() => "http://127.0.0.1:4445", authority, fetcher).get("r")).rejects.toThrow("journal_unavailable");
	});

});
