import { randomUUID } from "node:crypto";
import { parseMulticaIssueTitle } from "../shared/multica-issue-links";
import {
	OPEN_WITH_AO_ACTION_PREFIX,
	buildOpenWithAoPagePayload,
	isOpenWithAoNonce,
	isOpenWithAoSnapshot,
	parseOpenWithAoActionUrl,
	type OpenWithAoExecutorLine,
	type OpenWithAoSnapshot,
	type OpenWithAoSyncAction,
	type OpenWithAoSyncInput,
} from "../shared/multica-open-with-ao";
import { buildOpenWithAoRemoveScript, buildOpenWithAoScript } from "./multica-open-with-ao-script";
import type { MulticaViewHost } from "./multica-view-host";

const READ_WORKSPACE_SLUG_TIMEOUT_MS = 2000;
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export type MulticaOpenWithAoOptions = {
	getHost: () => Pick<MulticaViewHost, "runInAoWorld" | "evaluateInPage"> | undefined;
	getCurrentIssue: () => { identifier: string; title: string } | null;
	getLinks: () => ReadonlyArray<{ sessionId: string; issueIdentifier: string; projectId: string; workspaceSlug?: string }>;
	/** The status-sync state of the links, shown as a row under each linked session. Absent: no sync rows. */
	getSync?: () => OpenWithAoSyncInput | undefined;
	/** The user clicked a sync row (turn on, turn off, resume) for a link of the current issue. */
	onSyncAction?: (action: { syncAction: OpenWithAoSyncAction; sessionId: string; workspaceSlug: string; issueIdentifier: string }) => void;
	addLink: (link: { sessionId: string; projectId: string; workspaceSlug: string; issueIdentifier: string }) => Promise<boolean>;
	openSession: (target: { projectId: string; sessionId: string }) => void;
	requestNewTask: (projectId: string) => void;
	/** The executor line for the current issue, from the awareness read model; null when awareness has nothing to say. */
	getExecutorLine?: (input: {
		issueIdentifier: string;
		liveSessions: ReadonlyArray<{ id: string; label: string; stateLabel: string }>;
	}) => OpenWithAoExecutorLine | null;
	createNonce?: () => string;
};

export type MulticaOpenWithAo = {
	setSnapshot: (value: unknown) => { ok: boolean };
	refresh: () => void;
	handleActionUrl: (url: string) => boolean;
	dispose: () => void;
};

function parseWorkspaceSlug(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 63 || !WORKSPACE_SLUG_PATTERN.test(value)) return null;
	return value.toLowerCase();
}

export function buildReadWorkspaceSlugScript(): string {
	return `(() => {
	try {
		const state = JSON.parse(localStorage.getItem("multica_tabs") || "null")?.state;
		const candidate = state?.activeWorkspaceSlug;
		const slug =
			typeof candidate === "string" &&
			candidate.length > 0 &&
			candidate.length <= 63 &&
			/^[a-z0-9][a-z0-9_-]*$/i.test(candidate)
				? candidate.toLowerCase()
				: null;
		return JSON.stringify({ slug, title: document.title });
	} catch {
		return null;
	}
})()`;
}

type WorkspaceContext = { slug: string | null; title: string };

function parseWorkspaceContext(value: unknown): WorkspaceContext | null {
	if (typeof value !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || !("slug" in record) || !("title" in record)) return null;
	if (typeof record.title !== "string" || record.title.length > 500) return null;
	const slug = record.slug === null ? null : parseWorkspaceSlug(record.slug);
	if (record.slug !== null && slug === null) return null;
	return { slug, title: record.title };
}

