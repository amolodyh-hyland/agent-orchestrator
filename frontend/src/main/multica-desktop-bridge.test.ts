// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMulticaDesktopBridge, multicaBridgeChannels, type MulticaDesktopBridgeOptions } from "./multica-desktop-bridge";

const MULTICA = { id: 10 };
const STRANGER = { id: 99 };

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpc() {
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, Set<Handler>>();
	return {
		handlers,
		listeners,
		handle: vi.fn((channel: string, handler: Handler) => {
			handlers.set(channel, handler);
		}),
		on: vi.fn((channel: string, listener: Handler) => {
			listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
		}),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel);
		}),
		removeListener: vi.fn((channel: string, listener: Handler) => {
			listeners.get(channel)?.delete(listener);
		}),
		invoke: (channel: string, sender: { id: number }, ...args: unknown[]) => handlers.get(channel)?.({ sender }, ...args),
		// Mirrors a sendSync: the preload blocks until a listener sets returnValue.
		sendSync: (channel: string, sender: { id: number }): unknown => {
			const event = { sender, returnValue: undefined as unknown };
			listeners.get(channel)?.forEach((listener) => listener(event));
			return event.returnValue;
		},
		send: (channel: string, sender: { id: number }, ...args: unknown[]) =>
			listeners.get(channel)?.forEach((listener) => listener({ sender }, ...args)),
	};
}

function fakeDaemon() {
	return {
		getStatus: vi.fn(async () => ({ state: "running", pid: 7 })),
		start: vi.fn(async () => ({ success: true })),
		stop: vi.fn(async () => ({ success: true })),
		restart: vi.fn(async () => ({ success: true })),
		isInstalled: vi.fn(async () => true),
		refreshBinary: vi.fn(),
		probeRuntimes: vi.fn(async () => ({ probeResult: "error" })),
		startLogStream: vi.fn(),
		stopLogStream: vi.fn(),
		startPolling: vi.fn(),
		dispose: vi.fn(),
	};
}

function setup(overrides: Partial<MulticaDesktopBridgeOptions> = {}) {
	const ipc = fakeIpc();
	const openExternal = vi.fn(async (_url: string) => undefined);
	const send = vi.fn();
	const daemon = fakeDaemon();
	const bridge = createMulticaDesktopBridge({
		daemon,
		ipc,
		isMulticaSender: (sender: { id: number }) => sender.id === MULTICA.id,
		getAppInfo: () => ({ version: "1.2.3", os: "macos" }),
		getRuntimeConfig: () => ({
			ok: true,
			config: { schemaVersion: 1, apiUrl: "http://localhost:8080", wsUrl: "ws://localhost:8080/ws", appUrl: "http://localhost:3000" },
		}),
		getHostName: () => "dev-box",
		openExternal,
		send,
		...overrides,
	} as unknown as MulticaDesktopBridgeOptions);
	return { bridge, ipc, openExternal, send, daemon };
}

describe("multica desktop bridge: synchronous channels", () => {
	it("answers the boot channels for the Multica view", () => {
		const { ipc } = setup();

		expect(ipc.sendSync("app:get-info", MULTICA)).toEqual({ version: "1.2.3", os: "macos" });
		expect(ipc.sendSync("runtime-config:get", MULTICA)).toMatchObject({ ok: true, config: { apiUrl: "http://localhost:8080" } });
		expect(ipc.sendSync("freeze:get-last", MULTICA)).toBeNull();
	});

	it.each(["app:get-info", "runtime-config:get", "freeze:get-last"])(
		"still replies (with null) to %s from any other sender, so no caller can hang on it",
		(channel) => {
			const { ipc } = setup();

			expect(ipc.sendSync(channel, STRANGER)).toBeNull();
		},
	);

	it("replies with null instead of hanging the preload when producing the answer throws", () => {
		const { ipc } = setup({
			getRuntimeConfig: () => {
				throw new Error("boom");
			},
		});

		expect(ipc.sendSync("runtime-config:get", MULTICA)).toBeNull();
	});

	it("hands the renderer a blocking config error when no Multica URL is set", () => {
		const { ipc } = setup({ getRuntimeConfig: () => ({ ok: false, error: { message: "Multica URL is not set" } }) });

		expect(ipc.sendSync("runtime-config:get", MULTICA)).toEqual({ ok: false, error: { message: "Multica URL is not set" } });
	});
});

