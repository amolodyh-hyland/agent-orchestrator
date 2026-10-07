import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeAllTabs as closeAllTabsInTabs,
	closeTab as closeTabInTabs,
	countTabs,
	closeTabsToRight as closeTabsToRightInTabs,
	EMPTY_TOPBAR_TABS,
	findSession,
	type TopbarTabsState,
} from "../lib/topbar-tabs";
import {
	readPersistedColorCoding,
	readPersistedDensity,
	readPersistedOverflow,
	readPersistedProjectColors,
	readPersistedTopbarTabs,
	resetTopbarTabsStoreForTests,
	TOPBAR_TABS_STORAGE_KEYS,
	useTopbarTabsStore,
} from "./topbar-tabs-store";
import { assignProjectColorSlot, preferredProjectColorSlot } from "../lib/project-colors";

function resetStore(): void {
	resetTopbarTabsStoreForTests();
}

async function bootStore() {
	return (await import("./topbar-tabs-store")).useTopbarTabsStore;
}

beforeEach(() => {
	window.localStorage.clear();
	resetStore();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("topbar tabs hydration", () => {
	it("uses defaults when storage is empty", async () => {
		vi.resetModules();
		const store = await bootStore();
		expect(store.getState().tabs).toEqual(EMPTY_TOPBAR_TABS);
		expect(store.getState().overflow).toBe("scroll");
		expect(store.getState().density).toBe("comfortable");
		expect(store.getState().colorCoding).toBe(false);
		expect(store.getState().projectColors).toEqual({});
	});

	it("hydrates valid values from storage", async () => {
		const tabs: TopbarTabsState = {
			version: 1,
			groups: [
				{
					id: "project-1",
					collapsed: true,
					head: { sessionId: "orchestrator-1", mode: "persistent", lastActiveAt: 42 },
					tabs: [{ sessionId: "task-1", mode: "preview", lastActiveAt: 43 }],
				},
			],
		};
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.tabs, JSON.stringify(tabs));
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.overflow, "wrap");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.density, "compact");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.colorCoding, "on");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.projectColors, JSON.stringify({ "project-1": 7 }));

		vi.resetModules();
		const state = (await bootStore()).getState();
		expect(state.tabs).toEqual(tabs);
		expect(state.overflow).toBe("wrap");
		expect(state.density).toBe("compact");
		expect(state.colorCoding).toBe(true);
		expect(state.projectColors).toEqual({ "project-1": 7 });
	});

	it("defaults each reader on junk or corrupt values", () => {
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.tabs, "{");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.overflow, "wide");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.density, "small");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.colorCoding, "true");
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.projectColors, "not-json");

		expect(readPersistedTopbarTabs()).toBe(EMPTY_TOPBAR_TABS);
		expect(readPersistedOverflow()).toBe("scroll");
		expect(readPersistedDensity()).toBe("comfortable");
		expect(readPersistedColorCoding()).toBe(false);
		expect(readPersistedProjectColors()).toEqual({});
	});

	it("coerces invalid project color entries and malformed tab shapes", () => {
		window.localStorage.setItem(TOPBAR_TABS_STORAGE_KEYS.tabs, JSON.stringify({ version: 99, groups: [] }));
		window.localStorage.setItem(
			TOPBAR_TABS_STORAGE_KEYS.projectColors,
			JSON.stringify({ valid: 3, negative: -1, large: 10, fractional: 2.5, text: "4" }),
		);

		expect(readPersistedTopbarTabs()).toBe(EMPTY_TOPBAR_TABS);
		expect(readPersistedProjectColors()).toEqual({ valid: 3 });
	});

	it("returns defaults when storage reads throw", () => {
		const throwingStorage = {
			getItem: () => {
				throw new Error("unavailable");
			},
		} as unknown as Storage;

		expect(readPersistedTopbarTabs(throwingStorage)).toBe(EMPTY_TOPBAR_TABS);
		expect(readPersistedOverflow(throwingStorage)).toBe("scroll");
		expect(readPersistedDensity(throwingStorage)).toBe("comfortable");
		expect(readPersistedColorCoding(throwingStorage)).toBe(false);
		expect(readPersistedProjectColors(throwingStorage)).toEqual({});
	});
});

