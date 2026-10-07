import { STANDALONE_WORKSPACE_ID } from "../types/workspace";

export const TOPBAR_TABS_VERSION = 1;
export const MAX_TABS = 100;

export type TabMode = "preview" | "persistent";
export type TabSessionKind = "orchestrator" | "task";
export type TopbarTab = { sessionId: string; mode: TabMode; lastActiveAt: number };
export type TopbarHead = { sessionId: string | null; mode: TabMode; lastActiveAt: number };
export type TopbarGroup = { id: string; collapsed: boolean; head: TopbarHead; tabs: TopbarTab[] };
export type TopbarTabsState = { version: typeof TOPBAR_TABS_VERSION; groups: TopbarGroup[] };

export const EMPTY_TOPBAR_TABS: TopbarTabsState = { version: TOPBAR_TABS_VERSION, groups: [] };

const anchorHead = (): TopbarHead => ({ sessionId: null, mode: "persistent", lastActiveAt: 0 });

export function activateSession(
	state: TopbarTabsState,
	input: { sessionId: string; groupId: string; kind: TabSessionKind; now: number },
): { state: TopbarTabsState; evicted: number } {
	const isStandalone = input.groupId === STANDALONE_WORKSPACE_ID;
	const kind = isStandalone ? "task" : input.kind;
	let groups = state.groups;
	let changed = false;

	groups = groups.map((group) => {
		if (group.id === input.groupId) return group;
		let nextGroup = group;
		if (group.head.sessionId === input.sessionId) {
			nextGroup = { ...nextGroup, head: anchorHead() };
		}
		const nextTabs = nextGroup.tabs.filter((tab) => tab.sessionId !== input.sessionId);
		if (nextTabs.length !== nextGroup.tabs.length) nextGroup = { ...nextGroup, tabs: nextTabs };
		if (nextGroup !== group) changed = true;
		return nextGroup;
	});

	let groupIndex = groups.findIndex((group) => group.id === input.groupId);
	if (groupIndex === -1) {
		groups = [
			...groups,
			{
				id: input.groupId,
				collapsed: false,
				head: anchorHead(),
				tabs: [],
			},
		];
		groupIndex = groups.length - 1;
		changed = true;
	}

	const group = groups[groupIndex];
	let nextGroup = group;
	if (isStandalone && (group.collapsed || group.head.sessionId !== null || group.head.mode !== "persistent" || group.head.lastActiveAt !== 0)) {
		nextGroup = { ...nextGroup, collapsed: false, head: anchorHead() };
	}

	if (kind === "orchestrator") {
		if (nextGroup.head.sessionId === input.sessionId) {
			if (nextGroup.head.lastActiveAt !== input.now) {
				nextGroup = { ...nextGroup, head: { ...nextGroup.head, lastActiveAt: input.now } };
			}
		} else if (nextGroup.head.sessionId !== null) {
			nextGroup = {
				...nextGroup,
				head: { ...nextGroup.head, sessionId: input.sessionId, mode: "preview", lastActiveAt: input.now },
			};
		} else {
			nextGroup = {
				...nextGroup,
				head: { sessionId: input.sessionId, mode: "preview", lastActiveAt: input.now },
			};
		}
		const nextTabs = nextGroup.tabs.filter((tab) => tab.sessionId !== input.sessionId);
		if (nextTabs.length !== nextGroup.tabs.length) nextGroup = { ...nextGroup, tabs: nextTabs };
	} else if (nextGroup.head.sessionId === input.sessionId) {
		if (nextGroup.head.lastActiveAt !== input.now) {
			nextGroup = { ...nextGroup, head: { ...nextGroup.head, lastActiveAt: input.now } };
		}
	} else {
		const tabIndex = nextGroup.tabs.findIndex((tab) => tab.sessionId === input.sessionId);
		let nextTabs = nextGroup.tabs;
		if (tabIndex !== -1) {
			if (nextTabs[tabIndex].lastActiveAt !== input.now) {
				nextTabs = nextTabs.map((tab, index) =>
					index === tabIndex ? { ...tab, lastActiveAt: input.now } : tab,
				);
			}
		} else {
			const previewIndex = nextTabs.findIndex((tab) => tab.mode === "preview");
			const newTab: TopbarTab = { sessionId: input.sessionId, mode: "preview", lastActiveAt: input.now };
			if (previewIndex === -1) {
				nextTabs = [...nextTabs, newTab];
			} else {
				nextTabs = nextTabs.map((tab, index) => (index === previewIndex ? newTab : tab));
			}
		}
		if (nextTabs !== nextGroup.tabs) nextGroup = { ...nextGroup, tabs: nextTabs };
		if (!isStandalone && nextGroup.collapsed) nextGroup = { ...nextGroup, collapsed: false };
	}

	if (nextGroup !== group) {
		groups = groups.map((candidate, index) => (index === groupIndex ? nextGroup : candidate));
		changed = true;
	}

	const nextState = changed ? { ...state, groups } : state;
	return enforceCap(nextState, input.sessionId, input.now);
}

