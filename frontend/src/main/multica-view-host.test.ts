// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	coerceMulticaSettings,
	multicaRuntimeConfig,
	MULTICA_CHECK_SERVER_CHANNEL,
	MULTICA_CLOUD_PARTITION,
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
import { createMulticaNotifications } from "./multica-notifications";
import { createMulticaViewHost, type MulticaViewHostOptions } from "./multica-view-host";

const URL = "http://localhost:3000";
const local = (customUrl: string): MulticaSettings => ({ mode: "local", customUrl, apiUrl: "" });
const localRequest = (customUrl: string) => ({ mode: "local" as const, customUrl, force: true });
const BUNDLE = { rendererUrl: "file:///multica/out/renderer/index.html", preloadPath: "/multica/out/preload/index.js" };

class FakeWebContents extends EventEmitter {
	private static nextId = 100;
	static lastHeaderHandler: ((details: unknown, callback: (response: unknown) => void) => void) | undefined;
	id = FakeWebContents.nextId++;
	destroyed = false;
	loadURL = vi.fn(async (_url: string) => undefined);
	executeJavaScript = vi.fn(async (_script: string): Promise<unknown> => undefined);
	executeJavaScriptInIsolatedWorld = vi.fn(async (_worldId: number, _scripts: Array<{ code: string }>): Promise<unknown> => undefined);
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

async function setup(initial: MulticaSettings = local(URL), overrides: Partial<MulticaViewHostOptions> = {}) {
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
	const attachedChildren = new Set<unknown>();
	const contentView = {
		attachedChildren,
		addChildView: vi.fn((child: unknown) => {
			attachedChildren.add(child);
		}),
		removeChildView: vi.fn((child: unknown) => {
			attachedChildren.delete(child);
		}),
		getBounds: vi.fn(() => ({ x: 0, y: 0, ...contentBounds })),
		on: vi.fn((event: string, listener: () => void) => {
			contentViewListeners.set(event, listener);
		}),
		removeListener: vi.fn((event: string) => {
			contentViewListeners.delete(event);
		}),
	};
	const onTakeover = vi.fn();
	const daemonDispose = vi.fn();
	const notifications = {
		showNotification: vi.fn(),
		reportAuthSession: vi.fn(),
		setBadge: vi.fn(),
		reset: vi.fn(),
	};
	const ipc = fakeIpc();
	const openExternal = vi.fn(async (_url: string) => undefined);
	const writeSettings = vi.fn(async (settings: MulticaSettings) => coerceMulticaSettings(settings));
	const checkServer = vi.fn(async (request: { customUrl: string }) => {
		const derived = multicaRuntimeConfig(request.customUrl);
		return { ok: true as const, apiUrl: derived.ok ? derived.config.apiUrl : "" };
	});
	const latestView = () => FakeWebContentsView.instances[FakeWebContentsView.instances.length - 1];
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
		writeSettings,
		checkServer,
		resolveBundle: () => BUNDLE,
		ipcJailPreload: "/ao/multica-ipc-jail.cjs",
		webSecurity: true,
		locale: "en-US",
		appInfo: { version: "1.2.3", os: "macos" },
		notifications,
		hostName: () => "dev-box",
		createDaemonService: () => ({
			getStatus: vi.fn(async () => ({ state: "stopped" })),
			start: vi.fn(),
			stop: vi.fn(),
			restart: vi.fn(),
			isInstalled: vi.fn(),
			refreshBinary: vi.fn(),
			probeRuntimes: vi.fn(),
			startLogStream: vi.fn(),
			stopLogStream: vi.fn(),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
			dispose: daemonDispose,
		}),
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
		daemonDispose,
		notifications,
		ipc,
		openExternal,
		writeSettings,
		checkServer,
		view: latestView,
		multicaEvent: () => ({ sender: latestView().webContents, returnValue: undefined as unknown }),
		stateChannelPayloads: () =>
			shell.send.mock.calls.filter(([channel]) => channel === MULTICA_STATE_CHANNEL).map(([, state]) => state),
	};
}

function setupRealNotifications() {
	type Banner = {
		handlers: Map<"click" | "failed", () => void>;
		on: (event: "click" | "failed", listener: () => void) => void;
		show: () => void;
		close: () => void;
		click: () => void;
	};
	const banners: Banner[] = [];
	const openInboxItem = vi.fn();
	const setBadge = vi.fn();
	const createNotification = vi.fn(() => {
		const handlers = new Map<"click" | "failed", () => void>();
		const banner: Banner = {
			handlers,
			on: (event, listener) => handlers.set(event, listener),
			show: vi.fn(),
			close: vi.fn(),
			click: () => handlers.get("click")?.(),
		};
		banners.push(banner);
		return banner;
	});
	const service = createMulticaNotifications({
		isSupported: () => true,
		createNotification,
		isWindowFocused: () => false,
		isMulticaShown: () => false,
		openInboxItem,
		setBadge,
	});
	return { service, banners, createNotification, openInboxItem, setBadge };
}

function notificationPayload(itemId: string) {
	return {
		slug: "team/project",
		itemId,
		issueKey: `AO-${itemId}`,
		title: "New comment",
		body: "A comment was added",
	};
}


