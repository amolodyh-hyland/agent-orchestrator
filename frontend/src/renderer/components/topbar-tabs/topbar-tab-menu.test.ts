import { describe, expect, it } from "vitest";
import type { WorkspaceSession } from "../../types/workspace";
import type { TopbarTabView } from "./topbar-tabs-view";
import { buildTopbarTabMenu } from "./topbar-tab-menu";

function makeView(
	role: TopbarTabView["role"],
	overrides: Partial<TopbarTabView> = {},
): TopbarTabView {
	const session: WorkspaceSession = {
		id: "session-1",
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: "Session One",
		provider: "codex",
		status: "working",
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	};
	return {
		key: role === "head" ? "head:project-1" : "session-1",
		sessionId: role === "head" ? "orchestrator-1" : "session-1",
		role,
		groupId: "project-1",
		mode: "persistent",
		label: role === "head" ? "Project One" : "Session One",
		session: role === "head" ? session : session,
		isActive: false,
		isAnchor: false,
		...overrides,
	};
}

function entryIds(entries: ReturnType<typeof buildTopbarTabMenu>): string[] {
	return entries.map((entry) => entry.id);
}

describe("buildTopbarTabMenu", () => {
	it("builds task entries in order and shows rename only when a session can be refreshed", () => {
		const previewTask = makeView("task", { mode: "preview" });
		const entries = buildTopbarTabMenu(previewTask, {
			groupCollapsed: false,
			groupTabCount: 2,
			groupCount: 2,
			canRename: true,
			canCloseToRight: true,
		});

		expect(entryIds(entries)).toEqual(["rename", "keepOpen", "close", "closeOthers", "closeToRight", "closeAll", "copyLink"]);
		expect(entries[3]).toMatchObject({
			labelKey: "shell.tabs.menu.closeOthers",
			disabled: false,
		});
		expect(entries[4]).toMatchObject({ labelKey: "shell.tabs.menu.closeToRight", disabled: false });
		expect(entries[5]).toMatchObject({ labelKey: "shell.tabs.menu.closeAll", disabled: false });
		expect(entries[6]?.separatorBefore).toBe(true);

		const nonRenameable = buildTopbarTabMenu(makeView("task", { session: undefined }), {
			groupCollapsed: false,
			groupTabCount: 1,
			groupCount: 1,
			canRename: true,
			canCloseToRight: false,
		});
		expect(entryIds(nonRenameable)).toEqual(["close", "closeOthers", "closeToRight", "closeAll", "copyLink"]);
		expect(nonRenameable[1]?.disabled).toBe(true);
		expect(nonRenameable[2]?.disabled).toBe(true);
		expect(nonRenameable[3]?.disabled).toBe(false);
	});

	it("omits keep-open for persistent task tabs and rename without a refresh callback", () => {
		const entries = buildTopbarTabMenu(makeView("task"), {
			groupCollapsed: false,
			groupTabCount: 3,
			groupCount: 2,
			canRename: false,
			canCloseToRight: true,
		});

		expect(entryIds(entries)).toEqual(["close", "closeOthers", "closeToRight", "closeAll", "copyLink"]);
	});

	it("disables close-all when the task group is empty", () => {
		const entries = buildTopbarTabMenu(makeView("task"), {
			groupCollapsed: false,
			groupTabCount: 0,
			groupCount: 1,
			canRename: true,
			canCloseToRight: false,
		});

		expect(entries.find((entry) => entry.id === "closeToRight")?.disabled).toBe(true);
		expect(entries.find((entry) => entry.id === "closeAll")?.disabled).toBe(true);
	});

	it("uses the scratchpad wording and disables closing others when alone", () => {
		const entries = buildTopbarTabMenu(makeView("scratch", { mode: "preview" }), {
			groupCollapsed: false,
			groupTabCount: 1,
			groupCount: 1,
			canRename: true,
			canCloseToRight: false,
		});

		expect(entryIds(entries)).toEqual(["rename", "keepOpen", "close", "closeOthers", "closeToRight", "closeAll", "copyLink"]);
		expect(entries[3]).toMatchObject({
			labelKey: "shell.tabs.menu.closeOtherScratchpads",
			disabled: true,
		});
		expect(entries[4]?.disabled).toBe(true);
		expect(entries[5]?.disabled).toBe(false);
	});

	it("builds opened orchestrator head entries and respects preview and group state", () => {
		const previewHead = makeView("head", { mode: "preview" });
		const entries = buildTopbarTabMenu(previewHead, {
			groupCollapsed: true,
			groupTabCount: 2,
			groupCount: 2,
			canRename: true,
			canCloseToRight: true,
		});

		expect(entryIds(entries)).toEqual([
			"toggleCollapsed",
			"keepOpen",
			"newTask",
			"closeGroup",
			"closeToRight",
			"closeOtherGroups",
		]);
		expect(entries[0]).toMatchObject({ labelKey: "shell.tabs.menu.showTasks", disabled: false });
		expect(entries[4]).toMatchObject({ labelKey: "shell.tabs.menu.closeToRight", disabled: false });
		expect(entries[5]?.disabled).toBe(false);

		const persistentHead = buildTopbarTabMenu(makeView("head"), {
			groupCollapsed: false,
			groupTabCount: 0,
			groupCount: 1,
			canRename: true,
			canCloseToRight: false,
		});
		expect(entryIds(persistentHead)).toEqual(["toggleCollapsed", "newTask", "closeGroup", "closeToRight", "closeOtherGroups"]);
		expect(persistentHead[0]).toMatchObject({ labelKey: "shell.tabs.menu.hideTasks", disabled: true });
		expect(persistentHead[3]?.disabled).toBe(true);
		expect(persistentHead[4]?.disabled).toBe(true);
	});

	it("builds anchor entries without keep-open and exposes open-orchestrator first", () => {
		const entries = buildTopbarTabMenu(makeView("head", {
			sessionId: null,
			session: undefined,
			isAnchor: true,
		}), {
			groupCollapsed: false,
			groupTabCount: 1,
			groupCount: 2,
			canRename: true,
			canCloseToRight: true,
		});

		expect(entryIds(entries)).toEqual([
			"openOrchestrator",
			"toggleCollapsed",
			"newTask",
			"closeGroup",
			"closeToRight",
			"closeOtherGroups",
		]);
		expect(entries[0]?.labelKey).toBe("shell.tabs.menu.openOrchestrator");
		expect(entries[1]).toMatchObject({ labelKey: "shell.tabs.menu.hideTasks", disabled: false, separatorBefore: true });
	});
});
