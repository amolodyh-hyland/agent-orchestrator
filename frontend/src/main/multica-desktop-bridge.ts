import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { MulticaRuntimeConfigResult } from "../shared/multica";

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
// links, and deep-link delivery (auth token, invite). Everything else is a safe
// stub. Multica's daemon is not managed by AO; the user runs it from the CLI.

const CHANNEL_STATE_CHANNEL = "main-renderer:channel-state";

// Messages the renderer only accepts after it has installed the matching
// listener; a page finishing its load is not enough (React subscribes later).
const MAIN_RENDERER_CHANNELS = new Set(["auth:token", "invite:open", "inbox:open", "settings:open", "tab:select-by-shortcut"]);

const MAX_PENDING_PER_CHANNEL = 8;

const DAEMON_UNAVAILABLE = "The Multica daemon is not managed by AO. Run it from the multica CLI.";
const NOT_AVAILABLE = "Not available in AO";

export type MulticaAppInfo = { version: string; os: "macos" | "windows" | "linux" | "unknown" };

export type MulticaDesktopBridgeOptions = {
	/** The Multica view's own `webContents.ipc`. */
	ipc: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
	isMulticaSender: (sender: { id: number }) => boolean;
	getAppInfo: () => MulticaAppInfo;
	getRuntimeConfig: () => MulticaRuntimeConfigResult;
	getHostName: () => string;
	/** Must already enforce AO's external-URL allowlist. */
	openExternal: (url: string) => Promise<void>;
	/** Delivers a main-to-renderer message to the Multica view. */
	send: (channel: string, payload?: unknown) => void;
};

export type MulticaDesktopBridge = {
	/** Sends now when the renderer subscribed to the channel, otherwise holds it until it does. */
	dispatch: (channel: string, payload: unknown) => void;
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
function invokeStubs(getHostName: () => string): Record<string, (...args: unknown[]) => unknown> {
	const daemonFailure = { success: false, error: DAEMON_UNAVAILABLE };
	const prefs = { autoStart: false, autoStop: false };
	const updaterPrefs = { automaticUpdates: false };
	const none = () => undefined;
	return {
		"file:download-url": none,
		"window:setImmersive": none,
		"window:open-issue": () => ({ ok: false, reason: "invalid_request" }),
		"local-directory:pick": () => ({ ok: false, reason: "error", error: NOT_AVAILABLE }),
		"local-directory:validate": () => ({ ok: false, reason: "error", error: NOT_AVAILABLE }),
		"daemon:start": () => daemonFailure,
		"daemon:stop": () => daemonFailure,
		"daemon:restart": () => daemonFailure,
		"daemon:get-status": () => ({ state: "stopped" }),
		"daemon:probe-runtimes": () => ({ probeResult: "error" }),
		"daemon:get-host-name": () => getHostName(),
		"daemon:set-target-api-url": none,
		"daemon:sync-token": none,
		"daemon:clear-token": none,
		"daemon:reauthenticate": () => ({ ok: false, reason: "transient", message: DAEMON_UNAVAILABLE }),
		"daemon:is-cli-installed": () => true,
		"daemon:get-prefs": () => prefs,
		"daemon:set-prefs": () => prefs,
		"daemon:auto-start": none,
		"daemon:retry-install": none,
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
const NOOP_SEND_CHANNELS = [
	"freeze:ack",
	"auth:session-state",
	"renderer:route-context",
	"notification:show",
	"badge:set",
	"window:close",
	"daemon:start-log-stream",
	"daemon:stop-log-stream",
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
		...Object.keys(invokeStubs(() => "")),
	];
}

export function createMulticaDesktopBridge(options: MulticaDesktopBridgeOptions): MulticaDesktopBridge {
	const ready = new Set<string>();
	const pending = new Map<string, unknown[]>();

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
		...Object.entries(invokeStubs(options.getHostName)).map(
			([channel, stub]): [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown] => [
				channel,
				(event, ...args) => (options.isMulticaSender(event.sender) ? stub(...args) : undefined),
			],
		),
	];

	for (const [channel, listener] of [...syncListeners, ...noopListeners]) options.ipc.on(channel, listener);
	options.ipc.on(CHANNEL_STATE_CHANNEL, onChannelState);
	for (const [channel, handler] of handlers) options.ipc.handle(channel, handler);

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
		resetReadiness: () => ready.clear(),
		dispose: () => {
			for (const [channel, listener] of [...syncListeners, ...noopListeners]) {
				options.ipc.removeListener(channel, listener);
			}
			options.ipc.removeListener(CHANNEL_STATE_CHANNEL, onChannelState);
			for (const [channel] of handlers) options.ipc.removeHandler(channel);
			ready.clear();
			pending.clear();
		},
	};
}