export function markInteracted(state: TopbarTabsState, sessionId: string): TopbarTabsState {
	const found = findSession(state, sessionId);
	if (!found) return state;
	const groupIndex = state.groups.findIndex((group) => group.id === found.groupId);
	const group = state.groups[groupIndex];
	let nextGroup = group;

	if (found.role === "head") {
		if (group.head.mode === "persistent") return state;
		nextGroup = { ...group, head: { ...group.head, mode: "persistent" } };
	} else {
		const tabIndex = group.tabs.findIndex((tab) => tab.sessionId === sessionId);
		const tab = group.tabs[tabIndex];
		if (tab.mode === "preview") {
			const tabs = group.tabs.map((candidate, index) =>
				index === tabIndex ? { ...candidate, mode: "persistent" as const } : candidate,
			);
			nextGroup = { ...nextGroup, tabs };
		}
		if (
			group.id !== STANDALONE_WORKSPACE_ID &&
			nextGroup.head.sessionId !== null &&
			nextGroup.head.mode === "preview"
		) {
			nextGroup = { ...nextGroup, head: { ...nextGroup.head, mode: "persistent" } };
		}
		if (nextGroup === group) return state;
	}

	const groups = state.groups.map((candidate, index) => (index === groupIndex ? nextGroup : candidate));
	return { ...state, groups };
}

export function closeTab(
	state: TopbarTabsState,
	sessionId: string,
): { state: TopbarTabsState; nextSessionId: string | null; closedGroupId: string | null } {
	const found = findSession(state, sessionId);
	if (!found) return { state, nextSessionId: null, closedGroupId: null };
	const groupIndex = state.groups.findIndex((group) => group.id === found.groupId);
	const group = state.groups[groupIndex];
	if (found.role === "head") {
		const nextSessionId = nearestSessionAfterGroupClose(state.groups, groupIndex);
		return {
			state: closeGroup(state, group.id),
			nextSessionId,
			closedGroupId: group.id,
		};
	}

	const tabIndex = group.tabs.findIndex((tab) => tab.sessionId === sessionId);
	const nextSessionId =
		tabIndex > 0
			? group.tabs[tabIndex - 1].sessionId
			: group.tabs[tabIndex + 1]?.sessionId ?? group.head.sessionId;
	const tabs = group.tabs.filter((tab) => tab.sessionId !== sessionId);
	const groups = state.groups.map((candidate, index) =>
		index === groupIndex ? { ...candidate, tabs } : candidate,
	);
	return { state: { ...state, groups }, nextSessionId, closedGroupId: null };
}

export function closeGroup(state: TopbarTabsState, groupId: string): TopbarTabsState {
	const groupIndex = state.groups.findIndex((group) => group.id === groupId);
	if (groupIndex === -1) return state;
	return { ...state, groups: state.groups.filter((_, index) => index !== groupIndex) };
}