/** What Multica's login page does: open `<web app>/login?platform=desktop` in the browser from the view. */
async function startSignIn(t: Awaited<ReturnType<typeof setup>>, base = URL) {
	const contents = t.view().webContents;
	await contents.ipc.invoke("shell:openExternal", { sender: contents }, `${base}/login?platform=desktop`);
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

	it("leaves exactly one attached view and AO focused after repeated AO -> Multica -> AO switches", async () => {
		const t = await setup();
		t.host.setActive(true);
		// Creating the view must not attach it: only a ready, shown page belongs to the window.
		expect(t.contentView.attachedChildren.size).toBe(0);
		t.view().webContents.emit("did-finish-load");

		for (let i = 0; i < 5; i++) {
			expect(t.contentView.attachedChildren).toEqual(new Set([t.view()]));
			t.shell.focus.mockClear();

			t.host.setActive(false);
			expect(t.contentView.attachedChildren.size).toBe(0);
			expect(t.shell.focus).toHaveBeenCalledOnce();
			expect(t.host.isShown()).toBe(false);

			t.host.setActive(true);
		}
		expect(t.contentView.attachedChildren).toEqual(new Set([t.view()]));
		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.close).not.toHaveBeenCalled();
	});

	it("focuses the shell only after the Multica view has been detached", async () => {
		const t = await setup();
		ready(t);

		t.host.setActive(false);

		const detachedAt = t.contentView.removeChildView.mock.invocationCallOrder[0];
		expect(detachedAt).toBeLessThan(t.shell.focus.mock.invocationCallOrder[0]);
	});

	it("makes switching idempotent and detaches when the page stops being ready while shown", async () => {
		const t = await setup();
		ready(t);
		t.host.setActive(true);
		t.host.setActive(true);
		expect(t.contentView.addChildView).toHaveBeenCalledOnce();

		await t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);
		expect(t.contentView.attachedChildren.size).toBe(0);

		t.host.setActive(false);
		t.host.setActive(false);
		expect(t.contentView.removeChildView).toHaveBeenCalledOnce();
		expect(t.contentView.attachedChildren.size).toBe(0);
	});

	it("keeps a page that finishes loading while AO is showing detached", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.host.setActive(false);

		t.view().webContents.emit("did-finish-load");

		expect(t.contentView.addChildView).not.toHaveBeenCalled();
		expect(t.contentView.attachedChildren.size).toBe(0);
	});

	it("reports whether the ready Multica view covers the AO window", async () => {
		const t = await setup();
		expect(t.host.isShown()).toBe(false);

		t.host.setActive(true);
		expect(t.host.isShown()).toBe(false);

		t.view().webContents.emit("did-finish-load");
		expect(t.host.isShown()).toBe(true);

		t.host.setActive(false);
		expect(t.host.isShown()).toBe(false);
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
		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
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

	it("offers window-open targets to the AO session-link handler before the external allowlist", async () => {
		const onAoSessionLink = vi.fn(() => true);
		const t = await setup(local(URL), { onAoSessionLink });
		t.host.setActive(true);
		const contents = t.view().webContents;
		const target = "ao://sessions/p/s";

		expect(contents.windowOpenHandler?.({ url: target })).toEqual({ action: "deny" });

		expect(onAoSessionLink).toHaveBeenCalledExactlyOnceWith(target);
		expect(t.openExternal).not.toHaveBeenCalled();
	});

	it("keeps the external allowlist behavior when the AO session-link handler declines or is absent", async () => {
		const onAoSessionLink = vi.fn(() => false);
		const declined = await setup(local(URL), { onAoSessionLink });
		declined.host.setActive(true);
		const declinedContents = declined.view().webContents;
		declinedContents.windowOpenHandler?.({ url: "ao://sessions/p/s" });
		declinedContents.windowOpenHandler?.({ url: "https://example.com/" });

		expect(onAoSessionLink).toHaveBeenNthCalledWith(1, "ao://sessions/p/s");
		expect(onAoSessionLink).toHaveBeenNthCalledWith(2, "https://example.com/");
		expect(declined.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");

		const absent = await setup();
		absent.host.setActive(true);
		const absentContents = absent.view().webContents;
		absentContents.windowOpenHandler?.({ url: "https://example.com/" });
		absentContents.windowOpenHandler?.({ url: "ao://sessions/p/s" });

		expect(absent.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/");
	});

	it("offers blocked will-navigate targets to the AO session-link handler", async () => {
		const onAoSessionLink = vi.fn(() => true);
		const t = await setup(local(URL), { onAoSessionLink });
		t.host.setActive(true);
		const event = { preventDefault: vi.fn() };

		t.view().webContents.emit("will-navigate", event, "ao://sessions/p/s");

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(onAoSessionLink).toHaveBeenCalledExactlyOnceWith("ao://sessions/p/s");
		expect(t.openExternal).not.toHaveBeenCalled();
	});
});

describe("multica view host: page hooks", () => {
	it("reports every page title and tolerates an absent title handler", async () => {
		const onPageTitleChange = vi.fn();
		const t = await setup(local(URL), { onPageTitleChange });
		t.host.setActive(true);

		t.view().webContents.emit("page-title-updated", {}, "MUL-1: First title");
		t.view().webContents.emit("page-title-updated", {}, "MUL-1: Updated title");

		expect(onPageTitleChange).toHaveBeenNthCalledWith(1, "MUL-1: First title");
		expect(onPageTitleChange).toHaveBeenNthCalledWith(2, "MUL-1: Updated title");

		const withoutHandler = await setup();
		withoutHandler.host.setActive(true);
		expect(() => withoutHandler.view().webContents.emit("page-title-updated", {}, "MUL-1: Title")).not.toThrow();
	});

	it("runs a script only while a live view exists", async () => {
		const t = await setup();
		t.host.runInPage("window.test = true;");
		expect(FakeWebContentsView.instances).toHaveLength(0);

		t.host.setActive(true);
		t.host.runInPage("window.test = true;");
		expect(t.view().webContents.executeJavaScript).toHaveBeenCalledExactlyOnceWith("window.test = true;");

		t.host.dispose();
		t.host.runInPage("window.test = false;");
		expect(t.view().webContents.executeJavaScript).toHaveBeenCalledOnce();
	});

	it("runs a script in AO's isolated world", async () => {
		const t = await setup();
		t.host.setActive(true);

		t.host.runInAoWorld("window.test = true;");

		expect(t.view().webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(1001, [
			{ code: "window.test = true;" },
		]);
	});

	it("does not run an isolated script without a live view or after destruction", async () => {
		const t = await setup();
		t.host.runInAoWorld("window.test = true;");
		expect(FakeWebContentsView.instances).toHaveLength(0);

		t.host.setActive(true);
		t.view().webContents.destroyed = true;
		t.host.runInAoWorld("window.test = false;");
		expect(t.view().webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
	});

	it("swallows isolated-world script rejections", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error("world unavailable"));

		expect(() => t.host.runInAoWorld("window.test = true;")).not.toThrow();
		await Promise.resolve();
	});

	it("returns the value from an evaluated page script", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.executeJavaScript.mockResolvedValue({ identifier: "MUL-1" });

		await expect(t.host.evaluateInPage("Promise.resolve({ identifier: 'MUL-1' })")).resolves.toEqual({ identifier: "MUL-1" });
	});

	it("resolves undefined when an evaluated page script rejects", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.executeJavaScript.mockRejectedValue(new Error("page unavailable"));

		await expect(t.host.evaluateInPage("window.test")).resolves.toBeUndefined();
	});

	it("resolves undefined when evaluated without a view", async () => {
		const t = await setup();

		await expect(t.host.evaluateInPage("window.test")).resolves.toBeUndefined();
	});

	it("resolves undefined after the host is disposed", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.host.dispose();

		await expect(t.host.evaluateInPage("window.test")).resolves.toBeUndefined();
	});

	it("resolves undefined when the view is destroyed", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.destroyed = true;

		await expect(t.host.evaluateInPage("window.test")).resolves.toBeUndefined();
		expect(t.view().webContents.executeJavaScript).not.toHaveBeenCalled();
	});
});

