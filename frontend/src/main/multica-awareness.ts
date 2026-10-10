// Awareness coordinator: owns the watch configuration, one connection per
// switched-on server, the IPC surface, and the state pushed to the renderer.
//
// Read-only toward Multica: nothing here sends a write, and the only requests
// are the GETs of the read client. Nothing is watched until the user switches on
// the master switch, then a server, then each workspace.

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { resolveMulticaServer, validateMulticaServerUrl, type MulticaServer } from "../shared/multica";
import {
	MULTICA_ACTION_LOG_READ_CHANNEL,
	isMulticaActionLogQuery,
	type MulticaActionInput,
	type MulticaActionRecord,
} from "../shared/multica-action-log";
import {
	EMPTY_AWARENESS_STATE,
	MULTICA_AWARENESS_COMMAND_CHANNEL,
	MULTICA_AWARENESS_GET_STATE_CHANNEL,
	MULTICA_AWARENESS_OPEN_ISSUE_CHANNEL,
	MULTICA_AWARENESS_STATE_CHANNEL,
	isAwarenessCommand,
	isOpenMulticaIssueRequest,
	type AwarenessCommand,
	type AwarenessCommandFailure,
	type AwarenessCommandResult,
	type AwarenessIssue,
	type AwarenessRun,
	type AwarenessServerState,
	type AwarenessState,
} from "../shared/multica-awareness";
import type { MulticaIssueLink } from "../shared/multica-issue-links";
import type { MulticaActionLog } from "./multica-action-log";
import { createServerConnection, type KnownWorkspace, type ServerConnection } from "./multica-awareness-connection";
import type { MulticaCredentials } from "./multica-credentials";
import { MAX_WATCHED_SERVERS, type MulticaWatchConfigStore, type WatchConfig, type WatchServer } from "./multica-watch-config";
import { buildReadWorkspaceSlugScript } from "./multica-open-with-ao";
import { systemScheduler, type FetchLike, type Scheduler } from "./multica-read-client";
import type { PageHost } from "./multica-page-transport";

export const AWARENESS_PUSH_THROTTLE_MS = 250;

export type AwarenessPageHost = PageHost & { getServer: () => MulticaServer | null };

export type MulticaAwarenessOptions = {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "isDestroyed" | "send">;
	watchStore: MulticaWatchConfigStore;
	credentials: MulticaCredentials;
	actionLog: Pick<MulticaActionLog, "record" | "read">;
	fetch: FetchLike;
	env: NodeJS.ProcessEnv;
	/** Every stored issue link, all servers. */
	listLinks: () => Promise<MulticaIssueLink[]>;
	/** The embedded Multica view, for page-only mode and for opening an issue. Looked up lazily: it is created after this service. */
	getHost: () => (AwarenessPageHost & { navigatePath: (path: string) => boolean }) | undefined;
	/** Reads per minute and burst per server. Defaults to 60 and 10. */
	readBudget?: { perMinute: number; burst: number };
	scheduler?: Scheduler;
	random?: () => number;
};

export type AwarenessIssueLookup = {
	issue: AwarenessIssue;
	activeRuns: AwarenessRun[];
	/** Agent names for the active runs, and the assignee agent's name when it has one. */
	agentNames: string[];
	meId: string | null;
};

export type MulticaAwareness = {
	/** Reads the configuration and starts what the user switched on. */
	start: () => Promise<void>;
	getState: () => AwarenessState;
	/** The issue with this identifier on the server, or null when it is unknown or ambiguous (two workspaces share the prefix). */
	lookup: (serverKey: string, identifier: string) => AwarenessIssueLookup | null;
	/** Called after every state change (throttled), for consumers in the main process. */
	onChange: (listener: () => void) => () => void;
	/** Links changed: refresh the interest sets. */
	handleLinksChanged: () => void;
	dispose: () => void;
};

type Entry = { connection: ServerConnection; fingerprint: string; server: MulticaServer };

function serverLabel(server: WatchServer): string {
	if (server.mode === "cloud") return "Multica Cloud";
	try {
		return new URL(server.customUrl).host;
	} catch {
		return server.customUrl;
	}
}