export function closeOtherTabs(state: TopbarTabsState, sessionId: string): TopbarTabsState {
	const found = findSession(state, sessionId);
	if (!found || found.role === "head") return state;
	const groupIndex = state.groups.findIndex((group) => group.id === found.groupId);
	const group = state.groups[groupIndex];
	if (group.tabs.length === 1) return state;
	const tabs = group.tabs.filter((tab) => tab.sessionId === sessionId);
	const groups = state.groups.map((candidate, index) =>
		index === groupIndex ? { ...candidate, tabs } : candidate,
	);
	return { ...state, groups };
}

export function closeTabsToRight(state: TopbarTabsState, sessionId: string): TopbarTabsState {
	const found = findSession(state, sessionId);
	const groupIndex = found
		? state.groups.findIndex((group) => group.id === found.groupId)
		: state.groups.findIndex((group) => group.id === sessionId && group.id !== STANDALONE_WORKSPACE_ID);
	if (groupIndex === -1) return state;
	const group = state.groups[groupIndex];
	const tabIndex = found?.role === "tab"
		? group.tabs.findIndex((tab) => tab.sessionId === sessionId)
		: -1;
	if (tabIndex >= group.tabs.length - 1) return state;
	const tabs = group.tabs.slice(0, tabIndex + 1);
	const groups = state.groups.map((candidate, index) =>
		index === groupIndex ? { ...candidate, tabs } : candidate,
	);
	return { ...state, groups };
}

export function closeAllTabs(state: TopbarTabsState, sessionId: string): TopbarTabsState {
	const found = findSession(state, sessionId);
	if (!found || found.role === "head") return state;
	const groupIndex = state.groups.findIndex((group) => group.id === found.groupId);
	const group = state.groups[groupIndex];
	if (group.tabs.length === 0) return state;
	const groups = group.id === STANDALONE_WORKSPACE_ID
		? state.groups.filter((_, index) => index !== groupIndex)
		: state.groups.map((candidate, index) =>
			index === groupIndex ? { ...candidate, tabs: [] } : candidate,
		);
	return { ...state, groups };
}

export function closeOtherGroups(state: TopbarTabsState, groupId: string): TopbarTabsState {
	const groups = state.groups.filter((group) => group.id === groupId);
	if (groups.length === state.groups.length) return state;
	return { ...state, groups };
}

export function setCollapsed(state: TopbarTabsState, groupId: string, collapsed: boolean): TopbarTabsState {
	if (groupId === STANDALONE_WORKSPACE_ID) return state;
	const groupIndex = state.groups.findIndex((group) => group.id === groupId);
	if (groupIndex === -1 || state.groups[groupIndex].collapsed === collapsed) return state;
	const groups = state.groups.map((group, index) => (index === groupIndex ? { ...group, collapsed } : group));
	return { ...state, groups };
}

export function toggleCollapsed(state: TopbarTabsState, groupId: string): TopbarTabsState {
	if (groupId === STANDALONE_WORKSPACE_ID) return state;
	const group = state.groups.find((candidate) => candidate.id === groupId);
	return group ? setCollapsed(state, groupId, !group.collapsed) : state;
}

export function reorderTab(
	state: TopbarTabsState,
	groupId: string,
	sessionId: string,
	toIndex: number,
): TopbarTabsState {
	const groupIndex = state.groups.findIndex((group) => group.id === groupId);
	if (groupIndex === -1) return state;
	const group = state.groups[groupIndex];
	const fromIndex = group.tabs.findIndex((tab) => tab.sessionId === sessionId);
	if (fromIndex === -1 || group.tabs.length < 2 || Number.isNaN(toIndex)) return state;
	const targetIndex = Math.max(0, Math.min(toIndex, group.tabs.length - 1));
	if (fromIndex === targetIndex) return state;
	const tabs = [...group.tabs];
	const [tab] = tabs.splice(fromIndex, 1);
	tabs.splice(targetIndex, 0, tab);
	const groups = state.groups.map((candidate, index) => (index === groupIndex ? { ...candidate, tabs } : candidate));
	return { ...state, groups };
}