describe("multica view host: issue navigation", () => {
	it("activates the view and waits for inbox readiness before dispatching an issue route", async () => {
		const t = await setup();
		ready(t);
		t.host.setActive(false);

		expect(t.host.navigatePath("/acme/issues/MUL-1")).toBe(true);
		expect(t.host.getState().active).toBe(true);
		expect(t.view().webContents.executeJavaScript).not.toHaveBeenCalled();

		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "inbox:open", ready: true });

		expect(t.view().webContents.executeJavaScript).toHaveBeenCalledExactlyOnceWith(
			'window.dispatchEvent(new CustomEvent("multica:navigate", { detail: { path: "/acme/issues/MUL-1" } }));',
		);
	});

	it.each(["/acme/issues/mul-1", "javascript:alert(1)", "/acme/issues/MUL-1?x=1"])(
		"does not activate the view for an invalid issue path: %s",
		async (path) => {
			const t = await setup();

			expect(t.host.navigatePath(path)).toBe(false);
			expect(t.host.getState().active).toBe(false);
			expect(FakeWebContentsView.instances).toHaveLength(0);
		},
	);

	it("returns false when Multica is unconfigured or its bundle is missing", async () => {
		const unconfigured = await setup(local(""));
		expect(unconfigured.host.navigatePath("/acme/issues/MUL-1")).toBe(false);
		expect(FakeWebContentsView.instances).toHaveLength(0);

		const missingBundle = await setup(local(URL), { resolveBundle: () => null });
		expect(missingBundle.host.navigatePath("/acme/issues/MUL-1")).toBe(false);
		expect(FakeWebContentsView.instances).toHaveLength(0);
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
		const t = await setup(local(URL), { resolveBundle: () => bundle });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toMatchObject({
			active: true,
			status: "error",
			error: expect.stringContaining("bundle not found"),
			errorKind: "bundle-missing",
		});
		expect(t.stateChannelPayloads().at(-1)).toMatchObject({ status: "error", errorKind: "bundle-missing" });

		bundle = BUNDLE;
		t.ipc.invoke(MULTICA_RELOAD_CHANNEL, t.shellEvent);

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
		t.view().webContents.emit("did-finish-load");
		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: URL });
	});
});

describe("multica view host: not configured", () => {
	it("shows the empty state without creating a view", async () => {
		const t = await setup(local(""));
		expect(t.host.getState()).toEqual({ active: false, status: "unconfigured", url: "" });

		t.host.setActive(true);

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: true, status: "unconfigured", url: "" });
	});

	it("loads the page when a URL is saved while the empty state is showing", async () => {
		const t = await setup(local(""));
		t.host.setActive(true);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("localhost:3000"));

		expect(FakeWebContentsView.instances).toHaveLength(1);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(BUNDLE.rendererUrl);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: URL });
	});

	it("tears the page down when the URL is cleared", async () => {
		const t = await setup();
		ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest(""));

		expect(t.contentView.removeChildView).toHaveBeenCalledWith(t.view());
		expect(t.view().webContents.close).toHaveBeenCalledOnce();
		expect(t.onTakeover).toHaveBeenLastCalledWith(false);
		expect(t.host.getState()).toEqual({ active: true, status: "unconfigured", url: "" });
	});
});

