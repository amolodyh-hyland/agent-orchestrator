// @vitest-environment node
import { EventEmitter } from "node:events";
import type { IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerDictationIpc } from "./dictation-ipc";
import { DICTATION_EVENT_CHANNEL, type DictationEngine, type DictationEvent } from "../shared/dictation";

function setup() {
	let handle: (...args: unknown[]) => unknown = () => undefined;
	const engines: Array<DictationEngine & { emit: (event: DictationEvent) => void }> = [];
	const createEngine = () => {
		const engine = {
			availability: vi.fn(async () => ({ available: true as const })),
			emit: (_event: DictationEvent): void => undefined,
			start: vi.fn((_locale: string, emit: (event: DictationEvent) => void) => { engine.emit = emit; }),
			stop: vi.fn(), cancel: vi.fn(),
		};
		engines.push(engine);
		return engine;
	};
	const dispose = registerDictationIpc({ ipcMain: { handle: (_channel, callback) => { handle = callback as typeof handle; } } as Pick<IpcMain, "handle">, createEngine, isTrustedSender: (id) => id === 1 });
	const owner = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
	const event = { sender: owner as unknown as WebContents, senderFrame: owner.mainFrame };
	const command = (action: string, id: string | undefined = "one", locale = "en-US") => handle(event, action, id, locale);
	return { command, engines, owner, event, dispose, invoke: (...args: unknown[]) => handle(...args) };
}

describe("dictation ownership and native boundary", () => {
	it("forwards one final result to its owner and releases the engine", () => {
		const s = setup();
		expect(s.command("start")).toEqual({});
		s.engines[0].emit({ type: "recording" });
		s.command("stop");
		expect(s.engines[0].stop).toHaveBeenCalledOnce();
		s.engines[0].emit({ type: "result", text: "draft only" });
		expect(s.owner.send).toHaveBeenLastCalledWith(DICTATION_EVENT_CHANNEL, { id: "one", type: "result", text: "draft only" });
		expect(s.engines[0].cancel).toHaveBeenCalledOnce();
		s.engines[0].emit({ type: "result", text: "late" });
		expect(s.owner.send).toHaveBeenCalledTimes(2);
		expect(s.command("start", "two")).toEqual({});
		s.dispose();
	});

	it("rejects concurrent recording, foreign stop and stale callbacks", () => {
		const s = setup();
		s.command("start");
		expect(s.command("start", "two")).toEqual({ error: "busy" });
		s.command("cancel", "two");
		expect(s.engines[0].cancel).not.toHaveBeenCalled();
		s.command("cancel");
		s.command("start", "two");
		s.engines[0].emit({ type: "result", text: "discard" });
		expect(s.owner.send).not.toHaveBeenCalled();
		s.dispose();
		expect(s.engines[1].cancel).toHaveBeenCalledOnce();
	});

	it.each(["destroyed", "render-process-gone", "did-start-navigation"])("cancels on %s and removes listeners", (name) => {
		const s = setup();
		s.command("start");
		s.owner.emit(name, {}, "https://example.test", false, true);
		expect(s.engines[0].cancel).toHaveBeenCalledOnce();
		expect(s.owner.listenerCount("did-start-navigation")).toBe(0);
	});

	it("releases errors and validates both sender identity and frame", async () => {
		const s = setup();
		expect(await s.command("availability")).toEqual({ available: true });
		expect(() => s.invoke({ ...s.event, senderFrame: {} }, "start", "one", "en-US")).toThrow("Untrusted");
		expect(() => s.invoke({ ...s.event, sender: { id: 99 } }, "start", "one", "en-US")).toThrow("Untrusted");
		expect(s.command("start", "one", "en; command")).toEqual({ error: "unavailable" });
		s.command("start");
		s.engines[1].emit({ type: "error", error: "permission" });
		expect(s.owner.send).toHaveBeenLastCalledWith(DICTATION_EVENT_CHANNEL, { id: "one", type: "error", error: "permission" });
		expect(s.command("start", "two")).toEqual({});
		s.dispose();
	});
});
