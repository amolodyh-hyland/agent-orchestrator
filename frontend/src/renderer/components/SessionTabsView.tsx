import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { groupContaining, layoutCss, leafKeys, setRatioAt } from "../lib/pane-split";
import { sessionNavigateTarget } from "../lib/navigate-to-session";
import { useSplitPanesEnabled } from "../lib/split-panes";
import { focusSessionTab, sessionTabFromKey, sessionTabKey, sessionTabPaneScope } from "../lib/session-tab-panes";
import { useSessionSplitGroups, useSplitPanesStore } from "../stores/split-panes-store";
import type { SessionTabSelection } from "../stores/tab-selection-store";
import { SplitDivider } from "./SplitView";
import { confirmPaneRemoval, SessionPaneContext } from "./session-pane-context";
import { SessionTopbarProvider } from "./SessionTopbarPortal";

export function SessionTabsView({ sessionId, projectId, cloudOrgId, View }: SessionTabSelection & {
	cloudOrgId?: string;
	View: ComponentType<SessionTabSelection & { cloudOrgId?: string }>;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const enabled = useSplitPanesEnabled();
	const scope = sessionTabPaneScope();
	const groups = useSessionSplitGroups(scope);
	const routeKey = sessionTabKey({ sessionId, projectId });
	const storedGroup = groupContaining(groups, routeKey);
	const group = enabled ? storedGroup : undefined;
	const keys = storedGroup ? leafKeys(storedGroup.root) : [routeKey];
	const focused = group?.focus && keys.includes(group.focus) ? group.focus : routeKey;
	const [autoFocusKey, setAutoFocusKey] = useState<string | null>(routeKey);
	const screenRef = useRef<HTMLDivElement>(null);
	const previousRoute = useRef(routeKey);
	const passiveRoute = useRef<string | null>(null);
	const layout = group ? layoutCss(group.root) : undefined;
	useEffect(() => {
		focusSessionTab({ sessionId, projectId });
		if (previousRoute.current !== routeKey) {
			if (passiveRoute.current !== routeKey) setAutoFocusKey(routeKey);
			previousRoute.current = routeKey;
			passiveRoute.current = null;
		}
	}, [routeKey]);
	const activate = useCallback((tab: SessionTabSelection, requestAutoFocus = true) => {
		const key = sessionTabKey(tab);
		if (!requestAutoFocus) passiveRoute.current = key;
		focusSessionTab(tab);
		setAutoFocusKey(requestAutoFocus ? sessionTabKey(tab) : null);
		if (!requestAutoFocus && key !== routeKey) void navigate(sessionNavigateTarget(tab.projectId, tab.sessionId));
	}, [navigate, routeKey]);
	useEffect(() => {
		const screen = screenRef.current;
		if (!screen) return;
		// Cached terminals are portals outside this React tree, but their DOM is inside the pane.
		const focusFromDOM = (event: Event) => {
			if (!(event.target instanceof Element)) return;
			if (event instanceof KeyboardEvent && !event.target.closest("[data-terminal-cache-key]")) return;
			if (event instanceof PointerEvent && (event.metaKey || event.ctrlKey) && event.target.closest('[role="tab"]')) {
				event.preventDefault();
				return;
			}
			const pane = event.target.closest<HTMLElement>("[data-session-pane]");
			if (!pane || pane.hidden || pane.inert) return;
			const tab = sessionTabFromKey(pane.dataset.sessionPane!);
			if (tab) activate(tab, false);
		};
		screen.addEventListener("pointerdown", focusFromDOM, true);
		screen.addEventListener("focusin", focusFromDOM, true);
		screen.addEventListener("keydown", focusFromDOM, true);
		return () => {
			screen.removeEventListener("pointerdown", focusFromDOM, true);
			screen.removeEventListener("focusin", focusFromDOM, true);
			screen.removeEventListener("keydown", focusFromDOM, true);
		};
	}, [activate]);
	const close = async (key: string) => {
		if (!group || !await confirmPaneRemoval(new Set(keys.filter((candidate) => candidate !== key)))) return;
		const target = sessionTabFromKey(focused === key ? keys.find((candidate) => candidate !== key)! : focused);
		if (!target) return;
		await navigate(sessionNavigateTarget(target.projectId, target.sessionId));
		useSplitPanesStore.getState().removeTab(scope, key);
	};
	return <div className="relative h-full min-h-0 min-w-0 overflow-x-auto" data-testid={group ? "session-panes" : undefined}>
		<div className="relative h-full" ref={screenRef} style={{ ...layout?.vars, minWidth: (group ? keys.length : 1) * 320 } as CSSProperties}>
			{keys.map((key, index) => {
				const tab = sessionTabFromKey(key);
				if (!tab) return null;
				return <SessionPaneContext.Provider key={key} value={{ id: key, ...tab, focused: key === focused, autoFocus: key === autoFocusKey, visible: Boolean(group) || key === routeKey, split: Boolean(group), focus: () => { if (group || key === routeKey) activate(tab, false); }, activate, close: group ? () => void close(key) : undefined }}>
					<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-session-pane={key} data-session-id={tab.sessionId} data-project-id={tab.projectId} data-focused={key === focused}
						hidden={!group && key !== routeKey} inert={!group && key !== routeKey ? true : undefined}
						style={layout ? { position: "absolute", ...layout.leaves.get(key) } : { height: "100%" }}>
						{group ? <div className="flex h-toolbar shrink-0 items-center justify-between border-b-2 px-2 text-xs text-passive" style={{ borderColor: key === focused ? "var(--color-primary)" : "transparent", paddingRight: index === keys.length - 1 ? "max(8px, var(--topbar-trailing-width, 8px))" : undefined }}>
							<span className="truncate">{tab.sessionId}</span>
							<button type="button" className="inline-flex size-6 items-center justify-center hover:bg-interactive-hover" aria-label={t("splitPane.closePane", { name: tab.sessionId })} onClick={() => void close(key)}><X aria-hidden="true" className="size-3.5" /></button>
						</div> : null}
						<div className="min-h-0 flex-1"><SessionTopbarProvider><View {...tab} cloudOrgId={cloudOrgId} /></SessionTopbarProvider></div>
					</section>
				</SessionPaneContext.Provider>;
			})}
			{layout?.dividers.map((divider) => <SplitDivider key={divider.path} screenRef={screenRef} divider={divider} onResize={(path, ratio) => {
				if (group) useSplitPanesStore.getState().updateGroups(scope, (current) => current.map((candidate) => candidate.id === group.id ? { ...candidate, root: setRatioAt(candidate.root, path, ratio) } : candidate));
			}} />)}
		</div>
	</div>;
}
