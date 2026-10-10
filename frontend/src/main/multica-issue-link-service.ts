import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { resolveMulticaServer, type MulticaSettings } from "../shared/multica";
import {
	MULTICA_LINKS_ADD_CHANNEL,
	MULTICA_LINKS_CHANGED_CHANNEL,
	MULTICA_LINKS_LIST_CHANNEL,
	MULTICA_LINKS_OPEN_ISSUE_CHANNEL,
	MULTICA_LINKS_OPEN_SESSION_CHANNEL,
	MULTICA_LINKS_REMOVE_CHANNEL,
	isMulticaIssuePath,
	linksForServer,
	multicaIssuePath,
	parseAoSessionUrl,
	parseMulticaIssueRef,
	type MulticaIssueLink,
	type MulticaIssueRef,
} from "../shared/multica-issue-links";
import { MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, OPEN_WITH_AO_ACTION_PREFIX } from "../shared/multica-open-with-ao";
import { AO_SEND_ISSUE_URL, parseMulticaIssueTitleParts } from "../shared/multica-send-to-ao";
import type { MulticaIssueLinkStore, MulticaIssueStableIds, MulticaIssueTarget } from "./multica-issue-links";
import { createMulticaOpenWithAo } from "./multica-open-with-ao";
import { createMulticaSendToAo } from "./multica-send-to-ao";
import type { MulticaStatusSync } from "./multica-status-sync";
import type { MulticaViewHost } from "./multica-view-host";

export type MulticaIssueLinkServiceOptions = {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "isDestroyed" | "send">;
	store: MulticaIssueLinkStore;
	/** The Multica view host is created after this service, so it is looked up lazily. */
	getHost: () => Pick<MulticaViewHost, "navigatePath" | "runInPage" | "runInAoWorld" | "setActive" | "evaluateInPage" | "getServer"> | undefined;
	readSettings: () => Promise<MulticaSettings>;
	/** Status sync: told which links are visible and which server is selected, and drives the sync rows of the Open in AO menu. */
	sync?: Pick<MulticaStatusSync, "setLinks" | "handleServerChange" | "getSnapshot" | "onChanged" | "setLink" | "resume">;
};

export type MulticaIssueLinkService = {
	/** The selected Multica server changed (`serverKey` is "" when none): show the links of the new one. */
	handleServerChange: (serverKey: string) => void;
	/** Records the issue's UUIDs on its links (called by status sync the first time it reads the issue). */
	backfillIssueIds: (target: MulticaIssueTarget, ids: MulticaIssueStableIds) => Promise<void>;
	/** Feed every page title of the Multica view here. */
	handlePageTitle: (title: string) => void;
	/** Offered every external-open target of the Multica view. True when it was an ao://sessions URL (handled or swallowed). */
	handleAoSessionLink: (url: string) => boolean;
	dispose: () => void;
};

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown, keys: readonly string[]): value is Record<string, string> {
	return isRecord(value) && keys.every((key) => typeof value[key] === "string");
}

