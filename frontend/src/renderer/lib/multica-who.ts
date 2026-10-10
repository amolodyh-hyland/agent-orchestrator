// Joins what AO knows (sessions, issue links) with what Multica awareness
// knows (issues, agent runs) into the rows of the "who is working on what"
// view and the cards of the "Run by Multica" strip. Pure; detection only.

import {
	MULTICA_ACTIVE_TASK_STATUSES,
	MULTICA_RUN_LANES,
	multicaIssueJoinKey,
	multicaRunCardView,
	type AwarenessIssue,
	type AwarenessRun,
	type AwarenessState,
	type MulticaRunCardView,
} from "../../shared/multica-awareness";
import { deriveMulticaExecutor, multicaWhoFlags, type MulticaExecutorDerivation, type MulticaWhoFlag } from "../../shared/multica-executor";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { WorkspaceSession } from "../types/workspace";

type AoSessionRef = { id: string; projectId: string; title: string };

export type WhoRow = {
	key: string;
	serverKey: string;
	serverLabel: string;
	workspaceSlug: string;
	identifier: string;
	title: string;
	derivation: MulticaExecutorDerivation;
	flags: MulticaWhoFlag[];
	agentNames: string[];
	sessions: AoSessionRef[];
	/** The state of the run that decides the row's lane, when there is one. */
	run: { view: MulticaRunCardView; agentName: string | null; since: string | null } | null;
	updatedAt: string | null;
	mine: boolean;
};

export type WhoView = { rows: WhoRow[]; unlinkedSessions: AoSessionRef[] };

export function isLiveSession(session: Pick<WorkspaceSession, "isTerminated" | "status">): boolean {
	return session.isTerminated !== true && session.status !== "terminated";
}

const LANE_RANK = new Map(MULTICA_RUN_LANES.map((lane, index) => [lane, index]));

/** The run that best represents an issue: attention first, then running, queued, recent; newest within a lane. */
export function pickRun(runs: readonly AwarenessRun[], nowMs: number): { run: AwarenessRun; view: MulticaRunCardView } | null {
	let best: { run: AwarenessRun; view: MulticaRunCardView } | null = null;
	for (const run of runs) {
		const view = multicaRunCardView(run, nowMs);
		if (!view) continue;
		if (!best) {
			best = { run, view };
			continue;
		}
		const rank = (LANE_RANK.get(view.lane) ?? 9) - (LANE_RANK.get(best.view.lane) ?? 9);
		const time = (run.endedAt ?? run.startedAt ?? "").localeCompare(best.run.endedAt ?? best.run.startedAt ?? "");
		if (rank < 0 || (rank === 0 && time > 0)) best = { run, view };
	}
	return best;
}