describe("multica view host: changing the URL", () => {
	it("replaces the view so its preload reads the new runtime config", async () => {
		const t = await setup();
		ready(t);
		const oldView = t.view();

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));

		expect(FakeWebContentsView.instances).toHaveLength(2);
		expect(oldView.webContents.close).toHaveBeenCalledOnce();
		expect(t.view()).not.toBe(oldView);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(BUNDLE.rendererUrl);
		expect(t.notifications.reset).toHaveBeenCalledOnce();
		const event = t.multicaEvent();
		t.view().webContents.ipc.emit("runtime-config:get", event);
		expect(event.returnValue).toMatchObject({ ok: true, config: { appUrl: "https://multica.example.com" } });
	});

	it("does not reset notifications when the saved URL is unchanged", async () => {
		const t = await setup();
		ready(t);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest(URL));

		expect(t.notifications.reset).not.toHaveBeenCalled();
		expect(FakeWebContentsView.instances).toHaveLength(1);
	});

	it("drops a queued inbox item when the URL changes before renderer readiness", async () => {
		const t = await setup();
		const target = { slug: "team/project", itemId: "42", issueKey: "AO-42" };

		expect(t.host.openInboxItem(target)).toBe(true);
		const oldView = t.view();
		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "inbox:open", ready: true });

		expect(t.view()).not.toBe(oldView);
		expect(oldView.webContents.close).toHaveBeenCalledOnce();
		expect(t.notifications.reset).toHaveBeenCalledOnce();
		expect(t.view().webContents.send).not.toHaveBeenCalled();
	});

	it("drops a queued sign-in link when another server is selected: its token belongs to the old one", async () => {
		const t = await setup();
		t.host.setActive(true);
		await startSignIn(t);

		expect(t.host.handleDeepLink("multica://auth/callback?token=abc.def")).toBe(true);
		const oldView = t.view();
		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		expect(t.view()).not.toBe(oldView);
		expect(oldView.webContents.close).toHaveBeenCalledOnce();
		expect(t.view().webContents.send).not.toHaveBeenCalled();
	});

	it("treats another API address for the same web address as another server: new partition, queued sign-in dropped", async () => {
		const t = await setup(local("https://multica.example.com"));
		t.host.setActive(true);
		await startSignIn(t, "https://multica.example.com");

		expect(t.host.handleDeepLink("multica://auth/callback?token=abc.def")).toBe(true);
		const oldView = t.view();
		const oldPartition = oldView.options.webPreferences.partition;
		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, {
			mode: "local",
			customUrl: "https://multica.example.com",
			apiUrl: "https://api2.example.com",
			force: true,
		});
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		expect(t.view()).not.toBe(oldView);
		expect(t.view().options.webPreferences.partition).not.toBe(oldPartition);
		expect(t.view().webContents.send).not.toHaveBeenCalled();
	});

	it("keeps the default partition away from a custom API address on the default web address", async () => {
		const t = await setup();
		t.host.setActive(true);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, { mode: "local", customUrl: URL, apiUrl: "https://attacker.example", force: true });

		expect(FakeWebContentsView.instances).toHaveLength(2);
		expect(t.view().options.webPreferences.partition).not.toBe(MULTICA_PARTITION);
	});

	it("does not create a view for a URL saved while AO is showing", async () => {
		const t = await setup(local(""));

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest(URL));

		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.host.getState()).toEqual({ active: false, status: "idle", url: URL });
		expect(t.notifications.reset).not.toHaveBeenCalled();
	});

	it("rejects an invalid URL without changing state or writing", async () => {
		const t = await setup();

		await expect(t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("ftp://x"))).resolves.toEqual({
			ok: false,
			error: "invalid_url",
			forceable: false,
		});

		expect(t.writeSettings).not.toHaveBeenCalled();
		expect(t.host.getState().url).toBe(URL);
	});

	it("reports a failed write and leaves the state alone", async () => {
		const t = await setup();
		t.writeSettings.mockRejectedValueOnce(new Error("disk full"));

		await expect(t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"))).rejects.toThrow("disk full");

		expect(t.host.getState().url).toBe(URL);
	});
});

