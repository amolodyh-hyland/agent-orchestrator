import { type CSSProperties, type JSX } from "react";
import { useWindowFullScreen } from "../../hooks/useWindowFullScreen";
import { isLinuxPlatform, isMacPlatform } from "../../lib/platform";
import { cn } from "../../lib/utils";
import { sidebarOccupiesLayout, useUiStore } from "../../stores/ui-store";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { TopbarTabs } from "./TopbarTabs";

export function TopbarTabsRow(): JSX.Element | null {
	const hasGroups = useTopbarTabsStore((state) => state.tabs.groups.length > 0);
	const density = useTopbarTabsStore((state) => state.density);
	const isSidebarOpen = useUiStore(sidebarOccupiesLayout);
	const isFullScreen = useWindowFullScreen();
	const isMac = isMacPlatform();
	const isLinux = isLinuxPlatform();
	if (!hasGroups) return null;

	const clearanceClassName = cn(
		!isSidebarOpen && isMac && "session-topbar-titlebar-clearance-mac",
		!isFullScreen && !isSidebarOpen && isLinux && "session-topbar-titlebar-clearance-linux",
	);
	const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined;
	const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;

	return (
		<div className="topbar-toolbar flex w-full shrink-0 flex-col bg-sidebar" data-density={density} data-testid="topbar-tabs-row">
			<div
				className="relative flex min-w-0 items-start border-b border-border-strong bg-sidebar"
				data-testid="topbar-tabs-row-surface"
				style={{ minHeight: "var(--topbar-row-h)", ...dragStyle }}
			>
				<div
					className={cn("min-w-0 flex-1", clearanceClassName)}
					data-testid="topbar-tabs-row-strip"
					style={noDragStyle}
				>
					<TopbarTabs actionsReservePx={0} />
				</div>
			</div>
		</div>
	);
}
