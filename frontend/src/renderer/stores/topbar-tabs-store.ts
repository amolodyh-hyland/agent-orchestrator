import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
	activateSession as activateSessionInTabs,
	closeAllTabs as closeAllTabsInTabs,
	closeGroup as closeGroupInTabs,
	closeOtherGroups as closeOtherGroupsInTabs,
	closeOtherTabs as closeOtherTabsInTabs,
	closeTabsToRight as closeTabsToRightInTabs,
	closeTab as closeTabInTabs,
	coerceTopbarTabsState,
	EMPTY_TOPBAR_TABS,
	findSession,
	markInteracted as markInteractedInTabs,
	pruneTabs as pruneTabsInTabs,
	reorderTab as reorderTabInTabs,
	setCollapsed as setCollapsedInTabs,
	toggleCollapsed as toggleCollapsedInTabs,
	type TabSessionKind,
	type TopbarGroup,
	type TopbarTabsState,
} from "../lib/topbar-tabs";
import { assignProjectColorSlot } from "../lib/project-colors";

export type { TabSessionKind, TopbarGroup, TopbarTabsState } from "../lib/topbar-tabs";

export type TabOverflowMode = "scroll" | "wrap";
export type TabDensity = "comfortable" | "compact";

export const TOPBAR_TABS_STORAGE_KEYS = {
	tabs: "ao.topbarTabs.v1",
	overflow: "ao.topbarTabs.overflow",
	density: "ao.topbarTabs.density",
	colorCoding: "ao.topbarTabs.colorCoding",
	projectColors: "ao.topbarTabs.projectColors",
} as const;

export type TopbarTabsStoreState = {
	tabs: TopbarTabsState;
	overflow: TabOverflowMode;
	density: TabDensity;
	colorCoding: boolean;
	projectColors: Record<string, number>;
	lastEviction: { count: number; nonce: number } | null;
	activateSession: (input: { sessionId: string; groupId: string; kind: TabSessionKind }) => void;
	markInteracted: (sessionId: string) => void;
	closeTab: (sessionId: string) => { nextSessionId: string | null; closedGroupId: string | null };
	closeGroup: (groupId: string) => void;
	closeOtherTabs: (sessionId: string) => void;
	closeTabsToRight: (sessionId: string) => void;
	closeAllTabs: (sessionId: string) => void;
	closeOtherGroups: (groupId: string) => void;
	setCollapsed: (groupId: string, collapsed: boolean) => void;
	toggleCollapsed: (groupId: string) => void;
	reorderTab: (groupId: string, sessionId: string, toIndex: number) => void;
	pruneTabs: (isLive: (sessionId: string) => boolean) => void;
	setOverflow: (mode: TabOverflowMode) => void;
	setDensity: (density: TabDensity) => void;
	setColorCoding: (enabled: boolean) => void;
	setProjectColor: (projectId: string, slot: number) => void;
	ensureProjectColors: (projectIds: string[]) => void;
	clearEviction: () => void;
};

function storageForRead(storage?: Storage): Storage | null {
	try {
		if (storage) return storage;
		if (typeof window === "undefined") return null;
		return window.localStorage;
	} catch {
		return null;
	}
}

function readStorageValue(key: string, storage?: Storage): string | null {
	try {
		return storageForRead(storage)?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStorageValue(key: string, value: string): void {
	try {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable in private or quota-limited contexts.
	}
}

export function readPersistedTopbarTabs(storage?: Storage): TopbarTabsState {
	try {
		const value = readStorageValue(TOPBAR_TABS_STORAGE_KEYS.tabs, storage);
		return value === null ? EMPTY_TOPBAR_TABS : coerceTopbarTabsState(JSON.parse(value));
	} catch {
		return EMPTY_TOPBAR_TABS;
	}
}

export function readPersistedOverflow(storage?: Storage): TabOverflowMode {
	const value = readStorageValue(TOPBAR_TABS_STORAGE_KEYS.overflow, storage);
	return value === "wrap" || value === "scroll" ? value : "scroll";
}

export function readPersistedDensity(storage?: Storage): TabDensity {
	const value = readStorageValue(TOPBAR_TABS_STORAGE_KEYS.density, storage);
	return value === "compact" || value === "comfortable" ? value : "comfortable";
}

export function readPersistedColorCoding(storage?: Storage): boolean {
	const value = readStorageValue(TOPBAR_TABS_STORAGE_KEYS.colorCoding, storage);
	return value === "on";
}

export function readPersistedProjectColors(storage?: Storage): Record<string, number> {
	const value = readStorageValue(TOPBAR_TABS_STORAGE_KEYS.projectColors, storage);
	if (value === null) return {};
	try {
		const raw: unknown = JSON.parse(value);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter((entry): entry is [string, number] =>
				Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 9,
			),
		);
	} catch {
		return {};
	}
}

function persistTabs(tabs: TopbarTabsState): void {
	try {
		writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.tabs, JSON.stringify(tabs));
	} catch {
		// Serialization failures should not interrupt an in-memory update.
	}
}

const initialTabs = readPersistedTopbarTabs();
const initialOverflow = readPersistedOverflow();
const initialDensity = readPersistedDensity();
const initialColorCoding = readPersistedColorCoding();
const initialProjectColors = readPersistedProjectColors();

const PENDING_INTERACTION_MAX_AGE_MS = 10_000;
const pendingInteractions = new Set<{ sessionId: string; timestamp: number }>();

function prunePendingInteractions(now: number): void {
	for (const pending of pendingInteractions) {
		const age = now - pending.timestamp;
		if (age < 0 || age >= PENDING_INTERACTION_MAX_AGE_MS) pendingInteractions.delete(pending);
	}
}

