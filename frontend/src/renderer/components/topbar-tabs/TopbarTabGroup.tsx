import type { JSX } from "react";
import type { TabDensity } from "../../stores/topbar-tabs-store";
import { TopbarTab, type SessionTabActions, type TopbarTabProps } from "./TopbarTab";
import type { TopbarGroupView, TopbarTabView } from "./topbar-tabs-view";

export type TopbarTabGroupProps = {
	group: TopbarGroupView;
	density: TabDensity;
	separatorBefore?: boolean;
	firstTabKey?: string;
	accent?: string;
	hasActiveTab: boolean;
	onActivate: (view: TopbarTabView) => void;
	onPersist: (view: TopbarTabView) => void;
	onClose: (view: TopbarTabView) => void;
	onRenamed?: TopbarTabProps["onRenamed"];
	renderMenu?: TopbarTabProps["renderMenu"];
	tabAction?: (view: TopbarTabView) => SessionTabActions;
};

export function TopbarTabGroup({
	group,
	density,
	separatorBefore = false,
	firstTabKey,
	accent,
	hasActiveTab,
	onActivate,
	onPersist,
	onClose,
	onRenamed,
	renderMenu,
	tabAction,
}: TopbarTabGroupProps): JSX.Element {
	const views = [
		...(group.head ? [group.head] : []),
		...(!group.collapsed ? group.tabs : []),
	];
	const firstViewKey = views[0]?.key;
	const content = (
		<div className="contents" data-group-id={group.id} data-testid="topbar-tab-group">
			{group.head ? (
				<TopbarTab
					key={group.head.key}
					className={separatorBefore && group.head.key === firstViewKey
						? "shadow-[inset_1px_0_0_var(--bridge-border-strong)]"
						: undefined}
					accent={accent}
					density={density}
					hiddenCount={group.hiddenCount}
					isTabbable={group.head.isActive || (!hasActiveTab && group.head.key === firstTabKey)}
					onActivate={onActivate}
					onClose={onClose}
					onPersist={onPersist}
					onRenamed={onRenamed}
					renderMenu={renderMenu}
					tabAction={group.head.isActive ? tabAction?.(group.head) : undefined}
					view={group.head}
				/>
			) : null}
			{!group.collapsed ? group.tabs.map((view) => (
				<TopbarTab
					key={view.key}
					className={separatorBefore && view.key === firstViewKey
						? "shadow-[inset_1px_0_0_var(--bridge-border-strong)]"
						: undefined}
					accent={accent}
					density={density}
					hiddenCount={0}
					isTabbable={view.isActive || (!hasActiveTab && view.key === firstTabKey)}
					onActivate={onActivate}
					onClose={onClose}
					onPersist={onPersist}
					onRenamed={onRenamed}
					renderMenu={renderMenu}
					tabAction={view.isActive ? tabAction?.(view) : undefined}
					view={view}
				/>
			)) : null}
		</div>
	);
	return content;
}
