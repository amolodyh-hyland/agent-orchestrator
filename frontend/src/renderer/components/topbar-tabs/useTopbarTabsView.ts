import { useQueries } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCloudCp } from "../../hooks/useCloudCp";
import { useCloudOrg } from "../../hooks/useCloudOrg";
import { toCloudWorkspaceSession, useWorkspaceQuery } from "../../hooks/useWorkspaceQuery";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import type { CloudCpSession } from "../../lib/cloud-cp";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { buildTopbarTabsView, type TopbarGroupView } from "./topbar-tabs-view";

const EMPTY_WORKSPACES: WorkspaceSummary[] = [];
const MAX_EXTRA_SESSION_LOOKUPS = 20;

function sameReferences<T>(left: T[], right: T[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function getMissingSessionIds(
	tabs: ReturnType<typeof useTopbarTabsStore.getState>["tabs"],
	workspaces: WorkspaceSummary[],
): string[] {
	const listedSessionIds = new Set(workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.id)));
	const missingSessionIds = new Set<string>();
	for (const group of tabs.groups) {
		if (group.head.sessionId && !listedSessionIds.has(group.head.sessionId)) {
			missingSessionIds.add(group.head.sessionId);
		}
		for (const tab of group.tabs) {
			if (!listedSessionIds.has(tab.sessionId)) missingSessionIds.add(tab.sessionId);
		}
	}
	return Array.from(missingSessionIds).slice(0, MAX_EXTRA_SESSION_LOOKUPS);
}

export function useTopbarTabsView(): {
	groups: TopbarGroupView[];
	activeSessionId: string | undefined;
} {
	const tabs = useTopbarTabsStore((state) => state.tabs);
	const { data } = useWorkspaceQuery();
	const workspaces = data ?? EMPTY_WORKSPACES;
	const missingSessionIdsCandidate = useMemo(() => getMissingSessionIds(tabs, workspaces), [tabs, workspaces]);
	const missingSessionIdsKey = JSON.stringify(missingSessionIdsCandidate);
	const missingSessionIdsRef = useRef({ key: "", ids: missingSessionIdsCandidate });
	if (missingSessionIdsRef.current.key !== missingSessionIdsKey) {
		missingSessionIdsRef.current = { key: missingSessionIdsKey, ids: missingSessionIdsCandidate };
	}
	const missingSessionIds = missingSessionIdsRef.current.ids;
	const { client, baseUrl } = useCloudCp();
	const { org, ready } = useCloudOrg();
	const orgId = org?.id;
	const directSessionQueries = useQueries({
		queries: missingSessionIds.map((sessionId) => ({
			queryKey: ["cloud-session", baseUrl, orgId ?? "", sessionId],
			enabled: ready && orgId !== undefined,
			retry: 1,
			queryFn: async (): Promise<CloudCpSession | undefined> => {
				if (orgId === undefined) return undefined;
				const response = await client.getSession(orgId, sessionId);
				return response.session;
			},
		})),
	});
	const directSessionQueriesKey = JSON.stringify(directSessionQueries.map((query) => [
		query.status,
		query.data?.id ?? null,
		query.data?.updatedAt ?? null,
	]));
	const directSessionQueriesRef = useRef({ key: "", queries: directSessionQueries });
	if (directSessionQueriesRef.current.key !== directSessionQueriesKey) {
		directSessionQueriesRef.current = { key: directSessionQueriesKey, queries: directSessionQueries };
	}
	const stableDirectSessionQueries = directSessionQueriesRef.current.queries;

	const sessionIds = new Set(tabs.groups.flatMap((group) => [
		...(group.head.sessionId ? [group.head.sessionId] : []),
		...group.tabs.map((tab) => tab.sessionId),
	]));
	const sessionCacheRef = useRef(new Map<string, { signature: string; session: WorkspaceSession }>());
	const workspaceCacheRef = useRef(new Map<string, {
		name: string;
		sessions: WorkspaceSession[];
		workspace: WorkspaceSummary;
	}>());
	const viewWorkspacesRef = useRef<WorkspaceSummary[]>([]);
	const nextSessionCache = new Map<string, { signature: string; session: WorkspaceSession }>();
	const nextWorkspaceCache = new Map<string, {
		name: string;
		sessions: WorkspaceSession[];
		workspace: WorkspaceSummary;
	}>();
	const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	const viewWorkspaceCandidates = tabs.groups.flatMap((group): WorkspaceSummary[] => {
		const workspace = workspaceById.get(group.id);
		if (!workspace) return [];
		const sessions = workspace.sessions.flatMap((session) => {
			if (!sessionIds.has(session.id)) return [];
			const signature = JSON.stringify(session);
			const cached = sessionCacheRef.current.get(session.id);
			const stableSession = cached?.signature === signature ? cached.session : session;
			nextSessionCache.set(session.id, { signature, session: stableSession });
			return [stableSession];
		});
		const cached = workspaceCacheRef.current.get(workspace.id);
		const stableWorkspace = cached?.name === workspace.name && sameReferences(cached.sessions, sessions)
			? cached.workspace
			: { ...workspace, sessions };
		nextWorkspaceCache.set(workspace.id, { name: workspace.name, sessions, workspace: stableWorkspace });
		return [stableWorkspace];
	});
	if (!sameReferences(viewWorkspacesRef.current, viewWorkspaceCandidates)) {
		viewWorkspacesRef.current = viewWorkspaceCandidates;
	}
	sessionCacheRef.current = nextSessionCache;
	workspaceCacheRef.current = nextWorkspaceCache;
	const viewWorkspaces = viewWorkspacesRef.current;

	const extraSessions = useMemo(() => {
		if (!ready || orgId === undefined) return [];
		return stableDirectSessionQueries.flatMap((query, index): WorkspaceSession[] => {
			const session = query.data;
			if (!session || session.id !== missingSessionIds[index]) return [];
			const project = viewWorkspaces.find((workspace) => workspace.id === session.projectId);
			return [
				toCloudWorkspaceSession(
					session,
					{ id: session.projectId, displayName: project?.name ?? "Cloud project" },
					orgId,
				),
			];
		});
	}, [stableDirectSessionQueries, missingSessionIds, orgId, ready, viewWorkspaces]);
	const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
	const { t } = useTranslation();
	const scratchpadName = t("shell.tabs.scratchpad");
	const groups = useMemo(
		() => buildTopbarTabsView(tabs, viewWorkspaces, sessionId, scratchpadName, extraSessions),
		[tabs, viewWorkspaces, sessionId, scratchpadName, extraSessions],
	);
	return { groups, activeSessionId: sessionId };
}
