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
	MULTICA_SET_SETTINGS_CHANNEL,
	MULTICA_STATE_CHANNEL,
	TOGGLE_MULTICA_SHORTCUT_CHANNEL,
	type MulticaSettings,
} from "../shared/multica";
import { createMulticaViewHost, type MulticaViewHostOptions } from "./multica-view-host";

const URL = "http://localhost:3000/";
const BUNDLE = { rendererUrl: "file:///multica/out/renderer/index.html", preloadPath: "/multica/out/preload/index.js" };

class FakeWebContents extends EventEmitter {
	private static nextId = 100;
	static lastHeaderHandler: ((details: unknown, callback: (response: unknown) => void) => void) | undefined;
	id = FakeWebContents.nextId++;
	destroyed = false;
	loadURL = vi.fn(async (_url: string) => undefined);
	focus = vi.fn();
	send = vi.fn();
	ipc = fakeIpc();
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
		setPreloads: vi.fn(),
		webRequest: {
			onBeforeSendHeaders: vi.fn((_filter: unknown, handler: (details: unknown, callback: (response: unknown) => void) => void) => {
				FakeWebContents.lastHeaderHandler = handler;
			}),
		},
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
	const contentViewListeners = new Map<string, () => void>();
	const contentBounds = { width: 1200, height: 800 };
	const contentView = {
		addChildView: vi.fn(),
		removeChildView: vi.fn(),
		getBounds: vi.fn(() => ({ x: 0, y: 0, ...contentBounds })),
		on: vi.fn((event: string, listener: () => void) => {
			contentViewListeners.set(event, listener);
		}),
		removeListener: vi.fn((event: string) => {
			contentViewListeners.delete(event);
		}),
	};
	const onTakeover = vi.fn();
	const ipc = fakeIpc();
	const openExternal = vi.fn(async (_url: string) => undefined);
	const writeUrl = vi.fn(async (url: string) => coerceMulticaSettings({ url }));
	const host = await createMulticaViewHost({
		mainWindow: { contentView },
		shellWebContents: shell,
		ipcMain: ipc,
		shell: { openExternal },
		WebContentsView: FakeWebContentsView,
		isMac: true,
		getKeybindingOverrides: () => ({}),
		isKeybindingRecording: () => false,
		readSettings: async () => initial,
		writeUrl,
		resolveBundle: () => BUNDLE,
		ipcJailPreload: "/ao/multica-ipc-jail.cjs",
		webSecurity: true,
		locale: "en-US",
		appInfo: { version: "1.2.3", os: "macos" },
		hostName: () => "dev-box",
		onTakeover,
		...overrides,
	} as unknown as MulticaViewHostOptions);
	const shellEvent = { sender: shell };
	return {
		host,
		shell,
		shellEvent,
		contentView,
		contentViewListeners,
		contentBounds,
		onTakeover,
		ipc,
		openExternal,
		writeUrl,
		view: () => FakeWebContentsView.instances[0],
		multicaEvent: () => ({ sender: FakeWebContentsView.instances[0].webContents, returnValue: undefined as unknown }),
		stateChannelPayloads: () =>
			shell.send.mock.calls.filter(([channel]) => channel === MULTICA_STATE_CHANNEL).map(([, state]) => state),
	};
}


function ready(t: Awaited<ReturnType<typeof setup>>) {
	t.host.setActive(true);
	t.view().webContents.emit("did-finish-load");
}

describe("multica view host: lazy creation and switching", () => {
	it("creates nothing until Multica is first activated", async () => {
		const t = await setup();
		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: false, status: "idle", url: URL });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(BUNDLE.rendererUrl);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});

	it("only shows and hides the page when switching: no reload, no new view", async () => {
		const t = await setup();
		ready(t);

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

	it("covers the whole window when ready, and hands the window chrome back with focus when switching to AO", async () => {
		const t = await setup();
		t.host.setActive(true);
		expect(t.onTakeover).not.toHaveBeenCalled();

		t.view().webContents.emit("did-finish-load");

		expect(t.view().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);
		expect(t.contentView.addChildView).toHaveBeenLastCalledWith(t.view());
		expect(t.view().webContents.focus).toHaveBeenCalled();
		expect(t.onTakeover).toHaveBeenLastCalledWith(true);

		t.host.setActive(false);

		expect(t.view().setVisible).toHaveBeenLastCalledWith(false);
		expect(t.shell.focus).toHaveBeenCalled();
		expect(t.onTakeover).toHaveBeenLastCalledWith(false);
	});

	it("follows the window size, also while hidden", async () => {
		const t = await setup();
		ready(t);

		t.contentBounds.width = 1000;
		t.contentBounds.height = 600;
		t.contentViewListeners.get("bounds-changed")?.();

		expect(t.view().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1000, height: 600 });
	});

	it("starts in the AO view", async () => {
		const t = await setup();
		expect(t.host.getState().active).toBe(false);
	});
});

