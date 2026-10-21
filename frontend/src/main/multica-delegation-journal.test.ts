import { describe, expect, it, vi } from "vitest";
import { createDaemonDelegationJournal } from "./multica-delegation-journal";

describe("daemon delegation journal transport", () => {
	it("uses only the internal loopback path, without credentials or redirects", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ record: null }), { status: 200 }));
		const journal = createDaemonDelegationJournal(() => "http://127.0.0.1:4445", fetcher);
		expect(await journal.get("request-1")).toBeNull();
		expect(await journal.find("project-1", "task-1")).toBeNull();
		expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:4445/internal/multica-delegation-journal");
		expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", body: JSON.stringify({ operation: "get", requestId: "request-1" }) });
	});
	it.each([null, "http://evil.example", "https://127.0.0.1", "http://user:password@127.0.0.1", "http://127.0.0.1/path"])("rejects an invalid daemon origin: %s", async (origin) => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(createDaemonDelegationJournal(() => origin, fetcher).get("r")).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([409, 500])("fails closed on journal HTTP %s", async (status) => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
		await expect(createDaemonDelegationJournal(() => "http://127.0.0.1:4445", fetcher).get("r")).rejects.toThrow(status === 409 ? "journal_conflict" : "journal_unavailable");
	});
});
