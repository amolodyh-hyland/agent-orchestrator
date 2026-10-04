import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Session, View, WebContents, WebContentsView } from "electron";
import {
	MULTICA_GET_SETTINGS_CHANNEL,
	MULTICA_GET_STATE_CHANNEL,
	MULTICA_PARTITION,
	MULTICA_RELOAD_CHANNEL,
	MULTICA_SET_ACTIVE_CHANNEL,
	MULTICA_SET_SETTINGS_CHANNEL,
	MULTICA_STATE_CHANNEL,
	TOGGLE_MULTICA_SHORTCUT_CHANNEL,
	multicaRuntimeConfig,
	multicaWebSocketHeaders,
	parseMulticaDeepLink,
	parseMulticaUrl,
	type MulticaSettings,
	type MulticaErrorKind,
	type MulticaStatus,
	type MulticaViewState,
} from "../shared/multica";
import type { KeybindingOverrides } from "../shared/shortcuts";
import { attachAppShortcuts } from "./app-shortcuts";
import { isAllowedAppExternalURL, openAllowedAppExternalURL } from "./external-open";
import type { MulticaDaemonService } from "./multica-daemon-cli";
import { createMulticaDesktopBridge, type MulticaAppInfo, type MulticaDesktopBridge } from "./multica-desktop-bridge";
import type { MulticaDesktopBundle } from "./multica-desktop-bundle";

const CLOSE_ACTIVE_TAB_CHANNEL = "tab:close-active";
const BUNDLE_MISSING_MESSAGE = "Multica desktop bundle not found. Build it and set AO_MULTICA_DESKTOP_OUT.";

type MulticaWebContents = Pick<
	WebContents,
	"id" | "on" | "loadURL" | "focus" | "close" | "isDestroyed" | "setWindowOpenHandler" | "send" | "ipc"
> & {
	session: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setPreloads" | "webRequest">;
};

type MulticaViewLike = Pick<WebContentsView, "setBounds" | "setVisible"> & { webContents: MulticaWebContents };

export type MulticaViewHostOptions = {
	mainWindow: { contentView: Pick<View, "addChildView" | "removeChildView" | "getBounds" | "on" | "removeListener"> };
	shellWebContents: WebContents;
	ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
	shell: { openExternal: (url: string) => Promise<void> };
	WebContentsView: new (options: { webPreferences: Electron.WebPreferences }) => MulticaViewLike;
	isMac: boolean;
	getKeybindingOverrides: () => KeybindingOverrides;
	isKeybindingRecording: () => boolean;
	readSettings: () => Promise<MulticaSettings>;
	writeUrl: (url: string) => Promise<MulticaSettings>;
	/** Locates Multica's built renderer and preload; null when they have not been built. */
	resolveBundle: () => MulticaDesktopBundle | null;
	/** Preload run in the Multica view before Multica's own, confining its IPC (see multica-ipc-jail.ts). */
	ipcJailPreload: string;
	webSecurity: boolean;
	/** BCP 47 locale handed to the renderer (its `desktopAPI.systemLocale`). */
	locale: string;
	appInfo: MulticaAppInfo;
	hostName: () => string;
	/** Builds the daemon service for a new view; `emit` pushes messages to that view. */
	createDaemonService: (emit: (channel: string, payload: unknown) => void) => MulticaDaemonService;
	/** Called when the Multica view takes over the whole window or gives it back. */
	onTakeover?: (takenOver: boolean) => void;
};

export type MulticaViewHost = {
	getState: () => MulticaViewState;
	setActive: (active: boolean) => void;
	toggle: () => void;
	/** Routes a `multica://` deep link to the view and surfaces it. False when ignored. */
	handleDeepLink: (url: string) => boolean;
	dispose: () => void;
};

/**
 * Owns the single embedded Multica desktop view. Multica's built renderer runs
 * in a native WebContentsView that covers the whole AO window (sidebar, content
 * and toolbar), so switching between AO and Multica only shows or hides it:
 * neither side is reloaded or unmounted. AO's main process answers the IPC
 * Multica's own main process would (see multica-desktop-bridge.ts).
 *
 * The view is untrusted web content with a privileged preload, so it gets its
 * own persistent partition, sandbox and context isolation, every permission
 * denied, and navigation pinned to the built bundle.
 */