export function buildWhoView(input: {
	state: AwarenessState;
	links: readonly MulticaIssueLink[];
	sessions: readonly WorkspaceSession[];
	nowMs: number;
}): WhoView {
	const { state, links, sessions, nowMs } = input;
	const liveById = new Map(sessions.filter(isLiveSession).map((session) => [session.id, session]));
	const linkedKeysBySession = new Map<string, Set<string>>();
	const sessionsByIssue = new Map<string, AoSessionRef[]>();
	for (const link of links) {
		if (!link.serverKey) continue;
		const live = liveById.get(link.sessionId);
		const key = multicaIssueJoinKey(link.serverKey, link.workspaceSlug, link.issueIdentifier);
		const keys = linkedKeysBySession.get(link.sessionId) ?? new Set<string>();
		keys.add(key);
		linkedKeysBySession.set(link.sessionId, keys);
		if (!live) continue;
		const list = sessionsByIssue.get(key) ?? [];
		list.push({ id: live.id, projectId: link.projectId, title: live.title });
		sessionsByIssue.set(key, list);
	}

	const serverByKey = new Map(state.servers.map((server) => [server.serverKey, server]));
	const slugOf = (serverKey: string, workspaceId: string) => serverByKey.get(serverKey)?.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.slug ?? "";
	const agentNameOf = (serverKey: string, agentId: string) => state.agents.find((agent) => agent.serverKey === serverKey && agent.id === agentId)?.name ?? null;

	const rows: WhoRow[] = [];
	const seenKeys = new Set<string>();
	for (const issue of state.issues) {
		const server = serverByKey.get(issue.serverKey);
		const slug = slugOf(issue.serverKey, issue.workspaceId);
		const joinKey = multicaIssueJoinKey(issue.serverKey, slug, issue.identifier);
		const runs = state.runs.filter((run) => run.serverKey === issue.serverKey && run.issueId === issue.id);
		const activeRuns = runs.filter((run) => MULTICA_ACTIVE_TASK_STATUSES.includes(run.status) && !run.outcomeUnknown);
		const aoSessions = sessionsByIssue.get(joinKey) ?? [];
		const meId = server?.meId ?? null;
		const base = { issue, activeRunCount: activeRuns.length, hasLiveAoSession: aoSessions.length > 0, meId };
		const derivation = deriveMulticaExecutor(base);
		const flags = multicaWhoFlags({ ...base, updatedAt: issue.updatedAt || null, nowMs });
		const picked = pickRun(runs, nowMs);
		// Closed issues with no run and no live session are history, not work in progress.
		if (derivation.executor === "none" && !picked && flags.length === 0) continue;
		seenKeys.add(joinKey);
		const agentNames = new Set<string>();
		for (const run of activeRuns) {
			const name = agentNameOf(issue.serverKey, run.agentId);
			if (name) agentNames.add(name);
		}
		if (issue.assigneeType === "agent" && issue.assigneeId) {
			const name = agentNameOf(issue.serverKey, issue.assigneeId);
			if (name) agentNames.add(name);
		}
		rows.push({
			key: `${issue.serverKey}|${issue.id}`,
			serverKey: issue.serverKey,
			serverLabel: server?.label ?? issue.serverKey,
			workspaceSlug: slug,
			identifier: issue.identifier,
			title: issue.title,
			derivation,
			flags,
			agentNames: [...agentNames],
			sessions: aoSessions,
			run: picked ? { view: picked.view, agentName: agentNameOf(issue.serverKey, picked.run.agentId), since: picked.run.startedAt ?? picked.run.endedAt } : null,
			updatedAt: issue.updatedAt || null,
			mine: issue.assigneeType === "member" && issue.assigneeId === meId,
		});
	}

	// Linked sessions whose issue was deleted while watched: orphaned rows.
	for (const deleted of state.deleted) {
		const slug = slugOf(deleted.serverKey, deleted.workspaceId);
		const joinKey = multicaIssueJoinKey(deleted.serverKey, slug, deleted.identifier);
		const aoSessions = sessionsByIssue.get(joinKey) ?? [];
		if (aoSessions.length === 0 || seenKeys.has(joinKey)) continue;
		rows.push({
			key: `${deleted.serverKey}|deleted|${deleted.identifier}`,
			serverKey: deleted.serverKey,
			serverLabel: serverByKey.get(deleted.serverKey)?.label ?? deleted.serverKey,
			workspaceSlug: slug,
			identifier: deleted.identifier,
			title: "",
			derivation: deriveMulticaExecutor({ issue: null, activeRunCount: 0, hasLiveAoSession: true, meId: null }),
			flags: ["orphaned"],
			agentNames: [],
			sessions: aoSessions,
			run: null,
			updatedAt: null,
			mine: false,
		});
	}

	const weight = (row: WhoRow) => (row.derivation.contested ? 0 : row.flags.length > 0 ? 1 : row.derivation.executor === "multica-agent" ? 2 : row.derivation.executor === "ao" ? 3 : 4);
	rows.sort((left, right) => weight(left) - weight(right) || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.identifier.localeCompare(right.identifier));

	const unlinkedSessions: AoSessionRef[] = [];
	for (const session of sessions) {
		if (!isLiveSession(session) || session.kind === "orchestrator" || session.id.endsWith("-orchestrator")) continue;
		if (!linkedKeysBySession.has(session.id)) unlinkedSessions.push({ id: session.id, projectId: session.workspaceId, title: session.title });
	}
	return { rows, unlinkedSessions };
}

