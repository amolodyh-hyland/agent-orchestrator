import { create } from "zustand";

export const MAX_SESSION_PANES = 4;
export const MIN_SESSION_PANE_WIDTH = 320;
export const SESSION_PANES_STORAGE_KEY = "ao.sessionPanes.v1";

export type PaneSession = { sessionId: string; projectId?: string };
export type SessionPane = PaneSession & { id: string };
type PaneLayout = { panes: SessionPane[]; focusedId: string | null; sizes: Record<string, number> };
const emptyLayout = (): PaneLayout => ({ panes: [], focusedId: null, sizes: {} });

export function readSessionPanes(storage?: Storage): PaneLayout {
	try {
		const raw = JSON.parse((storage ?? window.sessionStorage).getItem(SESSION_PANES_STORAGE_KEY) ?? "null");
		if (!raw || !Array.isArray(raw.panes) || raw.panes.length > MAX_SESSION_PANES) return emptyLayout();
		const panes: SessionPane[] = raw.panes.filter((pane: SessionPane) => pane &&
			typeof pane.id === "string" && pane.id.length > 0 && typeof pane.sessionId === "string" && pane.sessionId.length > 0 &&
			(pane.projectId === undefined || typeof pane.projectId === "string"));
		if (panes.length !== raw.panes.length || new Set(panes.map((pane) => pane.id)).size !== panes.length) return emptyLayout();
		const sizes = Object.fromEntries(panes.map((pane) => [pane.id, raw.sizes?.[pane.id]]));
		const validSizes = Object.values(sizes).every((size) => typeof size === "number" && Number.isFinite(size) && size > 0) &&
			Math.abs(Object.values(sizes).reduce((sum, size) => sum + size, 0) - 100) < 0.1;
		return { panes, focusedId: panes.find((pane) => pane.id === raw.focusedId)?.id ?? panes[0]?.id ?? null, sizes: validSizes ? sizes : {} };
	} catch {
		return emptyLayout();
	}
}

function sameSession(left: PaneSession, right: PaneSession): boolean {
	return left.sessionId === right.sessionId && left.projectId === right.projectId;
}

function newPane(session: PaneSession): SessionPane {
	return { ...session, id: crypto.randomUUID() };
}

function equalSizes(panes: SessionPane[]): Record<string, number> {
	return Object.fromEntries(panes.map((pane) => [pane.id, 100 / panes.length]));
}

type SessionPanesState = PaneLayout & {
	selected: PaneSession[];
	select: (session: PaneSession, toggle: boolean, active?: PaneSession) => void;
	clearSelection: () => void;
	viewSelected: () => void;
	openRight: (session: PaneSession, current?: PaneSession) => void;
	focus: (id: string) => void;
	close: (id: string) => void;
	followRoute: (session: PaneSession) => void;
	resize: (sizes: Record<string, number>) => void;
};

export const useSessionPanesStore = create<SessionPanesState>((set, get) => {
	const update = (layout: PaneLayout) => {
		try { window.sessionStorage.setItem(SESSION_PANES_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ }
		set(layout);
	};
	return {
		...readSessionPanes(),
		selected: [],
		select: (session, toggle, active) => set((state) => {
			const selected = toggle ? (state.selected.length ? state.selected : active && !sameSession(active, session) ? [active] : []) : [];
			return { selected: toggle && selected.some((item) => sameSession(item, session))
				? selected.filter((item) => !sameSession(item, session)) : [...selected, session] };
		}),
		clearSelection: () => { if (get().selected.length) set({ selected: [] }); },
		viewSelected: () => {
			const { selected } = get();
			if (selected.length < 2 || selected.length > MAX_SESSION_PANES) return;
			const panes = selected.map(newPane);
			update({ panes, focusedId: panes[0].id, sizes: equalSizes(panes) });
		},
		openRight: (session, current) => {
			const state = get();
			if (state.panes.length >= MAX_SESSION_PANES) return;
			const panes = state.panes.length ? [...state.panes] : [newPane(current ?? session)];
			const index = Math.max(0, panes.findIndex((pane) => pane.id === state.focusedId));
			const pane = newPane(session);
			panes.splice(index + 1, 0, pane);
			update({ panes, focusedId: pane.id, sizes: equalSizes(panes) });
		},
		focus: (id) => {
			const state = get();
			if (state.focusedId === id || !state.panes.some((pane) => pane.id === id)) return;
			update({ panes: state.panes, sizes: state.sizes, focusedId: id });
		},
		close: (id) => {
			const state = get();
			const index = state.panes.findIndex((pane) => pane.id === id);
			if (index < 0) return;
			const panes = state.panes.filter((pane) => pane.id !== id);
			const focusedId = state.focusedId === id ? panes[Math.min(index, panes.length - 1)]?.id ?? null : state.focusedId;
			update({ panes, focusedId, sizes: equalSizes(panes) });
		},
		followRoute: (session) => {
			const state = get();
			if (!state.panes.length) return;
			const matching = state.panes.find((pane) => sameSession(pane, session));
			const focused = state.panes.find((pane) => pane.id === state.focusedId);
			if (focused && sameSession(focused, session)) return;
			if (matching) { get().focus(matching.id); return; }
			const panes = state.panes.map((pane) => pane.id === state.focusedId ? { ...pane, ...session, projectId: session.projectId } : pane);
			update({ panes, focusedId: state.focusedId, sizes: state.sizes });
		},
		resize: (sizes) => {
			const state = get();
			if (Object.keys(sizes).length !== state.panes.length || !state.panes.every((pane) => Number.isFinite(sizes[pane.id]) && sizes[pane.id] > 0) ||
				Math.abs(Object.values(sizes).reduce((sum, size) => sum + size, 0) - 100) > 0.1) return;
			update({ panes: state.panes, focusedId: state.focusedId, sizes });
		},
	};
});
