import { useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MulticaViewState } from "../../shared/multica";
import { aoBridge } from "../lib/bridge";
import { useNavigateToSession } from "../lib/navigate-to-session";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";
import { CenterPanelShell } from "./CenterPanelShell";
import { MulticaSendToAoDialog } from "./MulticaSendToAoDialog";
import { MulticaStatusPublisher } from "./MulticaStatusPublisher";
import { Button } from "./ui/button";

function MulticaMessage({ title, body, detail, action }: { title: ReactNode; body?: string; detail?: string; action?: ReactNode }) {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
			<p className="text-sm font-medium text-foreground">{title}</p>
			{body ? <p className="max-w-[420px] text-xs leading-relaxed text-muted-foreground">{body}</p> : null}
			{detail ? <p className="max-w-[420px] break-words font-mono text-2xs text-muted-foreground">{detail}</p> : null}
			{action}
		</div>
	);
}

function MulticaSurface({ view }: { view: MulticaViewState }) {
	const { t } = useTranslation();

	return (
		<div className="absolute inset-0 z-10" data-testid="multica-pane">
			<CenterPanelShell titlebarAlign={false}>
				<div className="relative h-full w-full">
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
							detail={view.error}
							title={t("multica.error.title")}
						/>
					) : null}
				</div>
			</CenterPanelShell>
		</div>
	);
}

/**
 * Status surface for the embedded Multica desktop view. When the view is ready
 * it covers the whole window natively and this renders underneath it; while it
 * is loading, unconfigured or failed it shows here instead. AO's own routes stay
 * mounted, so switching is a show/hide: neither side is reloaded or reset.
 */
export function MulticaPane() {
	const view = useMulticaStore((state) => state.view);
	const load = useMulticaStore((state) => state.load);
	const toggle = useMulticaStore((state) => state.toggle);
	const navigateToSession = useNavigateToSession();
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => aoBridge.multica.onToggleShortcut(toggle), [toggle]);
	useEffect(() => aoBridge.multicaLinks.onOpenSession((target) => navigateToSession(target.projectId, target.sessionId)), [navigateToSession]);

	// Choosing something inside AO (a project or session in the sidebar) means the
	// user wants AO back.
	const previousPathname = useRef(pathname);
	useEffect(() => {
		if (previousPathname.current === pathname) return;
		previousPathname.current = pathname;
		const store = useMulticaStore.getState();
		if (store.view.active) store.setActive(false);
	}, [pathname]);

	return (
		<>
			<MulticaSendToAoDialog />
			<MulticaStatusPublisher />
			{view.active ? <MulticaSurface view={view} /> : null}
		</>
	);
}
