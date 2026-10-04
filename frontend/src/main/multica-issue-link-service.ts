import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { MulticaSettings } from "../shared/multica";
import {
	MULTICA_LINKS_ADD_CHANNEL,
	MULTICA_LINKS_CHANGED_CHANNEL,
	MULTICA_LINKS_LIST_CHANNEL,
	MULTICA_LINKS_OPEN_ISSUE_CHANNEL,
	MULTICA_LINKS_OPEN_SESSION_CHANNEL,
	MULTICA_LINKS_REMOVE_CHANNEL,
	aoSessionUrl,
	isMulticaIssuePath,
	multicaIssuePath,
	parseAoSessionUrl,
	parseMulticaIssueRef,
	type MulticaIssueLink,
	type MulticaIssueRef,
} from "../shared/multica-issue-links";
import { AO_SEND_ISSUE_URL, parseMulticaIssueTitleParts } from "../shared/multica-send-to-ao";
import type { MulticaIssueLinkStore } from "./multica-issue-links";
import { buildLinkedSessionsPillScript } from "./multica-linked-sessions-pill";
import { createMulticaSendToAo } from "./multica-send-to-ao";
import type { MulticaViewHost } from "./multica-view-host";

export type MulticaIssueLinkServiceOptions = {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "isDestroyed" | "send">;
	store: MulticaIssueLinkStore;
	/** The Multica view host is created after this service, so it is looked up lazily. */
	getHost: () => Pick<MulticaViewHost, "navigatePath" | "runInPage" | "setActive" | "evaluateInPage"> | undefined;
	readSettings: () => Promise<MulticaSettings>;
};

export type MulticaIssueLinkService = {
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
	let cacheVersion = 0;
	let currentIssue: string | null = null;
	let currentTitle: string | null = null;
	let disposed = false;
	const sendToAo = createMulticaSendToAo({
		shellWebContents: options.shellWebContents,
		getHost: options.getHost,
		getCurrentIssue: () => (currentIssue ? { identifier: currentIssue, title: currentTitle ?? "" } : null),
		readSettings: options.readSettings,
	});
	const isTrustedShell = (event: IpcMainInvokeEvent): boolean => event.sender.id === options.shellWebContents.id;

	try {
		void options.store
			.list()
			.then((loaded) => {
				if (!disposed && cacheVersion === 0) {
					links = loaded;
					refreshPill();
				}
			})
			.catch(() => undefined);
	} catch {
		// The store may be unavailable while the app is starting.
	}

	const replaceLinks = (next: MulticaIssueLink[]): void => {
		links = next;
		cacheVersion += 1;
	};

	const pushChanged = (next: MulticaIssueLink[]): void => {
		if (!disposed && !options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_LINKS_CHANGED_CHANNEL, next);
	};

	const refreshPill = (): void => {
		if (disposed) return;
		const entries = currentIssue
			? links
					.filter((link) => link.issueIdentifier === currentIssue)
					.map((link) => ({ label: link.sessionId, url: aoSessionUrl(link.projectId, link.sessionId) }))
			: [];
		options.getHost()?.runInPage(buildLinkedSessionsPillScript(entries, { sendUrl: currentIssue ? AO_SEND_ISSUE_URL : undefined }));
	};

	const handlers: Array<[string, IpcHandler]> = [
		[
			MULTICA_LINKS_LIST_CHANNEL,
			async (event) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				const listed = await options.store.list();
				if (!disposed) {
					replaceLinks(listed);
					refreshPill();
				}
				return listed;
			},
		],
		[
			MULTICA_LINKS_ADD_CHANNEL,
			async (event, payload) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				if (!isStringRecord(payload, ["sessionId", "projectId", "issue"])) {
					return { ok: false, reason: "invalid_session" };
				}
				const issue = parseMulticaIssueRef(payload.issue);
				if (!issue) return { ok: false, reason: "invalid_issue" };
				try {
					const next = await options.store.add({
						sessionId: payload.sessionId,
						projectId: payload.projectId,
						workspaceSlug: issue.workspaceSlug,
						issueIdentifier: issue.issueIdentifier,
					});
					if (!disposed) {
						replaceLinks(next);
						pushChanged(next);
						refreshPill();
					}
					return { ok: true, links: next };
				} catch (error) {
					const reason = isRecord(error) && error.message === "invalid link" ? "invalid_session" : "save_failed";
					return { ok: false, reason };
				}
			},
		],
		[
			MULTICA_LINKS_REMOVE_CHANNEL,
			async (event, payload) => {
				if (disposed || !isTrustedShell(event)) return undefined;
				if (!isStringRecord(payload, ["sessionId", "workspaceSlug", "issueIdentifier"])) return links;
				try {
					const next = await options.store.remove({
						sessionId: payload.sessionId,
						workspaceSlug: payload.workspaceSlug,
						issueIdentifier: payload.issueIdentifier,
					});
					if (!disposed) {
						replaceLinks(next);
						pushChanged(next);
						refreshPill();
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
	];
	for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

	return {
		handlePageTitle: (title) => {
			if (disposed) return;
			const parts = parseMulticaIssueTitleParts(title);
			currentIssue = parts?.identifier ?? null;
			currentTitle = parts?.title ?? null;
			refreshPill();
		},
		handleAoSessionLink: (url) => {
			if (disposed) return false;
			if (url === AO_SEND_ISSUE_URL) {
				sendToAo.request();
				return true;
			}
			const target = parseAoSessionUrl(url);
			if (!target) return false;
			if (links.some((link) => link.projectId === target.projectId && link.sessionId === target.sessionId)) {
				options.getHost()?.setActive(false);
				if (!options.shellWebContents.isDestroyed()) options.shellWebContents.send(MULTICA_LINKS_OPEN_SESSION_CHANNEL, target);
			}
			return true;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			sendToAo.dispose();
			for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
		},
	};
}