describe("multica view host: choosing the server", () => {
	const partitionOf = (index: number) => FakeWebContentsView.instances[index].options.webPreferences.partition;
	const save = (t: Awaited<ReturnType<typeof setup>>, request: Record<string, unknown>) =>
		t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, request);

	it("keeps the original partition for the default local server", async () => {
		const t = await setup();
		t.host.setActive(true);

		expect(partitionOf(0)).toBe(MULTICA_PARTITION);
	});

	it("switches to Multica Cloud with its own partition and config, and back to the first partition", async () => {
		const t = await setup();
		ready(t);

		await expect(save(t, { mode: "cloud", customUrl: URL })).resolves.toMatchObject({ ok: true, settings: { mode: "cloud" } });

		expect(FakeWebContentsView.instances).toHaveLength(2);
		expect(partitionOf(1)).toBe(MULTICA_CLOUD_PARTITION);
		expect(partitionOf(1)).not.toBe(MULTICA_PARTITION);
		expect(t.view().webContents.loadURL).toHaveBeenCalledExactlyOnceWith(BUNDLE.rendererUrl);
		const event = t.multicaEvent();
		t.view().webContents.ipc.emit("runtime-config:get", event);
		expect(event.returnValue).toMatchObject({
			ok: true,
			config: { apiUrl: "https://api.multica.ai", wsUrl: "wss://api.multica.ai/ws", appUrl: "https://multica.ai" },
		});
		expect(t.host.getState()).toMatchObject({ active: true, url: "https://multica.ai" });
		expect(t.checkServer).not.toHaveBeenCalled();

		await save(t, { mode: "local", customUrl: URL });

		expect(FakeWebContentsView.instances).toHaveLength(3);
		expect(partitionOf(2)).toBe(MULTICA_PARTITION);
	});

	it("gives every other server a stable partition of its own, apart from the default and from Cloud", async () => {
		const t = await setup();
		t.host.setActive(true);

		await save(t, localRequest("https://multica.example.com"));
		await save(t, localRequest("https://other.example.com"));
		await save(t, localRequest("https://multica.example.com"));

		const [, first, second, again] = [0, 1, 2, 3].map(partitionOf);
		expect(new Set([MULTICA_PARTITION, MULTICA_CLOUD_PARTITION, first, second]).size).toBe(4);
		expect(first).toBe(again);
		expect(first).toMatch(/^persist:ao-multica-[0-9a-f]{16}$/);
	});

	it("keeps the remembered custom URL while in cloud mode and does not probe a server for it", async () => {
		const t = await setup();

		await save(t, { mode: "cloud", customUrl: "https://multica.example.com" });

		expect(t.writeSettings).toHaveBeenCalledExactlyOnceWith({ mode: "cloud", customUrl: "https://multica.example.com", apiUrl: "" });
		expect(t.checkServer).not.toHaveBeenCalled();
	});

	it("never stores an unvalidated custom URL, not even as the remembered one in cloud mode", async () => {
		const t = await setup();

		await save(t, { mode: "cloud", customUrl: "javascript:alert(1)" });
		await save(t, { mode: "cloud", customUrl: "http://public.example.com" });
		await save(t, { mode: "cloud", customUrl: "https://multica.example.com/with/path" });

		expect(t.writeSettings.mock.calls.map(([settings]) => settings)).toEqual([
			{ mode: "cloud", customUrl: "", apiUrl: "" },
			{ mode: "cloud", customUrl: "", apiUrl: "" },
			{ mode: "cloud", customUrl: "", apiUrl: "" },
		]);
		expect(t.checkServer).not.toHaveBeenCalled();
	});

	it("does not save a server that fails the check, unless forced, and says which errors can be forced", async () => {
		const t = await setup();
		t.checkServer.mockResolvedValueOnce({ ok: false as never, error: "unreachable" } as never);

		await expect(save(t, { mode: "local", customUrl: "https://multica.example.com" })).resolves.toEqual({
			ok: false,
			error: "unreachable",
			forceable: true,
		});
		expect(t.writeSettings).not.toHaveBeenCalled();
		expect(t.host.getState().url).toBe(URL);

		t.checkServer.mockResolvedValueOnce({ ok: false as never, error: "unreachable" } as never);
		await expect(save(t, { mode: "local", customUrl: "https://multica.example.com", force: true })).resolves.toMatchObject({ ok: true });
		expect(t.host.getState().url).toBe("https://multica.example.com");
	});

	it("refuses plain http to a public host and a path in the address, without probing or writing", async () => {
		const t = await setup();

		await expect(save(t, localRequest("http://multica.example.com"))).resolves.toEqual({ ok: false, error: "insecure_http", forceable: false });
		await expect(save(t, localRequest("https://multica.example.com/app"))).resolves.toEqual({ ok: false, error: "path_not_allowed", forceable: false });
		await expect(save(t, { mode: "local", customUrl: "https://multica.example.com", apiUrl: "http://api.example.com", force: true })).resolves.toEqual({
			ok: false,
			error: "insecure_http",
			forceable: false,
		});
		await expect(save(t, { mode: "bogus", customUrl: URL })).resolves.toMatchObject({ ok: false });

		expect(t.checkServer).not.toHaveBeenCalled();
		expect(t.writeSettings).not.toHaveBeenCalled();
	});

	it("stores the API address the check found when a same-origin deployment has no api.<host>", async () => {
		const t = await setup();
		t.checkServer.mockResolvedValueOnce({ ok: true, apiUrl: "https://multica.example.com" });

		await save(t, { mode: "local", customUrl: "https://multica.example.com" });

		expect(t.writeSettings).toHaveBeenCalledExactlyOnceWith({
			mode: "local",
			customUrl: "https://multica.example.com",
			apiUrl: "https://multica.example.com",
		});
		t.host.setActive(true);
		const event = t.multicaEvent();
		t.view().webContents.ipc.emit("runtime-config:get", event);
		expect(event.returnValue).toMatchObject({ config: { apiUrl: "https://multica.example.com", wsUrl: "wss://multica.example.com/ws" } });
	});

	it("rewrites the WebSocket origin for the server that is selected now, not the one at startup", async () => {
		const t = await setup();
		ready(t);
		await save(t, { mode: "cloud", customUrl: URL });
		const callback = vi.fn();

		FakeWebContents.lastHeaderHandler?.({ url: "wss://api.multica.ai/ws", requestHeaders: { Origin: "null" } }, callback);

		expect(callback).toHaveBeenCalledExactlyOnceWith({ requestHeaders: { Origin: "https://multica.ai" } });
	});

	it("tells the daemon service which server its view talks to, and announces server changes", async () => {
		const stubDaemon = { getStatus: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), isInstalled: vi.fn(), refreshBinary: vi.fn(), probeRuntimes: vi.fn(), startLogStream: vi.fn(), stopLogStream: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn(), dispose: vi.fn() };
		const createDaemonService = vi.fn((_emit: unknown, _server: unknown) => stubDaemon);
		const onServerChange = vi.fn();
		const t = await setup(local(URL), { createDaemonService: createDaemonService as never, onServerChange });
		expect(onServerChange).toHaveBeenLastCalledWith(URL);
		ready(t);
		expect(createDaemonService.mock.calls[0][1]).toMatchObject({ key: URL, cliProfile: null });

		await save(t, { mode: "cloud", customUrl: URL });

		expect(onServerChange).toHaveBeenLastCalledWith("cloud");
		expect(createDaemonService.mock.calls[1][1]).toMatchObject({ key: "cloud", cliProfile: "ao-multica.ai" });

		await save(t, { mode: "local", customUrl: "", force: true });
		expect(onServerChange).toHaveBeenLastCalledWith("");
	});

	it("does not announce or reload when the same server is saved again", async () => {
		const onServerChange = vi.fn();
		const t = await setup(local(URL), { onServerChange });
		ready(t);
		onServerChange.mockClear();

		await save(t, localRequest(URL));

		expect(onServerChange).not.toHaveBeenCalled();
		expect(FakeWebContentsView.instances).toHaveLength(1);
	});

	it("runs a script bound to a server only in a live view of that server, even right after a switch", async () => {
		const t = await setup();
		ready(t);
		const oldContents = t.view().webContents;
		expect(t.host.getServer()?.key).toBe(URL);

		await t.host.evaluateInPage("read()", URL);
		expect(oldContents.executeJavaScript).toHaveBeenCalledWith("read()");

		await save(t, { mode: "cloud", customUrl: URL });
		// The script was built for the old server: it must not reach the new view, nor run unbound checks wrongly.
		await expect(t.host.evaluateInPage("read()", URL)).resolves.toBeUndefined();
		expect(t.view().webContents.executeJavaScript).not.toHaveBeenCalled();
		expect(t.host.getServer()?.key).toBe("cloud");
		await t.host.evaluateInPage("read()", "cloud");
		expect(t.view().webContents.executeJavaScript).toHaveBeenCalledWith("read()");
	});

	it("reports no server while there is no live view", async () => {
		const t = await setup();
		expect(t.host.getServer()).toBeNull();
		await expect(t.host.evaluateInPage("x()", URL)).resolves.toBeUndefined();
	});

	it("only answers the trusted shell on the check channel", async () => {
		const t = await setup();

		expect(await t.ipc.invoke(MULTICA_CHECK_SERVER_CHANNEL, { sender: { id: 99 } }, { mode: "local", customUrl: URL })).toBeUndefined();
		await expect(t.ipc.invoke(MULTICA_CHECK_SERVER_CHANNEL, t.shellEvent, { mode: "local", customUrl: URL })).resolves.toMatchObject({ ok: true });
		await expect(t.ipc.invoke(MULTICA_CHECK_SERVER_CHANNEL, t.shellEvent, "nope")).resolves.toEqual({ ok: false, error: "invalid_url" });
	});
});

