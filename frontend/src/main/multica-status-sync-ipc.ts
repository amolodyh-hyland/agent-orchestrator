import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	EMPTY_MULTICA_SYNC_SNAPSHOT,
	MULTICA_SYNC_CHANGED_CHANNEL,
	MULTICA_SYNC_GET_STATE_CHANNEL,
	MULTICA_SYNC_PUBLISH_FACTS_CHANNEL,
	MULTICA_SYNC_REOPEN_CHANNEL,
	MULTICA_SYNC_RESUME_CHANNEL,
	MULTICA_SYNC_SET_LINK_CHANNEL,
	MULTICA_SYNC_SET_SETTINGS_CHANNEL,
	MULTICA_SYNC_SYNC_NOW_CHANNEL,
	isMulticaSyncFacts,
	isMulticaSyncLinkRef,
	parseMulticaSyncSettingsPatch,
	type MulticaSyncLinkRef,
} from "../shared/multica-status-sync";
import type { MulticaStatusSync } from "./multica-status-sync";

export type MulticaStatusSyncIpcOptions = {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "isDestroyed" | "send">;
	engine: Pick<
		MulticaStatusSync,
		"getSnapshot" | "setSettings" | "setLink" | "resume" | "reopen" | "syncNow" | "setFacts" | "onChanged"
	>;
};

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function linkRefOf(payload: unknown): MulticaSyncLinkRef | null {
	if (!isMulticaSyncLinkRef(payload)) return null;
	const { sessionId, workspaceSlug, issueIdentifier } = payload;
	return { sessionId, workspaceSlug, issueIdentifier };
}

/**
 * The renderer's side of status sync: read the state, change the settings, turn
 * a link on or off, resume or reopen, and publish the facts the engine maps.
 * Only the shell may call these, and a payload that is not exactly the expected
 * shape is ignored.
 */
export function registerMulticaStatusSyncIpc(options: MulticaStatusSyncIpcOptions): { dispose: () => void } {
	let disposed = false;
	const isTrustedShell = (event: IpcMainInvokeEvent): boolean => event.sender.id === options.shellWebContents.id;

	const unsubscribe = options.engine.onChanged((snapshot) => {
		if (!disposed && !options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_SYNC_CHANGED_CHANNEL, snapshot);
	});

	const handlers: Array<[string, IpcHandler]> = [
		[MULTICA_SYNC_GET_STATE_CHANNEL, (event) => (disposed || !isTrustedShell(event) ? EMPTY_MULTICA_SYNC_SNAPSHOT : options.engine.getSnapshot())],
		[
			MULTICA_SYNC_SET_SETTINGS_CHANNEL,
			async (event, payload) => {
				const patch = parseMulticaSyncSettingsPatch(payload);
				if (disposed || !isTrustedShell(event) || !patch) return options.engine.getSnapshot();
				return options.engine.setSettings(patch);
			},
		],
		[
			MULTICA_SYNC_SET_LINK_CHANNEL,
			async (event, payload) => {
				const ref = linkRefOf(payload);
				const enabled = (payload as { enabled?: unknown } | null)?.enabled;
				if (disposed || !isTrustedShell(event) || !ref || typeof enabled !== "boolean") return options.engine.getSnapshot();
				return options.engine.setLink({ ...ref, enabled });
			},
		],
		[
			MULTICA_SYNC_RESUME_CHANNEL,
			async (event, payload) => {
				const ref = linkRefOf(payload);
				if (disposed || !isTrustedShell(event) || !ref) return options.engine.getSnapshot();
				return options.engine.resume(ref);
			},
		],
		[
			MULTICA_SYNC_REOPEN_CHANNEL,
			async (event, payload) => {
				const ref = linkRefOf(payload);
				// Reopening a closed issue is only ever done after the user confirmed it.
				const confirmed = (payload as { confirmed?: unknown } | null)?.confirmed;
				if (disposed || !isTrustedShell(event) || !ref || confirmed !== true) return options.engine.getSnapshot();
				return options.engine.reopen(ref);
			},
		],
		[
			MULTICA_SYNC_SYNC_NOW_CHANNEL,
			async (event, payload) => {
				const ref = linkRefOf(payload);
				if (disposed || !isTrustedShell(event) || !ref) return options.engine.getSnapshot();
				return options.engine.syncNow(ref);
			},
		],
		[
			MULTICA_SYNC_PUBLISH_FACTS_CHANNEL,
			(event, payload) => {
				if (disposed || !isTrustedShell(event) || !isMulticaSyncFacts(payload)) return { ok: false };
				options.engine.setFacts(payload);
				return { ok: true };
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
		},
	};
}
