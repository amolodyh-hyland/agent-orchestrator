import { describe, expect, it } from "vitest";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import {
	closeAllTabs,
	activateSession,
	closeOtherGroups,
	closeOtherTabs,
	closeTabsToRight,
	closeTab,
	coerceTopbarTabsState,
	countTabs,
	EMPTY_TOPBAR_TABS,
	enforceCap,
	findSession,
	markInteracted,
	MAX_TABS,
	pruneTabs,
	reorderTab,
	setCollapsed,
	toggleCollapsed,
	type TopbarGroup,
	type TopbarTabsState,
} from "./topbar-tabs";

function nowCounter(): () => number {
	let value = 0;
	return () => ++value;
}

function activate(
	state: TopbarTabsState,
	sessionId: string,
	groupId = "project",
	kind: "orchestrator" | "task" = "task",
	now = 1,
): TopbarTabsState {
	return activateSession(state, { sessionId, groupId, kind, now }).state;
}

function persistentTask(state: TopbarTabsState, sessionId: string, groupId = "project", now = 1): TopbarTabsState {
	return markInteracted(activate(state, sessionId, groupId, "task", now), sessionId);
}

function group(state: TopbarTabsState, groupId = "project"): TopbarGroup {
	const found = state.groups.find((candidate) => candidate.id === groupId);
	if (!found) throw new Error(`Missing group ${groupId}`);
	return found;
}

function headGroups(count: number): TopbarTabsState {
	let state = EMPTY_TOPBAR_TABS;
	for (let index = 0; index < count; index += 1) {
		state = activate(state, `head-${index}`, `group-${index}`, "orchestrator", index + 1);
	}
	return state;
}

function withExtraGroup(state: TopbarTabsState, extra: TopbarGroup): TopbarTabsState {
	return { ...state, groups: [...state.groups, extra] };
}

describe("topbar tabs activation", () => {
	it("replaces a preview in place", () => {
		const tick = nowCounter();
		let state = activate(EMPTY_TOPBAR_TABS, "first", "project", "task", tick());
		state = persistentTask(state, "kept", "project", tick());
		state = activate(state, "preview-one", "project", "task", tick());
		state = activate(state, "preview-two", "project", "task", tick());

		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["kept", "preview-two"]);
	});

	it("keeps a persistent tab when the next preview opens", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "kept");
		state = activate(state, "preview", "project", "task", 2);

		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["kept", "preview"]);
	});

	it("appends a preview when the group has no preview slot", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "one");
		state = persistentTask(state, "two", "project", 2);
		state = activate(state, "three", "project", "task", 3);

		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["one", "two", "three"]);
	});

	it("bumps an existing tab timestamp without moving it", () => {
		const tick = nowCounter();
		let state = persistentTask(EMPTY_TOPBAR_TABS, "one", "project", tick());
		state = persistentTask(state, "two", "project", tick());
		state = activate(state, "three", "project", "task", tick());
		state = activate(state, "one", "project", "task", tick());

		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["one", "two", "three"]);
		expect(group(state).tabs[0].lastActiveAt).toBe(4);
	});

	it("opens an orchestrator preview from an anchor", () => {
		const state = activate(EMPTY_TOPBAR_TABS, "orchestrator", "project", "orchestrator", 8);

		expect(group(state).head).toEqual({ sessionId: "orchestrator", mode: "preview", lastActiveAt: 8 });
	});

	it("keeps an orchestrator head mode when reactivating the same id", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "orchestrator", "project", "orchestrator", 1);
		state = markInteracted(state, "orchestrator");
		state = activate(state, "orchestrator", "project", "orchestrator", 5);

		expect(group(state).head).toEqual({ sessionId: "orchestrator", mode: "persistent", lastActiveAt: 5 });
	});

	it("opens a replacement orchestrator as a preview", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "old-head", "project", "orchestrator", 1);
		state = markInteracted(state, "old-head");
		state = activate(state, "new-head", "project", "orchestrator", 7);

		expect(group(state).head).toEqual({ sessionId: "new-head", mode: "preview", lastActiveAt: 7 });
	});

	it("keeps the head preview and task preview as independent slots", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "orchestrator", "project", "orchestrator", 1);
		state = activate(state, "task", "project", "task", 2);

		expect(group(state).head.sessionId).toBe("orchestrator");
		expect(group(state).head.mode).toBe("preview");
		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["task"]);
	});

	it("expands a collapsed group when a task activates", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = setCollapsed(state, "project", true);
		state = activate(state, "task", "project", "task", 2);

		expect(group(state).collapsed).toBe(false);
	});

	it("leaves a collapsed group collapsed when its head activates", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "first-head", "project", "orchestrator", 1);
		state = setCollapsed(state, "project", true);
		state = activate(state, "replacement-head", "project", "orchestrator", 2);

		expect(group(state).collapsed).toBe(true);
	});

	it("moves a session out of its previous group before activating it", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "shared", "first", "task", 1);
		state = persistentTask(state, "other", "second", 2);
		state = activate(state, "shared", "second", "task", 3);

		expect(group(state, "first").tabs).toEqual([]);
		expect(group(state, "second").tabs.map((tab) => tab.sessionId)).toEqual(["other", "shared"]);
		expect(findSession(state, "shared")).toEqual({ groupId: "second", role: "tab", mode: "preview" });
	});
});