describe("multica view host: a stale document after a URL change", () => {
	it("keeps stale invoke calls on the old view after it is replaced", async () => {
		const daemon = {
			getStatus: vi.fn(async () => ({ state: "stopped" as const })),
			start: vi.fn(async () => ({ success: true })),
			stop: vi.fn(async () => ({ success: true })),
			restart: vi.fn(async () => ({ success: true })),
			isInstalled: vi.fn(async () => true),
			refreshBinary: vi.fn(),
			probeRuntimes: vi.fn(async () => ({ probeResult: "error" as const })),
			startLogStream: vi.fn(),
			stopLogStream: vi.fn(),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
			dispose: vi.fn(),
		};
		const t = await setup(local(URL), { createDaemonService: () => daemon });
		t.host.setActive(true);
		const oldView = t.view();

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		expect(t.view()).not.toBe(oldView);
		for (const channel of ["daemon:stop", "daemon:restart", "shell:openExternal"]) {
			expect(oldView.webContents.ipc.handlers.has(channel)).toBe(true);
		}
		for (const method of Object.values(daemon)) method.mockClear();
		t.openExternal.mockClear();

		for (const [channel, args] of [
			["daemon:stop", []],
			["daemon:restart", []],
			["shell:openExternal", ["https://accounts.example.com/oauth"]],
		] as const) {
			const result = await oldView.webContents.ipc.invoke(channel, { sender: oldView.webContents }, ...args);
			expect(result).toBeUndefined();
		}

		for (const method of Object.values(daemon)) expect(method).not.toHaveBeenCalled();
		expect(t.openExternal).not.toHaveBeenCalled();
		expect(t.ipc.handlers.has("daemon:stop")).toBe(false);
		expect(t.ipc.handlers.has("daemon:restart")).toBe(false);
		expect(t.ipc.handlers.has("shell:openExternal")).toBe(false);
	});

	it("removes the old notification listeners before the old document can report state", async () => {
		const real = setupRealNotifications();
		const t = await setup(local(URL), { notifications: real.service });
		t.host.setActive(true);
		const oldView = t.view();
		const oldEvent = { sender: oldView.webContents };
		oldView.webContents.ipc.emit("auth:session-state", oldEvent, "user-a");
		oldView.webContents.ipc.emit("notification:show", oldEvent, notificationPayload("before-change"));
		const originalBanner = real.banners[0];

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		const newView = t.view();
		oldView.webContents.ipc.emit("auth:session-state", oldEvent, "user-a");
		oldView.webContents.ipc.emit("notification:show", oldEvent, notificationPayload("from-stale-page"));

		expect(newView).not.toBe(oldView);
		expect(originalBanner.close).toHaveBeenCalledOnce();
		expect(real.createNotification).toHaveBeenCalledOnce();
		expect(real.openInboxItem).not.toHaveBeenCalled();
		for (const channel of ["auth:session-state", "notification:show", "badge:set"]) {
			expect(oldView.webContents.ipc.listeners.get(channel)?.size ?? 0).toBe(0);
		}
	});

	it("keeps a prior banner stale across the same user signing in on the replacement", async () => {
		const real = setupRealNotifications();
		const t = await setup(local(URL), { notifications: real.service });
		t.host.setActive(true);
		const oldView = t.view();
		oldView.webContents.ipc.emit("auth:session-state", { sender: oldView.webContents }, "user-a");
		oldView.webContents.ipc.emit("notification:show", { sender: oldView.webContents }, notificationPayload("old-banner"));
		const oldBanner = real.banners[0];

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		const newView = t.view();
		newView.webContents.ipc.emit("auth:session-state", { sender: newView.webContents }, "user-a");
		oldBanner.click();
		newView.webContents.ipc.emit("notification:show", { sender: newView.webContents }, notificationPayload("new-banner"));
		real.banners[1].click();

		expect(newView).not.toBe(oldView);
		expect(real.openInboxItem).toHaveBeenCalledExactlyOnceWith({
			slug: "team/project",
			itemId: "new-banner",
			issueKey: "AO-new-banner",
		});
	});

	it("handles the replacement renderer's first auth report immediately", async () => {
		const real = setupRealNotifications();
		const t = await setup(local(URL), { notifications: real.service });
		t.host.setActive(true);
		const oldView = t.view();
		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		const newView = t.view();

		newView.webContents.ipc.emit("auth:session-state", { sender: newView.webContents }, "user-a");
		newView.webContents.ipc.emit("notification:show", { sender: newView.webContents }, notificationPayload("first-report"));

		expect(newView).not.toBe(oldView);
		expect(real.banners).toHaveLength(1);
	});

	it("ignores late load and crash events from the replaced view", async () => {
		const t = await setup();
		t.host.setActive(true);
		const oldView = t.view();
		oldView.webContents.emit("did-finish-load");

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		const newView = t.view();
		oldView.webContents.emit("did-finish-load");
		expect(t.host.getState().status).toBe("loading");
		oldView.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", BUNDLE.rendererUrl, true);
		oldView.webContents.emit("render-process-gone", {}, { reason: "crashed" });

		expect(newView).not.toBe(oldView);
		expect(t.host.getState()).toEqual({ active: true, status: "loading", url: "https://multica.example.com" });
		newView.webContents.emit("did-finish-load");
		expect(t.host.getState()).toEqual({ active: true, status: "ready", url: "https://multica.example.com" });
	});

	it("keeps the replacement readiness when the old view starts loading late", async () => {
		const t = await setup();
		t.host.setActive(true);
		const oldView = t.view();

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest("https://multica.example.com"));
		const newView = t.view();
		const target = { slug: "team/project", itemId: "42", issueKey: "AO-42" };
		newView.webContents.ipc.emit("main-renderer:channel-state", { sender: newView.webContents }, { channel: "inbox:open", ready: true });
		oldView.webContents.emit("did-start-loading");

		expect(t.host.openInboxItem(target)).toBe(true);
		expect(newView.webContents.send).toHaveBeenCalledExactlyOnceWith("inbox:open", target);
	});
});

