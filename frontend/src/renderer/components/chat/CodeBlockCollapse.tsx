import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

const CODE_MAX_HEIGHT = 160;

export function CodeBlockCollapse({ body, source }: { body: HTMLElement | null; source: string }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [overflow, setOverflow] = useState(false);
	useLayoutEffect(() => {
		if (!body) return;
		const measure = () => setOverflow(body.scrollHeight > CODE_MAX_HEIGHT);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, [body, source]);
	useLayoutEffect(() => {
		if (body) body.style.maxHeight = expanded ? "none" : `${CODE_MAX_HEIGHT}px`;
	}, [body, expanded]);
	if (!overflow) return null;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			aria-expanded={expanded}
			aria-controls={body?.id}
			onKeyDown={(event) => event.stopPropagation()}
			onClick={() => setExpanded(!expanded)}
			className="m-1 h-7 rounded-none text-xs text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
		>
			{expanded ? t("chat.composer.showLessCode") : t("chat.composer.showMoreCode")}
		</Button>
	);
}
