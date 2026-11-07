import { createContext, useContext } from "react";
import type { SessionTabSelection } from "../stores/tab-selection-store";

export const SessionPaneContext = createContext<{
	id: string;
	sessionId?: string;
	projectId?: string;
	focused: boolean;
	autoFocus?: boolean;
	visible?: boolean;
	split?: boolean;
	focus?: () => void;
	activate?: (tab: SessionTabSelection) => void;
	close?: () => void;
} | null>(null);

export function useSessionPaneFocused(): boolean {
	return useContext(SessionPaneContext)?.focused ?? true;
}

export function useSessionPaneAutoFocus(): boolean {
	const pane = useContext(SessionPaneContext);
	return pane ? pane.focused && (pane.autoFocus ?? true) : true;
}

export function focusedSessionRoot(): ParentNode {
	return document.querySelector('[data-session-pane][data-focused="true"]') ?? document;
}

const closeGuards = new Map<string, () => Promise<boolean>>();
export function registerPaneCloseGuard(id: string, guard: () => Promise<boolean>): () => void {
	closeGuards.set(id, guard);
	return () => { if (closeGuards.get(id) === guard) closeGuards.delete(id); };
}

export async function confirmPaneRemoval(keep: ReadonlySet<string> = new Set()): Promise<boolean> {
	for (const [id, guard] of closeGuards) if (!keep.has(id) && !await guard()) return false;
	return true;
}

export function sessionPaneStaysMounted(id: string, pathname: string): boolean {
	const route = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/) ?? pathname.match(/^\/sessions\/([^/]+)$/);
	if (!route) return false;
	const projectId = route.length === 3 ? decodeURIComponent(route[1]) : undefined;
	const sessionId = decodeURIComponent(route[route.length - 1]);
	const panes = [...document.querySelectorAll<HTMLElement>("[data-session-pane]")];
	return panes.some((pane) => pane.dataset.sessionPane === id) && panes.some((pane) => pane.dataset.sessionId === sessionId && (pane.dataset.projectId || undefined) === projectId);
}
