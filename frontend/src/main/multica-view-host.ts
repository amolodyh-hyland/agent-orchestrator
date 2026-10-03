import type { BaseWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent, Session, WebContents, WebContentsView } from "electron";
import {
	MULTICA_GET_SETTINGS_CHANNEL,
	MULTICA_GET_STATE_CHANNEL,
	MULTICA_PARTITION,
	MULTICA_RELOAD_CHANNEL,
	MULTICA_SET_ACTIVE_CHANNEL,
	MULTICA_SET_BOUNDS_CHANNEL,
	MULTICA_SET_SETTINGS_CHANNEL,
	MULTICA_STATE_CHANNEL,
	isMulticaOrigin,
	parseMulticaUrl,
	type MulticaBoundsInput,
	type MulticaRect,
	type MulticaSettings,
	type MulticaStatus,
	type MulticaViewState,
} from "../shared/multica";
import type { KeybindingOverrides } from "../shared/shortcuts";
import { attachAppShortcuts } from "./app-shortcuts";
import { isAllowedAppExternalURL } from "./external-open";

type MulticaWebContents = Pick<
	WebContents,
	"id" | "on" | "loadURL" | "focus" | "close" | "isDestroyed" | "setWindowOpenHandler"
> & {
	session: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">;
};

type MulticaViewLike = Pick<WebContentsView, "setBounds" | "setVisible"> & { webContents: MulticaWebContents };

export type MulticaViewHostOptions = {
	mainWindow: Pick<BaseWindow, "contentView" | "getContentBounds">;
	shellWebContents: WebContents;
	ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
	shell: { openExternal: (url: string) => Promise<void> };
	WebContentsView: new (options: { webPreferences: Electron.WebPreferences }) => MulticaViewLike;
	isMac: boolean;
	getKeybindingOverrides: () => KeybindingOverrides;
	isKeybindingRecording: () => boolean;
	/** Re-raises the transparent shell above every native view (see window-composition.ts). */
	restackShell: () => void;
	readSettings: () => Promise<MulticaSettings>;
	writeUrl: (url: string) => Promise<MulticaSettings>;
};

export type MulticaViewHost = {
	getState: () => MulticaViewState;
	setActive: (active: boolean) => void;
	toggle: () => void;
	dispose: () => void;
};

function scaledBounds(rect: MulticaRect, zoomFactor: number, windowBounds: { width: number; height: number }): MulticaRect {
	const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
	const x = Math.min(Math.max(Math.round(rect.x * zoom), 0), windowBounds.width);
	const y = Math.min(Math.max(Math.round(rect.y * zoom), 0), windowBounds.height);
	return {
		x,
		y,
		width: Math.min(Math.max(Math.round(rect.width * zoom), 0), windowBounds.width - x),
		height: Math.min(Math.max(Math.round(rect.height * zoom), 0), windowBounds.height - y),
	};
}

function isRect(value: unknown): value is MulticaRect {
	if (!value || typeof value !== "object") return false;
	const rect = value as Record<string, unknown>;
	return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
}

/**
 * Owns the single embedded Multica web view. The view is a native
 * WebContentsView stacked over the shell's center panel, so switching between AO
 * and Multica only shows or hides it: neither side is reloaded or unmounted.
 *
 * The view is untrusted web content. It gets its own persistent partition, no
 * preload (so no AO bridge or IPC), sandbox on, every permission denied, and
 * main-frame navigation pinned to the configured origin.
 */