describe("topbar tabs interaction", () => {
	it("makes a task and its opened preview head persistent", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = activate(state, "task", "project", "task", 2);
		state = markInteracted(state, "task");

		expect(findSession(state, "task")?.mode).toBe("persistent");
		expect(group(state).head.mode).toBe("persistent");
	});

	it("does not turn a standalone anchor into a head", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "scratch", STANDALONE_WORKSPACE_ID, "task", 1);
		state = markInteracted(state, "scratch");

		expect(group(state, STANDALONE_WORKSPACE_ID).head).toEqual({
			sessionId: null,
			mode: "persistent",
			lastActiveAt: 0,
		});
	});

	it("does not change an already persistent head when a task interacts", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = markInteracted(state, "head");
		state = activate(state, "task", "project", "task", 2);
		state = markInteracted(state, "task");

		expect(group(state).head.mode).toBe("persistent");
	});

	it("promotes a preview head when a task that was already persistent interacts", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = activate(state, "task", "project", "task", 2);
		state = markInteracted(state, "task");
		state = activate(state, "next-task", "project", "task", 3);
		state = markInteracted(state, "task");

		expect(group(state).head.mode).toBe("persistent");
	});

	it("treats orchestrator activation in the standalone group as a scratchpad task", () => {
		const state = activate(EMPTY_TOPBAR_TABS, "scratch", STANDALONE_WORKSPACE_ID, "orchestrator", 1);

		expect(group(state, STANDALONE_WORKSPACE_ID).tabs.map((tab) => tab.sessionId)).toEqual(["scratch"]);
		expect(group(state, STANDALONE_WORKSPACE_ID).head.sessionId).toBeNull();
	});

	it("replaces only the standalone preview", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "first", STANDALONE_WORKSPACE_ID, "task", 1);
		state = activate(state, "second", STANDALONE_WORKSPACE_ID, "task", 2);

		expect(group(state, STANDALONE_WORKSPACE_ID).tabs.map((tab) => tab.sessionId)).toEqual(["second"]);
	});

	it("returns the same state for unknown or already persistent sessions", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "task");
		state = markInteracted(state, "task");

		expect(markInteracted(state, "unknown")).toBe(state);
		expect(markInteracted(state, "task")).toBe(state);
	});
});