export type StripCard = {
	key: string;
	serverKey: string;
	serverLabel: string;
	workspaceSlug: string;
	identifier: string;
	title: string;
	view: MulticaRunCardView;
	agentName: string | null;
	isLeader: boolean;
	isAutopilot: boolean;
	retrying: boolean;
	since: string | null;
	assignee: { kind: "agent" | "squad" | "member"; name: string | null; isMe: boolean } | null;
	/** A live AO session is linked to the same issue: shown once, as contested. */
	contested: boolean;
	sessions: AoSessionRef[];
};

/** One card per issue with a run that is still worth showing, most urgent lane first. */
export function buildStripCards(input: { state: AwarenessState; links: readonly MulticaIssueLink[]; sessions: readonly WorkspaceSession[]; nowMs: number }): StripCard[] {
	const { state, nowMs } = input;
	const who = buildWhoView(input);
	const whoByKey = new Map(who.rows.map((row) => [row.key, row]));
	const cards: StripCard[] = [];
	const issues = new Map<string, AwarenessIssue & { serverKey: string }>(state.issues.map((issue) => [`${issue.serverKey}|${issue.id}`, issue]));
	const groups = new Map<string, AwarenessRun[]>();
	for (const run of state.runs) {
		const key = `${run.serverKey}|${run.issueId}`;
		const list = groups.get(key) ?? [];
		list.push(run);
		groups.set(key, list);
	}
	for (const [key, runs] of groups) {
		const issue = issues.get(key);
		const picked = pickRun(runs, nowMs);
		if (!issue || !picked) continue;
		const row = whoByKey.get(key);
		const server = state.servers.find((candidate) => candidate.serverKey === issue.serverKey);
		const agentName = state.agents.find((agent) => agent.serverKey === issue.serverKey && agent.id === picked.run.agentId)?.name ?? null;
		const assignee =
			issue.assigneeType === null
				? null
				: {
						kind: issue.assigneeType,
						name: issue.assigneeType === "agent" ? (state.agents.find((agent) => agent.serverKey === issue.serverKey && agent.id === issue.assigneeId)?.name ?? null) : null,
						isMe: issue.assigneeType === "member" && issue.assigneeId === server?.meId,
					};
		cards.push({
			key,
			serverKey: issue.serverKey,
			serverLabel: server?.label ?? issue.serverKey,
			workspaceSlug: server?.workspaces.find((workspace) => workspace.workspaceId === issue.workspaceId)?.slug ?? "",
			identifier: issue.identifier,
			title: issue.title,
			view: picked.view,
			agentName,
			isLeader: picked.run.isLeaderTask,
			isAutopilot: picked.run.autopilotRunId !== null,
			retrying: picked.view.state === "retrying",
			since: picked.run.startedAt ?? picked.run.endedAt,
			assignee,
			contested: row?.derivation.contested ?? false,
			sessions: row?.sessions ?? [],
		});
	}
	cards.sort((left, right) => (LANE_RANK.get(left.view.lane) ?? 9) - (LANE_RANK.get(right.view.lane) ?? 9) || (right.since ?? "").localeCompare(left.since ?? ""));
	return cards;
}

/** True when at least one server and workspace is switched on: the strip and the view are hidden otherwise. */
export function isAwarenessActive(state: AwarenessState): boolean {
	return !state.killSwitch && state.masterEnabled && state.servers.some((server) => server.enabled && server.workspaces.some((workspace) => workspace.watch));
}
