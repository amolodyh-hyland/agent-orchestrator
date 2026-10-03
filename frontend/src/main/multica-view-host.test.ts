// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	coerceMulticaSettings,
	MULTICA_GET_SETTINGS_CHANNEL,
	MULTICA_GET_STATE_CHANNEL,
	MULTICA_PARTITION,
	MULTICA_RELOAD_CHANNEL,
	MULTICA_SET_ACTIVE_CHANNEL,
	MULTICA_SET_BOUNDS_CHANNEL,
	MULTICA_SET_SETTINGS_CHANNEL,
	MULTICA_STATE_CHANNEL,
	TOGGLE_MULTICA_SHORTCUT_CHANNEL,
	type MulticaSettings,
} from "../shared/multica";
import { createMulticaViewHost, type MulticaViewHostOptions } from "./multica-view-host";

const URL = "http://localhost:3000/";

class FakeWebContents extends EventEmitter {
	private static nextId = 100;
	id = FakeWebContents.nextId++;
	destroyed = false;
	loadURL = vi.fn(async (_url: string) => undefined);
	focus = vi.fn();
	close = vi.fn(() => {
		this.destroyed = true;
	});
	isDestroyed = () => this.destroyed;
	windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
	setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: string }) => {
		this.windowOpenHandler = handler;
	});
	permissionRequestHandler:
		| ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
		| undefined;
	permissionCheckHandler: ((...args: unknown[]) => boolean) | undefined;
	session = {
		setPermissionRequestHandler: vi.fn((handler: FakeWebContents["permissionRequestHandler"]) => {
			this.permissionRequestHandler = handler;
		}),
		setPermissionCheckHandler: vi.fn((handler: FakeWebContents["permissionCheckHandler"]) => {
			this.permissionCheckHandler = handler;
		}),
	};
}

type FakeViewOptions = { webPreferences: Record<string, unknown> };

class FakeWebContentsView {
	static instances: FakeWebContentsView[] = [];
	webContents = new FakeWebContents();
	setBounds = vi.fn();
	setVisible = vi.fn();
	constructor(public options: FakeViewOptions) {
		FakeWebContentsView.instances.push(this);
	}
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpc() {
	const handlers = new Map<string, IpcHandler>();
	const listeners = new Map<string, Set<IpcHandler>>();
	return {
		handlers,
		listeners,
		handle: vi.fn((channel: string, handler: IpcHandler) => {
			handlers.set(channel, handler);
		}),
		on: vi.fn((channel: string, listener: IpcHandler) => {
			listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
		}),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel);
		}),
		removeListener: vi.fn((channel: string, listener: IpcHandler) => {
			listeners.get(channel)?.delete(listener);
		}),
		invoke: (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)?.(event, ...args),
		emit: (channel: string, event: unknown, ...args: unknown[]) =>
			listeners.get(channel)?.forEach((listener) => listener(event, ...args)),
	};
}

async function setup(initial: MulticaSettings = { url: URL }, overrides: Partial<MulticaViewHostOptions> = {}) {
	FakeWebContentsView.instances = [];
	const shell = {
		id: 1,
		send: vi.fn(),
		focus: vi.fn(),
		isDestroyed: () => false,
		getZoomFactor: vi.fn(() => 1),
	};
	const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
	const ipc = fakeIpc();
	const openExternal = vi.fn(async (_url: string) => undefined);
	const restackShell = vi.fn();
	const writeUrl = vi.fn(async (url: string) => coerceMulticaSettings({ url }));
	const host = await createMulticaViewHost({
		mainWindow: { contentView, getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }) },
		shellWebContents: shell,
		ipcMain: ipc,
		shell: { openExternal },
		WebContentsView: FakeWebContentsView,
		isMac: true,
		getKeybindingOverrides: () => ({}),
		isKeybindingRecording: () => false,
		restackShell,
		readSettings: async () => initial,
		writeUrl,
		...overrides,
	} as unknown as MulticaViewHostOptions);
	const shellEvent = { sender: shell };
	return {
		host,
		shell,
		shellEvent,
		contentView,
		ipc,
		openExternal,
		restackShell,
		writeUrl,
		view: () => FakeWebContentsView.instances[0],
		sendBounds: (revision: number, rect: unknown) => ipc.emit(MULTICA_SET_BOUNDS_CHANNEL, shellEvent, { revision, rect }),
		stateChannelPayloads: () =>
			shell.send.mock.calls.filter(([channel]) => channel === MULTICA_STATE_CHANNEL).map(([, state]) => state),
	};
}

const RECT = { x: 260, y: 40, width: 900, height: 700 };

