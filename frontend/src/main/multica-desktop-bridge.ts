import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { MulticaRuntimeConfigResult } from "../shared/multica";
import type { MulticaDaemonService } from "./multica-daemon-cli";
import type { MulticaNotifications } from "./multica-notifications";

// AO's main process stands in for Multica's main process for the embedded
// desktop renderer. Multica's own preload (attached to the Multica view only)
// talks to these channels; the names come from the preload inventory in
// apps/desktop/src/preload/index.ts of the Multica repo.
//
// Handlers are registered on the Multica view's own `webContents.ipc`, not on
// the global `ipcMain`: Electron consults the sender's own `ipc` first, so the
// channels are scoped to that view by construction and take precedence over AO's
// global handlers that share a name (`daemon:start`, `daemon:stop`,
// `daemon:restart` would otherwise drive AO's own daemon from the Multica page).
// Every handler still checks the sender as a second line of defence.
//
// What is real: app info, locale, runtime config, freeze breadcrumb, external
// links, deep-link delivery (auth token, invite), notifications, account session,
// badge, and a minimal daemon surface backed by the installed multica CLI.

const CHANNEL_STATE_CHANNEL = "main-renderer:channel-state";

// Messages the renderer only accepts after it has installed the matching
// listener; a page finishing its load is not enough (React subscribes later).
const MAIN_RENDERER_CHANNELS = new Set(["auth:token", "invite:open", "inbox:open", "settings:open", "tab:select-by-shortcut"]);

const MAX_PENDING_PER_CHANNEL = 8;

const DAEMON_UNAVAILABLE = "Not managed by AO: the multica CLI keeps its own login and server config.";
const NOT_AVAILABLE = "Not available in AO";

export type MulticaAppInfo = { version: string; os: "macos" | "windows" | "linux" | "unknown" };

export type MulticaDesktopBridgeOptions = {
	/** The Multica view's own `webContents.ipc`. */
	ipc: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
	isMulticaSender: (sender: { id: number }) => boolean;
	getAppInfo: () => MulticaAppInfo;
	getRuntimeConfig: () => MulticaRuntimeConfigResult;
	getHostName: () => string;
	/** Controls the daemon through the multica CLI. The bridge starts its polling and disposes it. */
	daemon: MulticaDaemonService;
	/** Must already enforce AO's external-URL allowlist. */
	openExternal: (url: string) => Promise<void>;
	/** Delivers a main-to-renderer message to the Multica view. */
	send: (channel: string, payload?: unknown) => void;
	/** Receives Multica's notification, auth-session and badge messages. */
	notifications: Pick<MulticaNotifications, "showNotification" | "reportAuthSession" | "setBadge">;
	/** Queues safe deep links and auth tokens before the renderer subscribes. */
	initialPending?: ReadonlyArray<readonly [channel: string, payloads: readonly unknown[]]>;
};

export type MulticaDesktopBridge = {
	/** Sends now when the renderer subscribed to the channel, otherwise holds it until it does. */
	dispatch: (channel: string, payload: unknown) => void;
	/** Runs `callback` now when the renderer already subscribed to `channel`, otherwise once it does (once only). */
	whenReady: (channel: string, callback: () => void) => void;
	/** Drops messages still waiting for the renderer to subscribe to `channel`. */
	clearPending: (channel: string) => void;
	/** Copies queued payloads except inbox clicks, which belong to a server instance. */
	pendingSnapshot: () => Array<[string, unknown[]]>;
	/** A page load drops every renderer subscription, so readiness must be re-announced. */
	resetReadiness: () => void;
	dispose: () => void;
};

// Sync channels: the preload blocks on these during startup, so each must
// always set a return value, trusted sender or not.
type SyncReplies = Record<string, () => unknown>;

