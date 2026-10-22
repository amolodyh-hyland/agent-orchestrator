import { isDeepStrictEqual } from "node:util";
import { createDelegationStatusFlow } from "./multica-delegation-status";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { resolveMulticaServer, type MulticaSettings } from "../shared/multica";
import type { DelegationPreview, DelegationStatus } from "../shared/multica-delegation-confirmation";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import type { MulticaCredentials } from "./multica-credentials";
import { createDaemonDelegationJournal } from "./multica-delegation-journal";
import { createMulticaDelegationCoordinator } from "./multica-delegation-coordinator";
import { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";
import { registerDelegationConfirmationIpc } from "./multica-delegation-confirmation-ipc";
import { createMulticaPublicApi } from "./multica-public-api";
import { DELEGATION_SETTINGS, DELEGATION_SETTINGS_CHANGED, DELEGATION_ENABLE_CLICK } from "../shared/multica-delegation-confirmation";

export function registerDesktopDelegation(options: {
	ipcMain: IpcMain; shellWebContents: WebContents;
	authority: MainProcessDelegationAuthority; credentials: MulticaCredentials;
	readSettings: () => Promise<MulticaSettings>; daemonOrigin: () => string | null;
	confirmCancellation: (status: DelegationStatus) => Promise<boolean>;
	confirmEnable: () => Promise<boolean>;
	fetch: typeof fetch; confirm: (preview: DelegationPreview, detail: string) => Promise<boolean>;
}) {
	let enabled = false;
	let generation = 0;
	let disposed = false;
	let enabling = false;
	let server: ReturnType<typeof resolveMulticaServer> = null;
	const clients = new Map<string, ReturnType<typeof createMulticaPublicApi>>();
	const journal = createDaemonDelegationJournal(options.daemonOrigin, options.authority, options.fetch);
	async function client(workspaceId: string) {
		server = resolveMulticaServer(await options.readSettings());
		if (!server) throw new Error("connection_changed");
		const key = JSON.stringify([server.key, server.config.apiUrl, workspaceId]);
		let connection = clients.get(key);
		if (!connection) {
			connection = createMulticaPublicApi({ server, workspaceId, getConfiguredServer: () => server,
				credentials: options.credentials, fetch: options.fetch, delegationsEnabled: () => enabled && !disposed });
			clients.set(key, connection);
		}
		return connection;
	}
	const coordinator = createMulticaDelegationCoordinator({ journal, confirmations: options.authority, enabled: () => enabled && !disposed,
		client: (binding) => {
			const connection = clients.get(JSON.stringify([binding.serverKey, binding.origin, binding.workspaceId]));
			if (!connection) throw new Error("connection_changed");
			return connection;
		} });
	const status = createDelegationStatusFlow({ journal, coordinator: coordinator.taskOrchestrator, human: coordinator.human,
		prepare: async (binding) => { if (!isDeepStrictEqual((await client(binding.workspaceId)).binding, binding)) throw new Error("connection_changed"); },
		confirmCancellation: options.confirmCancellation });
	const flow = createDelegationConfirmationFlow({ ...coordinator, client: async (workspaceId) => {
		if (!enabled || disposed) throw new Error("delegations_disabled");
		return client(workspaceId);
	}, policy: journal.evaluatePolicy, confirm: options.confirm,
		onConfirmed: (record) => { void status.status(record.projectId, record.taskId); } });
	const ipc = registerDelegationConfirmationIpc({ ipcMain: options.ipcMain, shellWebContents: options.shellWebContents, flow, status,
		setCredential: async (workspaceId, token) => (await (await client(workspaceId)).setToken(token)).ok });
	const shell = options.shellWebContents;
	const trusted = (event: IpcMainInvokeEvent) => !disposed && !shell.isDestroyed() && event.sender.id === shell.id && event.senderFrame === shell.mainFrame;
	options.ipcMain.handle(DELEGATION_SETTINGS, (event) => trusted(event) ? { enabled } : { enabled: false });
	options.ipcMain.handle(DELEGATION_ENABLE_CLICK, async (event, value: unknown) => {
		if (!trusted(event) || !shell.isFocused() || typeof value !== "boolean") return;
		if (!value) {
			generation++; enabled = false; flow.invalidate(); status.revokeConfirmation();
			shell.send(DELEGATION_SETTINGS_CHANGED, { enabled });
			return;
		}
		if (enabled || enabling) return;
		enabling = true;
		const version = generation;
		try {
			if (await options.confirmEnable() !== true || !trusted(event) || !shell.isFocused() || version !== generation) return;
			enabled = true;
			shell.send(DELEGATION_SETTINGS_CHANGED, { enabled });
		} finally { enabling = false; }
	});
	const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) generation++; };
	shell.on("did-start-navigation", navigation);
	return {
		dispose() {
			disposed = true; enabled = false; generation++; ipc.dispose();
			shell.removeListener("did-start-navigation", navigation);
			options.ipcMain.removeHandler(DELEGATION_SETTINGS);
			options.ipcMain.removeHandler(DELEGATION_ENABLE_CLICK);
		},
		invalidate() { generation++; server = null; flow.invalidate(); status.invalidate(); },
	};
}
