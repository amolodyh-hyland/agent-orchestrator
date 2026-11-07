import { create } from "zustand";

export type SessionTabSelection = { sessionId: string; projectId?: string };
export function sameSessionTab(left: SessionTabSelection, right: SessionTabSelection): boolean {
	return left.sessionId === right.sessionId && left.projectId === right.projectId;
}

type TabSelectionState = {
	selected: SessionTabSelection[];
	select: (tab: SessionTabSelection, toggle: boolean, active?: SessionTabSelection) => void;
	clear: () => void;
};

export const useTabSelectionStore = create<TabSelectionState>((set, get) => ({
	selected: [],
	select: (tab, toggle, active) => set((state) => {
		const selected = toggle ? (state.selected.length ? state.selected : active && !sameSessionTab(active, tab) ? [active] : []) : [];
		return { selected: toggle && selected.some((item) => sameSessionTab(item, tab))
			? selected.filter((item) => !sameSessionTab(item, tab)) : [...selected, tab] };
	}),
	clear: () => { if (get().selected.length) set({ selected: [] }); },
}));
