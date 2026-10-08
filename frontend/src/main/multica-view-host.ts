import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Session, View, WebContents, WebContentsView } from "electron";
import {
	MULTICA_CHECK_SERVER_CHANNEL,
	MULTICA_GET_SETTINGS_CHANNEL,
	MULTICA_GET_STATE_CHANNEL,
	MULTICA_RELOAD_CHANNEL,
	MULTICA_SET_ACTIVE_CHANNEL,
	MULTICA_SET_SETTINGS_CHANNEL,
	MULTICA_STATE_CHANNEL,
	TOGGLE_MULTICA_SHORTCUT_CHANNEL,
	multicaWebSocketHeaders,
	parseMulticaDeepLink,
	resolveMulticaServer,
	validateMulticaServerUrl,
	type MulticaCheckResult,
	type MulticaServer,
	type MulticaSetSettingsRequest,
	type MulticaSetSettingsResult,
	type MulticaSettings,
	type MulticaErrorKind,
	type MulticaStatus,
	type MulticaViewState,
} from "../shared/multica";
import { isMulticaIssuePath } from "../shared/multica-issue-links";
import type { KeybindingOverrides } from "../shared/shortcuts";
import { attachAppShortcuts } from "./app-shortcuts";
import { isAllowedAppExternalURL, openAllowedAppExternalURL } from "./external-open";
import type { MulticaDaemonService } from "./multica-daemon-cli";
import { createMulticaDesktopBridge, type MulticaAppInfo, type MulticaDesktopBridge } from "./multica-desktop-bridge";
import type { MulticaDesktopBundle } from "./multica-desktop-bundle";
import type { MulticaInboxTarget, MulticaNotifications } from "./multica-notifications";

const CLOSE_ACTIVE_TAB_CHANNEL = "tab:close-active";
const BUNDLE_MISSING_MESSAGE = "Multica desktop bundle not found. Build it and set AO_MULTICA_DESKTOP_OUT.";
// Electron reserves 999 for context isolation and 1<<20.. for extensions.
export const MULTICA_AO_WORLD_ID = 1001;

type MulticaWebContents = Pick<
	WebContents,
	"id" | "on" | "loadURL" | "executeJavaScript" | "executeJavaScriptInIsolatedWorld" | "focus" | "close" | "isDestroyed" | "setWindowOpenHandler" | "send" | "ipc"
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
	writeSettings: (settings: MulticaSettings) => Promise<MulticaSettings>;
	/** Probes a self-hosted server before it is saved. */
	checkServer: (request: Pick<MulticaSetSettingsRequest, "customUrl" | "apiUrl">) => Promise<MulticaCheckResult>;
	/** Locates Multica's built renderer and preload; null when they have not been built. */
	resolveBundle: () => MulticaDesktopBundle | null;
	/** Preload run in the Multica view before Multica's own, confining its IPC (see multica-ipc-jail.ts). */
	ipcJailPreload: string;
	webSecurity: boolean;
	/** BCP 47 locale handed to the renderer (its `desktopAPI.systemLocale`). */
	locale: string;
	appInfo: MulticaAppInfo;
	/** Handles Multica's notification, auth-session and badge messages; the host resets it when the view is torn down. */
	notifications: MulticaNotifications;
	hostName: () => string;
	/** Builds the daemon service for a new view; `emit` pushes messages to that view, `server` is the one the view talks to. */
	createDaemonService: (emit: (channel: string, payload: unknown) => void, server: MulticaServer) => MulticaDaemonService;
	/** Called when the selected server changes (including to none), with its key or "". */
	onServerChange?: (serverKey: string) => void;
	/** Called when the Multica view takes over the whole window or gives it back. */
	onTakeover?: (takenOver: boolean) => void;
	/** Receives every page title the Multica view reports (Multica sets "MUL-1: Title" on an issue page). */
	onPageTitleChange?: (title: string) => void;
	/** Offered each external-open target before the allowlist; return true when the URL was handled. */
	onAoSessionLink?: (url: string) => boolean;
};

