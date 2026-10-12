import { describe, expect, it, vi } from "vitest";
import {
	MULTICA_LOCAL_SERVER_CANCEL_CHANNEL,
	MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL,
	MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL,
	MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL,
	MULTICA_LOCAL_SERVER_RESTART_CHANNEL,
	MULTICA_LOCAL_SERVER_SETUP_CHANNEL,
	MULTICA_LOCAL_SERVER_START_CHANNEL,
	MULTICA_LOCAL_SERVER_STOP_CHANNEL,
	MULTICA_LOCAL_SERVER_USE_DETECTED_CHANNEL,
	MULTICA_LOCAL_SERVER_WATCH_CHANNEL,
	EMPTY_LOCAL_SERVER_STATUS,
} from "../shared/multica-local-server";
import type { LocalServerLogsResult } from "../shared/multica-local-server";
import { registerMulticaLocalServerIpc } from "./multica-local-server-ipc";

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

function setup() {
	const handlers = new Map<string, Handler>();
	const ipcMain = {
		handle: vi.fn((channel: string, handler: Handler) => void handlers.set(channel, handler)),
		removeHandler: vi.fn((channel: string) => void handlers.delete(channel)),
	};
	const server = {
		getStatus: vi.fn(async () => ({ ...EMPTY_LOCAL_SERVER_STATUS, state: "stopped" as const })),
		watch: vi.fn(),
		start: vi.fn(async () => ({ ok: true }) as const),
		stop: vi.fn(async () => ({ ok: true }) as const),
		restart: vi.fn(async () => ({ ok: true }) as const),
		cancel: vi.fn(() => ({ ok: true }) as const),
		setup: vi.fn(async () => ({ ok: true }) as const),
		chooseFolder: vi.fn(async () => ({ ok: true }) as const),
		useDetectedFolder: vi.fn(async () => ({ ok: true }) as const),
		getLogs: vi.fn(async (): Promise<LocalServerLogsResult> => ({ ok: true, lines: ["x"] })),
	};
	const registration = registerMulticaLocalServerIpc({ ipcMain: ipcMain as never, shellWebContents: { id: 7 }, server });
	const shell = { sender: { id: 7 } };
	const other = { sender: { id: 99 } };
	return { handlers, ipcMain, server, registration, shell, other, call: (channel: string, event: { sender: { id: number } }, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}

const OPERATIONS: Array<[string, "start" | "stop" | "restart" | "setup" | "chooseFolder" | "useDetectedFolder" | "cancel"]> = [
	[MULTICA_LOCAL_SERVER_START_CHANNEL, "start"],
	[MULTICA_LOCAL_SERVER_STOP_CHANNEL, "stop"],
	[MULTICA_LOCAL_SERVER_RESTART_CHANNEL, "restart"],
	[MULTICA_LOCAL_SERVER_SETUP_CHANNEL, "setup"],
	[MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL, "chooseFolder"],
	[MULTICA_LOCAL_SERVER_USE_DETECTED_CHANNEL, "useDetectedFolder"],
	[MULTICA_LOCAL_SERVER_CANCEL_CHANNEL, "cancel"],
];

describe("registerMulticaLocalServerIpc", () => {
	it("runs each operation for the shell", async () => {
		const t = setup();
		for (const [channel, method] of OPERATIONS) {
			expect(await t.call(channel, t.shell)).toEqual({ ok: true });
			expect(t.server[method]).toHaveBeenCalledOnce();
		}
		expect(await t.call(MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL, t.shell)).toMatchObject({ state: "stopped" });
	});

	it("ignores every channel from any other sender, such as the embedded Multica page", async () => {
		const t = setup();
		for (const [channel] of OPERATIONS) expect(await t.call(channel, t.other)).toEqual({ ok: false, code: "bad_request" });
		expect(await t.call(MULTICA_LOCAL_SERVER_WATCH_CHANNEL, t.other, true)).toEqual({ ok: false, code: "bad_request" });
		expect(await t.call(MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL, t.other, { service: "backend" })).toEqual({ ok: false, code: "bad_request" });
		expect(await t.call(MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL, t.other)).toEqual(EMPTY_LOCAL_SERVER_STATUS);
		for (const method of Object.values(t.server)) expect(method).not.toHaveBeenCalled();
	});

	it("takes no path or command text: a payload on an operation channel is ignored", async () => {
		const t = setup();
		await t.call(MULTICA_LOCAL_SERVER_START_CHANNEL, t.shell, { dir: "/etc", args: ["down", "-v"] }, "x");
		expect(t.server.start).toHaveBeenCalledWith();
		await t.call(MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL, t.shell, "/etc");
		expect(t.server.chooseFolder).toHaveBeenCalledWith();
	});

	it("validates the watch flag", async () => {
		const t = setup();
		expect(await t.call(MULTICA_LOCAL_SERVER_WATCH_CHANNEL, t.shell, true)).toEqual({ ok: true });
		expect(t.server.watch).toHaveBeenCalledWith(true);
		for (const bad of ["true", 1, null, undefined]) expect(await t.call(MULTICA_LOCAL_SERVER_WATCH_CHANNEL, t.shell, bad)).toEqual({ ok: false, code: "bad_request" });
		expect(t.server.watch).toHaveBeenCalledOnce();
	});

	it("passes a log request only with an enumerated service and a sane line count", async () => {
		const t = setup();
		expect(await t.call(MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL, t.shell, { service: "backend" })).toEqual({ ok: true, lines: ["x"] });
		expect(t.server.getLogs).toHaveBeenLastCalledWith("backend", 200);
		await t.call(MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL, t.shell, { service: "frontend", tail: 9999 });
		expect(t.server.getLogs).toHaveBeenLastCalledWith("frontend", 500);

		t.server.getLogs.mockClear();
		for (const bad of [null, "backend", {}, { service: "backend; ls" }, { service: "--follow" }, { service: "backend", tail: 0 }, { service: "backend", tail: "5" }, { service: "backend", tail: 2.5 }]) {
			expect(await t.call(MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL, t.shell, bad)).toEqual({ ok: false, code: "bad_request" });
		}
		expect(t.server.getLogs).not.toHaveBeenCalled();
	});

	it("removes its handlers and stops the poll on dispose", async () => {
		const t = setup();
		t.registration.dispose();
		expect(t.handlers.size).toBe(0);
		expect(t.server.watch).toHaveBeenCalledWith(false);
		t.registration.dispose();
		expect(t.ipcMain.removeHandler).toHaveBeenCalledTimes(10);
	});
});
