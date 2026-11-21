import { useState } from "react";
import { useTranslation } from "react-i18next";
import { List, Loader2 } from "lucide-react";
import type { ConversationItem, ConversationMessage } from "../../types/conversation";
import { humanVisibleText } from "./messageAttachments";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export function ChatPrompts({ items, hasOlder, loadingOlder, onLoadOlder, onSelect }: {
	items: ConversationItem[];
	hasOlder?: boolean;
	loadingOlder?: boolean;
	onLoadOlder?: () => void;
	onSelect: (message: ConversationMessage) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [visibleCount, setVisibleCount] = useState(50);
	const prompts = items.filter((item): item is ConversationMessage => item.kind === "message" && item.role === "user" && (item.origin === "human" || item.authoredByUser === true) && !item.continuation).toReversed();
	return <Popover open={open} onOpenChange={setOpen}>
		<PopoverTrigger asChild><Button size="sm" variant="quiet"><List aria-hidden="true" />{t("chat.prompts.title")}</Button></PopoverTrigger>
		<PopoverContent align="end" className="w-80 p-1" aria-label={t("chat.prompts.title")}>
			<div className="max-h-72 overflow-y-auto" onKeyDown={(event) => {
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
				if (!buttons.length) return;
				const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
				const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
				event.preventDefault(); buttons[next].focus();
			}}>
				{prompts.length ? <ol>{prompts.slice(0, visibleCount).map((message) => <li key={message.id}><button type="button" title={humanVisibleText(message.text)} className="w-full rounded-sm px-2 py-2 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => { setOpen(false); onSelect(message); }}>
					<span className="line-clamp-2 whitespace-pre-wrap break-words">{humanVisibleText(message.text) || t("chat.prompts.attachment")}</span>
				</button></li>)}</ol> : <p role="status" className="p-3 text-xs text-muted-foreground">{t("chat.prompts.empty")}</p>}
				{prompts.length > visibleCount || hasOlder && onLoadOlder ? <Button className="w-full" size="sm" variant="quiet" disabled={loadingOlder} onClick={() => {
					setVisibleCount((count) => count + 50);
					if (prompts.length <= visibleCount) onLoadOlder?.();
				}}>{loadingOlder ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}{t("chat.prompts.older")}</Button> : null}
			</div>
		</PopoverContent>
	</Popover>;
}
