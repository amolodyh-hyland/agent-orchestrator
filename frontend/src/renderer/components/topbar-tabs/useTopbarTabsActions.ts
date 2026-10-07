import { useCallback, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { findSession, type TopbarGroup, type TopbarTabsState } from "../../lib/topbar-tabs";
import { sessionNavigateTarget } from "../../lib/navigate-to-session";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { STANDALONE_WORKSPACE_ID } from "../../types/workspace";
import type { TopbarTabView } from "./topbar-tabs-view";

export type TopbarTabsActionsOptions = {
	onOpenOrchestrator?: (groupId: string) => void;
};

function firstSessionInGroup(group: TopbarGroup): string | null {
	if (group.id === STANDALONE_WORKSPACE_ID) return group.tabs[0]?.sessionId ?? null;
	return group.head.sessionId ?? group.tabs[0]?.sessionId ?? null;
}

function nearestSessionAfterGroupRemoval(tabs: TopbarTabsState, groupId: string): string | null {
	const closedIndex = tabs.groups.findIndex((group) => group.id === groupId);
	if (closedIndex === -1) return null;
	for (let index = closedIndex - 1; index >= 0; index -= 1) {
		const sessionId = firstSessionInGroup(tabs.groups[index]);
		if (sessionId) return sessionId;
	}
	for (let index = closedIndex + 1; index < tabs.groups.length; index += 1) {
		const sessionId = firstSessionInGroup(tabs.groups[index]);
		if (sessionId) return sessionId;
	}
	return null;
}

export function useTopbarTabsActions({ onOpenOrchestrator }: TopbarTabsActionsOptions = {}) {
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const paramsRef = useRef(params);
	paramsRef.current = params;

	const navigateToSession = useCallback((sessionId: string, tabs: TopbarTabsState): boolean => {
		const found = findSession(tabs, sessionId);
		if (!found) return false;
		const projectId = found.groupId === STANDALONE_WORKSPACE_ID ? undefined : found.groupId;
		void navigate(sessionNavigateTarget(projectId, sessionId));
		return true;
	}, [navigate]);

	const navigateToBoard = useCallback((groupId?: string): void => {
		const projectId = groupId ?? paramsRef.current.projectId;
		if (!projectId || projectId === STANDALONE_WORKSPACE_ID) {
			void navigate({ to: "/sessions" });
			return;
		}
		void navigate({ to: "/projects/$projectId", params: { projectId } });
	}, [navigate]);

	const navigateToReplacement = useCallback((
		sessionId: string | null,
		tabs: TopbarTabsState,
		fallbackGroupId?: string,
	): void => {
		if (sessionId && navigateToSession(sessionId, tabs)) return;
		navigateToBoard(fallbackGroupId);
	}, [navigateToBoard, navigateToSession]);

	const activate = useCallback((view: TopbarTabView): void => {
		if (view.role === "head" && view.isAnchor) {
			onOpenOrchestrator?.(view.groupId);
			return;
		}
		if (!view.sessionId) return;
		const projectId = view.groupId === STANDALONE_WORKSPACE_ID ? undefined : view.groupId;
		void navigate(sessionNavigateTarget(projectId, view.sessionId));
	}, [navigate, onOpenOrchestrator]);

	const persist = useCallback((view: TopbarTabView): void => {
		if (view.sessionId) useTopbarTabsStore.getState().markInteracted(view.sessionId);
	}, []);

	const close = useCallback((view: TopbarTabView): void => {
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;

		if (!view.sessionId) {
			store.closeGroup(view.groupId);
			const after = useTopbarTabsStore.getState().tabs;
			if (activeBefore?.groupId !== view.groupId || !routeSessionId || findSession(after, routeSessionId)) return;
			const nextSessionId = nearestSessionAfterGroupRemoval(before, view.groupId);
			navigateToReplacement(nextSessionId, before, view.groupId);
			return;
		}

		const closingSession = view.sessionId;
		const closingSessionFound = findSession(before, closingSession);
		const result = store.closeTab(closingSession);
		if (closingSession !== routeSessionId || !closingSessionFound) return;
		const after = useTopbarTabsStore.getState().tabs;
		if (findSession(after, closingSession)) return;
		navigateToReplacement(result.nextSessionId, before, result.closedGroupId ?? closingSessionFound.groupId);
	}, [navigateToReplacement]);

	const closeOthers = useCallback((view: TopbarTabView): void => {
		if (!view.sessionId) return;
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;
		store.closeOtherTabs(view.sessionId);
		const after = useTopbarTabsStore.getState().tabs;
		if (!activeBefore || !routeSessionId || findSession(after, routeSessionId)) return;
		const nextSessionId = findSession(after, view.sessionId) ? view.sessionId : null;
		navigateToReplacement(nextSessionId, after, activeBefore.groupId);
	}, [navigateToReplacement]);

	const closeToRight = useCallback((view: TopbarTabView): void => {
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;
		store.closeTabsToRight(view.sessionId ?? view.groupId);
		const after = useTopbarTabsStore.getState().tabs;
		if (!activeBefore || activeBefore.groupId !== view.groupId || !routeSessionId || findSession(after, routeSessionId)) return;

		const nextSessionId = view.role === "head"
			? after.groups.find((group) => group.id === view.groupId)?.head.sessionId ?? null
			: view.sessionId;
		navigateToReplacement(nextSessionId, after, view.groupId);
	}, [navigateToReplacement]);

	const closeAll = useCallback((view: TopbarTabView): void => {
		if (!view.sessionId || view.role === "head") return;
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;
		store.closeAllTabs(view.sessionId);
		const after = useTopbarTabsStore.getState().tabs;
		if (!activeBefore || activeBefore.groupId !== view.groupId || !routeSessionId || findSession(after, routeSessionId)) return;

		const nextSessionId = after.groups.find((group) => group.id === view.groupId)?.head.sessionId ?? null;
		navigateToReplacement(nextSessionId, after, view.groupId);
	}, [navigateToReplacement]);

	const closeGroup = useCallback((groupId: string): void => {
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;
		store.closeGroup(groupId);
		const after = useTopbarTabsStore.getState().tabs;
		if (activeBefore?.groupId !== groupId || !routeSessionId || findSession(after, routeSessionId)) return;
		const nextSessionId = nearestSessionAfterGroupRemoval(before, groupId);
		navigateToReplacement(nextSessionId, before, groupId);
	}, [navigateToReplacement]);

	const closeOtherGroups = useCallback((groupId: string): void => {
		const store = useTopbarTabsStore.getState();
		const before = store.tabs;
		const routeSessionId = paramsRef.current.sessionId;
		const activeBefore = routeSessionId ? findSession(before, routeSessionId) : null;
		store.closeOtherGroups(groupId);
		const after = useTopbarTabsStore.getState().tabs;
		if (!activeBefore || activeBefore.groupId === groupId || !routeSessionId || findSession(after, routeSessionId)) return;
		const remainingGroup = after.groups.find((group) => group.id === groupId);
		const nextSessionId = remainingGroup ? firstSessionInGroup(remainingGroup) : null;
		navigateToReplacement(nextSessionId, after, activeBefore.groupId);
	}, [navigateToReplacement]);

	const toggleCollapsed = useCallback((groupId: string): void => {
		useTopbarTabsStore.getState().toggleCollapsed(groupId);
	}, []);

	return { activate, persist, close, closeOthers, closeToRight, closeAll, closeGroup, closeOtherGroups, toggleCollapsed };
}