export function pruneTabs(state: TopbarTabsState, isLive: (sessionId: string) => boolean): TopbarTabsState {
	let changed = false;
	const groups = state.groups
		.map((group) => {
			let nextGroup = group;
			if (group.head.sessionId !== null && !isLive(group.head.sessionId)) {
				nextGroup = { ...nextGroup, head: anchorHead() };
			}
			const tabs = nextGroup.tabs.filter((tab) => isLive(tab.sessionId));
			if (tabs.length !== nextGroup.tabs.length) nextGroup = { ...nextGroup, tabs };
			if (nextGroup !== group) changed = true;
			return nextGroup;
		})
		.filter((group) => {
			const keep = group.head.sessionId !== null || group.tabs.length > 0;
			if (!keep) changed = true;
			return keep;
		});
	if (!changed) return state;
	return groups.length > 0 ? { ...state, groups } : EMPTY_TOPBAR_TABS;
}

export function enforceCap(
	state: TopbarTabsState,
	activeSessionId: string | null,
	_now: number,
): { state: TopbarTabsState; evicted: number } {
	let groups = state.groups;
	let count = countTabs({ ...state, groups });
	let evicted = 0;
	let changed = false;

	while (count > MAX_TABS) {
		const preview = oldestPreview(groups, activeSessionId);
		if (preview?.kind === "tab") {
			groups = removeTabAt(groups, preview.groupIndex, preview.tabIndex);
			count -= 1;
			evicted += 1;
			changed = true;
			continue;
		}
		if (preview?.kind === "head") {
			if (groups[preview.groupIndex].tabs.length === 0) {
				const removedGroup = groups[preview.groupIndex];
				const removedCount = groupCount(removedGroup);
				groups = groups.filter((_, index) => index !== preview.groupIndex);
				count -= removedCount;
				evicted += removedCount;
			} else {
				groups = groups.map((group, index) =>
					index === preview.groupIndex ? { ...group, head: anchorHead() } : group,
				);
			}
			changed = true;
			continue;
		}

		const persistent = oldestTab(groups, "persistent", activeSessionId);
		if (persistent) {
			groups = removeTabAt(groups, persistent.groupIndex, persistent.tabIndex);
			count -= 1;
			evicted += 1;
			changed = true;
			continue;
		}

		let groupToRemove = -1;
		let oldestNewestMemberAt = Number.POSITIVE_INFINITY;
		for (let index = 0; index < groups.length; index += 1) {
			const group = groups[index];
			if (groupCount(group) === 0 || groupContainsSession(group, activeSessionId)) continue;
			const newestMemberAt = Math.max(
				group.head.lastActiveAt,
				...group.tabs.map((tab) => tab.lastActiveAt),
			);
			if (newestMemberAt < oldestNewestMemberAt) {
				oldestNewestMemberAt = newestMemberAt;
				groupToRemove = index;
			}
		}
		if (groupToRemove === -1) break;
		const removedGroup = groups[groupToRemove];
		const removedCount = groupCount(removedGroup);
		groups = groups.filter((_, index) => index !== groupToRemove);
		count -= removedCount;
		evicted += removedCount;
		changed = true;
	}

	return { state: changed ? { ...state, groups } : state, evicted };
}

export function countTabs(state: TopbarTabsState): number {
	return state.groups.reduce((total, group) => total + groupCount(group), 0);
}

export function findSession(
	state: TopbarTabsState,
	sessionId: string,
): { groupId: string; role: "head" | "tab"; mode: TabMode } | null {
	for (const group of state.groups) {
		if (group.head.sessionId === sessionId) return { groupId: group.id, role: "head", mode: group.head.mode };
		const tab = group.tabs.find((candidate) => candidate.sessionId === sessionId);
		if (tab) return { groupId: group.id, role: "tab", mode: tab.mode };
	}
	return null;
}