export type MulticaViewHost = {
	getState: () => MulticaViewState;
	/** True while the Multica view covers the AO window. */
	isShown: () => boolean;
	setActive: (active: boolean) => void;
	toggle: () => void;
	/** Routes a `multica://` deep link to the view and surfaces it. False when ignored. */
	handleDeepLink: (url: string) => boolean;
	/** Opens a Multica issue route in the view, surfacing it first. False when the path is not an issue route or the view is unavailable. */
	navigatePath: (path: string) => boolean;
	/** Runs a script in the Multica page's main world. Does nothing without a live view. */
	runInPage: (script: string) => void;
	/** Runs a script in AO's isolated world, sharing the DOM but not page globals. */
	runInAoWorld: (script: string) => void;
	/**
	 * Runs a script in the Multica page. When `serverKey` is given the script only
	 * runs if the live view belongs to that server, so a script built for one
	 * server (its API address) can never run, with its token, in another's page.
	 */
	evaluateInPage: (script: string, serverKey?: string) => Promise<unknown>;
	/** The server the live view was created for; null without a live view. */
	getServer: () => MulticaServer | null;
	/** Surfaces Multica and asks its renderer to open an inbox item. False when ignored (no Multica URL, no view). */
	openInboxItem: (target: MulticaInboxTarget) => boolean;
	dispose: () => void;
};

function parseSetSettingsRequest(value: unknown): MulticaSetSettingsRequest | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.mode !== "cloud" && record.mode !== "local") return null;
	if (typeof record.customUrl !== "string") return null;
	if (record.apiUrl !== undefined && typeof record.apiUrl !== "string") return null;
	return {
		mode: record.mode,
		customUrl: record.customUrl,
		...(record.apiUrl !== undefined ? { apiUrl: record.apiUrl } : {}),
		...(record.force === true ? { force: true } : {}),
	};
}

/**
 * Owns the single embedded Multica desktop view. Multica's built renderer runs
 * in a native WebContentsView that covers the whole AO window (sidebar, content
 * and toolbar), so switching between AO and Multica only attaches or detaches
 * it: neither side is reloaded or unmounted. AO's main process answers the IPC
 * Multica's own main process would (see multica-desktop-bridge.ts).
 *
 * The view is untrusted web content with a privileged preload, so it gets its
 * own persistent partition, sandbox and context isolation, every permission
 * denied, and navigation pinned to the built bundle.
 */
