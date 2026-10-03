import { useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MulticaViewState } from "../../shared/multica";
import { aoBridge } from "../lib/bridge";
import { BROWSER_OVERLAY_CANDIDATE_SELECTOR, OPEN_BROWSER_OVERLAY_SELECTOR } from "../lib/dom-selectors";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";
import { CenterPanelShell } from "./CenterPanelShell";
import { Button } from "./ui/button";

let boundsRevision = 0;

function MulticaMessage({ title, body, action }: { title: ReactNode; body?: string; action?: ReactNode }) {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
			<p className="text-sm font-medium text-foreground">{title}</p>
			{body ? <p className="max-w-[420px] text-xs leading-relaxed text-muted-foreground">{body}</p> : null}
			{action}
		</div>
	);
}

function MulticaSurface({ view }: { view: MulticaViewState }) {
	const { t } = useTranslation();
	const slotRef = useRef<HTMLDivElement>(null);
	const live = view.status === "ready";

	// The Multica page is a native view stacked over this slot, so the slot only
	// reports its geometry; the main process decides when the view is shown.
	useLayoutEffect(() => {
		const slot = slotRef.current;
		if (!slot) return;
		const send = () => {
			const { x, y, width, height } = slot.getBoundingClientRect();
			aoBridge.multica.setBounds({ revision: ++boundsRevision, rect: { x, y, width, height } });
		};
		send();
		const observer = new ResizeObserver(send);
		observer.observe(slot);
		window.addEventListener("resize", send);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", send);
			aoBridge.multica.setBounds({ revision: ++boundsRevision, rect: null });
		};
	}, []);

	// Native pixels sit above the renderer, so dialogs opened over a live page
	// must raise the shell; mirrors the Browser panel (useBrowserView.ts).
	useEffect(() => {
		if (!live) return;
		let open = false;
		const update = () => {
			const next = document.querySelector(OPEN_BROWSER_OVERLAY_SELECTOR) !== null;
			if (next === open) return;
			open = next;
			aoBridge.browser.setOverlayOpen(next);
		};
		const containsOverlayCandidate = (node: Node): boolean =>
			node instanceof Element &&
			(node.matches(BROWSER_OVERLAY_CANDIDATE_SELECTOR) ||
				node.querySelector(BROWSER_OVERLAY_CANDIDATE_SELECTOR) !== null);
		update();
		const observer = new MutationObserver((mutations) => {
			const changed = mutations.some((mutation) => {
				if (mutation.type === "attributes") return containsOverlayCandidate(mutation.target);
				return [...mutation.addedNodes, ...mutation.removedNodes].some(containsOverlayCandidate);
			});
			if (changed) update();
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state"],
		});
		return () => {
			observer.disconnect();
			if (open) aoBridge.browser.setOverlayOpen(false);
		};
	}, [live]);

	return (
		<div className="absolute inset-0 z-10" data-testid="multica-pane">
			<CenterPanelShell titlebarAlign={false}>
				<div className="relative h-full w-full" data-multica-native-page={live ? "live" : undefined} ref={slotRef}>
					{view.status === "unconfigured" ? (
						<MulticaMessage
							action={
								<Button onClick={() => useUiStore.getState().openGlobalSettings("general")} size="sm" variant="secondary">
									{t("multica.empty.openSettings")}
								</Button>
							}
							body={t("multica.empty.body")}
							title={t("multica.empty.title")}
						/>
					) : null}
					{view.status === "idle" || view.status === "loading" ? (
						<MulticaMessage
							title={
								<span className="inline-flex items-center gap-2">
									<Loader2 aria-hidden="true" className="size-icon-sm animate-spin text-muted-foreground" />
									{t("multica.loading")}
								</span>
							}
						/>
					) : null}
					{view.status === "error" ? (
						<MulticaMessage
							action={
								<Button onClick={() => useMulticaStore.getState().reload()} size="sm" variant="secondary">
									{t("multica.error.retry")}
								</Button>
							}
							body={t("multica.error.body", { url: view.url })}
							title={t("multica.error.title")}
						/>
					) : null}
				</div>
			</CenterPanelShell>
		</div>
	);
}

/**
 * Hosts the embedded Multica view over the shell's center panel. AO's own
 * routes stay mounted underneath, so switching is a show/hide: neither side is
 * reloaded or reset.
 */
export function MulticaPane() {
	const view = useMulticaStore((state) => state.view);
	const load = useMulticaStore((state) => state.load);
	const toggle = useMulticaStore((state) => state.toggle);
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => aoBridge.multica.onToggleShortcut(toggle), [toggle]);

	// Choosing something inside AO (a project or session in the sidebar) means the
	// user wants AO back.
	const previousPathname = useRef(pathname);
	useEffect(() => {
		if (previousPathname.current === pathname) return;
		previousPathname.current = pathname;
		const store = useMulticaStore.getState();
		if (store.view.active) store.setActive(false);
	}, [pathname]);

	return view.active ? <MulticaSurface view={view} /> : null;
}