export function coerceTopbarTabsState(raw: unknown): TopbarTabsState {
	if (!isRecord(raw) || raw.version !== TOPBAR_TABS_VERSION || !Array.isArray(raw.groups)) {
		return EMPTY_TOPBAR_TABS;
	}

	const groupIds = new Set<string>();
	const sessionIds = new Set<string>();
	const groups: TopbarGroup[] = [];
	for (const rawGroup of raw.groups) {
		if (!isRecord(rawGroup) || typeof rawGroup.id !== "string" || rawGroup.id.length === 0 || !Array.isArray(rawGroup.tabs)) {
			continue;
		}
		if (!isRecord(rawGroup.head) || !(rawGroup.head.sessionId === null || typeof rawGroup.head.sessionId === "string")) {
			continue;
		}
		if (groupIds.has(rawGroup.id)) continue;
		groupIds.add(rawGroup.id);

		const isStandalone = rawGroup.id === STANDALONE_WORKSPACE_ID;
		let head: TopbarHead = isStandalone
			? anchorHead()
			: {
					sessionId: rawGroup.head.sessionId,
					mode: toMode(rawGroup.head.mode, "persistent"),
					lastActiveAt: finiteNumber(rawGroup.head.lastActiveAt) ? rawGroup.head.lastActiveAt : 0,
				};
		if (head.sessionId !== null) {
			if (sessionIds.has(head.sessionId)) {
				head = anchorHead();
			} else {
				sessionIds.add(head.sessionId);
			}
		}

		const tabs: TopbarTab[] = [];
		for (const rawTab of rawGroup.tabs) {
			if (!isRecord(rawTab) || typeof rawTab.sessionId !== "string" || rawTab.sessionId.length === 0) continue;
			if (sessionIds.has(rawTab.sessionId)) continue;
			sessionIds.add(rawTab.sessionId);
			tabs.push({
				sessionId: rawTab.sessionId,
				mode: toMode(rawTab.mode, "preview"),
				lastActiveAt: finiteNumber(rawTab.lastActiveAt) ? rawTab.lastActiveAt : 0,
			});
		}
		let newestPreviewIndex = -1;
		for (let index = 0; index < tabs.length; index += 1) {
			if (tabs[index].mode !== "preview") continue;
			if (newestPreviewIndex === -1 || tabs[index].lastActiveAt >= tabs[newestPreviewIndex].lastActiveAt) {
				newestPreviewIndex = index;
			}
		}
		const normalizedTabs = tabs.map((tab, index) =>
			tab.mode === "preview" && index !== newestPreviewIndex ? { ...tab, mode: "persistent" as const } : tab,
		);

		const group: TopbarGroup = {
			id: rawGroup.id,
			collapsed: isStandalone ? false : typeof rawGroup.collapsed === "boolean" ? rawGroup.collapsed : false,
			head,
			tabs: normalizedTabs,
		};
		if (group.head.sessionId !== null || group.tabs.length > 0) groups.push(group);
	}

	if (groups.length === 0) return EMPTY_TOPBAR_TABS;
	return enforceCap({ version: TOPBAR_TABS_VERSION, groups }, null, 0).state;
}

type PreviewCandidate =
	| { kind: "tab"; groupIndex: number; tabIndex: number; lastActiveAt: number; freesSlot: true }
	| { kind: "head"; groupIndex: number; lastActiveAt: number; freesSlot: boolean };