describe("topbar tabs closing", () => {
	it("selects the left tab when closing a middle task", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "left");
		state = persistentTask(state, "middle", "project", 2);
		state = persistentTask(state, "right", "project", 3);
		const result = closeTab(state, "middle");

		expect(result.nextSessionId).toBe("left");
		expect(result.closedGroupId).toBeNull();
		expect(group(result.state).tabs.map((tab) => tab.sessionId)).toEqual(["left", "right"]);
	});

	it("selects the right tab when closing the first task", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "first");
		state = persistentTask(state, "second", "project", 2);
		const result = closeTab(state, "first");

		expect(result.nextSessionId).toBe("second");
	});

	it("selects the head when closing the last task", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = persistentTask(state, "task", "project", 2);
		const result = closeTab(state, "task");

		expect(result.nextSessionId).toBe("head");
	});

	it("returns null after closing the only standalone task", () => {
		const state = activate(EMPTY_TOPBAR_TABS, "scratch", STANDALONE_WORKSPACE_ID, "task", 1);

		expect(closeTab(state, "scratch").nextSessionId).toBeNull();
	});

	it("closes a head group and suggests the nearest head to the left", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "left-head", "left", "orchestrator", 1);
		state = activate(state, "closing-head", "middle", "orchestrator", 2);
		state = activate(state, "right-head", "right", "orchestrator", 3);
		const result = closeTab(state, "closing-head");

		expect(result.closedGroupId).toBe("middle");
		expect(result.nextSessionId).toBe("left-head");
		expect(result.state.groups.map((candidate) => candidate.id)).toEqual(["left", "right"]);
	});

	it("skips anchor groups and uses a standalone tab as the next suggestion", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "anchor-task", "anchor-group", "task", 1);
		state = activate(state, "closing-head", "middle", "orchestrator", 2);
		state = activate(state, "scratch", STANDALONE_WORKSPACE_ID, "task", 3);

		expect(closeTab(state, "closing-head").nextSessionId).toBe("scratch");
	});

	it("leaves state unchanged for an unknown session", () => {
		const state = activate(EMPTY_TOPBAR_TABS, "task", "project", "task", 1);
		const result = closeTab(state, "unknown");

		expect(result.state).toBe(state);
		expect(result.nextSessionId).toBeNull();
		expect(result.closedGroupId).toBeNull();
	});

	it("closes other tasks while keeping the selected task and head", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = persistentTask(state, "one", "project", 2);
		state = persistentTask(state, "two", "project", 3);
		state = persistentTask(state, "three", "project", 4);
		state = closeOtherTabs(state, "two");

		expect(group(state).head.sessionId).toBe("head");
		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["two"]);
		expect(closeOtherTabs(state, "two")).toBe(state);
		expect(closeOtherTabs(state, "head")).toBe(state);
	});

	it("closes only tabs to the right in their visual order", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "one");
		state = persistentTask(state, "two", "project", 2);
		state = persistentTask(state, "three", "project", 3);

		const next = closeTabsToRight(state, "two");

		expect(group(next).tabs.map((tab) => tab.sessionId)).toEqual(["one", "two"]);
	});

	it("closes every task to the right of a head and keeps the head", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = persistentTask(state, "one", "project", 2);
		state = persistentTask(state, "two", "project", 3);

		const next = closeTabsToRight(state, "head");

		expect(group(next).head.sessionId).toBe("head");
		expect(group(next).tabs).toEqual([]);
		expect(closeAllTabs(state, "head")).toBe(state);
	});

	it("supports an anchor head and standalone scratchpad groups", () => {
		let projectState = persistentTask(EMPTY_TOPBAR_TABS, "one");
		projectState = persistentTask(projectState, "two", "project", 2);
		const projectAfter = closeTabsToRight(projectState, "project");
		expect(group(projectAfter).head.sessionId).toBeNull();
		expect(group(projectAfter).tabs.map((tab) => tab.sessionId)).toEqual([]);

		let scratchState = persistentTask(EMPTY_TOPBAR_TABS, "scratch-one", STANDALONE_WORKSPACE_ID);
		scratchState = persistentTask(scratchState, "scratch-two", STANDALONE_WORKSPACE_ID, 2);
		expect(closeTabsToRight(scratchState, "scratch-one").groups[0].tabs.map((tab) => tab.sessionId)).toEqual([
			"scratch-one",
		]);
		expect(closeAllTabs(scratchState, "scratch-one").groups).toEqual([]);
	});

	it("returns the same state when the clicked tab is rightmost or no tabs are closable", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "one");
		state = persistentTask(state, "two", "project", 2);
		const rightmostState = closeTabsToRight(state, "two");

		expect(rightmostState).toBe(state);
		expect(closeTabsToRight(rightmostState, "two")).toBe(rightmostState);
		expect(closeTabsToRight(state, "unknown")).toBe(state);
		expect(closeAllTabs(state, "unknown")).toBe(state);
		expect(closeAllTabs(state, "head")).toBe(state);
	});

	it("closes all project task tabs but leaves its group head", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = persistentTask(state, "one", "project", 2);
		state = persistentTask(state, "two", "project", 3);

		const next = closeAllTabs(state, "one");

		expect(group(next).head.sessionId).toBe("head");
		expect(group(next).tabs).toEqual([]);
	});

	it("keeps only the selected group", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "one", "first", "orchestrator", 1);
		state = activate(state, "two", "second", "orchestrator", 2);
		state = closeOtherGroups(state, "second");

		expect(state.groups.map((candidate) => candidate.id)).toEqual(["second"]);
	});
});

