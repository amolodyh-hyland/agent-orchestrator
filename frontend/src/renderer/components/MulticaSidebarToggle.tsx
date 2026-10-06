import { ArrowLeftRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMulticaStore } from "../stores/multica-store";
import { NavRowHighlight } from "./NavRowHighlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// Class strings come from Sidebar.tsx's footer rows so these match their
// neighbors without importing back from the sidebar.
export function MulticaSidebarRow({ className, tabIndex }: { className: string; tabIndex?: number }) {
	const { t } = useTranslation();
	const active = useMulticaStore((state) => state.view.active);
	const toggle = useMulticaStore((state) => state.toggle);
	return (
		<button
			aria-label={t("multica.title")}
			aria-pressed={active}
			className={className}
			onClick={toggle}
			tabIndex={tabIndex}
			type="button"
		>
			<NavRowHighlight active={active} />
			<span className="relative z-[1] flex min-w-0 flex-1 items-center gap-2.5 [&_svg]:size-icon-md [&_svg]:shrink-0">
				<ArrowLeftRight aria-hidden="true" />
				<span className="tracking-tight">{t("multica.title")}</span>
			</span>
		</button>
	);
}

export function MulticaSidebarRailButton({ className, tabIndex }: { className: string; tabIndex?: number }) {
	const { t } = useTranslation();
	const active = useMulticaStore((state) => state.view.active);
	const toggle = useMulticaStore((state) => state.toggle);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={t("multica.title")}
					aria-pressed={active}
					className={className}
					onClick={toggle}
					tabIndex={tabIndex}
					type="button"
				>
					<NavRowHighlight active={active} />
					<span className="relative z-[1] grid place-items-center [&_svg]:size-icon-base">
						<ArrowLeftRight aria-hidden="true" />
					</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="right">{t("multica.title")}</TooltipContent>
		</Tooltip>
	);
}
