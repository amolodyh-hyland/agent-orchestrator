import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { SessionPanePreviewContext } from "../lib/session-pane-preview";
import { parseSessionLink } from "../lib/session-links";
import { LOCAL_HOST } from "../lib/hosts";
import { useSessionLinkSource } from "../lib/use-session-link-navigation";
import { sessionBrowserUnavailable } from "../lib/artifact-preview";
import { ContextMenuItem } from "./ui/context-menu";
import { BrowserIcon } from "./icons";

export function SessionPanePreviewMenu({ href, hostId, sourceKind }: { href: string; hostId?: string; sourceKind?: "cloud" }) {
	const open = useContext(SessionPanePreviewContext);
	return open ? <ResolvedPreviewMenu href={href} hostId={hostId} sourceKind={sourceKind} open={open} /> : null;
}

function ResolvedPreviewMenu({ href, hostId, sourceKind, open }: { href: string; hostId?: string; sourceKind?: "cloud"; open: NonNullable<React.ContextType<typeof SessionPanePreviewContext>> }) {
	const { t } = useTranslation();
	const source = useSessionLinkSource(hostId, sourceKind);
	const target = parseSessionLink(href);
	const session = target && source.workspaces.find((workspace) => workspace.id === target.projectId)?.sessions.find((candidate) => candidate.id === target.sessionId);
	if (!source.ready || !target || !session?.previewUrl || session.cloud || sessionBrowserUnavailable(session, hostId)) return null;
	return <ContextMenuItem onSelect={() => open({ ...target, hostId: hostId && hostId !== LOCAL_HOST ? hostId : undefined })}><BrowserIcon aria-hidden="true" />{t("sessionPane.openHere")}</ContextMenuItem>;
}