describe("topbar tabs layout", () => {
	it("toggles a normal group and ignores the standalone group", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = activate(state, "scratch", STANDALONE_WORKSPACE_ID, "task", 2);
		const standaloneState = state;
		state = toggleCollapsed(state, "project");

		expect(group(state).collapsed).toBe(true);
		expect(toggleCollapsed(standaloneState, STANDALONE_WORKSPACE_ID)).toBe(standaloneState);
		expect(setCollapsed(standaloneState, STANDALONE_WORKSPACE_ID, true)).toBe(standaloneState);
		expect(toggleCollapsed(standaloneState, "missing")).toBe(standaloneState);
	});

	it("reorders task tabs with clamped indexes and keeps the head fixed", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "head", "project", "orchestrator", 1);
		state = persistentTask(state, "one", "project", 2);
		state = persistentTask(state, "two", "project", 3);
		state = persistentTask(state, "three", "project", 4);
		state = reorderTab(state, "project", "three", -10);
		state = reorderTab(state, "project", "one", Number.POSITIVE_INFINITY);

		expect(group(state).head.sessionId).toBe("head");
		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["three", "two", "one"]);
	});

	it("returns the same state when a reorder changes nothing", () => {
		const state = persistentTask(EMPTY_TOPBAR_TABS, "task");

		expect(reorderTab(state, "project", "task", 0)).toBe(state);
		expect(reorderTab(state, "project", "missing", 0)).toBe(state);
		expect(reorderTab(state, "missing", "task", 0)).toBe(state);
	});
});

describe("topbar tabs pruning", () => {
	it("removes dead tasks", () => {
		let state = persistentTask(EMPTY_TOPBAR_TABS, "live");
		state = persistentTask(state, "dead", "project", 2);
		state = pruneTabs(state, (sessionId) => sessionId !== "dead");

		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["live"]);
	});

	it("turns a dead head into an anchor while keeping live tasks", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "dead-head", "project", "orchestrator", 1);
		state = persistentTask(state, "live-task", "project", 2);
		state = pruneTabs(state, (sessionId) => sessionId !== "dead-head");

		expect(group(state).head).toEqual({ sessionId: null, mode: "persistent", lastActiveAt: 0 });
		expect(group(state).tabs.map((tab) => tab.sessionId)).toEqual(["live-task"]);
	});

	it("removes empty anchors and an empty standalone group", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "dead-head", "project", "orchestrator", 1);
		state = activate(state, "scratch", STANDALONE_WORKSPACE_ID, "task", 2);
		state = pruneTabs(state, () => false);

		expect(state.groups).toEqual([]);
	});

	it("returns the same state when all sessions remain live", () => {
		const state = activate(EMPTY_TOPBAR_TABS, "task", "project", "task", 1);

		expect(pruneTabs(state, () => true)).toBe(state);
	});
});