export async function createMulticaViewHost(options: MulticaViewHostOptions): Promise<MulticaViewHost> {
	const { mainWindow, shellWebContents } = options;
	let url = "";
	let origin = "";
	let active = false;
	let status: MulticaStatus = "unconfigured";
	let error: string | undefined;
	let view: MulticaViewLike | undefined;
	let shown = false;
	let rect: MulticaRect | null = null;
	let zoomFactor = 1;
	let boundsRevision = 0;
	let overlayOpen = false;
	let loadFailed = false;

	const getState = (): MulticaViewState => ({ active, status, url, ...(error ? { error } : {}) });

	const pushState = (): void => {
		if (shellWebContents.isDestroyed()) return;
		shellWebContents.send(MULTICA_STATE_CHANNEL, getState());
	};

	const isTrustedShell = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender.id === shellWebContents.id;

	const openExternally = (target: string): void => {
		if (isAllowedAppExternalURL(target)) void options.shell.openExternal(target).catch(() => undefined);
	};

	const setStatus = (next: MulticaStatus, nextError?: string): void => {
		status = next;
		error = nextError;
		applyView();
		pushState();
	};

	function applyView(): void {
		if (!view || view.webContents.isDestroyed()) return;
		const visible = active && status === "ready" && rect !== null && rect.width > 0 && rect.height > 0;
		if (!visible || !rect) {
			if (shown) view.setVisible(false);
			shown = false;
			return;
		}
		view.setBounds(scaledBounds(rect, zoomFactor, mainWindow.getContentBounds()));
		if (shown) return;
		// Re-adding an existing child raises it above AO's own native views (the
		// per-worker browser pages), which stay mounted underneath. If a dialog is
		// open the shell must stay above everything, so restack it afterwards.
		mainWindow.contentView.addChildView(view as unknown as WebContentsView);
		if (overlayOpen) options.restackShell();
		view.setVisible(true);
		view.webContents.focus();
		shown = true;
	}

	const load = (): void => {
		if (!view || !url) return;
		loadFailed = false;
		setStatus("loading");
		// A failed load surfaces through did-fail-load; the rejection carries nothing new.
		void view.webContents.loadURL(url).catch(() => undefined);
	};

	const createView = (): MulticaViewLike => {
		const created = new options.WebContentsView({
			webPreferences: {
				partition: MULTICA_PARTITION,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				// Deliberately no `preload`: this content must never see the AO bridge.
			},
		});
		created.setVisible(false);
		mainWindow.contentView.addChildView(created as unknown as WebContentsView);
		const contents = created.webContents;

		contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		contents.session.setPermissionCheckHandler(() => false);

		const guardNavigation = (event: { preventDefault: () => void }, target: string, isMainFrame = true): void => {
			if (!isMainFrame || isMulticaOrigin(target, origin)) return;
			event.preventDefault();
			openExternally(target);
		};
		contents.on("will-navigate", (event, target) => guardNavigation(event, target));
		contents.on("will-redirect", (event, target, _isInPlace, isMainFrame) => guardNavigation(event, target, isMainFrame));
		contents.setWindowOpenHandler(({ url: target }) => {
			if (isMulticaOrigin(target, origin)) void contents.loadURL(target).catch(() => undefined);
			else openExternally(target);
			return { action: "deny" };
		});

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

		// The Multica page is its own WebContents, so shell keydown listeners never
		// see keys typed in it. Forward only the toggle so the user can always get
		// back to AO; every other chord belongs to the page.
		attachAppShortcuts(
			contents,
			options.isMac,
			shellWebContents,
			true,
			options.getKeybindingOverrides,
			options.isKeybindingRecording,
			(id) => id === "toggle-multica",
		);
		return created;
	};

	const destroyView = (): void => {
		const current = view;
		view = undefined;
		shown = false;
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
	};

	const applySettings = (settings: MulticaSettings): void => {
		const parsed = parseMulticaUrl(settings.url);
		const nextUrl = parsed.ok ? parsed.url : "";
		if (nextUrl === url) return;
		url = nextUrl;
		origin = parsed.ok ? parsed.origin : "";
		if (!url) {
			destroyView();
			setStatus("unconfigured");
		} else if (view) {
			load();
		} else if (active) {
			view = createView();
			load();
		} else {
			setStatus("idle");
		}
	};

	const setActive = (next: boolean): void => {
		if (active === next) return;
		active = next;
		// First activation is the only thing that creates the view or loads the
		// page; later switches just show and hide it.
		if (active && url && !view) {
			view = createView();
			load();
			return;
		}
		if (!active && !shellWebContents.isDestroyed()) shellWebContents.focus();
		applyView();
		pushState();
	};

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

	const onBounds = (event: IpcMainEvent, input: unknown): void => {
		if (!isTrustedShell(event) || !input || typeof input !== "object") return;
		const { revision, rect: nextRect } = input as Partial<MulticaBoundsInput>;
		if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= boundsRevision) return;
		if (nextRect !== null && !isRect(nextRect)) return;
		boundsRevision = revision;
		rect = nextRect;
		zoomFactor = event.sender.getZoomFactor();
		applyView();
	};
	options.ipcMain.on(MULTICA_SET_BOUNDS_CHANNEL, onBounds);

	// Observe the same overlay signal main.ts uses to raise the shell, so a view
	// that becomes visible while a dialog is open does not cover that dialog.
	const onOverlay = (event: IpcMainEvent, open: unknown): void => {
		if (!isTrustedShell(event) || typeof open !== "boolean") return;
		overlayOpen = open;
	};
	options.ipcMain.on("browser:overlay", onOverlay);

	return {
		getState,
		setActive,
		toggle: () => setActive(!active),
		dispose: () => {
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
			options.ipcMain.removeListener(MULTICA_SET_BOUNDS_CHANNEL, onBounds);
			options.ipcMain.removeListener("browser:overlay", onOverlay);
			destroyView();
		},
	};
}