describe("multica view host: deep links", () => {
	it("holds a sign-in token until the renderer subscribes, then delivers it and surfaces Multica", async () => {
		const t = await setup();
		t.host.setActive(true);
		await startSignIn(t);

		expect(t.host.handleDeepLink("multica://auth/callback?token=abc.def")).toBe(true);

		expect(t.host.getState().active).toBe(true);
		expect(t.view().webContents.send).not.toHaveBeenCalled();

		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		expect(t.view().webContents.send).toHaveBeenCalledExactlyOnceWith("auth:token", "abc.def");
	});

	it("waits again after the page reloads, since reloading drops the renderer's listeners", async () => {
		const t = await setup();
		ready(t);
		await startSignIn(t);
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "auth:token", ready: true });

		t.view().webContents.emit("did-start-loading");
		t.host.handleDeepLink("multica://auth/callback?token=late");

		expect(t.view().webContents.send).not.toHaveBeenCalled();
	});

	describe("sign-in links name no server, so they need a sign-in this view started", () => {
		const LINK = "multica://auth/callback?token=abc.def";

		it("ignores a token link when no sign-in was started in this view, without creating the view", async () => {
			const t = await setup();

			expect(t.host.handleDeepLink(LINK)).toBe(false);
			expect(FakeWebContentsView.instances).toHaveLength(0);
			expect(t.host.getState().active).toBe(false);

			ready(t);
			expect(t.host.handleDeepLink(LINK)).toBe(false);
			expect(t.view().webContents.send).not.toHaveBeenCalled();
		});

		it("only counts the login page of the view's own server as the start of a sign-in", async () => {
			const t = await setup();
			ready(t);

			for (const target of [
				"https://other.example.com/login?platform=desktop",
				`${URL}/login`,
				`${URL}/settings?platform=desktop`,
				"https://multica.ai/login?platform=desktop",
			]) {
				await t.view().webContents.ipc.invoke("shell:openExternal", { sender: t.view().webContents }, target);
			}

			expect(t.host.handleDeepLink(LINK)).toBe(false);
		});

		it("takes one token link per sign-in, within ten minutes", async () => {
			let clock = 1_000_000;
			const t = await setup(local(URL), { now: () => clock });
			ready(t);
			await startSignIn(t);

			expect(t.host.handleDeepLink(LINK)).toBe(true);
			expect(t.host.handleDeepLink(LINK)).toBe(false);

			await startSignIn(t);
			clock += 10 * 60 * 1000 + 1;
			expect(t.host.handleDeepLink(LINK)).toBe(false);
		});

		it("forgets a pending sign-in when another server is selected: a Cloud token never reaches a self-hosted API", async () => {
			const t = await setup(local(URL));
			ready(t);
			await startSignIn(t);
			await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, { mode: "cloud", customUrl: URL });
			t.view().webContents.emit("did-finish-load");

			expect(t.host.handleDeepLink(LINK)).toBe(false);
			expect(t.view().webContents.send).not.toHaveBeenCalled();
			// The new server's own sign-in works.
			await startSignIn(t, "https://multica.ai");
			expect(t.host.handleDeepLink(LINK)).toBe(true);
		});

		it("still routes invitation links without a sign-in", async () => {
			const t = await setup();

			expect(t.host.handleDeepLink("multica://invite/abc-123")).toBe(true);
		});
	});

	it("ignores anything that is not a multica deep link, and does so when no URL is configured", async () => {
		const t = await setup();
		expect(t.host.handleDeepLink("ao-app://callback?token=x")).toBe(false);
		expect(t.host.handleDeepLink("multica://auth/callback")).toBe(false);
		expect(t.host.getState().active).toBe(false);

		const unconfigured = await setup(local(""));
		expect(unconfigured.host.handleDeepLink("multica://auth/callback?token=abc")).toBe(false);
	});
});

