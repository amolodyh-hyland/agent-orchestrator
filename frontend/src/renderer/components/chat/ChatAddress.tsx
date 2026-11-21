import { ChatFindEngagedContext } from "./ChatFindUserProjection";
import { useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addressFilePath, addressName, type AddressDisplay, type ChatAddressKind } from "../../lib/chat-address";
import { requestLinkPreview, useCachedLinkPreview } from "../../hooks/useLinkPreview";
import { useUiStore } from "../../stores/ui-store";
import { AppLink } from "../AppLink";
import { ChatPathMenu } from "../ChatPathMenu";
import { ContextMenuItem, ContextMenuSeparator } from "../ui/context-menu";

export function ChatAddress({ target, kind, composer = false, onEdit, onBrowserOpen, onFileOpen, children, markdownFindContent }: {
	target: string;
	kind: ChatAddressKind;
	composer?: boolean;
	onEdit?: () => void;
	onBrowserOpen?: (url: string) => void;
	onFileOpen?: () => void;
	children?: ReactNode;
	markdownFindContent?: ReactNode;
}) {
	const { t } = useTranslation();
	const defaultDisplay = useUiStore((state) => kind === "url" ? state.chatUrlDisplay : state.chatPathDisplay);
	const [override, setOverride] = useState<AddressDisplay>();
	const [status, setStatus] = useState<"pending" | "error" | "empty">();
	const preview = useCachedLinkPreview(kind === "url" ? target : "");
	const finding = useContext(ChatFindEngagedContext);
	const mode = finding && !composer ? "full" : override ?? defaultDisplay;
	const filePath = kind === "path" ? addressFilePath(target) : undefined;
	const openPath = filePath !== undefined ? onFileOpen : undefined;
	const title = preview?.title?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 200);
	const label = mode === "compact" ? title || addressName(target, kind) : target;
	const menuItems = <>
		<ContextMenuSeparator />
		<ContextMenuItem onSelect={() => setOverride("full")}>{t("chat.address.full")}</ContextMenuItem>
		<ContextMenuItem onSelect={() => setOverride("compact")}>{t(kind === "url" ? "chat.address.title" : "chat.address.name")}</ContextMenuItem>
		<ContextMenuItem onSelect={() => setOverride(undefined)}>{t("chat.address.default")}</ContextMenuItem>
		{kind === "url" && <ContextMenuItem disabled={status === "pending"} onSelect={() => {
			setStatus("pending");
			void requestLinkPreview(target).then((result) => {
				setOverride("compact");
				setStatus(result.title?.trim() ? undefined : "empty");
			}, () => setStatus("error"));
		}}>{t(status === "pending" ? "chat.address.fetching" : "chat.address.fetchTitle")}</ContextMenuItem>}
		{onEdit && <ContextMenuItem onSelect={onEdit}>{t("chat.address.edit")}</ContextMenuItem>}
	</>;
	const contents = <span className="[unicode-bidi:plaintext]">{(finding && !composer ? markdownFindContent : undefined) ?? children ?? label}</span>;
	const className = "rounded-sm text-markdown-link underline decoration-markdown-link/45 underline-offset-2 hover:text-markdown-link-hover focus-visible:outline focus-visible:outline-ring";
	const notice = status === "error" || status === "empty" ? <span role="status" data-chat-find-exclude="" className="ml-1 text-xs text-muted-foreground">{t(status === "error" ? "chat.address.failed" : "chat.address.noTitle")}</span> : null;
	return <span data-chat-address={kind} data-target={target} data-composer-token={composer ? `address-${kind}` : undefined} contentEditable={composer ? false : undefined}>
		{kind === "url" ? <AppLink href={target} title={target} aria-label={target} className={className} previewEnabled={false} menuItems={menuItems} onBrowserOpen={onBrowserOpen} onMouseDown={composer ? (event) => event.preventDefault() : undefined} onClick={composer ? (event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); onEdit?.(); } } : undefined}>{contents}</AppLink> :
			<ChatPathMenu path={filePath ?? target} onFileOpen={filePath ? onFileOpen : undefined} menuItems={menuItems} copyText={target} nativeActions={filePath !== undefined}>
				<span tabIndex={0} role="button" title={target} aria-label={target} className={className} onMouseDown={composer ? (event) => event.preventDefault() : undefined} aria-haspopup={!openPath ? "menu" : undefined} onClick={composer ? onEdit : openPath ?? ((event) => { const rect = event.currentTarget.getBoundingClientRect(); event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom })); })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (composer ? onEdit : openPath)?.(); } }}>{contents}</span>
			</ChatPathMenu>}
		{notice}
	</span>;
}