function describe(command: AwarenessCommand): { trigger: string; serverKey?: string; workspaceId?: string } {
	switch (command.type) {
		case "setMaster":
			return { trigger: `setMaster:${command.enabled}` };
		case "addServer":
			return { trigger: `addServer:${command.mode}` };
		case "setServerEnabled":
			return { trigger: `setServerEnabled:${command.enabled}`, serverKey: command.serverKey };
		case "setCredentialSource":
			return { trigger: `setCredentialSource:${command.source}`, serverKey: command.serverKey };
		case "setWorkspaceWatch":
			return { trigger: `setWorkspaceWatch:${command.watch}`, serverKey: command.serverKey, workspaceId: command.workspaceId };
		case "setMaxSockets":
			return { trigger: `setMaxSockets:${command.value}` };
		// Token commands log the action only, never the value.
		case "setToken":
		case "clearToken":
		case "removeServer":
		case "grantConsent":
		case "revokeConsent":
		case "refreshWorkspaces":
			return { trigger: command.type, serverKey: command.serverKey };
	}
}

export function createMulticaAwareness(options: MulticaAwarenessOptions): MulticaAwareness {
	const scheduler = options.scheduler ?? systemScheduler;
	const connections = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	let config: WatchConfig = { masterEnabled: false, maxSockets: 8, servers: [] };
	let killSwitch = false;
	let linkCache: MulticaIssueLink[] = [];
	let pasted = new Set<string>();
	// Bumped when a server's stored credential is replaced or cleared, so its connection restarts and the old token is dropped.
	const credentialVersion = new Map<string, number>();
	let disposed = false;
	let pushTimer: unknown = null;
	let applyQueue: Promise<void> = Promise.resolve();

	const record = (input: MulticaActionInput): void => {
		void options.actionLog.record(input);
	};

	const emit = (): void => {
		if (disposed || pushTimer !== null) return;
		pushTimer = scheduler.setTimeout(() => {
			pushTimer = null;
			if (disposed) return;
			if (!options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_AWARENESS_STATE_CHANNEL, buildState());
			for (const listener of [...listeners]) listener();
		}, AWARENESS_PUSH_THROTTLE_MS);
	};

	const fingerprint = (server: WatchServer): string =>
		JSON.stringify([server.mode, server.customUrl, server.apiUrl, server.credentialSource, server.consentGranted, server.credentialSource === "pasted" && pasted.has(server.serverKey), credentialVersion.get(server.serverKey) ?? 0]);

	const linkedIdentifiers = (serverKey: string, workspaceSlug: string): string[] => {
		const slug = workspaceSlug.toLowerCase();
		return linkCache.filter((link) => link.serverKey === serverKey && link.workspaceSlug === slug).map((link) => link.issueIdentifier.toUpperCase());
	};

	function pageHost() {
		return (serverKey: string) => {
			const host = options.getHost();
			if (!host) return undefined;
			return {
				evaluateInPage: host.evaluateInPage,
				activeServerKey: () => host.getServer()?.key ?? null,
				readActiveSlug: async (): Promise<string | null> => {
					const raw = await host.evaluateInPage(buildReadWorkspaceSlugScript(), serverKey);
					if (typeof raw !== "string") return null;
					try {
						const parsed = JSON.parse(raw) as { slug?: unknown };
						return typeof parsed.slug === "string" ? parsed.slug.toLowerCase() : null;
					} catch {
						return null;
					}
				},
			};
		};
	}

	function mergeWorkspaces(serverKey: string, list: KnownWorkspace[]): Promise<void> {
		return options.watchStore
			.update((current) => ({
				...current,
				servers: current.servers.map((server) =>
					server.serverKey !== serverKey
						? server
						: {
								...server,
								workspaces: list.map((workspace) => ({
									workspaceId: workspace.id,
									slug: workspace.slug,
									name: workspace.name,
									watch: server.workspaces.find((held) => held.workspaceId === workspace.id)?.watch ?? false,
								})),
							},
				),
			}))
			.then((next) => {
				config = next;
				emit();
			});
	}

	function startConnection(server: WatchServer): Entry | null {
		const resolved = resolveMulticaServer({ mode: server.mode, customUrl: server.customUrl, apiUrl: server.apiUrl });
		if (!resolved) return null;
		const connection = createServerConnection({
			server: resolved,
			credentialSource: server.credentialSource,
			consentGranted: server.consentGranted,
			credentials: options.credentials,
			fetch: options.fetch,
			pageHost: () => pageHost()(resolved.key),
			linkedIdentifiers: (slug) => linkedIdentifiers(resolved.key, slug),
			onChange: emit,
			record,
			onWorkspaces: (list) => mergeWorkspaces(resolved.key, list),
			readBudget: options.readBudget,
			scheduler,
			random: options.random,
		});
		const entry: Entry = { connection, fingerprint: fingerprint(server), server: resolved };
		connections.set(server.serverKey, entry);
		connection.start();
		return entry;
	}

	async function applyUnlocked(): Promise<void> {
		if (disposed) return;
		config = await options.watchStore.read();
		killSwitch = options.env.AO_MULTICA_WATCH === "0";
		const stored = new Set<string>();
		for (const server of config.servers) if (await options.credentials.hasPasted(server.serverKey)) stored.add(server.serverKey);
		pasted = stored;
		if (disposed) return;

		const desired = new Map<string, WatchServer>();
		if (!killSwitch && config.masterEnabled) for (const server of config.servers) if (server.enabled) desired.set(server.serverKey, server);

		for (const [key, entry] of [...connections]) {
			const wanted = desired.get(key);
			if (!wanted || entry.fingerprint !== fingerprint(wanted)) {
				// Switched off, or the credential changed: cancel everything and drop the token from memory.
				entry.connection.stop();
				connections.delete(key);
			}
		}

		// One socket per watched workspace, at most `maxSockets` in total. Page-only servers hold no socket.
		let slots = config.maxSockets;
		for (const server of desired.values()) {
			let entry = connections.get(server.serverKey);
			if (!entry) entry = startConnection(server) ?? undefined;
			if (!entry) continue;
			const ids: string[] = [];
			for (const workspace of server.workspaces) {
				if (!workspace.watch) continue;
				if (server.credentialSource === "page") {
					ids.push(workspace.workspaceId);
				} else if (slots > 0) {
					slots -= 1;
					ids.push(workspace.workspaceId);
				}
			}
			entry.connection.setWatched(ids);
		}
		emit();
	}

	const apply = (): Promise<void> => {
		applyQueue = applyQueue.then(applyUnlocked, applyUnlocked);
		return applyQueue;
	};

	function buildState(): AwarenessState {
		const state: AwarenessState = { ...EMPTY_AWARENESS_STATE, issues: [], runs: [], agents: [], runtimes: [], deleted: [], servers: [] };
		state.killSwitch = killSwitch;
		state.masterEnabled = config.masterEnabled;
		state.maxSockets = config.maxSockets;
		state.tokenStoragePersistent = options.credentials.canPersist();
		for (const server of config.servers) {
			const entry = connections.get(server.serverKey);
			const view = entry?.connection.view();
			const row: AwarenessServerState = {
				serverKey: server.serverKey,
				label: serverLabel(server),
				mode: server.mode,
				customUrl: server.customUrl,
				apiUrl: server.apiUrl,
				enabled: server.enabled,
				credentialSource: server.credentialSource,
				consentGranted: server.consentGranted,
				hasPastedToken: pasted.has(server.serverKey),
				status: view?.status ?? "off",
				meId: view?.meId ?? null,
				workspaces:
					view && view.workspaces.length > 0
						? // The switch shown is the user's choice; the connection may run fewer sockets than that when the cap is lower.
							view.workspaces.map((workspace) => ({
								...workspace,
								watch: server.workspaces.find((stored) => stored.workspaceId === workspace.workspaceId)?.watch ?? false,
							}))
						: server.workspaces.map((workspace) => ({
								workspaceId: workspace.workspaceId,
								slug: workspace.slug,
								name: workspace.name,
								watch: workspace.watch,
								state: "idle" as const,
								attempt: 0,
								partial: false,
								transport: server.credentialSource === "page" ? ("page" as const) : ("socket" as const),
							})),
			};
			state.servers.push(row);
			if (!view) continue;
			for (const issue of view.model.issues.values()) state.issues.push({ ...issue, serverKey: server.serverKey });
			for (const run of view.model.runs.values()) state.runs.push({ ...run, serverKey: server.serverKey });
			for (const agent of view.model.agents.values()) state.agents.push({ ...agent, serverKey: server.serverKey });
			for (const runtime of view.model.runtimes.values()) state.runtimes.push({ ...runtime, serverKey: server.serverKey });
			for (const deleted of view.model.deleted.values()) state.deleted.push({ ...deleted, serverKey: server.serverKey });
		}
		return state;
	}

	// Commands

	async function runCommand(command: AwarenessCommand): Promise<AwarenessCommandResult> {
		const failure = (reason: AwarenessCommandFailure): AwarenessCommandResult => ({ ok: false, reason });
		const current = await options.watchStore.read();
		const serverOf = (key: string) => current.servers.find((candidate) => candidate.serverKey === key);
		const enabling =
			(command.type === "setMaster" && command.enabled) ||
			(command.type === "setServerEnabled" && command.enabled) ||
			(command.type === "setWorkspaceWatch" && command.watch);
		if (killSwitch && enabling) return failure("kill_switch");
		if ("serverKey" in command && !serverOf(command.serverKey)) return failure("unknown_server");

		const update = (change: (value: WatchConfig) => WatchConfig) => options.watchStore.update(change);
		const mapServer = (key: string, change: (server: WatchServer) => WatchServer) => (value: WatchConfig): WatchConfig => ({
			...value,
			servers: value.servers.map((server) => (server.serverKey === key ? change(server) : server)),
		});

		try {
			switch (command.type) {
				case "setMaster":
					await update((value) => ({ ...value, masterEnabled: command.enabled }));
					break;
				case "setMaxSockets":
					await update((value) => ({ ...value, maxSockets: command.value }));
					break;
				case "addServer": {
					const resolved = resolveMulticaServer({ mode: command.mode, customUrl: command.customUrl, apiUrl: command.apiUrl });
					const urlsValid =
						command.mode === "cloud" ||
						(validateMulticaServerUrl(command.customUrl).ok && (command.apiUrl.trim() === "" || validateMulticaServerUrl(command.apiUrl).ok));
					if (!resolved || !urlsValid) return failure("invalid_server");
					if (current.servers.some((server) => server.serverKey === resolved.key)) break;
					if (current.servers.length >= MAX_WATCHED_SERVERS) return failure("invalid_server");
					const server: WatchServer = {
						serverKey: resolved.key,
						mode: command.mode,
						customUrl: command.mode === "local" ? command.customUrl : "",
						apiUrl: command.mode === "local" ? command.apiUrl : "",
						enabled: false,
						credentialSource: "profile",
						consentGranted: false,
						workspaces: [],
					};
					await update((value) => ({ ...value, servers: [...value.servers, server] }));
					break;
				}
				case "removeServer":
					await options.credentials.clearPasted(command.serverKey);
					await update((value) => ({ ...value, servers: value.servers.filter((server) => server.serverKey !== command.serverKey) }));
					break;
				case "setServerEnabled":
					await update(mapServer(command.serverKey, (server) => ({ ...server, enabled: command.enabled })));
					break;
				case "setCredentialSource":
					await update(mapServer(command.serverKey, (server) => ({ ...server, credentialSource: command.source })));
					break;
				case "grantConsent":
					await update(mapServer(command.serverKey, (server) => ({ ...server, consentGranted: true })));
					break;
				case "revokeConsent":
					await update(mapServer(command.serverKey, (server) => ({ ...server, consentGranted: false })));
					break;
				case "setToken":
					if (!(await options.credentials.setPasted(command.serverKey, command.token))) return failure("invalid_request");
					credentialVersion.set(command.serverKey, (credentialVersion.get(command.serverKey) ?? 0) + 1);
					break;
				case "clearToken":
					await options.credentials.clearPasted(command.serverKey);
					credentialVersion.set(command.serverKey, (credentialVersion.get(command.serverKey) ?? 0) + 1);
					break;
				case "setWorkspaceWatch": {
					const server = serverOf(command.serverKey);
					if (!server || !server.workspaces.some((workspace) => workspace.workspaceId === command.workspaceId)) return failure("invalid_request");
					if (command.watch && server.credentialSource !== "page") {
						const watchedSockets = current.servers
							.filter((candidate) => candidate.credentialSource !== "page")
							.flatMap((candidate) => candidate.workspaces.filter((workspace) => workspace.watch && !(candidate.serverKey === command.serverKey && workspace.workspaceId === command.workspaceId)));
						if (watchedSockets.length >= current.maxSockets) return failure("socket_cap");
					}
					await update(
						mapServer(command.serverKey, (held) => ({
							...held,
							workspaces: held.workspaces.map((workspace) => (workspace.workspaceId === command.workspaceId ? { ...workspace, watch: command.watch } : workspace)),
						})),
					);
					break;
				}
				case "refreshWorkspaces":
					await connections.get(command.serverKey)?.connection.refreshWorkspaces();
					break;
			}
		} catch {
			return failure("save_failed");
		}

		const meta = describe(command);
		if (command.type !== "refreshWorkspaces") {
			record({
				kind: "setting_changed",
				direction: "local",
				actor: "user_setting",
				...(meta.serverKey ? { serverKey: meta.serverKey } : {}),
				...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
				trigger: meta.trigger,
				result: { ok: true },
			});
		}
		await apply();
		return { ok: true, state: buildState() };
	}

	// IPC

	const isTrustedShell = (event: IpcMainInvokeEvent): boolean => event.sender.id === options.shellWebContents.id;
	type Handler = (event: IpcMainInvokeEvent, payload: unknown) => unknown;
	const handlers: Array<[string, Handler]> = [
		[MULTICA_AWARENESS_GET_STATE_CHANNEL, (event) => (disposed || !isTrustedShell(event) ? EMPTY_AWARENESS_STATE : buildState())],
		[
			MULTICA_AWARENESS_COMMAND_CHANNEL,
			async (event, payload): Promise<AwarenessCommandResult> => {
				if (disposed || !isTrustedShell(event) || !isAwarenessCommand(payload)) return { ok: false, reason: "invalid_request" };
				return await runCommand(payload);
			},
		],
		[
			MULTICA_AWARENESS_OPEN_ISSUE_CHANNEL,
			(event, payload): boolean => {
				if (disposed || !isTrustedShell(event) || !isOpenMulticaIssueRequest(payload)) return false;
				const host = options.getHost();
				// Only the selected server's page can show the issue.
				if (!host || host.getServer()?.key !== payload.serverKey) return false;
				if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(payload.workspaceSlug) || !/^[A-Za-z0-9]{1,10}-[1-9][0-9]{0,8}$/.test(payload.identifier)) return false;
				return host.navigatePath(`/${payload.workspaceSlug.toLowerCase()}/issues/${payload.identifier.toUpperCase()}`);
			},
		],
		[
			MULTICA_ACTION_LOG_READ_CHANNEL,
			async (event, payload): Promise<MulticaActionRecord[]> => {
				if (disposed || !isTrustedShell(event) || !isMulticaActionLogQuery(payload)) return [];
				return await options.actionLog.read(payload);
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, (event, payload) => handler(event, payload));

	return {
		start: async () => {
			try {
				linkCache = await options.listLinks();
			} catch {
				linkCache = [];
			}
			await apply();
		},
		getState: buildState,
		lookup: (serverKey, identifier) => {
			const entry = connections.get(serverKey);
			if (!entry) return null;
			const matches = entry.connection.lookupAll(identifier);
			// Two workspaces may share a prefix; with no way to tell them apart, say nothing.
			if (matches.length !== 1) return null;
			const { issue, activeRuns } = matches[0];
			const view = entry.connection.view();
			const names = new Set<string>();
			for (const run of activeRuns) {
				const name = view.model.agents.get(run.agentId)?.name;
				if (name) names.add(name);
			}
			if (issue.assigneeType === "agent" && issue.assigneeId) {
				const name = view.model.agents.get(issue.assigneeId)?.name;
				if (name) names.add(name);
			}
			return { issue, activeRuns, agentNames: [...names], meId: view.meId };
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		handleLinksChanged: () => {
			void options
				.listLinks()
				.then((links) => {
					linkCache = links;
					for (const entry of connections.values()) entry.connection.noteLinksChanged();
				})
				.catch(() => undefined);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (pushTimer !== null) scheduler.clearTimeout(pushTimer);
			for (const entry of connections.values()) entry.connection.stop();
			connections.clear();
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
			listeners.clear();
		},
	};
}
