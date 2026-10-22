import { isDeepStrictEqual } from "node:util";
import { createDelegationStatusFlow } from "./multica-delegation-status";
import type { IpcMain, WebContents } from "electron";
import { resolveMulticaServer, type MulticaSettings } from "../shared/multica";
import type { DelegationPreview, DelegationStatus } from "../shared/multica-delegation-confirmation";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import type { MulticaCredentials } from "./multica-credentials";
import { createDaemonDelegationJournal } from "./multica-delegation-journal";
import { createMulticaDelegationCoordinator } from "./multica-delegation-coordinator";
import { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";
import { registerDelegationConfirmationIpc } from "./multica-delegation-confirmation-ipc";
import { createMulticaPublicApi } from "./multica-public-api";

export function registerDesktopDelegation(options: {
	ipcMain: IpcMain; shellWebContents: WebContents;
	authority: MainProcessDelegationAuthority; credentials: MulticaCredentials;
	readSettings: () => Promise<MulticaSettings>; daemonOrigin: () => string | null;
	confirmCancellation: (status: DelegationStatus) => Promise<boolean>;
	fetch: typeof fetch; confirm: (preview: DelegationPreview, detail: string) => Promise<boolean>;
}) {
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
				credentials: options.credentials, fetch: options.fetch, delegationsEnabled: true });
			clients.set(key, connection);
		}
		return connection;
	}
	const coordinator = createMulticaDelegationCoordinator({ journal, confirmations: options.authority, enabled: true,
		client: (binding) => {
			const connection = clients.get(JSON.stringify([binding.serverKey, binding.origin, binding.workspaceId]));
			if (!connection) throw new Error("connection_changed");
			return connection;
		} });
	const status = createDelegationStatusFlow({ journal, coordinator: coordinator.taskOrchestrator, human: coordinator.human,
		prepare: async (binding) => { if (!isDeepStrictEqual((await client(binding.workspaceId)).binding, binding)) throw new Error("connection_changed"); },
		confirmCancellation: options.confirmCancellation });
	const flow = createDelegationConfirmationFlow({ ...coordinator, client, policy: journal.evaluatePolicy, confirm: options.confirm,
		onConfirmed: (record) => { void status.status(record.projectId, record.taskId); } });
	const ipc = registerDelegationConfirmationIpc({ ipcMain: options.ipcMain, shellWebContents: options.shellWebContents, flow, status,
		setCredential: async (workspaceId, token) => (await (await client(workspaceId)).setToken(token)).ok });
	return { dispose: ipc.dispose, invalidate() { server = null; flow.invalidate(); status.invalidate(); } };
}