describe("topbar tabs actions", () => {
	it("assigns missing project colours in order and persists the map once", () => {
		const firstId = "project-a";
		const secondId = "project-b";
		const occupiedSlot = preferredProjectColorSlot(firstId);
		useTopbarTabsStore.setState({ projectColors: { existing: occupiedSlot } });
		const setItem = vi.spyOn(window.localStorage, "setItem");

		useTopbarTabsStore.getState().ensureProjectColors([firstId, secondId, firstId]);

		const colors = useTopbarTabsStore.getState().projectColors;
		expect(colors[firstId]).toBe((occupiedSlot + 1) % 10);
		expect(colors[secondId]).toBe(assignProjectColorSlot(secondId, new Set([occupiedSlot, colors[firstId]])));
		expect(setItem).toHaveBeenCalledOnce();
		expect(setItem).toHaveBeenCalledWith(TOPBAR_TABS_STORAGE_KEYS.projectColors, JSON.stringify(colors));
	});

	it("does not overwrite existing project colours or write unchanged maps", () => {
		useTopbarTabsStore.setState({ projectColors: { "project-a": 6 } });
		const currentColors = useTopbarTabsStore.getState().projectColors;
		const setItem = vi.spyOn(window.localStorage, "setItem");

		useTopbarTabsStore.getState().ensureProjectColors(["project-a"]);

		expect(useTopbarTabsStore.getState().projectColors).toBe(currentColors);
		expect(setItem).not.toHaveBeenCalled();
	});

	it("persists the versioned state and skips an identical activation", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const setItem = vi.spyOn(window.localStorage, "setItem");
		const activate = useTopbarTabsStore.getState().activateSession;
		const input = { sessionId: "orchestrator-1", groupId: "project-1", kind: "orchestrator" as const };

		activate(input);
		const persisted = window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.tabs);
		expect(JSON.parse(persisted ?? "null")).toEqual(useTopbarTabsStore.getState().tabs);
		expect(JSON.parse(persisted ?? "null").version).toBe(1);
		expect(setItem).toHaveBeenCalledTimes(1);

		activate(input);
		expect(setItem).toHaveBeenCalledTimes(1);
	});

	it("promotes an interacted preview and persists it", () => {
		const store = useTopbarTabsStore.getState();
		store.activateSession({ sessionId: "task-1", groupId: "project-1", kind: "task" });
		const setItem = vi.spyOn(window.localStorage, "setItem");

		useTopbarTabsStore.getState().markInteracted("task-1");

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].mode).toBe("persistent");
		expect(JSON.parse(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.tabs) ?? "null")).toEqual(
			useTopbarTabsStore.getState().tabs,
		);
		expect(setItem).toHaveBeenCalledTimes(1);
	});

	it("promotes an interaction recorded before navigation opens the tab", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
		const store = useTopbarTabsStore.getState();

		store.markInteracted("restored-before-navigation");
		store.activateSession({ sessionId: "restored-before-navigation", groupId: "project-1", kind: "task" });

		expect(findSession(useTopbarTabsStore.getState().tabs, "restored-before-navigation")?.mode).toBe("persistent");
	});

	it("clears pending interactions and restores defaults in the test reset", () => {
		useTopbarTabsStore.getState().markInteracted("pending-before-reset");
		useTopbarTabsStore.setState({ overflow: "wrap", density: "compact", colorCoding: true, projectColors: { project: 4 } });

		resetTopbarTabsStoreForTests();
		expect(useTopbarTabsStore.getState()).toMatchObject({
			tabs: EMPTY_TOPBAR_TABS,
			overflow: "scroll",
			density: "comfortable",
			colorCoding: false,
			projectColors: {},
			lastEviction: null,
		});
		useTopbarTabsStore.getState().activateSession({ sessionId: "pending-before-reset", groupId: "project", kind: "task" });
		expect(findSession(useTopbarTabsStore.getState().tabs, "pending-before-reset")?.mode).toBe("preview");
	});

	it("drops a pending interaction older than ten seconds", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
		const store = useTopbarTabsStore.getState();

		store.markInteracted("late-navigation");
		vi.setSystemTime(new Date("2026-10-01T00:00:10.001Z"));
		store.activateSession({ sessionId: "late-navigation", groupId: "project-1", kind: "task" });

		expect(findSession(useTopbarTabsStore.getState().tabs, "late-navigation")?.mode).toBe("preview");
	});

	it("returns the library close suggestion and persists the updated tabs", () => {
		const store = useTopbarTabsStore.getState();
		store.activateSession({ sessionId: "orchestrator-1", groupId: "project-1", kind: "orchestrator" });
		store.activateSession({ sessionId: "task-1", groupId: "project-1", kind: "task" });
		store.markInteracted("task-1");
		store.activateSession({ sessionId: "task-2", groupId: "project-1", kind: "task" });
		store.markInteracted("task-2");
		const before = useTopbarTabsStore.getState().tabs;
		const expected = closeTabInTabs(before, "task-2");

		const result = useTopbarTabsStore.getState().closeTab("task-2");

		expect(result).toEqual({ nextSessionId: expected.nextSessionId, closedGroupId: expected.closedGroupId });
		expect(useTopbarTabsStore.getState().tabs).toEqual(expected.state);
		expect(JSON.parse(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.tabs) ?? "null")).toEqual(expected.state);
	});

	it("persists close-to-right only when it changes tab state", () => {
		const tabs: TopbarTabsState = {
			version: 1,
			groups: [{
				id: "project-1",
				collapsed: false,
				head: { sessionId: "head-1", mode: "persistent", lastActiveAt: 0 },
				tabs: [
					{ sessionId: "task-1", mode: "persistent", lastActiveAt: 1 },
					{ sessionId: "task-2", mode: "persistent", lastActiveAt: 2 },
				],
			}],
		};
		useTopbarTabsStore.setState({ tabs });
		const expected = closeTabsToRightInTabs(tabs, "task-1");
		const setItem = vi.spyOn(window.localStorage, "setItem");
		useTopbarTabsStore.getState().closeAllTabs("head-1");
		expect(setItem).not.toHaveBeenCalled();

		useTopbarTabsStore.getState().closeTabsToRight("task-1");

		expect(useTopbarTabsStore.getState().tabs).toEqual(expected);
		expect(JSON.parse(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.tabs) ?? "null")).toEqual(expected);
		expect(setItem).toHaveBeenCalledOnce();
		useTopbarTabsStore.getState().closeTabsToRight("task-1");
		useTopbarTabsStore.getState().closeAllTabs("head-1");
		expect(setItem).toHaveBeenCalledOnce();
	});

	it("persists close-all and removes the standalone group", () => {
		const tabs: TopbarTabsState = {
			version: 1,
			groups: [{
				id: "__standalone__",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: [{ sessionId: "scratch-1", mode: "persistent", lastActiveAt: 1 }],
			}],
		};
		useTopbarTabsStore.setState({ tabs });
		const expected = closeAllTabsInTabs(tabs, "scratch-1");
		const setItem = vi.spyOn(window.localStorage, "setItem");

		useTopbarTabsStore.getState().closeAllTabs("scratch-1");

		expect(useTopbarTabsStore.getState().tabs).toEqual(expected);
		expect(expected.groups).toEqual([]);
		expect(JSON.parse(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.tabs) ?? "null")).toEqual(expected);
		expect(setItem).toHaveBeenCalledOnce();
	});

	it("persists valid preferences and ignores invalid values", () => {
		const store = useTopbarTabsStore.getState();
		const setItem = vi.spyOn(window.localStorage, "setItem");

		store.setOverflow("invalid" as "scroll");
		store.setDensity("small" as "comfortable");
		store.setColorCoding("on" as unknown as boolean);
		store.setProjectColor("project-1", 10);
		store.setProjectColor("project-1", -1);
		store.setProjectColor("project-1", 1.5);
		expect(setItem).not.toHaveBeenCalled();

		store.setOverflow("wrap");
		store.setDensity("compact");
		store.setColorCoding(true);
		store.setProjectColor("project-1", 4);

		expect(useTopbarTabsStore.getState().overflow).toBe("wrap");
		expect(useTopbarTabsStore.getState().density).toBe("compact");
		expect(useTopbarTabsStore.getState().colorCoding).toBe(true);
		expect(useTopbarTabsStore.getState().projectColors).toEqual({ "project-1": 4 });
		expect(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.overflow)).toBe("wrap");
		expect(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.density)).toBe("compact");
		expect(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.colorCoding)).toBe("on");
		expect(JSON.parse(window.localStorage.getItem(TOPBAR_TABS_STORAGE_KEYS.projectColors) ?? "null")).toEqual({
			"project-1": 4,
		});
		expect(setItem).toHaveBeenCalledTimes(4);
	});

	it("records an eviction when activation exceeds the cap", () => {
		const store = useTopbarTabsStore.getState();
		store.activateSession({ sessionId: "orchestrator-1", groupId: "project-1", kind: "orchestrator" });
		store.markInteracted("orchestrator-1");
		for (let index = 1; index < 100; index += 1) {
			const sessionId = `task-${index}`;
			store.activateSession({ sessionId, groupId: "project-1", kind: "task" });
			store.markInteracted(sessionId);
		}
		expect(countTabs(useTopbarTabsStore.getState().tabs)).toBe(100);

		store.activateSession({ sessionId: "task-100", groupId: "project-1", kind: "task" });

		expect(useTopbarTabsStore.getState().lastEviction).toEqual({ count: 1, nonce: 1 });
		expect(countTabs(useTopbarTabsStore.getState().tabs)).toBe(100);
	});

	it("keeps in-memory actions working when storage writes throw", () => {
		vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});

		expect(() => {
			useTopbarTabsStore.getState().activateSession({
				sessionId: "orchestrator-1",
				groupId: "project-1",
				kind: "orchestrator",
			});
		}).not.toThrow();
		expect(useTopbarTabsStore.getState().tabs.groups[0].head.sessionId).toBe("orchestrator-1");
	});
});