describe("topbar tabs capacity", () => {
	it("keeps 99 counted tabs unchanged", () => {
		const state = headGroups(99);
		const result = enforceCap(state, null, 0);

		expect(countTabs(state)).toBe(99);
		expect(result.state).toBe(state);
		expect(result.evicted).toBe(0);
	});

	it("keeps 100 counted tabs unchanged", () => {
		const state = headGroups(MAX_TABS);
		const result = enforceCap(state, null, 0);

		expect(countTabs(state)).toBe(100);
		expect(result.state).toBe(state);
		expect(result.evicted).toBe(0);
	});

	it("evicts the oldest eligible preview and protects the active tab", () => {
		const base = headGroups(99);
		const groups = base.groups.map((candidate, index) =>
			index < 2
				? {
						...candidate,
						tabs: [
							{ sessionId: index === 0 ? "active" : "older", mode: "preview" as const, lastActiveAt: index },
						],
					}
				: candidate,
		);
		const state = { ...base, groups };
		const result = enforceCap(state, "active", 0);

		expect(result.evicted).toBe(1);
		expect(countTabs(result.state)).toBe(100);
		expect(findSession(result.state, "active")).not.toBeNull();
		expect(findSession(result.state, "older")).toBeNull();
	});

	it("evicts the oldest persistent tab when no preview is available", () => {
		const previewBase = headGroups(99);
		const base = {
			...previewBase,
			groups: previewBase.groups.map((candidate) => ({
				...candidate,
				head: { ...candidate.head, mode: "persistent" as const },
			})),
		};
		const groups = base.groups.map((candidate, index) =>
			index < 2
				? {
						...candidate,
						tabs: [
							{ sessionId: index === 0 ? "active" : "old-persistent", mode: "persistent" as const, lastActiveAt: index },
						],
					}
				: candidate,
		);
		const state = { ...base, groups };
		const result = enforceCap(state, "active", 0);

		expect(result.evicted).toBe(1);
		expect(countTabs(result.state)).toBe(100);
		expect(findSession(result.state, "active")).not.toBeNull();
		expect(findSession(result.state, "old-persistent")).toBeNull();
	});

	it("evicts a head-only preview before persistent tasks", () => {
		let state = activate(EMPTY_TOPBAR_TABS, "preview-head-a", "group-a", "orchestrator", 1);
		state = activate(state, "persistent-head-b", "group-b", "orchestrator", 2);
		state = markInteracted(state, "persistent-head-b");
		const persistentTaskIds = Array.from({ length: 98 }, (_, index) => `task-${index}`);
		for (let index = 0; index < persistentTaskIds.length; index += 1) {
			state = persistentTask(state, persistentTaskIds[index], "group-b", index + 3);
		}
		expect(countTabs(state)).toBe(MAX_TABS);

		const result = activateSession(state, {
			sessionId: "task-c",
			groupId: "group-b",
			kind: "task",
			now: 101,
		});

		expect(result.evicted).toBe(1);
		expect(countTabs(result.state)).toBe(MAX_TABS);
		expect(findSession(result.state, "preview-head-a")).toBeNull();
		expect(findSession(result.state, "task-c")).not.toBeNull();
		for (const sessionId of persistentTaskIds) {
			expect(findSession(result.state, sessionId)).not.toBeNull();
		}
	});

	it("evicts an older head-only preview before a newer preview task", () => {
		const base = headGroups(MAX_TABS);
		const state = {
			...base,
			groups: base.groups.map((candidate, index) => {
				if (index === 0) {
					return { ...candidate, head: { ...candidate.head, mode: "preview" as const, lastActiveAt: 1 } };
				}
			if (index === 1) {
				return {
					...candidate,
					tabs: [{ sessionId: "preview-task", mode: "preview" as const, lastActiveAt: 50 }],
				};
			}
			return candidate;
			}),
		};
		expect(countTabs(state)).toBe(MAX_TABS + 1);

		const result = enforceCap(state, null, 0);

		expect(countTabs(result.state)).toBe(MAX_TABS);
		expect(result.state.groups.some((candidate) => candidate.id === "group-0")).toBe(false);
		expect(findSession(result.state, "preview-task")).not.toBeNull();
	});

	it("selects the oldest preview across heads, task tabs, and scratch tabs", () => {
		const base = headGroups(97);
		const groups = base.groups.map((candidate, index) => {
			if (index === 0) {
				return {
					...candidate,
					head: { ...candidate.head, mode: "preview" as const, lastActiveAt: 1 },
					tabs: [{ sessionId: "head-task", mode: "persistent" as const, lastActiveAt: 2 }],
				};
			}
			if (index === 1) {
				return {
					...candidate,
					tabs: [{ sessionId: "preview-task", mode: "preview" as const, lastActiveAt: 70 }],
				};
			}
			if (index === 2) {
				return {
					...candidate,
					head: { ...candidate.head, mode: "preview" as const, lastActiveAt: 80 },
					tabs: [{ sessionId: "later-head-task", mode: "persistent" as const, lastActiveAt: 3 }],
				};
			}
			return { ...candidate, head: { ...candidate.head, mode: "persistent" as const } };
		});
		const state = {
			...base,
			groups: [
				...groups,
				{
					id: STANDALONE_WORKSPACE_ID,
					collapsed: false,
					head: { sessionId: null, mode: "persistent" as const, lastActiveAt: 0 },
					tabs: [{ sessionId: "scratch-preview", mode: "preview" as const, lastActiveAt: 50 }],
				},
			],
		};
		expect(countTabs(state)).toBe(MAX_TABS + 1);

		const result = enforceCap(state, null, 0);

		expect(countTabs(result.state)).toBe(MAX_TABS);
		expect(group(result.state, "group-0").head.sessionId).toBeNull();
		expect(findSession(result.state, "scratch-preview")).toBeNull();
		expect(findSession(result.state, "preview-task")).not.toBeNull();
		expect(group(result.state, "group-2").head.sessionId).toBe("head-2");
	});

	it("prefers a slot freeing preview when timestamps tie", () => {
		const base = headGroups(99);
		const state = {
			...base,
			groups: base.groups.map((candidate, index) => {
				if (index === 0) {
					return {
						...candidate,
						head: { ...candidate.head, mode: "preview" as const, lastActiveAt: 10 },
						tabs: [{ sessionId: "head-group-task", mode: "persistent" as const, lastActiveAt: 11 }],
					};
				}
				if (index === 1) {
					return {
						...candidate,
						head: { ...candidate.head, mode: "persistent" as const },
						tabs: [{ sessionId: "tied-preview-task", mode: "preview" as const, lastActiveAt: 10 }],
					};
				}
				return { ...candidate, head: { ...candidate.head, mode: "persistent" as const } };
			}),
		};
		expect(countTabs(state)).toBe(MAX_TABS + 1);

		const result = enforceCap(state, null, 0);

		expect(countTabs(result.state)).toBe(MAX_TABS);
		expect(group(result.state, "group-0").head.sessionId).toBe("head-0");
		expect(findSession(result.state, "tied-preview-task")).toBeNull();
	});

	it("anchors a preview head with tabs before evicting a persistent task", () => {
		const state: TopbarTabsState = {
			version: 1,
			groups: [
				{
					id: "preview-group",
					collapsed: false,
					head: { sessionId: "preview-head", mode: "preview", lastActiveAt: 1 },
					tabs: [{ sessionId: "kept-task", mode: "persistent", lastActiveAt: 10 }],
				},
				{
					id: "active-group",
					collapsed: false,
					head: { sessionId: "active-head", mode: "persistent", lastActiveAt: 100 },
					tabs: [{ sessionId: "active-task", mode: "persistent", lastActiveAt: 100 }],
				},
				{
					id: "old-task-group",
					collapsed: false,
					head: { sessionId: "old-task-head", mode: "persistent", lastActiveAt: 0 },
					tabs: [{ sessionId: "old-task", mode: "persistent", lastActiveAt: 0 }],
				},
				...Array.from({ length: 95 }, (_, index) => ({
					id: `head-group-${index}`,
					collapsed: false,
					head: { sessionId: `head-${index}`, mode: "persistent" as const, lastActiveAt: index + 1 },
					tabs: [],
				})),
			],
		};
		const result = enforceCap(state, "active-task", 0);

		expect(result.evicted).toBe(1);
		expect(countTabs(result.state)).toBe(MAX_TABS);
		expect(group(result.state, "preview-group").head).toEqual({
			sessionId: null,
			mode: "persistent",
			lastActiveAt: 0,
		});
		expect(findSession(result.state, "kept-task")).not.toBeNull();
		expect(findSession(result.state, "old-task")).toBeNull();
	});

	it("evicts a whole oldest group when only heads remain over the cap", () => {
		const previewBase = headGroups(100);
		const base = {
			...previewBase,
			groups: previewBase.groups.map((candidate) => ({
				...candidate,
				head: { ...candidate.head, mode: "persistent" as const },
			})),
		};
		const state = withExtraGroup(base, {
			id: "extra",
			collapsed: false,
			head: { sessionId: "extra-head", mode: "persistent", lastActiveAt: 101 },
			tabs: [],
		});
		const result = enforceCap(state, null, 0);

		expect(result.evicted).toBe(1);
		expect(countTabs(result.state)).toBe(100);
		expect(result.state.groups).toHaveLength(100);
		expect(findSession(result.state, "head-0")).toBeNull();
		expect(findSession(result.state, "head-1")?.role).toBe("head");
		expect(findSession(result.state, "extra-head")?.role).toBe("head");
	});
});