export function createMulticaIssueLinkService(options: MulticaIssueLinkServiceOptions): MulticaIssueLinkService {
	let links: MulticaIssueLink[] = [];
	let serverKey = "";
	// Once the view host has announced the server, settings are no longer consulted for it.
	let serverAnnounced = false;
	let currentIssue: string | null = null;
	let currentTitle: string | null = null;
	let disposed = false;
	// Links belong to the server they were made on; the rest stay stored and
	// reappear when that server is selected again.
	const visible = (all: MulticaIssueLink[]): MulticaIssueLink[] => (serverKey ? linksForServer(all, serverKey) : []);
	const replaceLinks = (next: MulticaIssueLink[]): void => {
		links = next;
	};

	// Status sync only ever sees links that were really loaded or saved, never the interim empty list of a server switch.
	const syncLinks = (): void => {
		if (!disposed && serverKey) options.sync?.setLinks(serverKey, links);
	};

	const pushChanged = (next: MulticaIssueLink[]): void => {
		if (!disposed && !options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_LINKS_CHANGED_CHANNEL, next);
	};

	const openSession = (target: { projectId: string; sessionId: string }): void => {
		options.getHost()?.setActive(false);
		if (!options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_LINKS_OPEN_SESSION_CHANNEL, target);
	};

	async function addLink(
		link: Omit<MulticaIssueLink, "createdAt">,
		result?: { links?: MulticaIssueLink[]; error?: unknown },
	): Promise<boolean> {
		try {
			// Tag with the server selected right now, and refuse when the live page belongs to another one.
			if (!serverKey || (options.getHost()?.getServer()?.key ?? serverKey) !== serverKey) throw new Error("no server");
			const next = visible(await options.store.add({ ...link, serverKey }));
			if (result) result.links = next;
			if (!disposed) {
				replaceLinks(next);
				syncLinks();
				pushChanged(next);
				refreshOpenWithAo();
			}
			return true;
		} catch (error) {
			if (result) result.error = error;
			return false;
		}
	}

	const sendToAo = createMulticaSendToAo({
		shellWebContents: options.shellWebContents,
		getHost: options.getHost,
		getCurrentIssue: () => (currentIssue ? { identifier: currentIssue, title: currentTitle ?? "" } : null),
	});
	const openWithAo = createMulticaOpenWithAo({
		getHost: options.getHost,
		getCurrentIssue: () => (currentIssue ? { identifier: currentIssue, title: currentTitle ?? "" } : null),
		getLinks: () => links,
		addLink,
		openSession,
		requestNewTask: (projectId) => sendToAo.request({ projectId }),
		...(options.sync
			? {
					getSync: () => {
						const snapshot = options.sync?.getSnapshot();
						return snapshot ? { enabled: snapshot.settings.enabled, killSwitch: snapshot.killSwitch, views: snapshot.links } : undefined;
					},
					onSyncAction: ({ syncAction, ...ref }: { syncAction: "enable" | "disable" | "resume"; sessionId: string; workspaceSlug: string; issueIdentifier: string }) => {
						if (syncAction === "resume") void options.sync?.resume(ref);
						else void options.sync?.setLink({ ...ref, enabled: syncAction === "enable" });
					},
				}
			: {}),
	});
	const unsubscribeSync = options.sync?.onChanged(() => refreshOpenWithAo());
	function refreshOpenWithAo(): void {
		if (disposed) return;
		openWithAo.refresh();
	}

	const isTrustedShell = (event: IpcMainInvokeEvent): boolean => event.sender.id === options.shellWebContents.id;

	// Resolves the selected server, adopts links made before servers could be
	// switched (they belong to the server that was configured then), and loads
	// the links of that server.
	const loadForServer = async (announce: boolean): Promise<void> => {
		if (!serverAnnounced) serverKey = resolveMulticaServer(await options.readSettings())?.key ?? "";
		const key = serverKey;
		const all = key ? await options.store.adoptLegacy(key) : await options.store.list();
		if (disposed || key !== serverKey) return;
		replaceLinks(visible(all));
		syncLinks();
		if (announce) pushChanged(links);
		refreshOpenWithAo();
	};
	let loading: Promise<void> = Promise.resolve();
	const reload = (announce: boolean): Promise<void> => {
		loading = loading.then(() => loadForServer(announce)).catch(() => undefined);
		return loading;
	};
	try {
		void reload(false);
	} catch {
		// The store may be unavailable while the app is starting.
	}

	const handlers: Array<[string, IpcHandler]> = [
		[
			MULTICA_LINKS_LIST_CHANNEL,
			async (event) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				await loading;
				if (disposed) return undefined;
				const listed = visible(await options.store.list());
				replaceLinks(listed);
				syncLinks();
				refreshOpenWithAo();
				return listed;
			},
		],
		[
			MULTICA_LINKS_ADD_CHANNEL,
			async (event, payload) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				await loading;
				if (!isStringRecord(payload, ["sessionId", "projectId", "issue"])) {
					return { ok: false, reason: "invalid_session" };
				}
				const issue = parseMulticaIssueRef(payload.issue);
				if (!issue) return { ok: false, reason: "invalid_issue" };
				const result: { links?: MulticaIssueLink[]; error?: unknown } = {};
				const added = await addLink(
					{
						sessionId: payload.sessionId,
						projectId: payload.projectId,
						workspaceSlug: issue.workspaceSlug,
						issueIdentifier: issue.issueIdentifier,
					},
					result,
				);
				if (!added) {
					const reason = isRecord(result.error) && result.error.message === "invalid link" ? "invalid_session" : "save_failed";
					return { ok: false, reason };
				}
				return { ok: true, links: result.links ?? links };
			},
		],
		[
			MULTICA_LINKS_REMOVE_CHANNEL,
			async (event, payload) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				await loading;
				if (!isStringRecord(payload, ["sessionId", "workspaceSlug", "issueIdentifier"])) return links;
				try {
					const next = visible(
						await options.store.remove({
							sessionId: payload.sessionId,
							workspaceSlug: payload.workspaceSlug,
							issueIdentifier: payload.issueIdentifier,
							serverKey,
						}),
					);
					if (!disposed) {
						replaceLinks(next);
						syncLinks();
						pushChanged(next);
						refreshOpenWithAo();
					}
					return next;
				} catch {
					return links;
				}
			},
		],
		[
			MULTICA_LINKS_OPEN_ISSUE_CHANNEL,
			(event, payload) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				if (!isStringRecord(payload, ["workspaceSlug", "issueIdentifier"])) return false;
				const ref: MulticaIssueRef = {
					workspaceSlug: payload.workspaceSlug,
					issueIdentifier: payload.issueIdentifier,
				};
				const path = multicaIssuePath(ref);
				if (!isMulticaIssuePath(path)) return false;
				return options.getHost()?.navigatePath(path) ?? false;
			},
		],
		[
			MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL,
			(event, payload) => {
				if (disposed || !isTrustedShell(event)) return { ok: false };
				return openWithAo.setSnapshot(payload);
			},
		],
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		handleServerChange: (key) => {
			if (disposed) return;
			// Synchronously, so an add or open arriving before the reload already sees the new server.
			serverAnnounced = true;
			serverKey = key;
			options.sync?.handleServerChange(key);
			// The issue on the old server's page is not on the new one until its page reports a title.
			currentIssue = null;
			currentTitle = null;
			replaceLinks([]);
			void reload(true);
		},
		backfillIssueIds: async (target, ids) => {
			if (disposed || target.serverKey !== serverKey) return;
			const all = await options.store.recordIssueIds(target, ids);
			if (disposed || target.serverKey !== serverKey) return;
			replaceLinks(visible(all));
			pushChanged(links);
			refreshOpenWithAo();
			// Status sync keeps using the links it already has: the ids only matter to the next read.
			syncLinks();
		},
		handlePageTitle: (title) => {
			if (disposed) return;
			const parts = parseMulticaIssueTitleParts(title);
			currentIssue = parts?.identifier ?? null;
			currentTitle = parts?.title ?? null;
			refreshOpenWithAo();
		},
		handleAoSessionLink: (url) => {
			if (disposed) return false;
			if (url.startsWith(OPEN_WITH_AO_ACTION_PREFIX)) return openWithAo.handleActionUrl(url);
			if (url === AO_SEND_ISSUE_URL) {
				sendToAo.request();
				return true;
			}
			const target = parseAoSessionUrl(url);
			if (!target) return false;
			if (links.some((link) => link.projectId === target.projectId && link.sessionId === target.sessionId)) {
				openSession(target);
			}
			return true;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribeSync?.();
			sendToAo.dispose();
			openWithAo.dispose();
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
		},
	};
}