function oldestPreview(groups: TopbarGroup[], activeSessionId: string | null): PreviewCandidate | null {
	let oldest: (PreviewCandidate & { position: number }) | null = null;
	let position = 0;
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
		const group = groups[groupIndex];
		if (
			group.id !== STANDALONE_WORKSPACE_ID &&
			group.head.sessionId !== null &&
			group.head.mode === "preview" &&
			group.head.sessionId !== activeSessionId
		) {
			const candidate = {
				kind: "head" as const,
				groupIndex,
				lastActiveAt: group.head.lastActiveAt,
				freesSlot: group.tabs.length === 0,
				position,
			};
			oldest = earlierPreview(oldest, candidate);
		}
		position += 1;
		for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex += 1) {
			const tab = group.tabs[tabIndex];
			if (tab.mode === "preview" && tab.sessionId !== activeSessionId) {
				const candidate = {
					kind: "tab" as const,
					groupIndex,
					tabIndex,
					lastActiveAt: tab.lastActiveAt,
					freesSlot: true as const,
					position,
				};
				oldest = earlierPreview(oldest, candidate);
			}
			position += 1;
		}
	}
	if (!oldest) return null;
	if (oldest.kind === "tab") {
		return {
			kind: oldest.kind,
			groupIndex: oldest.groupIndex,
			tabIndex: oldest.tabIndex,
			lastActiveAt: oldest.lastActiveAt,
			freesSlot: oldest.freesSlot,
		};
	}
	return {
		kind: oldest.kind,
		groupIndex: oldest.groupIndex,
		lastActiveAt: oldest.lastActiveAt,
		freesSlot: oldest.freesSlot,
	};
}

function earlierPreview(
	current: (PreviewCandidate & { position: number }) | null,
	candidate: PreviewCandidate & { position: number },
): (PreviewCandidate & { position: number }) {
	if (!current || candidate.lastActiveAt < current.lastActiveAt) return candidate;
	if (candidate.lastActiveAt > current.lastActiveAt) return current;
	if (candidate.freesSlot !== current.freesSlot) return candidate.freesSlot ? candidate : current;
	return candidate.position < current.position ? candidate : current;
}

function oldestTab(
	groups: TopbarGroup[],
	mode: TabMode,
	activeSessionId: string | null,
): { groupIndex: number; tabIndex: number } | null {
	let oldest: { groupIndex: number; tabIndex: number; lastActiveAt: number } | null = null;
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
		const group = groups[groupIndex];
		for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex += 1) {
			const tab = group.tabs[tabIndex];
			if (tab.mode !== mode || tab.sessionId === activeSessionId) continue;
			if (!oldest || tab.lastActiveAt < oldest.lastActiveAt) {
				oldest = { groupIndex, tabIndex, lastActiveAt: tab.lastActiveAt };
			}
		}
	}
	return oldest ? { groupIndex: oldest.groupIndex, tabIndex: oldest.tabIndex } : null;
}

function removeTabAt(groups: TopbarGroup[], groupIndex: number, tabIndex: number): TopbarGroup[] {
	return groups.map((group, index) =>
		index === groupIndex ? { ...group, tabs: group.tabs.filter((_, tabPosition) => tabPosition !== tabIndex) } : group,
	);
}

function groupCount(group: TopbarGroup): number {
	return group.tabs.length + (group.id === STANDALONE_WORKSPACE_ID ? 0 : 1);
}

function groupContainsSession(group: TopbarGroup, sessionId: string | null): boolean {
	return sessionId !== null && (group.head.sessionId === sessionId || group.tabs.some((tab) => tab.sessionId === sessionId));
}

function nearestSessionAfterGroupClose(groups: TopbarGroup[], closedIndex: number): string | null {
	for (let index = closedIndex - 1; index >= 0; index -= 1) {
		const sessionId = selectableSession(groups[index]);
		if (sessionId !== null) return sessionId;
	}
	for (let index = closedIndex + 1; index < groups.length; index += 1) {
		const sessionId = selectableSession(groups[index]);
		if (sessionId !== null) return sessionId;
	}
	return null;
}

function selectableSession(group: TopbarGroup): string | null {
	if (group.id === STANDALONE_WORKSPACE_ID) return group.tabs[0]?.sessionId ?? null;
	return group.head.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function toMode(value: unknown, fallback: TabMode): TabMode {
	return value === "preview" || value === "persistent" ? value : fallback;
}