function clearPendingInteraction(sessionId: string): void {
	for (const pending of pendingInteractions) {
		if (pending.sessionId === sessionId) pendingInteractions.delete(pending);
	}
}

function takePendingInteraction(sessionId: string, now: number): boolean {
	prunePendingInteractions(now);
	let found = false;
	for (const pending of pendingInteractions) {
		if (pending.sessionId !== sessionId) continue;
		pendingInteractions.delete(pending);
		found = true;
	}
	return found;
}

export const useTopbarTabsStore: UseBoundStore<StoreApi<TopbarTabsStoreState>> = create<TopbarTabsStoreState>((set, get) => {
	const updateTabs = (update: (tabs: TopbarTabsState) => TopbarTabsState) => {
		const current = get().tabs;
		const tabs = update(current);
		if (tabs === current) return;
		persistTabs(tabs);
		set({ tabs });
	};

	return {
		tabs: initialTabs,
		overflow: initialOverflow,
		density: initialDensity,
		colorCoding: initialColorCoding,
		projectColors: initialProjectColors,
		lastEviction: null,
		activateSession: (input) => {
			const state = get();
			const now = Date.now();
			const result = activateSessionInTabs(state.tabs, { ...input, now });
			const shouldPromote = takePendingInteraction(input.sessionId, now);
			const tabs = shouldPromote ? markInteractedInTabs(result.state, input.sessionId) : result.state;
			if (tabs === state.tabs) return;
			persistTabs(tabs);
			set({
				tabs,
				...(result.evicted > 0
					? { lastEviction: { count: result.evicted, nonce: (state.lastEviction?.nonce ?? 0) + 1 } }
					: {}),
			});
		},
		markInteracted: (sessionId) => {
			const now = Date.now();
			prunePendingInteractions(now);
			const tabs = get().tabs;
			if (!findSession(tabs, sessionId)) {
				clearPendingInteraction(sessionId);
				pendingInteractions.add({ sessionId, timestamp: now });
				return;
			}
			clearPendingInteraction(sessionId);
			updateTabs((current) => markInteractedInTabs(current, sessionId));
		},
		closeTab: (sessionId) => {
			const result = closeTabInTabs(get().tabs, sessionId);
			if (result.state !== get().tabs) {
				persistTabs(result.state);
				set({ tabs: result.state });
			}
			return { nextSessionId: result.nextSessionId, closedGroupId: result.closedGroupId };
		},
		closeGroup: (groupId) => updateTabs((tabs) => closeGroupInTabs(tabs, groupId)),
		closeOtherTabs: (sessionId) => updateTabs((tabs) => closeOtherTabsInTabs(tabs, sessionId)),
		closeTabsToRight: (sessionId) => updateTabs((tabs) => closeTabsToRightInTabs(tabs, sessionId)),
		closeAllTabs: (sessionId) => updateTabs((tabs) => closeAllTabsInTabs(tabs, sessionId)),
		closeOtherGroups: (groupId) => updateTabs((tabs) => closeOtherGroupsInTabs(tabs, groupId)),
		setCollapsed: (groupId, collapsed) => updateTabs((tabs) => setCollapsedInTabs(tabs, groupId, collapsed)),
		toggleCollapsed: (groupId) => updateTabs((tabs) => toggleCollapsedInTabs(tabs, groupId)),
		reorderTab: (groupId, sessionId, toIndex) => updateTabs((tabs) => reorderTabInTabs(tabs, groupId, sessionId, toIndex)),
		pruneTabs: (isLive) => updateTabs((tabs) => pruneTabsInTabs(tabs, isLive)),
		setOverflow: (overflow) => {
			if (overflow !== "scroll" && overflow !== "wrap") return;
			if (get().overflow === overflow) return;
			writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.overflow, overflow);
			set({ overflow });
		},
		setDensity: (density) => {
			if (density !== "comfortable" && density !== "compact") return;
			if (get().density === density) return;
			writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.density, density);
			set({ density });
		},
		setColorCoding: (colorCoding) => {
			if (typeof colorCoding !== "boolean" || get().colorCoding === colorCoding) return;
			writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.colorCoding, colorCoding ? "on" : "off");
			set({ colorCoding });
		},
		setProjectColor: (projectId, slot) => {
			if (typeof projectId !== "string" || !Number.isInteger(slot) || slot < 0 || slot > 9) return;
			const projectColors = get().projectColors;
			if (projectColors[projectId] === slot) return;
			const nextProjectColors = { ...projectColors, [projectId]: slot };
			writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.projectColors, JSON.stringify(nextProjectColors));
			set({ projectColors: nextProjectColors });
		},
		ensureProjectColors: (projectIds) => {
			const projectColors = get().projectColors;
			let nextProjectColors = projectColors;
			for (const projectId of projectIds) {
				if (Object.hasOwn(nextProjectColors, projectId)) continue;
				const slot = assignProjectColorSlot(projectId, new Set(Object.values(nextProjectColors)));
				nextProjectColors = { ...nextProjectColors, [projectId]: slot };
			}
			if (nextProjectColors === projectColors) return;
			writeStorageValue(TOPBAR_TABS_STORAGE_KEYS.projectColors, JSON.stringify(nextProjectColors));
			set({ projectColors: nextProjectColors });
		},
		clearEviction: () => {
			if (get().lastEviction === null) return;
			set({ lastEviction: null });
		},
	};
});

export function resetTopbarTabsStoreForTests(): void {
	pendingInteractions.clear();
	useTopbarTabsStore.setState({
		tabs: EMPTY_TOPBAR_TABS,
		overflow: "scroll",
		density: "comfortable",
		colorCoding: false,
		projectColors: {},
		lastEviction: null,
	});
}

export const selectTopbarGroups = (state: TopbarTabsStoreState): TopbarGroup[] => state.tabs.groups;