export async function createMulticaViewHost(options: MulticaViewHostOptions): Promise<MulticaViewHost> {
	const { mainWindow, shellWebContents } = options;
	let server: MulticaServer | null = null;
	let url = "";
	let active = false;
	let status: MulticaStatus = "unconfigured";
	let error: string | undefined;
	let errorKind: MulticaErrorKind | undefined;
	let view: MulticaViewLike | undefined;
	let viewServer: MulticaServer | undefined;
	let rendererUrl = "";
	let shown = false;
	let attached = false;
	let loadFailed = false;
	let carriedPending: Array<[string, unknown[]]> = [];

	const getState = (): MulticaViewState => ({ active, status, url, ...(error ? { error } : {}), ...(errorKind ? { errorKind } : {}) });

	const pushState = (): void => {
		if (shellWebContents.isDestroyed()) return;
		shellWebContents.send(MULTICA_STATE_CHANNEL, getState());
	};

	const isTrustedShell = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender.id === shellWebContents.id;

	const openExternally = (target: string): void => {
		if (options.onAoSessionLink?.(target)) return;
		if (isAllowedAppExternalURL(target)) void options.shell.openExternal(target).catch(() => undefined);
	};

	const runInPage = (script: string): void => {
		if (!view || view.webContents.isDestroyed()) return;
		void view.webContents.executeJavaScript(script).catch(() => undefined);
	};
	const runInAoWorld = (script: string): void => {
		if (!view || view.webContents.isDestroyed()) return;
		void view.webContents.executeJavaScriptInIsolatedWorld(MULTICA_AO_WORLD_ID, [{ code: script }]).catch(() => undefined);
	};
	const evaluateInPage = async (script: string, serverKey?: string): Promise<unknown> => {
		if (!view || view.webContents.isDestroyed()) return undefined;
		if (serverKey !== undefined && viewServer?.key !== serverKey) return undefined;
		return await view.webContents.executeJavaScript(script).catch(() => undefined);
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

	const detachView = (target: MulticaViewLike): void => {
		attached = false;
		try {
			mainWindow.contentView.removeChildView(target as unknown as WebContentsView);
		} catch {
			// The BaseWindow may already have destroyed its content hierarchy.
		}
	};

	// While AO is showing, the Multica view must not be a child of the window at
	// all. A hidden but attached view keeps contributing the window-drag regions
	// of its page (Multica's own top bar) to the native hit test, and those
	// override AO's no-drag carve-outs over the toolbar.
	function applyView(): void {
		if (!view || view.webContents.isDestroyed()) return;
		if (!(active && status === "ready")) {
			if (attached) {
				view.setVisible(false);
				detachView(view);
			}
			if (shown) {
				shown = false;
				options.onTakeover?.(false);
			}
			return;
		}
		fit();
		if (shown) return;
		// Adding the child places it above AO's own native views (the per-worker
		// browser pages), which stay mounted underneath.
		mainWindow.contentView.addChildView(view as unknown as WebContentsView);
		attached = true;
		view.setVisible(true);
		view.webContents.focus();
		shown = true;
		options.onTakeover?.(true);
	}

	const createView = (): MulticaViewLike | undefined => {
		const bundle = options.resolveBundle();
		if (!server) return undefined;
		const createdFor = server;
		viewServer = createdFor;
		if (!bundle) {
			setStatus("error", BUNDLE_MISSING_MESSAGE, "bundle-missing");
			return undefined;
		}
		rendererUrl = bundle.rendererUrl;
		const created = new options.WebContentsView({
			webPreferences: {
				partition: createdFor.partition,
				preload: bundle.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: options.webSecurity,
				additionalArguments: [`--multica-locale=${options.locale.replace(/[^A-Za-z0-9_-]/g, "") || "en"}`],
			},
		});
		created.setVisible(false);
		const contents = created.webContents;

		contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		contents.session.setPermissionCheckHandler(() => false);
		// Session-level preloads run just before the view's own preload. This
		// partition is used by the Multica view alone.
		contents.session.setPreloads([options.ipcJailPreload]);
		// The file:// renderer's WebSocket handshake carries `Origin: null`, which a
		// Multica server rejects (403) unless its allowlist names it.
		contents.session.webRequest.onBeforeSendHeaders({ urls: ["ws://*/*", "wss://*/*"] }, (details, callback) => {
			callback({ requestHeaders: multicaWebSocketHeaders(details.url, details.requestHeaders, createdFor.config) });
		});

		bridge = createMulticaDesktopBridge({
			ipc: contents.ipc,
			isMulticaSender: (sender) => !contents.isDestroyed() && sender.id === contents.id,
			getAppInfo: () => options.appInfo,
			getRuntimeConfig: () => ({ ok: true, config: createdFor.config }),
			getHostName: options.hostName,
			notifications: options.notifications,
			initialPending: carriedPending,
			daemon: options.createDaemonService((channel, payload) => {
				if (!contents.isDestroyed()) contents.send(channel, payload);
			}, createdFor),
			openExternal: (target) => openAllowedAppExternalURL(target, options.shell),
			send: (channel, payload) => {
				if (!contents.isDestroyed()) contents.send(channel, payload);
			},
		});
		carriedPending = [];

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
		contents.on("page-title-updated", (_event, title) => options.onPageTitleChange?.(title));
		contents.setWindowOpenHandler(({ url: target }) => {
			openExternally(target);
			return { action: "deny" };
		});

		// A page load drops every renderer subscription, so deep links must wait
		// for the renderer to announce its listeners again.
		contents.on("did-start-loading", () => {
			if (view?.webContents !== contents) return;
			bridge?.resetReadiness();
		});
		// A failed navigation commits Chromium's own error page and then fires
		// did-finish-load for it (observed order: fail, then finish), so a failure
		// has to veto the next did-finish-load. Only an explicit load() (retry or a
		// URL change) clears it; the error state offers no other way forward.
		contents.on("did-finish-load", () => {
			if (view?.webContents !== contents) return;
			if (!loadFailed) setStatus("ready");
		});
		contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
			if (view?.webContents !== contents) return;
			if (!isMainFrame || errorCode === -3) return;
			loadFailed = true;
			setStatus("error", errorDescription || "Unable to load page");
		});
		contents.on("render-process-gone", () => {
			if (view?.webContents !== contents) return;
			setStatus("error", "The Multica view stopped unexpectedly");
		});
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
		viewServer = undefined;
		const wasShown = shown;
		shown = false;
		bridge?.dispose();
		bridge = undefined;
		if (!current) return;
		options.notifications.reset();
		detachView(current);
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

	// A view is replaced when its identity changes: another server (its own
	// sign-in partition) or another API address for the same server.
	const identityOf = (candidate: MulticaServer | null): string =>
		candidate ? `${candidate.partition}|${candidate.config.apiUrl}|${candidate.config.wsUrl}` : "";

	const applySettings = (settings: MulticaSettings): void => {
		const next = resolveMulticaServer(settings);
		if (identityOf(next) === identityOf(server)) return;
		const previous = server;
		server = next;
		url = next?.appUrl ?? "";
		const sameServer = !!previous && !!next && previous.partition === next.partition;
		options.onServerChange?.(next?.key ?? "");
		if (!next) {
			destroyView();
			setStatus("unconfigured");
		} else if (view || active) {
			const carried = bridge?.pendingSnapshot() ?? [];
			const hadView = Boolean(view);
			destroyView();
			// Queued sign-in and invite links belong to one server: a token minted for
			// another must not be delivered to the new one.
			if (hadView && sameServer) {
				carriedPending = carried;
			} else {
				if (!hadView) options.notifications.reset();
				carriedPending = [];
			}
			load();
		} else {
			carriedPending = [];
			setStatus("idle");
		}
	};

	const saveSettings = async (value: unknown): Promise<MulticaSetSettingsResult> => {
		const request = parseSetSettingsRequest(value);
		if (!request) return { ok: false, error: "invalid_url", forceable: false };
		let customUrl = request.customUrl.trim();
		let apiUrl = (request.apiUrl ?? "").trim();
		if (request.mode === "local" && customUrl !== "") {
			const web = validateMulticaServerUrl(customUrl);
			if (!web.ok) return { ok: false, error: web.error, forceable: false };
			customUrl = web.origin;
			if (apiUrl !== "") {
				const api = validateMulticaServerUrl(apiUrl);
				if (!api.ok) return { ok: false, error: api.error, forceable: false };
				apiUrl = api.origin;
			}
			const checked = await options.checkServer({ customUrl, apiUrl });
			if (!checked.ok && !request.force) return { ok: false, error: checked.error, forceable: true };
			// A same-origin deployment is only reachable through the discovered API address.
			if (checked.ok && apiUrl === "") {
				const derived = resolveMulticaServer({ mode: "local", customUrl, apiUrl: "" });
				if (derived && derived.config.apiUrl !== checked.apiUrl) apiUrl = checked.apiUrl;
			}
		} else if (request.mode === "local") {
			apiUrl = "";
		} else {
			// Cloud keeps the remembered custom URL, but only a valid one.
			const remembered = customUrl === "" ? { ok: true as const, origin: "" } : validateMulticaServerUrl(customUrl);
			customUrl = remembered.ok ? remembered.origin : "";
			apiUrl = "";
		}
		const saved = await options.writeSettings({ mode: request.mode, customUrl, apiUrl });
		applySettings(saved);
		return { ok: true, settings: saved };
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
		applyView();
		// Focus after the view is detached so the shell, not the departing page, ends up focused.
		if (!active && !shellWebContents.isDestroyed()) shellWebContents.focus();
		pushState();
	}

	applySettings(await options.readSettings().catch(() => ({ mode: "local" as const, customUrl: "", apiUrl: "" })));

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
				if (!isTrustedShell(event)) return undefined;
				return saveSettings(value);
			},
		],
		[
			MULTICA_CHECK_SERVER_CHANNEL,
			async (event, value) => {
				if (!isTrustedShell(event)) return undefined;
				const request = parseSetSettingsRequest(value);
				return request ? options.checkServer(request) : ({ ok: false, error: "invalid_url" } satisfies MulticaCheckResult);
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		getState,
		isShown: () => shown,
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
		navigatePath: (path) => {
			if (!isMulticaIssuePath(path) || !url) return false;
			setActive(true);
			if (!view || view.webContents.isDestroyed() || !bridge) return false;
			const script = `window.dispatchEvent(new CustomEvent("multica:navigate", { detail: { path: ${JSON.stringify(path)} } }));`;
			// The signed-in layout subscribes to inbox:open and handles multica:navigate, so it can act.
			bridge.whenReady("inbox:open", () => runInPage(script));
			return true;
		},
		runInPage,
		runInAoWorld,
		evaluateInPage,
		getServer: () => (view && !view.webContents.isDestroyed() ? (viewServer ?? null) : null),
		openInboxItem: (target) => {
			if (!url) return false;
			setActive(true);
			if (!bridge) return false;
			bridge.dispatch("inbox:open", target);
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