describe("multica view host: inbox items", () => {
	it("ignores inbox items when no Multica URL is configured", async () => {
		const t = await setup(local(""));

		expect(t.host.openInboxItem({ slug: "team/project", itemId: "42", issueKey: "AO-42" })).toBe(false);
		expect(t.host.getState().active).toBe(false);
		expect(FakeWebContentsView.instances).toHaveLength(0);
	});

	it("activates Multica and sends the payload once the renderer is ready", async () => {
		const t = await setup();
		t.host.setActive(true);
		t.view().webContents.emit("did-finish-load");
		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "inbox:open", ready: true });
		t.host.setActive(false);
		const target = { slug: "team/project", itemId: "42", issueKey: "AO-42" };

		expect(t.host.openInboxItem(target)).toBe(true);

		expect(t.host.getState().active).toBe(true);
		expect(t.view().webContents.send).toHaveBeenCalledExactlyOnceWith("inbox:open", target);
	});

	it("queues an inbox item until the renderer announces readiness", async () => {
		const t = await setup();
		const target = { slug: "team/project", itemId: "42", issueKey: "AO-42" };

		expect(t.host.openInboxItem(target)).toBe(true);
		expect(t.view().webContents.send).not.toHaveBeenCalled();

		t.view().webContents.ipc.emit("main-renderer:channel-state", t.multicaEvent(), { channel: "inbox:open", ready: true });

		expect(t.view().webContents.send).toHaveBeenCalledExactlyOnceWith("inbox:open", target);
	});
});

describe("multica view host: notifications bridge", () => {
	it("forwards notification, session and badge messages to the supplied service", async () => {
		const t = await setup();
		t.host.setActive(true);
		const event = t.multicaEvent();
		const notification = { title: "New comment" };
		const session = { active: true };

		t.view().webContents.ipc.emit("notification:show", event, notification);
		t.view().webContents.ipc.emit("auth:session-state", event, session);
		t.view().webContents.ipc.emit("badge:set", event, 4);

		expect(t.notifications.showNotification).toHaveBeenCalledExactlyOnceWith(notification);
		expect(t.notifications.reportAuthSession).toHaveBeenCalledExactlyOnceWith(session);
		expect(t.notifications.setBadge).toHaveBeenCalledExactlyOnceWith(4);
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
		await expect(t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, stranger, localRequest("http://evil.test"))).resolves.toBeUndefined();

		expect(t.host.getState().active).toBe(false);
		expect(FakeWebContentsView.instances).toHaveLength(0);
		expect(t.writeSettings).not.toHaveBeenCalled();
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
		expect(t.daemonDispose).toHaveBeenCalledOnce();
		expect(t.notifications.reset).toHaveBeenCalledOnce();
	});

	it("resets notifications when clearing the URL destroys the view", async () => {
		const t = await setup();
		t.host.setActive(true);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest(""));

		expect(t.notifications.reset).toHaveBeenCalledOnce();
		t.host.dispose();
		expect(t.notifications.reset).toHaveBeenCalledOnce();
	});

	it("does not reset notifications when no view was created", async () => {
		const t = await setup();

		t.host.dispose();

		expect(t.notifications.reset).not.toHaveBeenCalled();
	});

	it("stops the daemon polling when the view is torn down by clearing the URL", async () => {
		const t = await setup();
		t.host.setActive(true);

		await t.ipc.invoke(MULTICA_SET_SETTINGS_CHANNEL, t.shellEvent, localRequest(""));

		expect(t.daemonDispose).toHaveBeenCalledOnce();
	});
});
