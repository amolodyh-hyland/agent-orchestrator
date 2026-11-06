import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { sessionNavigateTarget } from "../lib/navigate-to-session";
import { loadSessionView } from "../lib/session-view-chunk";
import { MIN_SESSION_PANE_WIDTH, useSessionPanesStore, type PaneSession, type SessionPane } from "../stores/session-panes-store";
import { cn } from "../lib/utils";
import { confirmPaneRemoval, SessionPaneContext } from "./session-pane-context";
import { SessionTopbarProvider } from "./SessionTopbarPortal";
import { TerminalCacheProvider } from "./TerminalPane";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

const SessionView = lazy(() => loadSessionView().then((module) => ({ default: module.SessionView })));

export function SessionPanes({ session, cloudOrgId, children }: { session: PaneSession; cloudOrgId?: string; children: ReactNode }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const panes = useSessionPanesStore((state) => state.panes);
	const focusedId = useSessionPanesStore((state) => state.focusedId);
	const autoFocusId = useSessionPanesStore((state) => state.autoFocusId);
	const sizes = useSessionPanesStore((state) => state.sizes);
	useEffect(() => {
		useSessionPanesStore.getState().followRoute(session);
	}, [session.sessionId, session.projectId]);
	const focus = (pane: SessionPane) => {
		const alreadyFocused = useSessionPanesStore.getState().focusedId === pane.id;
		useSessionPanesStore.getState().focus(pane.id, false);
		if (alreadyFocused) return;
		void navigate(sessionNavigateTarget(pane.projectId, pane.sessionId));
	};
	const close = async (id: string) => {
		if (!await confirmPaneRemoval([id])) return;
		useSessionPanesStore.getState().close(id);
		const state = useSessionPanesStore.getState();
		const pane = state.panes.find((candidate) => candidate.id === state.focusedId);
		if (pane) void navigate(sessionNavigateTarget(pane.projectId, pane.sessionId));
	};
	if (panes.length === 0) return children;
	return (
		<div className="h-full min-h-0 min-w-0 overflow-x-auto" data-testid={panes.length > 1 ? "session-panes" : undefined}>
			<ResizablePanelGroup
				defaultLayout={sizes}
				onLayoutChanged={(layout) => useSessionPanesStore.getState().resize(layout)}
				orientation="horizontal"
				style={{ minWidth: panes.length * MIN_SESSION_PANE_WIDTH + panes.length - 1 }}
			>
				{panes.map((pane, index) => (
					<Fragment key={pane.id}>
						{index > 0 ? <ResizableHandle aria-label={t("shell.panes.resize")} withHandle /> : null}
						<ResizablePanel id={pane.id} minSize={`${MIN_SESSION_PANE_WIDTH}px`} defaultSize={`${100 / panes.length}%`}>
							<SessionPaneContext.Provider value={{ id: pane.id, focused: pane.id === focusedId, autoFocus: pane.id === autoFocusId, sessionId: pane.sessionId, projectId: pane.projectId, split: panes.length > 1, focus: () => focus(pane) }}>
								<section
									aria-label={t("shell.panes.session", { session: pane.sessionId })}
									className={cn("flex h-full min-h-0 flex-col border-t-2", panes.length > 1 && (pane.id === focusedId ? "border-primary" : "border-transparent"), panes.length === 1 && "border-t-0")}
									data-session-pane={pane.id}
									data-session-id={pane.sessionId}
									data-focused={pane.id === focusedId}
									onPointerDownCapture={() => focus(pane)}
									onFocusCapture={() => focus(pane)}
								>
									{panes.length > 1 ? <div className="flex h-toolbar shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-xs text-passive" style={index === panes.length - 1 ? { paddingRight: "max(8px, var(--topbar-trailing-width, 8px))" } : undefined}>
										<span className="truncate">{pane.sessionId}</span>
										<button aria-label={t("shell.panes.close")} title={t("shell.panes.close")} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-interactive-hover hover:text-foreground" onClick={() => close(pane.id)} type="button"><X aria-hidden="true" className="size-3.5" /></button>
									</div> : null}
									<div className="min-h-0 flex-1">
										<SessionTopbarProvider>
											<TerminalCacheProvider>
												<Suspense fallback={null}><SessionView sessionId={pane.sessionId} projectId={pane.projectId} cloudOrgId={cloudOrgId} /></Suspense>
											</TerminalCacheProvider>
										</SessionTopbarProvider>
									</div>
								</section>
							</SessionPaneContext.Provider>
						</ResizablePanel>
					</Fragment>
				))}
			</ResizablePanelGroup>
		</div>
	);
}