describe("multica view host: lockdown", () => {
	it("attaches Multica's preload only to its own view, in a dedicated persistent partition", async () => {
		const t = await setup();
		t.host.setActive(true);
		const prefs = t.view().options.webPreferences;

		expect(prefs.partition).toBe(MULTICA_PARTITION);
		expect(prefs.partition).toMatch(/^persist:/);
		expect(prefs.preload).toBe(BUNDLE.preloadPath);
		expect(prefs.contextIsolation).toBe(true);
		expect(prefs.nodeIntegration).toBe(false);
		expect(prefs.sandbox).toBe(true);
		expect(prefs.webSecurity).toBe(true);
		expect(prefs.additionalArguments).toEqual(["--multica-locale=en-US"]);
	});

	it("confines the page's IPC with the jail preload, which runs before Multica's own", async () => {
		const t = await setup();
		t.host.setActive(true);

		expect(t.view().webContents.session.setPreloads).toHaveBeenCalledExactlyOnceWith(["/ao/multica-ipc-jail.cjs"]);
	});

	it("serves Multica's channels on the view's own ipc, never on the global one that holds AO's handlers", async () => {
		const t = await setup();
		t.host.setActive(true);

		for (const channel of ["daemon:start", "daemon:stop", "daemon:restart", "app:get-info", "shell:openExternal"]) {
			expect(t.view().webContents.ipc.handlers.has(channel) || t.view().webContents.ipc.listeners.has(channel)).toBe(true);
			expect(t.ipc.handlers.has(channel) || t.ipc.listeners.has(channel)).toBe(false);
		}
	});

	it("presents the Multica app origin on WebSocket handshakes to the API, since the file:// page sends a null origin", async () => {
		const t = await setup();
		t.host.setActive(true);
		const callback = vi.fn();

		FakeWebContents.lastHeaderHandler?.({ url: "ws://localhost:8080/ws", requestHeaders: { Origin: "null" } }, callback);

		expect(callback).toHaveBeenCalledExactlyOnceWith({ requestHeaders: { Origin: "http://localhost:3000" } });
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

	it("handles the switch shortcut in main while the page has focus, leaving every other chord to Multica", async () => {
		const t = await setup();
		ready(t);
		const contents = t.view().webContents;
		const toggle = { preventDefault: vi.fn() };
		const newSession = { preventDefault: vi.fn() };
		const input = { control: false, meta: true, shift: false, alt: false, type: "keyDown" };

		contents.emit("before-input-event", toggle, { ...input, key: "E", shift: true });
		contents.emit("before-input-event", newSession, { ...input, key: "n" });

		expect(toggle.preventDefault).toHaveBeenCalledOnce();
		expect(t.host.getState().active).toBe(false);
		expect(newSession.preventDefault).not.toHaveBeenCalled();
		expect(t.shell.send.mock.calls.map(([channel]) => channel)).not.toContain(TOGGLE_MULTICA_SHORTCUT_CHANNEL);
	});

	it("forwards Cmd+W to the page as a close-tab request without repeating it", async () => {
		const t = await setup();
		ready(t);
		const contents = t.view().webContents;
		const input = { control: false, meta: true, shift: false, alt: false, type: "keyDown", key: "w" };
		const first = { preventDefault: vi.fn() };
		const repeat = { preventDefault: vi.fn() };

		contents.emit("before-input-event", first, input);
		contents.emit("before-input-event", repeat, { ...input, isAutoRepeat: true });

		// AO's own close-terminal chord also consumes Cmd+W; either way the menu's Close never sees it.
		expect(first.preventDefault).toHaveBeenCalled();
		expect(repeat.preventDefault).toHaveBeenCalled();
		expect(contents.send).toHaveBeenCalledExactlyOnceWith("tab:close-active");
	});
});

describe("multica view host: navigation", () => {
	it("allows the bundle itself", async () => {
		const t = await setup();
		t.host.setActive(true);
		const event = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-navigate", event, `${BUNDLE.rendererUrl}#/issues`);

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(t.openExternal).not.toHaveBeenCalled();
	});

	it.each([
		["a web page", "https://example.com/docs"],
		["the Multica web app", "http://localhost:3000/issues/42"],
		["an email link", "mailto:team@example.com"],
	])("blocks %s and opens it in the system browser", async (_name, target) => {
		const t = await setup();
		t.host.setActive(true);
		const event = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-navigate", event, target);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(t.openExternal).toHaveBeenCalledExactlyOnceWith(target);
	});

	it.each(["javascript:alert(1)", "file:///etc/passwd", "file:///multica/out/other.html", "data:text/html,hi"])(
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

	it("never opens a popup window: web links go to the system browser, everything else is dropped", async () => {
		const t = await setup();
		t.host.setActive(true);
		const contents = t.view().webContents;

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

	it("shows an error state, hides the page, and reports the reason when the bundle fails to load", async () => {
		const t = await setup();
		ready(t);
		expect(t.view().setVisible).toHaveBeenLastCalledWith(true);

		t.view().webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", BUNDLE.rendererUrl, true);

		expect(t.host.getState()).toEqual({ active: true, status: "error", url: URL, error: "ERR_FILE_NOT_FOUND" });
		expect(t.view().setVisible).toHaveBeenLastCalledWith(false);
	});

	it("keeps the error when Chromium's error page finishes loading, as real Electron reports it", async () => {
		const t = await setup();
		t.host.setActive(true);

		// Observed sequence for a failed load: loading, fail, then finish for the error page.
		t.view().webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", BUNDLE.rendererUrl, true);
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "error", url: URL, error: "ERR_FILE_NOT_FOUND" });
		expect(t.stateChannelPayloads().map((state) => state.status)).toEqual(["idle", "loading", "error"]);
	});

	it("becomes ready after a retry that loads, even though an earlier load failed", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", BUNDLE.rendererUrl, true);
		t.view().webContents.emit("did-finish-load");

		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);
		t.view().webContents.emit("did-finish-load");

		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: URL });
	});

	it("ignores aborted loads and subframe failures", async () => {
		const t = await setup();
		ready(t);

		t.view().webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", BUNDLE.rendererUrl, true);
		t.view().webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://x/", false);

		expect(t.host.getState().status).toBe("ready");
	});

	it("reports a crashed page as an error", async () => {
		const t = await setup();
		ready(t);

		t.view().webContents.emit("render-process-gone", {}, { reason: "crashed" });

		expect(t.host.getState().status).toBe("error");
	});

	it("reports a missing bundle and retries creating the view on reload", async () => {
		let bundle: typeof BUNDLE | null = null;
		const t = await setup({ url: URL }, { resolveBundle: () => bundle });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toMatchObject({ active: true, status: "error", error: expect.stringContaining("bundle not found") });

		bundle = BUNDLE;
		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
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
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(BUNDLE.rendererUrl);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});

	it("tears the page down when the URL is cleared", async () => {
		const t = await setup();
		ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "");

		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
		expect(t.view().webContents.close).toHaveBeenCalledOnce();
		expect(t.onTakeover).toHaveBeenLastCalledWith(false);
		expect(t.host.getState()).toEqual({ active: true, status: "unconfigured", url: "" });
	});
});