async function ready(t: Awaited<ReturnType<typeof setup>>) {
	t.host.setActive(true);
	t.sendBounds(1, RECT);
	t.view().webContents.emit("did-finish-load");
}

describe("multica view host: lazy creation and switching", () => {
	it("creates nothing until Multica is first activated", async () => {
		const t = await setup();
		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: false, status: "idle", url: URL });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(URL);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});

	it("only shows and hides the page when switching: no reload, no new view", async () => {
		const t = await setup();
		await ready(t);

		for (let i = 0; i < 3; i++) {
			t.host.toggle();
			expect(t.host.getState().active).toBe(false);
			t.host.toggle();
			expect(t.host.getState().active).toBe(true);
		}

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.loadURL).toHaveBeenCalledOnce();
		expect(t.view().webContents.close).not.toHaveBeenCalled();
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);
	});

	it("hides the page and returns focus to the shell when switching back to AO", async () => {
		const t = await setup();
		await ready(t);
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);
		expect(t.view().webContents.focus).toHaveBeenCalled();

		t.host.setActive(false);

		expect(t.view().setVisible).toHaveBeenLastCalledWith(false);
		expect(t.shell.focus).toHaveBeenCalled();
	});

	it("starts in the AO view", async () => {
		const t = await setup();
		expect(t.host.getState().active).toBe(false);
	});
});

describe("multica view host: lockdown", () => {
	it("uses a dedicated persistent partition and exposes no AO preload or Node access", async () => {
		const t = await setup();
		t.host.setActive(true);
		const prefs = t.view().options.webPreferences;

		expect(prefs.partition).toBe(MULTICA_PARTITION);
		expect(prefs.partition).toMatch(/^persist:/);
		expect(prefs.contextIsolation).toBe(true);
		expect(prefs.nodeIntegration).toBe(false);
		expect(prefs.sandbox).toBe(true);
		expect(prefs).not.toHaveProperty("preload");
	});

	it("denies every permission request and check", async () => {
		const t = await setup();
		t.host.setActive(true);
		const contents = t.view().webContents;

		for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "clipboard-sanitized-write"]) {
			const callback = vi.fn();
			contents.permissionRequestHandler?.(contents, permission, callback);
			expect(callback).toHaveBeenCalledExactlyOnceWith(false);
			expect(contents.permissionCheckHandler?.(contents, permission)).toBe(false);
		}
	});

	it("only forwards the switch shortcut from the page, leaving every other chord to Multica", async () => {
		const t = await setup();
		t.host.setActive(true);
		const contents = t.view().webContents;
		const toggle = { preventDefault: vi.fn() };
		const newSession = { preventDefault: vi.fn() };
		const input = { control: false, meta: true, shift: false, alt: false, type: "keyDown" };

		contents.emit("before-input-event", toggle, { ...input, key: "E", shift: true });
		contents.emit("before-input-event", newSession, { ...input, key: "n" });

		expect(toggle.preventDefault).toHaveBeenCalledOnce();
		expect(t.shell.send).toHaveBeenCalledWith(TOGGLE_MULTICA_SHORTCUT_CHANNEL);
		expect(t.shell.focus).toHaveBeenCalled();
		expect(newSession.preventDefault).not.toHaveBeenCalled();
		expect(t.shell.send.mock.calls.map(([channel]) => channel)).not.toContain("app:new-session");
	});
});