// Invoke channels the renderer awaits. Unsupported features answer with a value
// shaped like Multica's own failure/empty result so the UI degrades instead of
// throwing.
function invokeStubs(getHostName: () => string, daemon: MulticaDaemonService): Record<string, (...args: unknown[]) => unknown> {
	const daemonFailure = { success: false, error: DAEMON_UNAVAILABLE };
	// Nothing here ever starts or stops the daemon on its own: that is always an
	// explicit action in the UI.
	const prefs = { autoStart: false, autoStop: false };
	const updaterPrefs = { automaticUpdates: false };
	const none = () => undefined;
	return {
		"file:download-url": none,
		"window:setImmersive": none,
		"window:open-issue": () => ({ ok: false, reason: "invalid_request" }),
		"local-directory:pick": () => ({ ok: false, reason: "error", error: NOT_AVAILABLE }),
		"local-directory:validate": () => ({ ok: false, reason: "error", error: NOT_AVAILABLE }),
		"daemon:start": () => daemon.start(),
		"daemon:stop": () => daemon.stop(),
		"daemon:restart": () => daemon.restart(),
		"daemon:get-status": () => daemon.getStatus(),
		"daemon:probe-runtimes": () => daemon.probeRuntimes(),
		"daemon:get-host-name": () => getHostName(),
		// The CLI owns its login and server config; the page must never overwrite
		// them, so token and target sync are deliberate no-ops.
		"daemon:set-target-api-url": none,
		"daemon:sync-token": none,
		"daemon:clear-token": none,
		"daemon:reauthenticate": () => ({ ok: false, reason: "transient", message: DAEMON_UNAVAILABLE }),
		"daemon:is-cli-installed": () => daemon.isInstalled(),
		"daemon:get-prefs": () => prefs,
		// Auto-start and stop-on-quit are not implemented, so the stored values stay
		// off and a change is refused by answering with them (the toggle reverts).
		"daemon:set-prefs": () => prefs,
		"daemon:auto-start": none,
		"daemon:retry-install": () => daemon.refreshBinary(),
		"daemon:open-log-file": () => daemonFailure,
		"updater:download": none,
		"updater:install": none,
		"updater:get-preferences": () => updaterPrefs,
		"updater:set-automatic-updates": () => updaterPrefs,
		"updater:check": () => ({ ok: false, error: NOT_AVAILABLE }),
	};
}

// Fire-and-forget channels with nothing to do, so they need no sender check.
// `window:close` is deliberately a no-op: an embedded view closing "its window"
// must never close AO's window.
const LOG_STREAM_CHANNELS = ["daemon:start-log-stream", "daemon:stop-log-stream"] as const;
const NOTIFICATION_CHANNELS = ["auth:session-state", "notification:show", "badge:set"] as const;

const NOOP_SEND_CHANNELS = [
	"freeze:ack",
	"renderer:route-context",
	"window:close",
] as const;

/**
 * Every channel Multica's preload may use. The Multica view's own preload gets
 * a generic `ipcRenderer` pass-through, so the view is confined to exactly this
 * list (see multica-ipc-jail.ts).
 */
export function multicaBridgeChannels(): string[] {
	return [
		"app:get-info",
		"runtime-config:get",
		"freeze:get-last",
		CHANNEL_STATE_CHANNEL,
		"shell:openExternal",
		...NOOP_SEND_CHANNELS,
		...NOTIFICATION_CHANNELS,
		...LOG_STREAM_CHANNELS,
		...Object.keys(invokeStubs(() => "", {} as MulticaDaemonService)),
	];
}