describe("topbar tabs coercion", () => {
	it("uses the empty state for junk and a wrong version", () => {
		expect(coerceTopbarTabsState(null)).toBe(EMPTY_TOPBAR_TABS);
		expect(coerceTopbarTabsState({ version: 2, groups: [] })).toBe(EMPTY_TOPBAR_TABS);
		expect(coerceTopbarTabsState({ version: 1, groups: {} })).toBe(EMPTY_TOPBAR_TABS);
	});

	it("keeps the first duplicate group and session ids", () => {
		const state = coerceTopbarTabsState({
			version: 1,
			groups: [
				{
					id: "first",
					collapsed: false,
					head: { sessionId: "shared", mode: "preview", lastActiveAt: 1 },
					tabs: [{ sessionId: "first-tab", mode: "persistent", lastActiveAt: 2 }],
				},
				{
					id: "first",
					collapsed: false,
					head: { sessionId: "ignored-head", mode: "persistent", lastActiveAt: 3 },
					tabs: [],
				},
				{
					id: "second",
					collapsed: false,
					head: { sessionId: "shared", mode: "persistent", lastActiveAt: 4 },
					tabs: [
						{ sessionId: "first-tab", mode: "preview", lastActiveAt: 5 },
						{ sessionId: "second-tab", mode: "preview", lastActiveAt: 6 },
					],
				},
			],
		});

		expect(state.groups.map((candidate) => candidate.id)).toEqual(["first", "second"]);
		expect(state.groups[0].head.sessionId).toBe("shared");
		expect(state.groups[1].head.sessionId).toBeNull();
		expect(state.groups[1].tabs.map((tab) => tab.sessionId)).toEqual(["second-tab"]);
	});

	it("defaults missing optional fields and drops invalid entries", () => {
		const state = coerceTopbarTabsState({
			version: 1,
			groups: [
				{
					id: "project",
					head: { sessionId: null },
					tabs: [
						{ sessionId: "good" },
						{ sessionId: "", mode: "preview" },
						null,
				],
				},
				{ id: "missing-head", tabs: [] },
			],
		});

		expect(state.groups).toHaveLength(1);
		expect(state.groups[0].collapsed).toBe(false);
		expect(state.groups[0].head).toEqual({ sessionId: null, mode: "persistent", lastActiveAt: 0 });
		expect(state.groups[0].tabs).toEqual([{ sessionId: "good", mode: "preview", lastActiveAt: 0 }]);
	});

	it("forces standalone group invariants", () => {
		const state = coerceTopbarTabsState({
			version: 1,
			groups: [
				{
					id: STANDALONE_WORKSPACE_ID,
					collapsed: true,
					head: { sessionId: "not-a-head", mode: "preview", lastActiveAt: 99 },
					tabs: [{ sessionId: "scratch", mode: "persistent", lastActiveAt: 4 }],
				},
			],
		});

		expect(group(state, STANDALONE_WORKSPACE_ID).collapsed).toBe(false);
		expect(group(state, STANDALONE_WORKSPACE_ID).head).toEqual({
			sessionId: null,
			mode: "persistent",
			lastActiveAt: 0,
		});
	});

	it("keeps only the most recently active project preview", () => {
		const state = coerceTopbarTabsState({
			version: 1,
			groups: [
				{
					id: "project",
					head: { sessionId: null },
					tabs: [
						{ sessionId: "older", mode: "preview", lastActiveAt: 4 },
						{ sessionId: "newer", mode: "preview", lastActiveAt: 8 },
						{ sessionId: "saved", mode: "persistent", lastActiveAt: 2 },
					],
				},
			],
		});

		expect(group(state).tabs).toEqual([
			{ sessionId: "older", mode: "persistent", lastActiveAt: 4 },
			{ sessionId: "newer", mode: "preview", lastActiveAt: 8 },
			{ sessionId: "saved", mode: "persistent", lastActiveAt: 2 },
		]);
	});

	it("keeps the later preview on a timestamp tie in the standalone group", () => {
		const state = coerceTopbarTabsState({
			version: 1,
			groups: [
				{
					id: STANDALONE_WORKSPACE_ID,
					head: { sessionId: null },
					tabs: [
						{ sessionId: "first", mode: "preview", lastActiveAt: 8 },
						{ sessionId: "later", mode: "preview", lastActiveAt: 8 },
					],
				},
			],
		});

		expect(group(state, STANDALONE_WORKSPACE_ID).tabs).toEqual([
			{ sessionId: "first", mode: "persistent", lastActiveAt: 8 },
			{ sessionId: "later", mode: "preview", lastActiveAt: 8 },
		]);
	});

	it("prunes empty anchors and applies the cap to oversized input", () => {
		const groups = Array.from({ length: 101 }, (_, index) => ({
			id: `project-${index}`,
			collapsed: false,
			head: { sessionId: `head-${index}`, mode: "persistent", lastActiveAt: index },
			tabs: [],
		}));
		const state = coerceTopbarTabsState({ version: 1, groups });

		expect(countTabs(state)).toBe(100);
		expect(state.groups).toHaveLength(100);
		expect(findSession(state, "head-0")).toBeNull();
		expect(findSession(state, "head-100")?.role).toBe("head");
		expect(coerceTopbarTabsState({ version: 1, groups: [{ id: "empty", head: { sessionId: null }, tabs: [] }] }).groups).toEqual(
			[],
		);
	});
});