describe("multica view host: navigation", () => {
	it("allows main-frame navigation within the configured origin", async () => {
		const t = await setup();
		t.host.setActive(true);
		const event = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-navigate", event, "http://localhost:3000/issues/42?tab=activity");

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(t.openExternal).not.toHaveBeenCalled();
	});

	it.each([
		["another origin", "https://example.com/docs"],
		["another port", "http://localhost:3001/"],
		["a different scheme", "https://localhost:3000/"],
		["an email link", "mailto:team@example.com"],
	])("blocks %s and opens it in the system browser", async (_name, target) => {
		const t = await setup();
		t.host.setActive(true);
		const event = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-navigate", event, target);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(t.openExternal).toHaveBeenCalledExactlyOnceWith(target);
	});

	it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"])(
		"blocks %s without handing it to the system",
		async (target) => {
			const t = await setup();
			t.host.setActive(true);
			const event = { preventDefault: vi.fn() };

			t.view().webContents.emit("will-navigate", event, target);

			expect(event.preventDefault).toHaveBeenCalledOnce();
			expect(t.openExternal).not.toHaveBeenCalled();
		},
	);

	it("applies the same rule to main-frame redirects but ignores subframes", async () => {
		const t = await setup();
		t.host.setActive(true);
		const redirect = { preventDefault: vi.fn() };
		const subframe = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-redirect", redirect, "https://accounts.example.com/login", false, true);
		t.view().webContents.emit("will-redirect", subframe, "https://ads.example.com/frame", false, false);

		expect(redirect.preventDefault).toHaveBeenCalledOnce();
		expect(t.openExternal).toHaveBeenCalledExactlyOnceWith("https://accounts.example.com/login");
		expect(subframe.preventDefault).not.toHaveBeenCalled();
	});

	it("never opens a popup window: same-origin loads in place, everything else goes to the system browser", async () => {
		const t = await setup();
		t.host.setActive(true);
		const contents = t.view().webContents;

		expect(contents.windowOpenHandler?.({ url: "http://localhost:3000/issues/7" })).toEqual({ action: "deny" });
		expect(contents.loadURL).toHaveBeenLastCalledWith("http://localhost:3000/issues/7");
		expect(contents.windowOpenHandler?.({ url: "https://example.com/" })).toEqual({ action: "deny" });
		expect(t.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");
		expect(contents.windowOpenHandler?.({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
		expect(t.openExternal).toHaveBeenCalledOnce();
	});
});

describe("multica view host: load state", () => {
	it("reports ready after the page loads and pushes each state to the shell", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: URL });
		expect(t.stateChannelPayloads().at(-1)).toEqual({ active: true, status: "ready", url: URL });
	});

	it("shows an error state, hides the page, and reports the reason when the server is unreachable", async () => {
		const t = await setup();
		await ready(t);
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);

		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", URL, true);

		expect(t.host.getState()).toEqual({ active: true, status: "error", url: URL, error: "ERR_CONNECTION_REFUSED" });
		expect(t.view().setVisible).toHaveBeenLastCalledWith(false);
	});

	it("keeps the error when Chromium's error page finishes loading, as real Electron reports it", async () => {
		const t = await setup();
		t.host.setActive(true);

		// Observed sequence for an unreachable server: loading, fail, then finish for the error page.
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", URL, true);
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "error", url: URL, error: "ERR_CONNECTION_REFUSED" });
		expect(t.stateChannelPayloads().map((state) => state.status)).toEqual(["idle", "loading", "error"]);
	});

	it("becomes ready after a retry that loads, even though an earlier load failed", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", URL, true);
		t.view().webContents.emit("did-finish-load");

		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: URL });
	});

	it("recovers when the URL is changed after a failure", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", URL, true);
		t.view().webContents.emit("did-finish-load");

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "http://localhost:3100");
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: "http://localhost:3100/" });
	});

	it("ignores aborted loads and subframe failures", async () => {
		const t = await setup();
		await ready(t);

		t.view().webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", URL, true);
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://x/", false);

		expect(t.host.getState().status).toBe("ready");
	});

	it("reports a crashed page as an error", async () => {
		const t = await setup();
		await ready(t);

		t.view().webContents.emit("render-process-gone", {}, { reason: "crashed" });

		expect(t.host.getState().status).toBe("error");
	});

	it("retries by loading the configured URL again", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", URL, true);

		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);

		expect(t.view().webContents.loadURL).toHaveBeenCalledTimes(2);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});
});

describe("multica view host: bounds", () => {
	it("places the page over the reported slot only while active and ready", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.sendBounds(1, RECT);
		expect(t.view().setBounds).not.toHaveBeenCalled();

		t.view().webContents.emit("did-finish-load");

		expect(t.view().setBounds).toHaveBeenLastCalledWith(RECT);
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);
		expect(t.contentView.addChildView).toHaveBeenLastCalledWith(t.view());
	});

	it("scales for page zoom and clamps to the window", async () => {
		const t = await setup();
		t.shell.getZoomFactor.mockReturnValue(2);
		await ready(t);

		t.sendBounds(2, { x: 260, y: 40, width: 900, height: 700 });

		expect(t.view().setBounds).toHaveBeenLastCalledWith({ x: 520, y: 80, width: 680, height: 720 });
	});

	it("hides the page when the slot goes away", async () => {
		const t = await setup();
		await ready(t);

		t.sendBounds(2, null);

		expect(t.view().setVisible).toHaveBeenLastCalledWith(false);
	});

	it("drops stale, malformed and untrusted bounds", async () => {
		const t = await setup();
		await ready(t);
		const applied = t.view().setBounds.mock.calls.length;

		t.sendBounds(1, { x: 0, y: 0, width: 10, height: 10 });
		t.sendBounds(5, { x: 0, y: 0, width: Number.NaN, height: 10 });
		t.sendBounds(6, "nope");
		t.ipc.emit(MULTICA_SET_BOUNDS_CHANNEL, { sender: { id: 999, getZoomFactor: () => 1 } }, { revision: 9, rect: RECT });

		expect(t.view().setBounds).toHaveBeenCalledTimes(applied);
	});

	it("keeps a dialog above the page when the page becomes visible while one is open", async () => {
		const t = await setup();
		t.ipc.emit("browser:overlay", t.shellEvent, true);

		await ready(t);

		expect(t.restackShell).toHaveBeenCalledOnce();
	});

	it("leaves the shell stacking alone when no dialog is open", async () => {
		const t = await setup();
		await ready(t);
		expect(t.restackShell).not.toHaveBeenCalled();
	});
});