export async function createMulticaViewHost(options: MulticaViewHostOptions): Promise<MulticaViewHost> {
	const { mainWindow, shellWebContents } = options;
	let url = "";
	let active = false;
	let status: MulticaStatus = "unconfigured";
	let error: string | undefined;
	let errorKind: MulticaErrorKind | undefined;
	let view: MulticaViewLike | undefined;
	let rendererUrl = "";
	let shown = false;
	let loadFailed = false;

	const getState = (): MulticaViewState => ({ active, status, url, ...(error ? { error } : {}), ...(errorKind ? { errorKind } : {}) });

	const pushState = (): void => {
		if (shellWebContents.isDestroyed()) return;
		shellWebContents.send(MULTICA_STATE_CHANNEL, getState());
	};

	const isTrustedShell = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender.id === shellWebContents.id;

	const openExternally = (target: string): void => {
		if (isAllowedAppExternalURL(target)) void options.shell.openExternal(target).catch(() => undefined);
	};

	let bridge: MulticaDesktopBridge | undefined;

	const setStatus = (next: MulticaStatus, nextError?: string, nextErrorKind?: MulticaErrorKind): void => {
		status = next;
		error = nextError;
		errorKind = nextErrorKind;
		applyView();
		pushState();
	};

	const fit = (): void => {
		if (!view || view.webContents.isDestroyed()) return;
		const { width, height } = mainWindow.contentView.getBounds();
		view.setBounds({ x: 0, y: 0, width, height });
	};
	mainWindow.contentView.on("bounds-changed", fit);

	function applyView(): void {
		if (!view || view.webContents.isDestroyed()) return;
		if (!(active && status === "ready")) {
			if (shown) {
				view.setVisible(false);
				shown = false;
				options.onTakeover?.(false);
			}
			return;
		}
		fit();
		if (shown) return;
		// Re-adding an existing child raises it above AO's own native views (the
		// per-worker browser pages), which stay mounted underneath.
		mainWindow.contentView.addChildView(view as unknown as WebContentsView);
		view.setVisible(true);
		view.webContents.focus();
		shown = true;
		options.onTakeover?.(true);
	}

	const createView = (): MulticaViewLike | undefined => {
		const bundle = options.resolveBundle();
		if (!bundle) {
			setStatus("error", BUNDLE_MISSING_MESSAGE, "bundle-missing");
			return undefined;
		}
		rendererUrl = bundle.rendererUrl;
		const created = new options.WebContentsView({
			webPreferences: {
				partition: MULTICA_PARTITION,
				preload: bundle.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: options.webSecurity,
				additionalArguments: [`--multica-locale=${options.locale.replace(/[^A-Za-z0-9_-]/g, "") || "en"}`],
			},
		});
		created.setVisible(false);
		mainWindow.contentView.addChildView(created as unknown as WebContentsView);
		const contents = created.webContents;

		contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		contents.session.setPermissionCheckHandler(() => false);
		// Session-level preloads run just before the view's own preload. This
		// partition is used by the Multica view alone.
		contents.session.setPreloads([options.ipcJailPreload]);
		// The file:// renderer's WebSocket handshake carries `Origin: null`, which a
		// Multica server rejects (403) unless its allowlist names it.
		contents.session.webRequest.onBeforeSendHeaders({ urls: ["ws://*/*", "wss://*/*"] }, (details, callback) => {
			callback({ requestHeaders: multicaWebSocketHeaders(details.url, details.requestHeaders, url) });
		});

		bridge = createMulticaDesktopBridge({
			ipc: contents.ipc,
			isMulticaSender: (sender) => !contents.isDestroyed() && sender.id === contents.id,
			getAppInfo: () => options.appInfo,
			getRuntimeConfig: () => multicaRuntimeConfig(url),
			getHostName: options.hostName,
			daemon: options.createDaemonService((channel, payload) => {
				if (!contents.isDestroyed()) contents.send(channel, payload);
			}),
			openExternal: (target) => openAllowedAppExternalURL(target, options.shell),
			send: (channel, payload) => {
				if (!contents.isDestroyed()) contents.send(channel, payload);
			},
		});

		// The renderer uses an in-memory router, so it never navigates on its own.
		// Anything that tries to leave the built bundle goes to the system browser.
		const isBundle = (target: string): boolean => {
			try {
				const parsed = new URL(target);
				return parsed.protocol === "file:" && parsed.pathname === new URL(rendererUrl).pathname;
			} catch {
				return false;
			}
		};
		const guardNavigation = (event: { preventDefault: () => void }, target: string, isMainFrame = true): void => {
			if (!isMainFrame || isBundle(target)) return;
			event.preventDefault();
			openExternally(target);
		};
		contents.on("will-navigate", (event, target) => guardNavigation(event, target));
		contents.on("will-redirect", (event, target, _isInPlace, isMainFrame) => guardNavigation(event, target, isMainFrame));
		contents.setWindowOpenHandler(({ url: target }) => {
			openExternally(target);
			return { action: "deny" };
		});

		// A page load drops every renderer subscription, so deep links must wait
		// for the renderer to announce its listeners again.
		contents.on("did-start-loading", () => bridge?.resetReadiness());
		// A failed navigation commits Chromium's own error page and then fires
		// did-finish-load for it (observed order: fail, then finish), so a failure
		// has to veto the next did-finish-load. Only an explicit load() (retry or a
		// URL change) clears it; the error state offers no other way forward.
		contents.on("did-finish-load", () => {
			if (!loadFailed) setStatus("ready");
		});
		contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
			if (!isMainFrame || errorCode === -3) return;
			loadFailed = true;
			setStatus("error", errorDescription || "Unable to load page");
		});
		contents.on("render-process-gone", () => setStatus("error", "The Multica view stopped unexpectedly"));
		contents.on("preload-error", (_event, preloadPath, preloadError) => {
			console.error(`AO: Multica preload failed (${preloadPath}): ${preloadError.message}`);
		});

		// The Multica page is its own WebContents, so shell keydown listeners never
		// see keys typed in it. Handle the switch in main so it works even if the
		// shell renderer is busy; every other AO chord belongs to the page.
		attachAppShortcuts(
			contents,
			options.isMac,
			{ focus: () => undefined, send: (channel) => channel === TOGGLE_MULTICA_SHORTCUT_CHANNEL && setActive(!active) },
			false,
			options.getKeybindingOverrides,
			options.isKeybindingRecording,
			(id) => id === "toggle-multica",
		);
		// Cmd/Ctrl+W closes the active Multica tab. AO owns that chord at the menu
		// level, so it is forwarded to the page explicitly.
		contents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown" || input.alt || input.shift || input.key.toLowerCase() !== "w") return;
			if (!(options.isMac ? input.meta && !input.control : input.control && !input.meta)) return;
			event.preventDefault();
			if (!input.isAutoRepeat) contents.send(CLOSE_ACTIVE_TAB_CHANNEL);
		});
		return created;
	};

	const destroyView = (notify = true): void => {
		const current = view;
		view = undefined;
		const wasShown = shown;
		shown = false;
		bridge?.dispose();
		bridge = undefined;
		if (!current) return;
		try {
			mainWindow.contentView.removeChildView(current as unknown as WebContentsView);
		} catch {
			// The BaseWindow may already have destroyed its content hierarchy.
		}
		try {
			current.webContents.close();
		} catch {
			// WebContents teardown is idempotent during window close.
		}
		if (wasShown && notify) options.onTakeover?.(false);
	};

	const load = (): void => {
		if (!url) return;
		view ??= createView();
		if (!view) return;
		loadFailed = false;
		setStatus("loading");
		// A failed load surfaces through did-fail-load; the rejection carries nothing new.
		void view.webContents.loadURL(rendererUrl).catch(() => undefined);
	};

	const applySettings = (settings: MulticaSettings): void => {
		const parsed = parseMulticaUrl(settings.url);
		const nextUrl = parsed.ok ? parsed.url : "";
		if (nextUrl === url) return;
		url = nextUrl;
		if (!url) {
			destroyView();
			setStatus("unconfigured");
		} else if (view || active) {
			// The runtime config is read when the page's preload runs, so a URL
			// change needs a fresh page load.
			load();
		} else {
			setStatus("idle");
		}
	};

	function setActive(next: boolean): void {
		if (active === next) return;
		active = next;
		// First activation is the only thing that creates the view or loads the
		// page; later switches just show and hide it.
		if (active && url && !view) {
			load();
			return;
		}
		if (!active && !shellWebContents.isDestroyed()) shellWebContents.focus();
		applyView();
		pushState();
	}

	applySettings(await options.readSettings().catch(() => ({ url: "" })));

	const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
		[MULTICA_GET_STATE_CHANNEL, (event) => (isTrustedShell(event) ? getState() : undefined)],
		[
			MULTICA_SET_ACTIVE_CHANNEL,
			(event, value) => {
				if (isTrustedShell(event) && typeof value === "boolean") setActive(value);
				return getState();
			},
		],
		[
			MULTICA_RELOAD_CHANNEL,
			(event) => {
				if (isTrustedShell(event)) load();
				return getState();
			},
		],
		[MULTICA_GET_SETTINGS_CHANNEL, (event) => (isTrustedShell(event) ? options.readSettings() : undefined)],
		[
			MULTICA_SET_SETTINGS_CHANNEL,
			async (event, value) => {
				if (!isTrustedShell(event) || typeof value !== "string") return undefined;
				const saved = await options.writeUrl(value);
				applySettings(saved);
				return saved;
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		getState,
		setActive,
		toggle: () => setActive(!active),
		handleDeepLink: (rawUrl) => {
			const link = parseMulticaDeepLink(rawUrl);
			if (!link || !url) return false;
			// Surfacing Multica creates the view (and its bridge) on first use.
			setActive(true);
			if (!bridge) return false;
			bridge.dispatch(link.channel, link.payload);
			return true;
		},
		dispose: () => {
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
			try {
				mainWindow.contentView.removeListener("bounds-changed", fit);
			} catch {
				// The BaseWindow may already have destroyed its content hierarchy.
			}
			destroyView(false);
		},
	};
}
