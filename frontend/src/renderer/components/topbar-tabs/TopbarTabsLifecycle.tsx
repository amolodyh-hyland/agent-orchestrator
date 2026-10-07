import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	useCloudProjectsQuery,
	useCloudSessionsQuery,
	useWorkspaceQuery,
	useWorkspaceSession,
	workspaceQueryOptions,
} from "../../hooks/useWorkspaceQuery";
import { useCloudOrg } from "../../hooks/useCloudOrg";
import { apiErrorCode } from "../../lib/api-client";
import { findSession, type TopbarGroup } from "../../lib/topbar-tabs";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useUiStore } from "../../stores/ui-store";
import {
	CLOUD_PROJECT_KIND,
	STANDALONE_WORKSPACE_ID,
	sessionIsActive,
	type WorkspaceSummary,
} from "../../types/workspace";
import { useTopbarTabsActions } from "./useTopbarTabsActions";

type IsTabSessionLiveInput = {
	sessionId: string;
	groupId?: string;
	workspaces: WorkspaceSummary[] | undefined;
	localWorkspaces: WorkspaceSummary[] | undefined;
	cloudSettled: boolean;
	routedSessionId?: string;
	cloudProjectIds?: ReadonlySet<string>;
};

type ShouldDropGroupInput = {
	group: Pick<TopbarGroup, "id" | "head" | "tabs">;
	workspaces: WorkspaceSummary[] | undefined;
	localWorkspaces: WorkspaceSummary[] | undefined;
	cloudProjectIds: ReadonlySet<string>;
	localSettled: boolean;
	cloudSettled: boolean;
	routedSessionId?: string;
};

function isCloudGroup(
	groupId: string,
	workspaces: WorkspaceSummary[] | undefined,
	cloudProjectIds: ReadonlySet<string> | undefined,
): boolean {
	return Boolean(
		cloudProjectIds?.has(groupId) ||
		workspaces?.some((workspace) => workspace.id === groupId && workspace.kind === CLOUD_PROJECT_KIND),
	);
}

export function isTabSessionLive({
	sessionId,
	groupId,
	workspaces,
	localWorkspaces,
	cloudSettled,
	routedSessionId,
	cloudProjectIds,
}: IsTabSessionLiveInput): boolean {
	if (sessionId === routedSessionId) return true;

	const isKnownCloudGroup = groupId ? isCloudGroup(groupId, workspaces, cloudProjectIds) : false;
	const isKnownLocalGroup = Boolean(groupId && localWorkspaces?.some((workspace) => workspace.id === groupId));
	if (!isKnownCloudGroup && !isKnownLocalGroup && !cloudSettled) return true;

	const session = workspaces?.flatMap((workspace) => workspace.sessions).find((candidate) => candidate.id === sessionId);
	if (session) return sessionIsActive(session);
	if (isKnownCloudGroup) return true;
	return !isKnownLocalGroup && !cloudSettled;
}

export function shouldDropGroup({
	group,
	workspaces,
	localWorkspaces,
	cloudProjectIds,
	localSettled,
	cloudSettled,
	routedSessionId,
}: ShouldDropGroupInput): boolean {
	if (!localSettled) return false;
	if (
		routedSessionId &&
		(group.head.sessionId === routedSessionId || group.tabs.some((tab) => tab.sessionId === routedSessionId))
	) {
		return false;
	}
	if (isCloudGroup(group.id, workspaces, cloudProjectIds)) return false;
	if (localWorkspaces?.some((workspace) => workspace.id === group.id)) return false;
	return cloudSettled;
}

