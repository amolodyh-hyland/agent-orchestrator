import type { TopbarTabView } from "./topbar-tabs-view";

export type TopbarMenuEntry = {
	id: string;
	labelKey: string;
	disabled?: boolean;
	separatorBefore?: boolean;
	danger?: boolean;
	run:
		| "rename"
		| "keepOpen"
		| "close"
		| "closeOthers"
		| "closeToRight"
		| "closeAll"
		| "copyLink"
		| "toggleCollapsed"
		| "newTask"
		| "closeGroup"
		| "closeOtherGroups"
		| "openOrchestrator";
};

export function buildTopbarTabMenu(
	view: TopbarTabView,
	ctx: {
		groupCollapsed: boolean;
		groupTabCount: number;
		groupCount: number;
		canRename: boolean;
		canCloseToRight: boolean;
	},
): TopbarMenuEntry[] {
	if (view.role === "head") {
		const entries: TopbarMenuEntry[] = [];
		if (view.isAnchor) {
			entries.push({
				id: "openOrchestrator",
				labelKey: "shell.tabs.menu.openOrchestrator",
				run: "openOrchestrator",
			});
		}
		entries.push({
			id: "toggleCollapsed",
			labelKey: ctx.groupCollapsed ? "shell.tabs.menu.showTasks" : "shell.tabs.menu.hideTasks",
			disabled: ctx.groupTabCount === 0,
			separatorBefore: view.isAnchor,
			run: "toggleCollapsed",
		});
		if (!view.isAnchor && view.mode === "preview") {
			entries.push({ id: "keepOpen", labelKey: "shell.tabs.menu.keepOpen", run: "keepOpen" });
		}
		entries.push({ id: "newTask", labelKey: "shell.tabs.menu.newTask", run: "newTask" });
		entries.push({
			id: "closeGroup",
			labelKey: "shell.tabs.menu.closeGroup",
			separatorBefore: true,
			run: "closeGroup",
		});
		entries.push({
			id: "closeToRight",
			labelKey: "shell.tabs.menu.closeToRight",
			disabled: !ctx.canCloseToRight,
			run: "closeToRight",
		});
		entries.push({
			id: "closeOtherGroups",
			labelKey: "shell.tabs.menu.closeOtherGroups",
			disabled: ctx.groupCount <= 1,
			run: "closeOtherGroups",
		});
		return entries;
	}

	const entries: TopbarMenuEntry[] = [];
	if (ctx.canRename && view.session) {
		entries.push({ id: "rename", labelKey: "shell.tabs.menu.rename", run: "rename" });
	}
	if (view.mode === "preview") {
		entries.push({ id: "keepOpen", labelKey: "shell.tabs.menu.keepOpen", run: "keepOpen" });
	}
	entries.push({ id: "close", labelKey: "shell.tabs.menu.close", run: "close" });
	entries.push({
		id: "closeOthers",
		labelKey: view.role === "scratch" ? "shell.tabs.menu.closeOtherScratchpads" : "shell.tabs.menu.closeOthers",
		disabled: ctx.groupTabCount <= 1,
		run: "closeOthers",
	});
	entries.push({
		id: "closeToRight",
		labelKey: "shell.tabs.menu.closeToRight",
		disabled: !ctx.canCloseToRight,
		run: "closeToRight",
	});
	entries.push({
		id: "closeAll",
		labelKey: "shell.tabs.menu.closeAll",
		disabled: ctx.groupTabCount <= 0,
		run: "closeAll",
	});
	entries.push({
		id: "copyLink",
		labelKey: "shell.tabs.menu.copyLink",
		separatorBefore: true,
		run: "copyLink",
	});
	return entries;
}
