import { forwardRef, useImperativeHandle, useLayoutEffect } from "react";
import type { DictationError } from "../../../shared/dictation";
import { Loader2, Mic, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDictation } from "../../hooks/useDictation";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

export type DictationControlHandle = { isActive(): boolean; cancel(): void };

export const DictationControls = forwardRef<DictationControlHandle, {
	disabled: boolean;
	scope: string;
	locale: string;
	onTranscript: (text: string) => void;
	onActiveChange: (active: boolean) => void;
	onError: (error: DictationError | undefined) => void;
}>(function DictationControls({ disabled, scope, locale, onTranscript, onActiveChange, onError }, ref) {
	const { t } = useTranslation();
	const dictation = useDictation({ disabled, scope, locale, onTranscript });
	useImperativeHandle(ref, () => ({ isActive: dictation.isActive, cancel: dictation.cancel }));
	useLayoutEffect(() => { onActiveChange(dictation.active); }, [dictation.active, onActiveChange]);
	useLayoutEffect(() => { onError(dictation.error); }, [dictation.error, onError]);
	useLayoutEffect(() => () => onActiveChange(false), [onActiveChange]);
	const { phase, availability, active } = dictation;
	const label = t(phase === "recording" ? "chat.dictation.stop" : phase === "starting" ? "chat.dictation.starting" : phase === "stopping" ? "chat.dictation.stopping" : "chat.dictation.start");
	const unavailable = !availability.available ? t(`chat.dictation.error.${availability.error}`) : undefined;
	return <>
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex" tabIndex={unavailable ? 0 : undefined} aria-label={unavailable}>
					<Button type="button" variant="ghost" size="icon-sm"
						aria-label={label} aria-pressed={active}
						disabled={disabled || !availability.available || phase === "starting" || phase === "stopping"}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => void (phase === "recording" ? dictation.stop() : dictation.start())}
						className={cn("size-7 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-interactive-active! hover:text-foreground", active && "text-destructive")}
					>
						{phase === "starting" || phase === "stopping" ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : phase === "recording" ? <Square aria-hidden="true" className="size-3 fill-current" /> : <Mic aria-hidden="true" className="size-3.5" />}
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
		{active ? <span role="status" className="truncate text-xs text-muted-foreground">{t(phase === "recording" ? "chat.dictation.recording" : phase === "starting" ? "chat.dictation.starting" : "chat.dictation.stopping")}</span> : null}
	</>;
});
