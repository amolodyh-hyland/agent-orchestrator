import type { TFunction } from "i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import { clampStatusText } from "../../shared/multica-session-status";
import {
	MAX_OPEN_WITH_AO_DETAIL,
	MAX_OPEN_WITH_AO_ID,
	MAX_OPEN_WITH_AO_NAME,
	MAX_OPEN_WITH_AO_PROJECTS,
	MAX_OPEN_WITH_AO_SESSIONS,
	MAX_OPEN_WITH_AO_STATE_LABEL,
	type OpenWithAoDaemonState,
	type OpenWithAoSession,
	type OpenWithAoSnapshot,
} from "../../shared/multica-open-with-ao";
import { foundSessionEntry } from "./multica-link-status";
import {
	CLOUD_PROJECT_KIND,
	newestActiveOrchestrator,
	sessionIsActive,
	sortedWorkerSessions,
	STANDALONE_WORKSPACE_ID,
	type WorkspaceSession,
	type WorkspaceSummary,
	workerSessions,
} from "../types/workspace";

export function buildOpenWithAoSnapshot(input: {
	workspaces: readonly WorkspaceSummary[];
	links: readonly MulticaIssueLink[];
	daemon: OpenWithAoDaemonState;
	stale: boolean;
	t: TFunction;
}): OpenWithAoSnapshot {
	const linkedSessionIds = new Set(input.links.map((link) => link.sessionId));
	const seenProjectIds = new Set<string>();
	const seenSessionIds = new Set<string>();
	const eligibleWorkspaces: WorkspaceSummary[] = [];
	for (const workspace of input.workspaces) {
		if (
			workspace.id === STANDALONE_WORKSPACE_ID ||
			workspace.kind === CLOUD_PROJECT_KIND ||
			!isValidId(workspace.id) ||
			seenProjectIds.has(workspace.id)
		) {
			continue;
		}
		seenProjectIds.add(workspace.id);
		eligibleWorkspaces.push(workspace);
	}

	const linkedProjects: WorkspaceSummary[] = [];
	const activeProjects: WorkspaceSummary[] = [];
	const otherProjects: WorkspaceSummary[] = [];
	for (const workspace of eligibleWorkspaces) {
		if (workspace.sessions.some((session) => linkedSessionIds.has(session.id))) {
			linkedProjects.push(workspace);
		} else if (
			newestActiveOrchestrator(workspace.sessions) ||
			workerSessions(workspace.sessions).some(sessionIsActive)
		) {
			activeProjects.push(workspace);
		} else {
			otherProjects.push(workspace);
		}
	}
	const prioritizedWorkspaces = [...linkedProjects, ...activeProjects, ...otherProjects]
		.slice(0, MAX_OPEN_WITH_AO_PROJECTS);

	const projects = prioritizedWorkspaces
		.map((workspace) => {
			const activeOrchestrator = newestActiveOrchestrator(workspace.sessions);
			const orchestrator = activeOrchestrator && isValidId(activeOrchestrator.id) && !seenSessionIds.has(activeOrchestrator.id)
				? mapSession(activeOrchestrator, workspace.id, input.stale, input.t)
				: null;
			if (orchestrator) seenSessionIds.add(orchestrator.id);

			const totalWorkers = workerSessions(workspace.sessions).length;
			const candidateSessionIds = new Set<string>();
			const eligibleWorkers = prioritizeWorkers(sortedWorkerSessions(workspace.sessions), linkedSessionIds)
				.filter((session) => {
					if (!isValidId(session.id) || seenSessionIds.has(session.id) || candidateSessionIds.has(session.id)) return false;
					candidateSessionIds.add(session.id);
					return true;
				});
			const keptWorkers = eligibleWorkers.slice(0, MAX_OPEN_WITH_AO_SESSIONS);
			const sessions = keptWorkers.map((session) => {
				seenSessionIds.add(session.id);
				return mapSession(session, workspace.id, input.stale, input.t);
			});

			return {
				id: clampStatusText(workspace.id, MAX_OPEN_WITH_AO_ID),
				name: clampStatusText(workspace.name || workspace.id, MAX_OPEN_WITH_AO_NAME),
				orchestrator,
				sessions,
				moreCount: totalWorkers - keptWorkers.length,
			};
		});

	return { daemon: input.daemon, stale: input.stale, projects };
}

function prioritizeWorkers(sessions: WorkspaceSession[], linkedSessionIds: ReadonlySet<string>): WorkspaceSession[] {
	const linkedActive: WorkspaceSession[] = [];
	const linkedTerminated: WorkspaceSession[] = [];
	const unlinkedActive: WorkspaceSession[] = [];
	const unlinkedTerminated: WorkspaceSession[] = [];

	for (const session of sessions) {
		const active = sessionIsActive(session);
		const target = linkedSessionIds.has(session.id)
			? active ? linkedActive : linkedTerminated
			: active ? unlinkedActive : unlinkedTerminated;
		target.push(session);
	}

	return [...linkedActive, ...linkedTerminated, ...unlinkedActive, ...unlinkedTerminated];
}

function mapSession(session: WorkspaceSession, projectId: string, stale: boolean, t: TFunction): OpenWithAoSession {
	const entry = foundSessionEntry(session, t);
	const updatedAt = Date.parse(session.updatedAt);
	return {
		id: clampStatusText(session.id, MAX_OPEN_WITH_AO_ID),
		projectId: clampStatusText(projectId, MAX_OPEN_WITH_AO_ID),
		label: clampStatusText(session.title || session.id, MAX_OPEN_WITH_AO_NAME),
		tone: entry.tone,
		stateLabel: clampStatusText(entry.label, MAX_OPEN_WITH_AO_STATE_LABEL),
		detail: clampStatusText(entry.detail, MAX_OPEN_WITH_AO_DETAIL),
		stale,
		terminated: !sessionIsActive(session),
		updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
	};
}

function isValidId(value: string): boolean {
	const length = Array.from(value).length;
	return length > 0 && length <= MAX_OPEN_WITH_AO_ID;
}
