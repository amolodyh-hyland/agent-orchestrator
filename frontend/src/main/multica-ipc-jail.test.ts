// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { multicaIpcJailSource } from "./multica-ipc-jail";

function loadJail(channels: string[]) {
	const methods = ["send", "sendSync", "invoke", "postMessage", "sendToHost"] as const;
	const originals = Object.fromEntries(methods.map((method) => [method, vi.fn(() => `${method}-result`)])) as Record<
		(typeof methods)[number],
		ReturnType<typeof vi.fn>
	>;
	const ipcRenderer: Record<string, unknown> = { ...originals, on: vi.fn() };
	const onBeforeJail = ipcRenderer.on;
	new Function("require", multicaIpcJailSource(channels))((id: string) => {
		if (id !== "electron") throw new Error(`unexpected require ${id}`);
		return { ipcRenderer };
	});
	return { ipcRenderer: ipcRenderer as Record<(typeof methods)[number], (...args: unknown[]) => unknown>, originals, onBeforeJail, methods };
}

describe("multica ipc jail", () => {
	it("passes the listed channels through to the real ipcRenderer", () => {
		const { ipcRenderer, originals, methods } = loadJail(["app:get-info"]);

		for (const method of methods) {
			expect(ipcRenderer[method]("app:get-info", 1, 2)).toBe(`${method}-result`);
			expect(originals[method]).toHaveBeenCalledExactlyOnceWith("app:get-info", 1, 2);
		}
	});

	it("rejects every other channel on every outbound method, including AO's own", () => {
		const { ipcRenderer, originals, methods } = loadJail(["app:get-info"]);

		for (const method of methods) {
			expect(() => ipcRenderer[method]("terminal:spawn")).toThrow("not available in the Multica view");
			expect(() => ipcRenderer[method]("daemon:status-of-ao")).toThrow();
			expect(() => ipcRenderer[method](undefined)).toThrow();
			expect(originals[method]).not.toHaveBeenCalled();
		}
	});

	it("leaves the receiving side alone", () => {
		const { ipcRenderer, onBeforeJail } = loadJail([]);

		expect((ipcRenderer as unknown as Record<string, unknown>).on).toBe(onBeforeJail);
	});
});
