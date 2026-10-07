import type { TopbarTabsState } from "../../lib/topbar-tabs";
import {
	STANDALONE_WORKSPACE_ID,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../../types/workspace";

export type TopbarTabRole = "head" | "task" | "scratch";

export type TopbarTabView = {
	key: string;
	sessionId: string | null;
	role: TopbarTabRole;
	groupId: string;
	mode: "preview" | "persistent";
	label: string;
	session?: WorkspaceSession;
	isActive: boolean;
	isAnchor: boolean;
};

export type TopbarGroupView = {
	id: string;
	name: string;
	isStandalone: boolean;
	collapsed: boolean;
	head: TopbarTabView | null;
	tabs: TopbarTabView[];
	hiddenCount: number;
};

export function computeRevealScrollLeft({
	scrollLeft,
	clientWidth,
	actionsReservePx,
	leftChevronVisible,
	rightChevronVisible,
	tabLeft,
	tabRight,
}: {
	scrollLeft: number;
	clientWidth: number;
	actionsReservePx: number;
	leftChevronVisible: boolean;
	rightChevronVisible: boolean;
	tabLeft: number;
	tabRight: number;
}): number {
	const leftInset = leftChevronVisible ? 28 : 0;
	const rightInset = rightChevronVisible ? 28 : 0;
	const actionsReserve = Math.max(0, actionsReservePx);
	const visibleWidth = Math.max(0, clientWidth - actionsReserve - leftInset - rightInset);
	const visibleLeft = scrollLeft + leftInset;
	const visibleRight = scrollLeft + clientWidth - actionsReserve - rightInset;
	const tabWidth = tabRight - tabLeft;
	if (tabWidth > visibleWidth) return Math.max(0, tabLeft - leftInset);
	if (tabLeft < visibleLeft) return Math.max(0, tabLeft - leftInset);
	if (tabRight > visibleRight) return Math.max(0, tabRight - (clientWidth - actionsReserve - rightInset));
	return scrollLeft;
}

export function buildTopbarTabsView(
	state: TopbarTabsState,
	workspaces: WorkspaceSummary[],
	activeSessionId: string | undefined,
	scratchpadName: string,
	extraSessions: WorkspaceSession[] = [],
): TopbarGroupView[] {
	const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	const sessionById = new Map(
		workspaces.flatMap((workspace) => workspace.sessions.map((session) => [session.id, session] as const)),
	);
	for (const session of extraSessions) sessionById.set(session.id, session);

	return state.groups.map((group) => {
		const isStandalone = group.id === STANDALONE_WORKSPACE_ID;
		const workspace = workspaceById.get(group.id);
		const name = isStandalone ? scratchpadName : workspace?.name ?? group.id;
		const headSession = group.head.sessionId ? sessionById.get(group.head.sessionId) : undefined;
		const head: TopbarTabView | null = isStandalone
			? null
			: {
					key: group.head.sessionId ?? `anchor:${group.id}`,
					sessionId: group.head.sessionId,
					role: "head",
					groupId: group.id,
					mode: group.head.mode,
					label: name,
					session: headSession,
					isActive: group.head.sessionId !== null && group.head.sessionId === activeSessionId,
					isAnchor: group.head.sessionId === null,
				};
		const tabs = group.tabs.map((tab): TopbarTabView => {
			const session = sessionById.get(tab.sessionId);
			return {
				key: tab.sessionId,
				sessionId: tab.sessionId,
				role: isStandalone ? "scratch" : "task",
				groupId: group.id,
				mode: tab.mode,
				label: session?.title || tab.sessionId,
				session,
				isActive: tab.sessionId === activeSessionId,
				isAnchor: false,
			};
		});
		return {
			id: group.id,
			name,
			isStandalone,
			collapsed: group.collapsed,
			head,
			tabs,
			hiddenCount: group.collapsed ? tabs.length : 0,
		};
	});
}
