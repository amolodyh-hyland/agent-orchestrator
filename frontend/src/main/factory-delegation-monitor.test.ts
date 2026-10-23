import { afterEach, expect, it, vi } from "vitest";
import { createFactoryDelegationMonitor } from "./factory-delegation-monitor";

afterEach(() => vi.useRealTimers());
it.each(["offline", "unauthorized", "rate_limit", "restart"])("restores approved references read-only after %s", async (failure) => {
	vi.useFakeTimers();
	let healthy = false;
	const fetcher = vi.fn(async (_url, input) => {
		expect(input.method).toBe("GET");
		if (!healthy && failure === "offline") throw new Error("offline");
		return new Response(JSON.stringify({ runs: [{ projectId: "p", taskId: "t", delegationId: "same-id" }, { projectId: "p", taskId: "unapproved" }] }), { status: healthy || failure === "restart" ? 200 : failure === "unauthorized" ? 401 : 429 });
	});
	const restore = vi.fn(async () => undefined);
	const monitor = createFactoryDelegationMonitor({ origin: () => "http://127.0.0.1:39001", fetch: fetcher as typeof fetch, restore });
	await vi.advanceTimersByTimeAsync(0);
	if (failure !== "restart") expect(restore).not.toHaveBeenCalled();
	healthy = true;
	await vi.advanceTimersByTimeAsync(30_000);
	expect(restore).toHaveBeenCalledWith({ projectId: "p", taskId: "t", delegationId: "same-id" });
	expect(fetcher.mock.calls.every(([, input]) => input.method === "GET")).toBe(true);
	monitor.dispose();
});
it("retries when the daemon origin becomes available and stops after disposal", async () => {
	vi.useFakeTimers();
	let origin: string | null = null;
	const fetcher = vi.fn(async () => new Response('{"runs":[]}'));
	const monitor = createFactoryDelegationMonitor({ origin: () => origin, fetch: fetcher as typeof fetch, restore: vi.fn() });
	await vi.advanceTimersByTimeAsync(0); expect(fetcher).not.toHaveBeenCalled();
	origin = "http://127.0.0.1:39001";
	await vi.advanceTimersByTimeAsync(30_000); expect(fetcher).toHaveBeenCalledTimes(1);
	monitor.dispose(); await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("continues the startup scan after one unavailable reference", async () => {
	vi.useFakeTimers();
	const rows = [{ projectId: "p", taskId: "offline", delegationId: "one" }, { projectId: "q", taskId: "available", delegationId: "two" }];
	const restore = vi.fn(async (row) => { if (row.taskId === "offline") throw new Error("offline"); });
	const monitor = createFactoryDelegationMonitor({ origin: () => "http://127.0.0.1:39001", fetch: vi.fn(async () => new Response(JSON.stringify({ runs: rows }))) as typeof fetch, restore });
	await vi.advanceTimersByTimeAsync(0); expect(restore).toHaveBeenCalledTimes(2); expect(restore).toHaveBeenLastCalledWith(rows[1]); monitor.dispose();
});
it("restores every approved page without an observation sweep or any POST", async () => {
 vi.useFakeTimers();
 const fetcher=vi.fn(async(url: string,input: RequestInit)=>{
  expect(input.method).toBe("GET");
  return new Response(JSON.stringify(url.includes("afterId=") ? {runs:[{projectId:"p",taskId:"late",delegationId:"late-id"}]} : {runs:[{projectId:"p",taskId:"early",delegationId:"early-id"}],nextCursor:"run-099"}));
 });
 const restore=vi.fn(async()=>undefined);
 const monitor=createFactoryDelegationMonitor({origin:()=>"http://127.0.0.1:39001",fetch:fetcher as typeof fetch,restore});
 await vi.advanceTimersByTimeAsync(0);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][0]).toContain("afterId=run-099");expect(restore).toHaveBeenCalledTimes(2);monitor.dispose();
});
