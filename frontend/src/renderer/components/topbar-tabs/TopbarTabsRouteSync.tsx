import { useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useCloudOrg } from "../../hooks/useCloudOrg";
import {
	toCloudWorkspaceSession,
	useCloudSessionQuery,
	useWorkspaceScope,
	useWorkspaceSession,
} from "../../hooks/useWorkspaceQuery";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { isOrchestratorSession, STANDALONE_WORKSPACE_ID } from "../../types/workspace";

export function TopbarTabsRouteSync() {
	const params = useParams({ strict: false }) as { hostId?: string; projectId?: string; sessionId?: string };
	const href = useRouterState({ select: (state) => state.location.href });
	// Tabs describe this machine's sessions. A remote host numbers its sessions on its
	// own, so a host-scoped route must not resolve against (or open a tab for) a local
	// session that happens to share the id.
	const sessionId = params.hostId ? undefined : params.sessionId;
	const scope = useWorkspaceScope(params.hostId ? undefined : params.projectId, sessionId);
	const listedSession = scope.data?.session;
	const isCloudRoute = scope.data?.project?.kind === "cloud";
	const { org } = useCloudOrg();
	const cloudSession = useCloudSessionQuery(
		org?.id,
		sessionId ?? "",
		Boolean(org?.id && (isCloudRoute || !listedSession)),
	);
	const localLookupEnabled =
		!org?.id || Boolean(listedSession && !listedSession.cloud) || Boolean(!isCloudRoute && cloudSession.isError);
	const workspaceSession = useWorkspaceSession(sessionId ?? "", undefined, localLookupEnabled);
	const directCloudSession = cloudSession.data && org?.id
		? toCloudWorkspaceSession(
				cloudSession.data,
				{
					id: cloudSession.data.projectId,
					displayName:
						scope.data?.project?.id === cloudSession.data.projectId ? scope.data.project.name : "Cloud project",
				},
				org.id,
			)
		: undefined;
	const candidateSession = workspaceSession.data ?? directCloudSession ?? listedSession;
	const resolvedSession = candidateSession?.id === sessionId ? candidateSession : undefined;
	const groupId = resolvedSession?.workspaceId;
	const kind = resolvedSession
		? groupId === STANDALONE_WORKSPACE_ID || !isOrchestratorSession(resolvedSession)
			? "task"
			: "orchestrator"
		: undefined;
	const lastActivationRef = useRef<string | null>(null);
	const lastRoutedKeyRef = useRef<string | null>(null);

	useEffect(() => {
		const routedKey = JSON.stringify([href, sessionId ?? null]);
		if (lastRoutedKeyRef.current !== routedKey) {
			lastRoutedKeyRef.current = routedKey;
			lastActivationRef.current = null;
		}
		if (!sessionId) {
			lastActivationRef.current = null;
			return;
		}
		if (!resolvedSession || !groupId || !kind) return;

		const activationKey = JSON.stringify([sessionId, groupId, kind, href]);
		if (lastActivationRef.current === activationKey) return;

		lastActivationRef.current = activationKey;
		useTopbarTabsStore.getState().activateSession({ sessionId, groupId, kind });
	}, [groupId, href, kind, resolvedSession, sessionId]);

	return null;
}
