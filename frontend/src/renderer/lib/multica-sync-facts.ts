import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import {
	MAX_MULTICA_SYNC_FACT_SESSIONS,
	type MulticaSyncFacts,
} from "../../shared/multica-status-sync";
import {
	SYNC_ACTIVITIES,
	SYNC_KANBAN_COLUMNS,
	type SyncActivity,
	type SyncKanbanColumn,
	type SyncSessionFacts,
} from "../../shared/multica-status-writer";
import { toKanbanColumn, type WorkspaceSession, type WorkspaceSummary } from "../types/workspace";

function activityOf(session: WorkspaceSession): SyncActivity {
	const state = session.activity?.state;
	return (SYNC_ACTIVITIES as readonly string[]).includes(state ?? "") ? (state as SyncActivity) : "unknown";
}

function columnOf(session: WorkspaceSession): SyncKanbanColumn {
	const column = toKanbanColumn(session.kanbanColumn, session.status);
	return (SYNC_KANBAN_COLUMNS as readonly string[]).includes(column) ? column : "building";
}

/** The facts the daemon already derived for one session, reduced to what status sync maps. */
export function syncFactsOf(session: WorkspaceSession): SyncSessionFacts {
	return {
		sessionId: session.id,
		provisioning: session.provisionState ?? "ready",
		column: columnOf(session),
		activity: activityOf(session),
		terminated: session.isTerminated === true || session.status === "terminated",
		prs: session.prs.map((pr) => pr.state),
	};
}

/**
 * The facts of every session that is linked to a Multica issue. A linked session AO does not know
 * (deleted, or another daemon) is left out, and the sync reads that as nothing to say. `stale` marks
 * a lost daemon feed: the facts may be out of date and nothing is written until it is back.
 */
export function buildMulticaSyncFacts(input: {
	workspaces: readonly WorkspaceSummary[];
	links: readonly MulticaIssueLink[];
	stale: boolean;
}): MulticaSyncFacts {
	const linked = new Set(input.links.map((link) => link.sessionId));
	const seen = new Set<string>();
	const sessions: SyncSessionFacts[] = [];
	for (const workspace of input.workspaces) {
		for (const session of workspace.sessions) {
			if (!linked.has(session.id) || seen.has(session.id)) continue;
			seen.add(session.id);
			sessions.push(syncFactsOf(session));
			if (sessions.length >= MAX_MULTICA_SYNC_FACT_SESSIONS) return { stale: input.stale, sessions };
		}
	}
	return { stale: input.stale, sessions };
}
