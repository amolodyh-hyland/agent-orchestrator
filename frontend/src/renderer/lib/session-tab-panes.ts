import { groupContaining, groupSelectedTabs, leafKeys, splitBeside } from "./pane-split";
import { useSplitPanesStore } from "../stores/split-panes-store";
import type { SessionTabSelection } from "../stores/tab-selection-store";

export const MAX_SESSION_TAB_PANES = 4;
const KEY_PREFIX = "session-view:";
const WINDOW_KEY = "ao.sessionTabPanes.window";
let fallbackWindowId: string | undefined;

export function sessionTabPaneScope(): string {
	try {
		let id = window.sessionStorage.getItem(WINDOW_KEY);
		if (!id) { id = crypto.randomUUID(); window.sessionStorage.setItem(WINDOW_KEY, id); }
		return `session-tabs:${id}`;
	} catch {
		return `session-tabs:${fallbackWindowId ??= crypto.randomUUID()}`;
	}
}

export function sessionTabKey(tab: SessionTabSelection): string {
	return `${KEY_PREFIX}${JSON.stringify([tab.projectId ?? null, tab.sessionId])}`;
}

export function sessionTabFromKey(key: string): SessionTabSelection | undefined {
	if (!key.startsWith(KEY_PREFIX)) return undefined;
	try {
		const value: unknown = JSON.parse(key.slice(KEY_PREFIX.length));
		if (!Array.isArray(value) || value.length !== 2 || (value[0] !== null && typeof value[0] !== "string") || typeof value[1] !== "string" || !value[1]) return undefined;
		return { projectId: value[0] ?? undefined, sessionId: value[1] };
	} catch { return undefined; }
}

export function selectedSessionTabsGroup(tabs: readonly SessionTabSelection[]): void {
	const keys = [...new Set(tabs.map(sessionTabKey))];
	if (keys.length < 2 || keys.length > MAX_SESSION_TAB_PANES) return;
	useSplitPanesStore.getState().updateGroups(sessionTabPaneScope(), (groups) => groupSelectedTabs(groups, keys));
}

export function focusSessionTab(tab: SessionTabSelection): void {
	const key = sessionTabKey(tab);
	useSplitPanesStore.getState().updateGroups(sessionTabPaneScope(), (groups) => {
		const group = groupContaining(groups, key);
		return !group || group.focus === key ? groups : groups.map((candidate) => candidate === group ? { ...group, focus: key } : candidate);
	});
}

export function canSplitSessionTab(tab: SessionTabSelection, current: SessionTabSelection): boolean {
	const groups = useSplitPanesStore.getState().groupsBySession[sessionTabPaneScope()] ?? [];
	const group = groupContaining(groups, sessionTabKey(current));
	return Boolean(groupContaining(groups, sessionTabKey(tab))) || !group || leafKeys(group.root).length < MAX_SESSION_TAB_PANES;
}

export function splitSessionTabRight(tab: SessionTabSelection, current: SessionTabSelection): void {
	const store = useSplitPanesStore.getState();
	const scope = sessionTabPaneScope();
	const groups = store.groupsBySession[scope] ?? [];
	const key = sessionTabKey(tab);
	if (groupContaining(groups, key)) { focusSessionTab(tab); return; }
	if (!canSplitSessionTab(tab, current)) return;
	store.updateGroups(scope, (groups) => {
		const next = splitBeside(groups, sessionTabKey(current), key, "right");
		const group = groupContaining(next, key);
		if (!group) return groups;
		const balanced = groupSelectedTabs(next, leafKeys(group.root));
		return balanced.map((candidate, index) => index === balanced.length - 1 ? { ...candidate, focus: key } : candidate);
	});
}
