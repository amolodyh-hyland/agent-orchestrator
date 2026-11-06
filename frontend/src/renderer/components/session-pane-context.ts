import { useSessionPanesStore } from "../stores/session-panes-store";
import { createContext, useContext } from "react";

export const SessionPaneContext = createContext<{ id: string; focused: boolean; sessionId?: string; projectId?: string; split?: boolean } | null>(null);

export function focusedSessionRoot(): ParentNode {
	return document.querySelector('[data-session-pane][data-focused="true"]') ?? document;
}

export function useSessionPaneFocused(): boolean {
	return useContext(SessionPaneContext)?.focused ?? true;
}

const closeGuards = new Map<string, () => Promise<boolean>>();

export function registerPaneCloseGuard(id: string, guard: () => Promise<boolean>): () => void {
	closeGuards.set(id, guard);
	return () => { if (closeGuards.get(id) === guard) closeGuards.delete(id); };
}

export async function confirmPaneRemoval(ids = [...closeGuards.keys()]): Promise<boolean> {
	for (const id of ids) {
		if (await closeGuards.get(id)?.() === false) return false;
	}
	return true;
}

export function sessionPaneStaysMounted(id: string, pathname: string): boolean {
	const { panes, focusedId } = useSessionPanesStore.getState();
	const route = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/) ?? pathname.match(/^\/sessions\/([^/]+)$/);
	if (!route || !panes.some((pane) => pane.id === id)) return false;
	const projectId = route.length === 3 ? decodeURIComponent(route[1]) : undefined;
	const sessionId = decodeURIComponent(route[route.length - 1]);
	return id !== focusedId || panes.some((pane) => pane.sessionId === sessionId && pane.projectId === projectId);
}
