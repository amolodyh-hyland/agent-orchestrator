import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBrowserView } from "../hooks/useBrowserView";
import { useHostConnection } from "../hooks/useHostConnection";
import { sessionBrowserUnavailable } from "../lib/artifact-preview";
import { sessionUiKey } from "../lib/hosts";
import type { WorkspaceSession } from "../types/workspace";
import { useNavigateToSession } from "../lib/navigate-to-session";
import { useSessionLinkSource } from "../lib/use-session-link-navigation";
import type { SessionPanePreviewTarget } from "../lib/session-pane-preview";
import { BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { SessionArtifactsView } from "./SessionArtifactsView";
import { SessionBrowserPopOut } from "./SessionBrowserPopOut";
import { AppBrowserLinkContext } from "./AppLink";
import { Button } from "./ui/button";

export function SessionPanePreview({ target, active, onClose }: { target: SessionPanePreviewTarget; active: boolean; onClose: () => void }) {
	const { t } = useTranslation();
	const source = useSessionLinkSource(target.hostId, target.sourceKind);
	const session = source.workspaces.find((workspace) => workspace.id === target.projectId)?.sessions.find((candidate) => candidate.id === target.sessionId);
	const navigate = useNavigateToSession();
	const [browserUrl, setBrowserUrl] = useState<string>();
	const artifactRequest = useMemo(() => target.path ? { key: 1, path: target.path } : undefined, [target.path]);
	return <section className="flex h-full min-h-0 flex-col" aria-label={t("sessionPane.preview")}>
		<div className="session-inspector__trailing flex h-inspector-tabs shrink-0 items-center gap-2 border-b px-3">
			<span className="min-w-0 flex-1 truncate text-xs" title={target.sessionId}>{session?.title || target.sessionId}</span>
			{target.path && browserUrl ? <Button size="sm" variant="quiet" onClick={() => setBrowserUrl(undefined)}>{t("inspector.artifacts", { count: session?.artifactFiles?.length ?? 0 })}</Button> : null}
			<Button size="sm" variant="quiet" onClick={() => navigate(target.projectId, target.sessionId, target.hostId)}>{t("sessionPane.goToSession")}</Button>
			<Button size="icon-sm" variant="quiet" aria-label={t("sessionPane.closePreview")} onClick={onClose}><X className="size-4" /></Button>
		</div>
		<div className="min-h-0 flex-1">
			{!session ? <p role="status" className="p-4 text-xs text-muted-foreground">{t(source.isLoading ? "session.statusChecking" : "session.notFound")}</p>
				: target.path && !browserUrl ? <AppBrowserLinkContext.Provider value={setBrowserUrl}><SessionArtifactsView key={sessionUiKey(session.id, target.hostId)} session={session} hostId={target.hostId} request={artifactRequest} /></AppBrowserLinkContext.Provider>
					: <OwnerBrowser session={session} hostId={target.hostId} active={active} url={browserUrl} />}
		</div>
	</section>;
}

function OwnerBrowser({ session, hostId, active, url }: { session: WorkspaceSession; hostId?: string; active: boolean; url?: string }) {
	const [poppedOut, setPoppedOut] = useState(false);
	const [topbarHost, setTopbarHost] = useState<HTMLDivElement | null>(null);
	const { baseUrl } = useHostConnection(hostId);
	const browser = useBrowserView({
		sessionId: sessionUiKey(session.id, hostId),
		origin: hostId ? { hostId, sessionId: session.id, proxyBase: baseUrl ?? "" } : undefined,
		active,
		poppedOut,
		terminated: Boolean(session.cloud) || sessionBrowserUnavailable(session, hostId),
		sessionEnded: session.isTerminated,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
	});
	const annotations = useBrowserAnnotationQueue({ sessionId: session.id, hostId, sourcePreviewUrl: session.previewUrl, navUrl: browser.navState.url });
	useEffect(() => {
		if (url) void browser.openLink(url);
	}, [url, browser.openLink]);
	const panel = <BrowserPanelView active={active} annotationQueue={annotations} browserView={browser} poppedOut={poppedOut} onTogglePopOut={setPoppedOut} session={session} topbarHost={poppedOut ? topbarHost : undefined} />;
	return poppedOut ? createPortal(<SessionBrowserPopOut phase="open" onClose={() => setPoppedOut(false)} onTopbarHost={setTopbarHost}>{panel}</SessionBrowserPopOut>, document.body) : panel;
}