describe("multica view host: not configured", () => {
	it("shows the empty state without creating a view", async () => {
		const t = await setup({ url: "" });
		expect(t.host.getState()).toEqual({ active: false, status: "unconfigured", url: "" });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: true, status: "unconfigured", url: "" });
	});

	it("loads the page when a URL is saved while the empty state is showing", async () => {
		const t = await setup({ url: "" });
		t.host.setActive(true);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "localhost:3000");

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(URL);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});

	it("tears the page down when the URL is cleared", async () => {
		const t = await setup();
		await ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "");

		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
		expect(t.view().webContents.close).toHaveBeenCalledOnce();
		expect(t.host.getState()).toEqual({ active: true, status: "unconfigured", url: "" });
	});
});

describe("multica view host: changing the URL", () => {
	it("navigates the existing view and pins navigation to the new origin", async () => {
		const t = await setup();
		await ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "https://multica.example.com");

		expect(t.view().webContents.loadURL).toHaveBeenLastCalledWith("https://multica.example.com/");
		expect(FakeWebContentsView.instances).toHaveLength(1);
		const toOld = { preventDefault: vi.fn() };
		const toNew = { preventDefault: vi.fn() };
		t.view().webContents.emit("will-navigate", toOld, "http://localhost:3000/");
		t.view().webContents.emit("will-navigate", toNew, "https://multica.example.com/issues");
		expect(toOld.preventDefault).toHaveBeenCalledOnce();
		expect(toNew.preventDefault).not.toHaveBeenCalled();
	});

	it("does not create a view for a URL saved while AO is showing", async () => {
		const t = await setup({ url: "" });

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, URL);

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: false, status: "idle", url: URL });
	});

	it("rejects an invalid URL without changing state", async () => {
		const t = await setup();
		t.writeUrl.mockRejectedValueOnce(new Error("Invalid Multica URL"));

		await expect(t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "ftp://x")).rejects.toThrow();

		expect(t.host.getState().url).toBe(URL);
	});
});

describe("multica view host: IPC trust", () => {
	it("serves the shell and ignores every other sender", async () => {
		const t = await setup();
		const stranger = { sender: { id: 999 } };

		expect(t.ipc.invoke(MULTICA_GET_STATE_CHANNEL, t.shellEvent)).toEqual({ active: false, status: "idle", url: URL });
		expect(t.ipc.invoke(MULTICA_GET_STATE_CHANNEL, stranger)).toBeUndefined();
		t.ipc.invoke(MULTICA_SET_ACTIVE_CHANNEL, stranger, true);
		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, stranger);
		expect(t.ipc.invoke(MULTICA_GET_SETTINGS_CHANNEL, stranger)).toBeUndefined();
		await expect(t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, stranger, "http://evil.test")).resolves.toBeUndefined();

		expect(t.host.getState().active).toBe(false);
		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.writeUrl).not.toHaveBeenCalled();
	});

	it("ignores non-boolean activation payloads", async () => {
		const t = await setup();

		t.ipc.invoke(MULTICA_SET_ACTIVE_CHANNEL, t.shellEvent, "yes");
		expect(t.host.getState().active).toBe(false);

		t.ipc.invoke(MULTICA_SET_ACTIVE_CHANNEL, t.shellEvent, true);
		expect(t.host.getState().active).toBe(true);
	});
});

describe("multica view host: dispose", () => {
	it("releases IPC registrations and the view so a recreated window can register again", async () => {
		const t = await setup();
		t.host.setActive(true);

		t.host.dispose();

		expect(t.ipc.handlers.size).toBe(0);
		expect(t.ipc.listeners.get(MULTICA_SET_BOUNDS_CHANNEL)?.size ?? 0).toBe(0);
		expect(t.ipc.listeners.get("browser:overlay")?.size ?? 0).toBe(0);
		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
		expect(t.view().webContents.close).toHaveBeenCalledOnce();
	});
});
