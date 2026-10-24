import { registerResultImport } from "./specialist-result-import";
import { isDeepStrictEqual } from "node:util";
import { createFactoryDelegationMonitor } from "./factory-delegation-monitor";
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
	readEnabled: () => Promise<boolean>; writeEnabled: (enabled: boolean) => Promise<void>;
	confirmCancellation: (status: DelegationStatus) => Promise<boolean>;
	confirmEnable: () => Promise<boolean>;
	confirmResult?: (detail:string) => Promise<boolean>;
	fetch: typeof fetch; confirm: (preview: DelegationPreview, detail: string) => Promise<boolean>;
}) {
	let enabled = false;
	let generation = 0;
	let disposed = false;
	let enabling = false;
	let restoreEnabled = true;
	const ready = Promise.resolve().then(options.readEnabled).then((value) => {
		if (!disposed && restoreEnabled) enabled = value === true;
	}).catch(() => undefined);
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
	const monitor = createFactoryDelegationMonitor({ origin: options.daemonOrigin, fetch: options.fetch, restore: async (reference) => {
		const record = await journal.find(reference.projectId, reference.taskId);
		if (!record || (record.requestId !== reference.delegationId && record.remote?.delegation_id !== reference.delegationId) || record.state === "terminal" || record.state === "rejected" || disposed) return;
		await status.status(reference.projectId, reference.taskId);
	} });
	const flow = createDelegationConfirmationFlow({ ...coordinator, client: async (workspaceId) => {
		await ready;
		if (!enabled || disposed) throw new Error("delegations_disabled");
		return client(workspaceId);
	}, policy: journal.evaluatePolicy, confirm: options.confirm,
		onConfirmed: (record) => { void status.status(record.projectId, record.taskId); } });
	const ipc = registerDelegationConfirmationIpc({ ipcMain: options.ipcMain, shellWebContents: options.shellWebContents, flow, status,
		setCredential: async (workspaceId, token) => (await (await client(workspaceId)).setToken(token)).ok });
	const resultImport=registerResultImport({ipcMain:options.ipcMain,shellWebContents:options.shellWebContents,authority:options.authority,origin:options.daemonOrigin,fetch:options.fetch,policy:journal.evaluatePolicy,enabled:()=>enabled&&!disposed,confirm:options.confirmResult ?? (async()=>false),
        client:async(binding)=>{await ready;const connection=await client(binding.workspaceId);if(!isDeepStrictEqual(connection.binding,binding))throw new Error("connection_changed");return connection;}});
    const shell = options.shellWebContents;
	const trusted = (event: IpcMainInvokeEvent) => !disposed && !shell.isDestroyed() && event.sender.id === shell.id && event.senderFrame === shell.mainFrame;
	options.ipcMain.handle(DELEGATION_SETTINGS, async (event) => { await ready; return { enabled: trusted(event) && enabled }; });
	options.ipcMain.handle(DELEGATION_ENABLE_CLICK, async (event, value: unknown) => {
		if (!trusted(event) || !shell.isFocused() || typeof value !== "boolean") return;
		if (!value) {
			generation++; restoreEnabled = false; enabled = false; flow.invalidate(); status.revokeConfirmation(); resultImport.invalidate();
			shell.send(DELEGATION_SETTINGS_CHANGED, { enabled });
			await options.writeEnabled(false);
			return;
		}
		if (enabled || enabling) return;
		enabling = true;
		const version = generation;
		try {
			await ready;
			if (!trusted(event) || !shell.isFocused() || version !== generation) return;
			if (await options.confirmEnable() !== true || !trusted(event) || !shell.isFocused() || version !== generation) return;
			await options.writeEnabled(true);
			if (!trusted(event) || !shell.isFocused() || version !== generation) { await options.writeEnabled(false); return; }
			enabled = true;
			shell.send(DELEGATION_SETTINGS_CHANGED, { enabled });
		} catch {
			enabled = false;
			if (trusted(event)) shell.send(DELEGATION_SETTINGS_CHANGED, { enabled });
		} finally { enabling = false; }
	});
	const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) generation++; };
	shell.on("did-start-navigation", navigation);
	return {
		dispose() {
			disposed = true; enabled = false; generation++; monitor.dispose(); ipc.dispose(); resultImport.dispose();
			shell.removeListener("did-start-navigation", navigation);
			options.ipcMain.removeHandler(DELEGATION_SETTINGS);
			options.ipcMain.removeHandler(DELEGATION_ENABLE_CLICK);
		},
		invalidate() { generation++; server = null; flow.invalidate(); status.invalidate(); resultImport.invalidate(); },
	};
}
