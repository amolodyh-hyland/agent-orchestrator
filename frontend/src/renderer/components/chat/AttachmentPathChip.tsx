import { createContext, useContext, type ReactElement } from "react";
import { Copy, FolderOpen, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../../lib/bridge";
import { isMacPlatform, isWindowsPlatform } from "../../lib/platform";
import { useUiStore } from "../../stores/ui-store";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import { composerFileIcon } from "./composerFileIcon";
import { attachmentName } from "./messageAttachments";

export type AttachmentPathActions = {
	sessionId?: string;
	remoteHost?: boolean;
	hostId?: string;
	onOpenFile?: (path: string) => void;
};

export const AttachmentPathContext = createContext<AttachmentPathActions>({});

export function AttachmentPathMenu({ path, folder, children, actions }: {
	path: string;
	folder?: boolean;
	children: ReactElement;
	actions?: AttachmentPathActions;
}) {
	const context = useContext(AttachmentPathContext);
	const { sessionId, remoteHost, hostId, onOpenFile } = actions ?? context;
	const { t } = useTranslation();
	const showGlobalToast = useUiStore((state) => state.showGlobalToast);
	const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
	const run = (action: () => Promise<unknown>) => {
		void action().catch(() => showGlobalToast(t("chat.path.actionFailed"), undefined, "error"));
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild onKeyDownCapture={(event) => {
				if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
				event.preventDefault();
				event.stopPropagation();
				const rect = event.currentTarget.getBoundingClientRect();
				event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
			}}>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				{!remoteHost && (absolute || sessionId) ? (
					<ContextMenuItem onSelect={() => run(() => aoBridge.chatAttachment.path({ path, sessionId, action: "reveal" }))}>
						<FolderOpen aria-hidden="true" />
						{t(isMacPlatform() ? "chat.path.revealMac" : isWindowsPlatform() ? "chat.path.revealWindows" : "chat.path.reveal")}
					</ContextMenuItem>
				) : null}
				{onOpenFile && (!folder || (sessionId && (!remoteHost || hostId))) ? (
					<ContextMenuItem onSelect={() => {
						if (sessionId && (!remoteHost || hostId)) useUiStore.getState().requestWorkspaceFileOpen(sessionId, path, hostId, "panel", folder);
						else onOpenFile(path);
					}}>
						<PanelRight aria-hidden="true" />{t("chat.path.openSidePanel")}
					</ContextMenuItem>
				) : null}
				<ContextMenuItem disabled={!absolute && (!sessionId || remoteHost)} onSelect={() => run(async () => {
					const fullPath = absolute ? path : await aoBridge.chatAttachment.path({ path, sessionId, action: "resolve" });
					await aoBridge.clipboard.writeText(fullPath);
				})}>
					<Copy aria-hidden="true" />{t("chat.path.copy")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function AttachmentPathChip({ path, display, folder, actions, composer = false }: {
	path: string;
	display?: string;
	folder?: boolean;
	actions?: AttachmentPathActions;
	composer?: boolean;
}) {
	const Icon = folder ? FolderOpen : composerFileIcon(path);
	return (
		<AttachmentPathMenu path={path} folder={folder} actions={actions}>
			<span
				tabIndex={0}
				role="button"
				aria-label={path}
				data-composer-token={composer ? "file" : undefined}
				data-value={path}
				contentEditable={false}
				title={path}
				className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-border-strong bg-interactive-hover px-1.5 py-0.5 align-middle text-[0.9em] leading-none text-foreground select-none focus-visible:outline focus-visible:outline-ring"
			>
				<Icon aria-hidden="true" className="size-3 shrink-0" />
				<span className="truncate">{display ?? attachmentName(path)}</span>
			</span>
		</AttachmentPathMenu>
	);
}
