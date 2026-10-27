import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mic, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDictation } from "../../hooks/useDictation";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

// Chat tabs keep composers mounted under hidden/inert ancestors to preserve drafts.
// Observe those boundaries only during capture, and check again before inserting.
function controlsVisible(node: HTMLElement | null): boolean {
	if (!node?.isConnected) return false;
	for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
		if (ancestor.hidden || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true") return false;
		const style = getComputedStyle(ancestor);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
	}
	return true;
}

export type DictationControlHandle = { isActive(): boolean; cancel(): void };

export const DictationControls = forwardRef<DictationControlHandle, {
	disabled: boolean;
	scope: string;
	locale: string;
	onTranscript: (text: string) => void;
	onActiveChange: (active: boolean) => void;
	statusRef: RefObject<HTMLDivElement | null>;
}>(function DictationControls({ disabled, scope, locale, onTranscript, onActiveChange, statusRef }, ref) {
	const { t } = useTranslation();
	const control = useRef<HTMLSpanElement>(null);
	const [statusTarget, setStatusTarget] = useState<HTMLDivElement | null>(null);
	const dictation = useDictation({ disabled, scope, locale, onTranscript: (text) => {
		if (controlsVisible(control.current)) onTranscript(text);
	} });
	useLayoutEffect(() => { setStatusTarget(statusRef.current); }, [statusRef]);
	useImperativeHandle(ref, () => ({ isActive: dictation.isActive, cancel: dictation.cancel }));
	useLayoutEffect(() => { onActiveChange(dictation.active); }, [dictation.active, onActiveChange]);
	useLayoutEffect(() => () => { dictation.cancel(); onActiveChange(false); }, [dictation.cancel, onActiveChange]);
	useLayoutEffect(() => {
		if (!dictation.active) return;
		const check = () => { if (!controlsVisible(control.current)) dictation.cancel(); };
		const observer = new MutationObserver(check);
		for (let node = control.current; node; node = node.parentElement) {
			observer.observe(node, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "class", "style"] });
		}
		check();
		window.addEventListener("resize", check);
		return () => { observer.disconnect(); window.removeEventListener("resize", check); };
	}, [dictation.active, dictation.cancel]);
	const { phase, availability, active } = dictation;
	const label = t(phase === "recording" ? "chat.dictation.stop" : phase === "starting" ? "chat.dictation.starting" : (phase === "stopping" || phase === "finishing") ? "chat.dictation.stopping" : "chat.dictation.start");
	const unavailable = dictation.availabilityChecked && !availability.available ? t(`chat.dictation.error.${availability.error}`) : undefined;
	const recovery = dictation.error ?? (dictation.availabilityChecked && !availability.available ? availability.error : undefined);
	return <>
		{statusTarget ? createPortal(recovery ? <p role={dictation.error ? "alert" : "status"} aria-label={t("chat.dictation.start")} aria-live={dictation.error ? "assertive" : "polite"} aria-atomic="true" className="px-1.5 text-xs leading-snug text-destructive">{t(`chat.dictation.error.${recovery}`)}</p> : null, statusTarget) : null}
		<Tooltip>
			<TooltipTrigger asChild>
				<span ref={control} className="inline-flex" tabIndex={unavailable ? 0 : undefined} aria-label={unavailable}>
					<Button type="button" variant="ghost" size="icon-sm"
						aria-label={label} aria-pressed={active}
						disabled={disabled || !availability.available || phase === "starting" || phase === "stopping" || phase === "finishing"}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => { if (controlsVisible(control.current)) void (phase === "recording" ? dictation.stop() : dictation.start()); }}
						className={cn("size-7 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-interactive-active! hover:text-foreground", active && "text-destructive")}
					>
						{phase === "starting" || phase === "stopping" || phase === "finishing" ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : phase === "recording" ? <Square aria-hidden="true" className="size-3 fill-current" /> : <Mic aria-hidden="true" className="size-3.5" />}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom">{unavailable ?? label}</TooltipContent>
		</Tooltip>
		{active ? <Tooltip>
			<TooltipTrigger asChild>
				<Button type="button" variant="ghost" size="icon-sm" aria-label={t("chat.dictation.cancel")} onMouseDown={(event) => event.preventDefault()} onClick={dictation.cancel} className="size-7 shrink-0 rounded-full p-0 text-muted-foreground">
					<X aria-hidden="true" className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{t("chat.dictation.cancel")}</TooltipContent>
		</Tooltip> : null}
		{active ? <span role="status" className="truncate text-xs text-muted-foreground">{t(phase === "recording" || phase === "stopping" ? "chat.dictation.recording" : phase === "starting" ? "chat.dictation.starting" : "chat.dictation.stopping")}</span> : null}
	</>;
});
