import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { TopbarTabs } from "./TopbarTabs";
import type { TopbarTabsProps } from "./TopbarTabs";
import type { SessionTabActions } from "./TopbarTab";

export type TopbarToolbarProps = {
	actions: ReactNode;
	subTabs?: ReactNode;
	tabAction?: SessionTabActions;
	onRenamed?: TopbarTabsProps["onRenamed"];
	onSelectActiveSession?: () => void;
	onTabsKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
	clearanceClassName?: string;
	hideActions?: boolean;
};

export function TopbarToolbar({
	actions,
	subTabs,
	tabAction,
	onRenamed,
	onSelectActiveSession,
	onTabsKeyDown,
	clearanceClassName,
	hideActions = false,
}: TopbarToolbarProps): JSX.Element {
	const density = useTopbarTabsStore((state) => state.density);
	const actionRegionRef = useRef<HTMLDivElement | null>(null);
	const [actionsWidth, setActionsWidth] = useState(0);
	const actionsReservePx = hideActions ? 0 : actionsWidth;

	useEffect(() => {
		const region = actionRegionRef.current;
		if (!region || hideActions) {
			setActionsWidth(0);
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const entry = entries.find((item) => item.target === region);
			if (!entry) return;
			const width = Math.ceil(region.getBoundingClientRect().width);
			setActionsWidth((current) => current === width ? current : width);
		});
		observer.observe(region);
		return () => observer.disconnect();
	}, [hideActions]);

	return (
		<div
			className="topbar-toolbar flex w-full shrink-0 flex-col bg-sidebar"
			data-density={density}
			data-testid="session-topbar-toolbar"
		>
			<div
				className="session-topbar-surface relative flex min-w-0 items-start"
				data-testid="session-workspace-topbar"
				style={{ minHeight: "var(--topbar-row-h)" }}
			>
				<div
					className={cn("min-w-0 flex-1", clearanceClassName)}
					data-testid="session-terminal-region"
					onKeyDown={(event) => {
						if (event.key === "Tab" && event.ctrlKey && !event.altKey && !event.metaKey) {
							onTabsKeyDown?.(event);
						}
					}}
				>
					<TopbarTabs
						actionsReservePx={actionsReservePx}
						onRenamed={onRenamed}
						onSelectActiveSession={onSelectActiveSession}
						tabAction={tabAction ? () => tabAction : undefined}
					/>
				</div>
				{hideActions ? null : (
					<div
						className="absolute right-0 top-0 flex items-center gap-1 pl-2 pr-3"
						data-testid="session-action-region"
						ref={actionRegionRef}
						style={{ height: "var(--topbar-row-h)" }}
					>
						{actions}
					</div>
				)}
			</div>
			{subTabs ? (
				<div className="flex h-8 items-stretch" data-testid="session-sub-tabs">
					{subTabs}
				</div>
			) : null}
		</div>
	);
}