describe("multica desktop bridge: daemon", () => {
	it("never lets another sender reach the daemon service", async () => {
		const { ipc, daemon } = setup();

		for (const channel of ["daemon:start", "daemon:stop", "daemon:restart", "daemon:get-status", "daemon:probe-runtimes", "daemon:is-cli-installed", "daemon:retry-install"]) {
			await ipc.invoke(channel, STRANGER);
		}
		ipc.send("daemon:start-log-stream", STRANGER);
		ipc.send("daemon:stop-log-stream", STRANGER);

		for (const method of [daemon.start, daemon.stop, daemon.restart, daemon.getStatus, daemon.probeRuntimes, daemon.isInstalled, daemon.refreshBinary, daemon.startLogStream, daemon.stopLogStream]) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it("drives the log stream for the Multica view", () => {
		const { ipc, daemon } = setup();

		ipc.send("daemon:start-log-stream", MULTICA);
		ipc.send("daemon:stop-log-stream", MULTICA);

		expect(daemon.startLogStream).toHaveBeenCalledOnce();
		expect(daemon.stopLogStream).toHaveBeenCalledOnce();
	});

	it("never touches the CLI's login or server config: token and target sync do not reach the service", async () => {
		const { ipc, daemon } = setup();

		await ipc.invoke("daemon:sync-token", MULTICA, "secret", "user");
		await ipc.invoke("daemon:clear-token", MULTICA);
		await ipc.invoke("daemon:set-target-api-url", MULTICA, "http://elsewhere");
		await ipc.invoke("daemon:auto-start", MULTICA);

		for (const [name, method] of Object.entries(daemon)) {
			if (name !== "startPolling") expect(method).not.toHaveBeenCalled();
		}
	});

	it("does not pretend to support auto-start or stop-on-quit: preferences stay off", async () => {
		const { ipc } = setup();

		expect(await ipc.invoke("daemon:set-prefs", MULTICA, { autoStart: true, autoStop: true })).toEqual({ autoStart: false, autoStop: false });
		expect(await ipc.invoke("daemon:get-prefs", MULTICA)).toEqual({ autoStart: false, autoStop: false });
	});

	it("starts polling when created and disposes the service with the bridge", () => {
		const { bridge, daemon } = setup();
		expect(daemon.startPolling).toHaveBeenCalledOnce();

		bridge.dispose();

		expect(daemon.dispose).toHaveBeenCalledOnce();
	});
});

describe("multica desktop bridge: stubs and sender scoping", () => {
	const stubs: Array<[string, unknown[], unknown]> = [
		["file:download-url", ["https://x"], undefined],
		["window:setImmersive", [true], undefined],
		["window:open-issue", [{}], { ok: false, reason: "invalid_request" }],
		["local-directory:pick", [], { ok: false, reason: "error", error: "Not available in AO" }],
		["local-directory:validate", ["/tmp"], { ok: false, reason: "error", error: "Not available in AO" }],
		["daemon:start", [], { success: true }],
		["daemon:stop", [], { success: true }],
		["daemon:restart", [], { success: true }],
		["daemon:get-status", [], { state: "running", pid: 7 }],
		["daemon:probe-runtimes", [], { probeResult: "error" }],
		["daemon:get-host-name", [], "dev-box"],
		["daemon:set-target-api-url", ["http://x"], undefined],
		["daemon:sync-token", ["t", "u"], undefined],
		["daemon:clear-token", [], undefined],
		["daemon:reauthenticate", ["t", "u"], { ok: false, reason: "transient", message: expect.any(String) }],
		["daemon:is-cli-installed", [], true],
		["daemon:get-prefs", [], { autoStart: false, autoStop: false }],
		["daemon:set-prefs", [{ autoStart: true }], { autoStart: false, autoStop: false }],
		["daemon:auto-start", [], undefined],
		["daemon:retry-install", [], undefined],
		["daemon:open-log-file", [], { success: false, error: expect.any(String) }],
		["updater:download", [], undefined],
		["updater:install", [], undefined],
		["updater:get-preferences", [], { automaticUpdates: false }],
		["updater:set-automatic-updates", [true], { automaticUpdates: false }],
		["updater:check", [], { ok: false, error: expect.any(String) }],
	];

	it.each(stubs)("answers %s for the Multica view with a safe stub", async (channel, args, expected) => {
		const { ipc } = setup();

		await expect(Promise.resolve(ipc.invoke(channel, MULTICA, ...args))).resolves.toEqual(expected);
	});

	it.each(stubs)("ignores %s from any other sender", async (channel, args) => {
		const { ipc } = setup();

		expect(await ipc.invoke(channel, STRANGER, ...args)).toBeUndefined();
	});

	it("opens external links for the Multica view only, through the safe opener", async () => {
		const { ipc, openExternal } = setup();

		await ipc.invoke("shell:openExternal", MULTICA, "https://accounts.example.com/oauth");
		await ipc.invoke("shell:openExternal", STRANGER, "https://evil.example.com/");
		await ipc.invoke("shell:openExternal", MULTICA, { not: "a string" });

		expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://accounts.example.com/oauth");
	});

	it("does not surface a rejected external open to the page", async () => {
		const { ipc } = setup({ openExternal: vi.fn(async () => Promise.reject(new Error("Unsupported external URL"))) });

		await expect(ipc.invoke("shell:openExternal", MULTICA, "javascript:alert(1)")).resolves.toBeUndefined();
	});
});

describe("multica desktop bridge: main-to-renderer messages", () => {
	it("holds a message until the renderer announces its listener, then delivers it once", () => {
		const { bridge, ipc, send } = setup();

		bridge.dispatch("auth:token", "t1");
		expect(send).not.toHaveBeenCalled();

		ipc.send("main-renderer:channel-state", MULTICA, { channel: "auth:token", ready: true });
		expect(send).toHaveBeenCalledExactlyOnceWith("auth:token", "t1");

		bridge.dispatch("auth:token", "t2");
		expect(send).toHaveBeenLastCalledWith("auth:token", "t2");
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("ignores readiness reports from other senders and for unknown channels", () => {
		const { bridge, ipc, send } = setup();
		bridge.dispatch("auth:token", "t1");

		ipc.send("main-renderer:channel-state", STRANGER, { channel: "auth:token", ready: true });
		ipc.send("main-renderer:channel-state", MULTICA, { channel: "shell:openExternal", ready: true });
		ipc.send("main-renderer:channel-state", MULTICA, { channel: "auth:token", ready: "yes" });
		ipc.send("main-renderer:channel-state", MULTICA, null);

		expect(send).not.toHaveBeenCalled();
	});

	it("stops delivering when the renderer unsubscribes or the page reloads", () => {
		const { bridge, ipc, send } = setup();
		ipc.send("main-renderer:channel-state", MULTICA, { channel: "auth:token", ready: true });

		ipc.send("main-renderer:channel-state", MULTICA, { channel: "auth:token", ready: false });
		bridge.dispatch("auth:token", "t1");
		ipc.send("main-renderer:channel-state", MULTICA, { channel: "auth:token", ready: true });
		bridge.resetReadiness();
		bridge.dispatch("auth:token", "t2");

		expect(send).toHaveBeenCalledExactlyOnceWith("auth:token", "t1");
	});

	it("releases every registration on dispose", () => {
		const { bridge, ipc } = setup();

		bridge.dispose();

		expect(ipc.handlers.size).toBe(0);
		expect([...ipc.listeners.values()].every((set) => set.size === 0)).toBe(true);
	});
});

describe("multica desktop bridge: channel allowlist", () => {
	it("lists exactly the channels the bridge serves, so the IPC jail cannot drift from it", () => {
		const { ipc } = setup();

		const served = [...ipc.handlers.keys(), ...ipc.listeners.keys()].sort();

		expect([...multicaBridgeChannels()].sort()).toEqual(served);
	});
});