export function createMulticaOpenWithAo(options: MulticaOpenWithAoOptions): MulticaOpenWithAo {
	const nonce = (options.createNonce ?? randomUUID)();
	if (!isOpenWithAoNonce(nonce)) throw new Error("invalid open-with-ao nonce");

	let snapshot: OpenWithAoSnapshot | null = null;
	let snapshotKey: string | null = null;
	let disposed = false;
	const pendingOpenSessionIds = new Set<string>();

	const openSession = (projectId: string, sessionId: string): void => {
		if (disposed) return;
		try {
			options.openSession({ projectId, sessionId });
		} catch {
			// A failed open should not escape the Multica view's URL handler.
		}
	};

	const readWorkspaceContext = async (
		host: Pick<MulticaViewHost, "runInAoWorld" | "evaluateInPage">,
	): Promise<WorkspaceContext | null> => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				Promise.resolve().then(() => host.evaluateInPage(buildReadWorkspaceSlugScript())),
				new Promise<undefined>((resolve) => {
					timeout = setTimeout(() => resolve(undefined), READ_WORKSPACE_SLUG_TIMEOUT_MS);
				}),
			]);
			return parseWorkspaceContext(result);
		} catch {
			return null;
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	};

	const openWorker = async (
		projectId: string,
		sessionId: string,
		issueIdentifier: string,
		clickedWorkspaceSlug: string | undefined,
	): Promise<void> => {
		try {
			let workspaceContext: WorkspaceContext | null = null;
			try {
				const host = options.getHost();
				if (host) workspaceContext = await readWorkspaceContext(host);
			} catch {
				workspaceContext = null;
			}

			if (disposed) return;
			const workspaceSlug = workspaceContext?.slug ?? null;
			if (
				workspaceContext !== null &&
				clickedWorkspaceSlug !== undefined &&
				workspaceSlug === clickedWorkspaceSlug &&
				parseMulticaIssueTitle(workspaceContext.title) === issueIdentifier &&
				options.getCurrentIssue()?.identifier === issueIdentifier
			) {
				try {
					await options.addLink({ sessionId, projectId, workspaceSlug: clickedWorkspaceSlug, issueIdentifier });
				} catch {
					// Opening the session still proceeds when saving its issue link fails.
				}
			}
			if (disposed) return;
			openSession(projectId, sessionId);
		} catch {
			if (!disposed) openSession(projectId, sessionId);
		} finally {
			pendingOpenSessionIds.delete(sessionId);
		}
	};

	/** Non-terminated AO sessions linked to the issue, with the label and state the menu already shows. */
	const executorLine = (issueIdentifier: string): OpenWithAoExecutorLine | null => {
		if (!options.getExecutorLine) return null;
		try {
			const linkedIds = new Set(options.getLinks().filter((link) => link.issueIdentifier === issueIdentifier).map((link) => link.sessionId));
			const liveSessions: Array<{ id: string; label: string; stateLabel: string }> = [];
			for (const project of snapshot?.projects ?? []) {
				for (const session of project.sessions) {
					if (linkedIds.has(session.id) && !session.terminated) liveSessions.push({ id: session.id, label: session.label, stateLabel: session.stateLabel });
				}
			}
			return options.getExecutorLine({ issueIdentifier, liveSessions });
		} catch {
			return null;
		}
	};

	const refresh = (): void => {
		if (disposed) return;
		try {
			const host = options.getHost();
			if (!host) return;
			const issue = options.getCurrentIssue();
			if (issue === null) {
				host.runInAoWorld(buildOpenWithAoRemoveScript());
				return;
			}
			const payload = buildOpenWithAoPagePayload({
				snapshot,
				links: options.getLinks(),
				issue,
				nonce,
				sync: options.getSync?.(),
				executor: executorLine(issue.identifier),
			});
			host.runInAoWorld(buildOpenWithAoScript(payload));
		} catch {
			// Page refreshes are best effort; a subsequent snapshot or issue change retries.
		}
	};

	return {
		setSnapshot: (value) => {
			if (disposed || !isOpenWithAoSnapshot(value)) return { ok: false };
			const nextKey = JSON.stringify(value);
			if (nextKey === snapshotKey) return { ok: true };
			snapshot = value;
			snapshotKey = nextKey;
			refresh();
			return { ok: true };
		},
		refresh,
		handleActionUrl: (url) => {
			if (typeof url !== "string" || !url.startsWith(OPEN_WITH_AO_ACTION_PREFIX)) return false;
			const action = parseOpenWithAoActionUrl(url);
			if (action === null || action.nonce !== nonce || disposed || snapshot === null) return true;

			try {
				const project = snapshot.projects.find((candidate) => candidate.id === action.projectId);
				if (!project) return true;

				if (action.kind === "new-task") {
					if (options.getCurrentIssue() !== null) options.requestNewTask(action.projectId);
					return true;
				}

				if (action.kind === "sync") {
					// Only for a worker of this project that is linked to the issue on screen.
					const issue = options.getCurrentIssue();
					if (issue === null || !project.sessions.some((candidate) => candidate.id === action.sessionId)) return true;
					const link = options
						.getLinks()
						.find(
							(candidate) =>
								candidate.sessionId === action.sessionId &&
								candidate.projectId === action.projectId &&
								candidate.issueIdentifier === issue.identifier,
						);
					if (link?.workspaceSlug === undefined) return true;
					options.onSyncAction?.({
						syncAction: action.syncAction,
						sessionId: link.sessionId,
						workspaceSlug: link.workspaceSlug,
						issueIdentifier: link.issueIdentifier,
					});
					return true;
				}

				const orchestrator = project.orchestrator;
				if (orchestrator?.id === action.sessionId) {
					openSession(action.projectId, action.sessionId);
					return true;
				}
				const worker = project.sessions.find((candidate) => candidate.id === action.sessionId);
				if (!worker) return true;

				const issue = options.getCurrentIssue();
				if (
					issue === null ||
					options.getLinks().some((link) => link.sessionId === action.sessionId && link.issueIdentifier === issue.identifier)
				) {
					openSession(action.projectId, action.sessionId);
					return true;
				}
				if (pendingOpenSessionIds.has(action.sessionId)) return true;
				pendingOpenSessionIds.add(action.sessionId);
				void openWorker(action.projectId, action.sessionId, issue.identifier, action.workspaceSlug);
			} catch {
				// Malformed or unavailable dependencies are swallowed along with action URLs.
			}
			return true;
		},
		dispose: () => {
			disposed = true;
		},
	};
}
