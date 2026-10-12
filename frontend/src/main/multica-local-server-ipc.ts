import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	EMPTY_LOCAL_SERVER_STATUS,
	MULTICA_LOCAL_SERVER_CANCEL_CHANNEL,
	MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL,
	MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL,
	MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL,
	MULTICA_LOCAL_SERVER_RESTART_CHANNEL,
	MULTICA_LOCAL_SERVER_SETUP_CHANNEL,
	MULTICA_LOCAL_SERVER_START_CHANNEL,
	MULTICA_LOCAL_SERVER_STOP_CHANNEL,
	MULTICA_LOCAL_SERVER_USE_DETECTED_CHANNEL,
	MULTICA_LOCAL_SERVER_WATCH_CHANNEL,
	parseLocalServerService,
	parseLocalServerTail,
	type LocalServerLogsResult,
	type LocalServerResult,
} from "../shared/multica-local-server";
import type { MulticaLocalServer } from "./multica-local-server";

export type MulticaLocalServerIpcOptions = {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id">;
	server: Pick<MulticaLocalServer, "getStatus" | "watch" | "start" | "stop" | "restart" | "cancel" | "setup" | "chooseFolder" | "useDetectedFolder" | "getLogs">;
};

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const REJECTED = { ok: false, code: "bad_request" } as const satisfies LocalServerResult & LocalServerLogsResult;

/**
 * The renderer's side of the local server controls. Only the shell may call these. No
 * channel takes a path or command text: an operation is its channel name, a log request
 * carries an enumerated service and a bounded line count, and anything else is ignored.
 */
export function registerMulticaLocalServerIpc(options: MulticaLocalServerIpcOptions): { dispose: () => void } {
	let disposed = false;
	const isTrustedShell = (event: IpcMainInvokeEvent): boolean => !disposed && event.sender.id === options.shellWebContents.id;
	const guarded =
		(run: () => Promise<LocalServerResult>): IpcHandler =>
		(event) =>
			isTrustedShell(event) ? run() : REJECTED;

	const handlers: Array<[string, IpcHandler]> = [
		[MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL, (event) => (isTrustedShell(event) ? options.server.getStatus() : EMPTY_LOCAL_SERVER_STATUS)],
		[
			MULTICA_LOCAL_SERVER_WATCH_CHANNEL,
			(event, enabled) => {
				if (!isTrustedShell(event) || typeof enabled !== "boolean") return REJECTED;
				options.server.watch(enabled);
				return { ok: true } satisfies LocalServerResult;
			},
		],
		[MULTICA_LOCAL_SERVER_START_CHANNEL, guarded(() => options.server.start())],
		[MULTICA_LOCAL_SERVER_STOP_CHANNEL, guarded(() => options.server.stop())],
		[MULTICA_LOCAL_SERVER_RESTART_CHANNEL, guarded(() => options.server.restart())],
		[MULTICA_LOCAL_SERVER_CANCEL_CHANNEL, guarded(async () => options.server.cancel())],
		[MULTICA_LOCAL_SERVER_SETUP_CHANNEL, guarded(() => options.server.setup())],
		[MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL, guarded(() => options.server.chooseFolder())],
		[MULTICA_LOCAL_SERVER_USE_DETECTED_CHANNEL, guarded(() => options.server.useDetectedFolder())],
		[
			MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL,
			(event, payload): Promise<LocalServerLogsResult> | LocalServerLogsResult => {
				const request = payload && typeof payload === "object" ? (payload as { service?: unknown; tail?: unknown }) : null;
				const service = parseLocalServerService(request?.service);
				const tail = parseLocalServerTail(request?.tail);
				if (!isTrustedShell(event) || !service || tail === null) return REJECTED;
				return options.server.getLogs(service, tail);
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			options.server.watch(false);
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
		},
	};
}