describe("multica view host: changing the URL", () => {
	it("reloads the existing view so its preload reads the new runtime config", async () => {
		const t = await setup();
		ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, "https://multica.example.com");

		expect(t.view().webContents.loadURL).toHaveBeenCalledTimes(2);
		expect(FakeWebContentsView.instances).toHaveLength(1);
		const event = t.multicaEvent();
		t.view().webContents.ipc.emit("runtime-config:get", event);
		expect(event.returnValue).toMatchObject({ ok: true, config: { appUrl: "https://multica.example.com" } });
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

describe("multica view host: deep links", () => {
	it("holds a sign-in token until the renderer subscribes, then delivers it and surfaces Multica", async () => {
		const t = await setup();

		expect(t.host.handleDeepLink("multica://auth/callback?token=abc.def")).toBe(true);

		expect(t.host.getState().active).toBe(true);
		expect(t.view().webContents.send).not.toHaveBeenCalled();

		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		expect(t.view().webContents.send).toHaveBeenCalledExactlyOnceWith("auth:token", "abc.def");
	});

	it("waits again after the page reloads, since reloading drops the renderer's listeners", async () => {
		const t = await setup();
		ready(t);
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		t.view().webContents.emit("did-start-loading");
		t.host.handleDeepLink("multica://auth/callback?token=late");

		expect(t.view().webContents.send).not.toHaveBeenCalled();
	});

	it("ignores anything that is not a multica deep link, and does so when no URL is configured", async () => {
		const t = await setup();
		expect(t.host.handleDeepLink("ao-app://callback?token=x")).toBe(false);
		expect(t.host.handleDeepLink("multica://auth/callback")).toBe(false);
		expect(t.host.getState().active).toBe(false);

		const unconfigured = await setup({ url: "" });
		expect(unconfigured.host.handleDeepLink("multica://auth/callback?token=abc")).toBe(false);
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

	it("does not let the Multica page drive AO's own switch and settings channels", async () => {
		const t = await setup();
		t.host.setActive(true);
		const page = { sender: t.view().webContents };

		expect(t.ipc.invoke(MULTICA_GET_SETTINGS_CHANNEL, page)).toBeUndefined();
		t.ipc.invoke(MULTICA_SET_ACTIVE_CHANNEL, page, false);

		expect(t.host.getState().active).toBe(true);
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
		expect([...t.ipc.listeners.values()].every((set) => set.size === 0)).toBe(true);
		expect(t.contentViewListeners.size).toBe(0);
		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
		expect(t.view().webContents.close).toHaveBeenCalledOnce();
	});
});