export function createMulticaDesktopBridge(options: MulticaDesktopBridgeOptions): MulticaDesktopBridge {
	const ready = new Set<string>();
	const pending = new Map<string, unknown[]>();
	const waiting = new Map<string, Array<() => void>>();
	for (const [channel, payloads] of options.initialPending ?? []) {
		if (!MAIN_RENDERER_CHANNELS.has(channel) || channel === "inbox:open") continue;
		const queue = pending.get(channel) ?? [];
		pending.set(channel, [...queue, ...payloads].slice(-MAX_PENDING_PER_CHANNEL));
	}

	const syncReplies: SyncReplies = {
		"app:get-info": options.getAppInfo,
		"runtime-config:get": options.getRuntimeConfig,
		"freeze:get-last": () => null,
	};

	const syncListeners: Array<[string, (event: IpcMainEvent) => void]> = Object.entries(syncReplies).map(
		([channel, reply]) => [
			channel,
			(event) => {
				let value: unknown = null;
				try {
					if (options.isMulticaSender(event.sender)) value = reply();
				} catch {
					value = null;
				}
				event.returnValue = value;
			},
		],
	);

	const noopListeners: Array<[string, (event: IpcMainEvent) => void]> = NOOP_SEND_CHANNELS.map((channel) => [
		channel,
		() => undefined,
	]);

	const notificationListeners: Array<[string, (event: IpcMainEvent, value: unknown) => void]> = [
		[
			"auth:session-state",
			(event, value) => {
				if (options.isMulticaSender(event.sender) && options.notifications.reportAuthSession(value)) {
					// Invalidation makes any queued inbox click belong to the previous account.
					pending.delete("inbox:open");
				}
			},
		],
		[
			"notification:show",
			(event, value) => {
				if (options.isMulticaSender(event.sender)) options.notifications.showNotification(value);
			},
		],
		[
			"badge:set",
			(event, value) => {
				if (options.isMulticaSender(event.sender)) options.notifications.setBadge(value);
			},
		],
	];

	const logStreamListeners: Array<[string, (event: IpcMainEvent) => void]> = [
		[
			"daemon:start-log-stream",
			(event) => {
				if (options.isMulticaSender(event.sender)) options.daemon.startLogStream();
			},
		],
		[
			"daemon:stop-log-stream",
			(event) => {
				if (options.isMulticaSender(event.sender)) options.daemon.stopLogStream();
			},
		],
	];

	const onChannelState = (event: IpcMainEvent, input: unknown): void => {
		if (!options.isMulticaSender(event.sender) || !input || typeof input !== "object") return;
		const { channel, ready: isReady } = input as { channel?: unknown; ready?: unknown };
		if (typeof channel !== "string" || !MAIN_RENDERER_CHANNELS.has(channel) || typeof isReady !== "boolean") return;
		if (!isReady) {
			ready.delete(channel);
			return;
		}
		ready.add(channel);
		for (const payload of pending.get(channel) ?? []) options.send(channel, payload);
		pending.delete(channel);
		for (const callback of waiting.get(channel) ?? []) {
			try {
				callback();
			} catch {
				// Ignore one callback failure so the rest can run.
			}
		}
		waiting.delete(channel);
	};

	const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
		[
			"shell:openExternal",
			async (event, url) => {
				if (!options.isMulticaSender(event.sender) || typeof url !== "string") return undefined;
				await options.openExternal(url).catch(() => undefined);
				return undefined;
			},
		],
		...Object.entries(invokeStubs(options.getHostName, options.daemon)).map(
			([channel, stub]): [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown] => [
				channel,
				(event, ...args) => (options.isMulticaSender(event.sender) ? stub(...args) : undefined),
			],
		),
	];

	for (const [channel, listener] of [...syncListeners, ...noopListeners, ...notificationListeners, ...logStreamListeners]) options.ipc.on(channel, listener);
	options.ipc.on(CHANNEL_STATE_CHANNEL, onChannelState);
	for (const [channel, handler] of handlers) options.ipc.handle(channel, handler);
	options.daemon.startPolling();

	return {
		dispatch: (channel, payload) => {
			if (ready.has(channel)) {
				options.send(channel, payload);
				return;
			}
			const queue = pending.get(channel) ?? [];
			queue.push(payload);
			pending.set(channel, queue.slice(-MAX_PENDING_PER_CHANNEL));
		},
		whenReady: (channel, callback) => {
			if (ready.has(channel)) {
				callback();
				return;
			}
			const queue = waiting.get(channel) ?? [];
			queue.push(callback);
			waiting.set(channel, queue.slice(-MAX_PENDING_PER_CHANNEL));
		},
		clearPending: (channel) => pending.delete(channel),
		pendingSnapshot: () =>
			[...pending]
				.filter(([channel, payloads]) => channel !== "inbox:open" && payloads.length > 0)
				.map(([channel, payloads]): [string, unknown[]] => [channel, [...payloads]]),
		resetReadiness: () => ready.clear(),
		dispose: () => {
			for (const [channel, listener] of [...syncListeners, ...noopListeners, ...notificationListeners, ...logStreamListeners]) {
				options.ipc.removeListener(channel, listener);
			}
			options.daemon.dispose();
			options.ipc.removeListener(CHANNEL_STATE_CHANNEL, onChannelState);
			// Keep invokes local until this WebContents closes; otherwise they fall through to AO's global handlers.
			for (const [channel] of handlers) {
				options.ipc.removeHandler(channel);
				options.ipc.handle(channel, () => undefined);
			}
			ready.clear();
			pending.clear();
			waiting.clear();
		},
	};
}