function nearestSurvivingSession(
	groupBefore: TopbarGroup | undefined,
	groupAfter: TopbarGroup | undefined,
	sessionId: string,
): string | undefined {
	if (!groupAfter) return undefined;
	const removedIndex = groupBefore?.tabs.findIndex((tab) => tab.sessionId === sessionId) ?? -1;
	if (removedIndex >= 0 && groupBefore) {
		for (let distance = 1; distance < groupBefore.tabs.length; distance += 1) {
			const left = groupBefore.tabs[removedIndex - distance]?.sessionId;
			if (left && groupAfter.tabs.some((tab) => tab.sessionId === left)) return left;
			const right = groupBefore.tabs[removedIndex + distance]?.sessionId;
			if (right && groupAfter.tabs.some((tab) => tab.sessionId === right)) return right;
		}
	}
	if (groupBefore?.head.sessionId === sessionId) return groupAfter.tabs[0]?.sessionId ?? groupAfter.head.sessionId ?? undefined;
	return groupAfter.tabs[0]?.sessionId ?? groupAfter.head.sessionId ?? undefined;
}

export function TopbarTabsLifecycle() {
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const routedSessionId = params.sessionId;
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const tabActions = useTopbarTabsActions();
	const workspaces = useWorkspaceQuery().data;
	const localQuery = useQuery(workspaceQueryOptions);
	const localWorkspaces = localQuery.data;
	const localSettled = localQuery.isSuccess && localQuery.fetchStatus === "idle";
	const routedSession = useWorkspaceSession(routedSessionId ?? "");
	const directLookup = routedSessionId
		? queryClient.getQueryState(["session", routedSessionId])
		: undefined;
	const directLookupNotFound =
		directLookup?.status === "error" &&
		directLookup.fetchStatus === "idle" &&
		apiErrorCode(directLookup.error) === "SESSION_NOT_FOUND";
	const cloudProjects = useCloudProjectsQuery();
	const cloudSessions = useCloudSessionsQuery();
	const cloudOrg = useCloudOrg();
	const cloudOrgSettled = cloudOrg.ready && !cloudOrg.isLoading && cloudOrg.error === undefined;
	const cloudNoOrg = cloudOrgSettled && cloudOrg.org === undefined;
	const cloudProjectsSettled = cloudProjects.fetchStatus === "idle" && (cloudProjects.isSuccess || cloudNoOrg);
	const cloudSessionsSettled = cloudSessions.fetchStatus === "idle" && (cloudSessions.isSuccess || cloudNoOrg);
	const cloudHasError =
		cloudOrg.error !== undefined || cloudProjects.isError || cloudSessions.isError;
	const cloudSettled =
		cloudOrgSettled && cloudProjectsSettled && cloudSessionsSettled && !cloudHasError;
	const tabSessionIdsKey = useTopbarTabsStore((state) => {
		const ids = state.tabs.groups.flatMap((group) => [
			...(group.head.sessionId ? [group.head.sessionId] : []),
			...group.tabs.map((tab) => tab.sessionId),
		]);
		return [...new Set(ids)].sort().join("\u0000");
	});
	const lastEviction = useTopbarTabsStore((state) => state.lastEviction);
	const lastEvictionNonceRef = useRef<number | null>(null);
	const handledRemovedRouteRef = useRef<string | null>(null);
	const { t } = useTranslation();

	useEffect(() => {
		if (!localSettled || localWorkspaces === undefined || !workspaces || cloudHasError) return;

		if (lastEviction) {
			if (lastEvictionNonceRef.current !== lastEviction.nonce) {
				lastEvictionNonceRef.current = lastEviction.nonce;
				useUiStore.getState().showGlobalToast(t("shell.tabs.evicted", { count: lastEviction.count }));
				useTopbarTabsStore.getState().clearEviction();
			}
		} else {
			lastEvictionNonceRef.current = null;
		}

		const store = useTopbarTabsStore.getState();
		const tabsBeforePrune = store.tabs;
		const groupBySessionId = new Map<string, string>();
		for (const group of store.tabs.groups) {
			if (group.head.sessionId) groupBySessionId.set(group.head.sessionId, group.id);
			for (const tab of group.tabs) groupBySessionId.set(tab.sessionId, group.id);
		}

		const cloudProjectIds = new Set(cloudProjects.data?.map((project) => project.id) ?? []);
		const routedSessionInWorkspace = workspaces.some((workspace) =>
			workspace.sessions.some((session) => session.id === routedSessionId),
		);
		const routedTab = routedSessionId ? findSession(tabsBeforePrune, routedSessionId) : null;
		const routedGroupId = routedTab?.groupId ?? params.projectId ?? routedSession.data?.workspaceId;
		const routedGroupIsLocal = Boolean(
			routedGroupId && localWorkspaces.some((workspace) => workspace.id === routedGroupId),
		);
		const routedGroupIsCloud = routedGroupId
			? isCloudGroup(routedGroupId, workspaces, cloudProjectIds)
			: false;
		const routedOriginSettled = routedGroupId === STANDALONE_WORKSPACE_ID || routedGroupIsLocal
			? localSettled
			: cloudSettled;
		const routedSessionRemoved = Boolean(
			routedSessionId &&
			!routedGroupIsCloud &&
			!routedSessionInWorkspace &&
			!routedSession.isLoading &&
			directLookupNotFound &&
			routedOriginSettled,
		);
		const routeExemptionSessionId = routedSessionRemoved ? undefined : routedSessionId;
		store.pruneTabs((sessionId) =>
			isTabSessionLive({
				sessionId,
				groupId: groupBySessionId.get(sessionId),
				workspaces,
				localWorkspaces,
				cloudSettled,
				routedSessionId: routeExemptionSessionId,
				cloudProjectIds,
			}),
		);

		for (const group of useTopbarTabsStore.getState().tabs.groups) {
			if (
				shouldDropGroup({
					group,
					workspaces,
					localWorkspaces,
					cloudProjectIds,
					localSettled,
					cloudSettled,
					routedSessionId: routeExemptionSessionId,
				})
			) {
				useTopbarTabsStore.getState().closeGroup(group.id);
			}
		}

		if (routedSessionRemoved && routedSessionId) {
			const routeKey = JSON.stringify([params.projectId ?? null, routedSessionId]);
			if (handledRemovedRouteRef.current !== routeKey) {
				handledRemovedRouteRef.current = routeKey;
				const tabsAfterPrune = useTopbarTabsStore.getState().tabs;
				const groupBefore = routedGroupId
					? tabsBeforePrune.groups.find((group) => group.id === routedGroupId)
					: undefined;
				const groupAfter = routedGroupId
					? tabsAfterPrune.groups.find((group) => group.id === routedGroupId)
					: undefined;
				const replacementId = groupBefore && groupAfter
					? nearestSurvivingSession(groupBefore, groupAfter, routedSessionId)
					: undefined;
				const replacement = replacementId ? findSession(tabsAfterPrune, replacementId) : null;
				if (replacementId && replacement) {
					tabActions.activate({
						key: replacementId,
						sessionId: replacementId,
						role: replacement.role === "head"
							? "head"
							: replacement.groupId === STANDALONE_WORKSPACE_ID
								? "scratch"
								: "task",
						groupId: replacement.groupId,
						mode: replacement.mode,
						label: "",
						isActive: false,
						isAnchor: false,
					});
				} else if (routedGroupId === STANDALONE_WORKSPACE_ID || (!routedGroupId && !params.projectId)) {
					void navigate({ to: "/sessions" });
				} else if (
					routedGroupId &&
					workspaces.some((workspace) => workspace.id === routedGroupId)
				) {
					void navigate({ to: "/projects/$projectId", params: { projectId: routedGroupId } });
				} else {
					void navigate({ to: "/" });
				}
			}
		} else {
			handledRemovedRouteRef.current = null;
		}
	}, [
		cloudHasError,
		cloudProjects.data,
		cloudSettled,
		lastEviction,
		localSettled,
		localWorkspaces,
		navigate,
		params.projectId,
		routedSessionId,
		routedSession.data?.workspaceId,
		routedSession.isLoading,
		directLookupNotFound,
		tabSessionIdsKey,
		tabActions.activate,
		t,
		workspaces,
	]);

	return null;
}
