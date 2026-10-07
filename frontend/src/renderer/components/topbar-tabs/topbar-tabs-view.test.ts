import { describe, expect, it } from "vitest";
import { TOPBAR_TABS_VERSION, type TopbarTabsState } from "../../lib/topbar-tabs";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { buildTopbarTabsView, computeRevealScrollLeft } from "./topbar-tabs-view";

function session(id: string, title: string, workspaceId: string): WorkspaceSession {
	return {
		id,
		workspaceId,
		workspaceName: workspaceId,
		title,
		provider: "codex",
		status: "working",
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	};
}

function workspace(id: string, name: string, sessions: WorkspaceSession[] = []): WorkspaceSummary {
	return { id, name, path: `/${id}`, sessions };
}

describe("buildTopbarTabsView", () => {
	it("builds project, scratchpad, and unknown groups with labels and active state", () => {
		const state: TopbarTabsState = {
			version: TOPBAR_TABS_VERSION,
			groups: [
				{
					id: "project-1",
					collapsed: false,
					head: { sessionId: "project-1-orchestrator", mode: "persistent", lastActiveAt: 1 },
					tabs: [{ sessionId: "task-1", mode: "preview", lastActiveAt: 2 }],
				},
				{
					id: "__standalone__",
					collapsed: false,
					head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
					tabs: [{ sessionId: "scratch-1", mode: "persistent", lastActiveAt: 3 }],
				},
				{
					id: "missing-project",
					collapsed: false,
					head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
					tabs: [{ sessionId: "not-loaded", mode: "preview", lastActiveAt: 4 }],
				},
			],
		};
		const workspaces = [
			workspace("project-1", "Project One", [
				session("project-1-orchestrator", "Orchestrator", "project-1"),
				session("task-1", "Fix the tabs", "project-1"),
			]),
			workspace("__standalone__", "Not the scratchpad label", [session("scratch-1", "Quick note", "__standalone__")]),
		];

		const groups = buildTopbarTabsView(state, workspaces, "task-1", "Scratchpad");

		expect(groups[0]).toMatchObject({ name: "Project One", isStandalone: false, collapsed: false, hiddenCount: 0 });
		expect(groups[0].head).toMatchObject({
			key: "project-1-orchestrator",
			sessionId: "project-1-orchestrator",
			role: "head",
			label: "Project One",
			isActive: false,
			isAnchor: false,
		});
		expect(groups[0].tabs[0]).toMatchObject({
			key: "task-1",
			role: "task",
			label: "Fix the tabs",
			isActive: true,
			isAnchor: false,
		});
		expect(groups[0].tabs[0].session).toBe(workspaces[0].sessions[1]);
		expect(groups[1]).toMatchObject({ name: "Scratchpad", isStandalone: true, head: null });
		expect(groups[1].tabs[0]).toMatchObject({ role: "scratch", label: "Quick note" });
		expect(groups[2]).toMatchObject({ name: "missing-project", isStandalone: false });
		expect(groups[2].tabs[0]).toMatchObject({ label: "not-loaded", session: undefined });
	});

	it("uses anchor keys and reports the full hidden tab count for collapsed groups", () => {
		const state: TopbarTabsState = {
			version: TOPBAR_TABS_VERSION,
			groups: [
				{
					id: "project-2",
					collapsed: true,
					head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
					tabs: [
						{ sessionId: "task-a", mode: "persistent", lastActiveAt: 1 },
						{ sessionId: "task-b", mode: "preview", lastActiveAt: 2 },
					],
				},
			],
		};

		const [group] = buildTopbarTabsView(state, [workspace("project-2", "Project Two")], undefined, "Scratchpad");

		expect(group.head).toMatchObject({ key: "anchor:project-2", sessionId: null, role: "head", isAnchor: true });
		expect(group.hiddenCount).toBe(2);
		expect(group.tabs).toHaveLength(2);
		expect(group.tabs[0].label).toBe("task-a");
	});

	it("uses directly resolved sessions for tabs absent from the workspace list", () => {
		const state: TopbarTabsState = {
			version: TOPBAR_TABS_VERSION,
			groups: [
				{
					id: "project-cloud",
					collapsed: false,
					head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
					tabs: [{ sessionId: "cloud-task", mode: "preview", lastActiveAt: 1 }],
				},
			],
		};
		const resolved = session("cloud-task", "Cloud session title", "project-cloud");

		const [group] = buildTopbarTabsView(state, [workspace("project-cloud", "Cloud project")], "cloud-task", "Scratchpad", [resolved]);

		expect(group.tabs[0].session).toBe(resolved);
		expect(group.tabs[0].label).toBe("Cloud session title");
	});
});

describe("computeRevealScrollLeft", () => {
	it("keeps a tab that is fully inside the unobscured region", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: false,
			rightChevronVisible: false,
			tabLeft: 300,
			tabRight: 500,
		})).toBe(100);
	});

	it("moves a tab fully inside the viewport right edge", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: false,
			rightChevronVisible: false,
			tabLeft: 600,
			tabRight: 950,
		})).toBe(150);
	});

	it("reveals a tab to the left of the scroll viewport", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: false,
			rightChevronVisible: false,
			tabLeft: 20,
			tabRight: 80,
		})).toBe(20);
	});

	it("aligns a tab wider than the visible region at its left edge", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 100,
			actionsReservePx: 0,
			leftChevronVisible: true,
			rightChevronVisible: true,
			tabLeft: 120,
			tabRight: 180,
		})).toBe(92);
	});

	it("moves a wrapper fully clear of the visible right chevron", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 0,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: false,
			rightChevronVisible: true,
			tabLeft: 600,
			tabRight: 850,
		})).toBe(78);
	});

	it("keeps a wrapper clear of both visible chevrons", () => {
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: true,
			rightChevronVisible: true,
			tabLeft: 120,
			tabRight: 300,
		})).toBe(92);
		expect(computeRevealScrollLeft({
			scrollLeft: 100,
			clientWidth: 800,
			actionsReservePx: 0,
			leftChevronVisible: true,
			rightChevronVisible: true,
			tabLeft: 600,
			tabRight: 950,
		})).toBe(178);
	});
});
