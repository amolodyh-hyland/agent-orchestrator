import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { STANDALONE_WORKSPACE_ID } from "../../types/workspace";
import type { TopbarTabView } from "./topbar-tabs-view";
import { useTopbarTabsActions } from "./useTopbarTabsActions";

const routerMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: "task-1" as string | undefined },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => routerMocks.navigate,
		useParams: () => routerMocks.params,
	};
});

function group(id: string, headSessionId: string | null, tabSessionIds: string[]) {
	return {
		id,
		collapsed: false,
		head: { sessionId: id === STANDALONE_WORKSPACE_ID ? null : headSessionId, mode: "persistent" as const, lastActiveAt: 0 },
		tabs: tabSessionIds.map((sessionId, index) => ({
			sessionId,
			mode: index === 0 ? "preview" as const : "persistent" as const,
			lastActiveAt: index,
		})),
	};
}

function setStore() {
	useTopbarTabsStore.setState({
		tabs: {
			version: 1,
			groups: [
				group("project-1", "orch-1", ["task-1", "task-2"]),
				group("project-2", "orch-2", ["task-3"]),
				group(STANDALONE_WORKSPACE_ID, null, ["scratch-1", "scratch-2"]),
			],
		},
	});
}

function view(
	sessionId: string | null,
	groupId = "project-1",
	role: TopbarTabView["role"] = "task",
): TopbarTabView {
	return {
		key: sessionId ?? `anchor:${groupId}`,
		sessionId,
		role,
		groupId,
		mode: "preview",
		label: sessionId ?? "Project One",
		isActive: sessionId === routerMocks.params.sessionId,
		isAnchor: sessionId === null,
	};
}

function renderActions(onOpenOrchestrator?: (groupId: string) => void) {
	return renderHook(() => useTopbarTabsActions({ onOpenOrchestrator }));
}

beforeEach(() => {
	localStorage.clear();
	routerMocks.navigate.mockReset();
	routerMocks.params.projectId = "project-1";
	routerMocks.params.sessionId = "task-1";
	setStore();
});

describe("useTopbarTabsActions", () => {
	it("opens the orchestrator from an anchor without navigating", () => {
		const onOpenOrchestrator = vi.fn();
		const { result } = renderActions(onOpenOrchestrator);
		act(() => result.current.activate(view(null, "project-1", "head")));

		expect(onOpenOrchestrator).toHaveBeenCalledWith("project-1");
		expect(routerMocks.navigate).not.toHaveBeenCalled();
	});

	it("navigates to project and standalone session tabs", () => {
		const { result } = renderActions();
		act(() => result.current.activate(view("task-2")));
		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "task-2" },
		});

		routerMocks.navigate.mockClear();
		act(() => result.current.activate(view("scratch-1", STANDALONE_WORKSPACE_ID, "scratch")));
		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/sessions/$sessionId",
			params: { sessionId: "scratch-1" },
		});
	});

	it("persists an interacted preview tab", () => {
		const { result } = renderActions();
		act(() => result.current.persist(view("task-1")));

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].mode).toBe("persistent");
	});

	it("navigates from a closed active tab to its adjacent tab", () => {
		const { result } = renderActions();
		act(() => result.current.close(view("task-1")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "task-2" },
		});
	});

	it("resolves a head-close neighbor before the closed group is removed", () => {
		routerMocks.params.sessionId = "orch-1";
		const { result } = renderActions();
		act(() => result.current.close(view("orch-1", "project-1", "head")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-2", sessionId: "orch-2" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups.map((item) => item.id)).toEqual([
			"project-2",
			STANDALONE_WORKSPACE_ID,
		]);
	});

	it("does not navigate when closing a non-active tab", () => {
		const { result } = renderActions();
		act(() => result.current.close(view("task-2")));

		expect(routerMocks.navigate).not.toHaveBeenCalled();
	});

	it("closes an anchor group and navigates when its active route session is removed", () => {
		const { result } = renderActions();
		act(() => result.current.close(view(null, "project-1", "head")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-2", sessionId: "orch-2" },
		});
	});

	it("closes other tabs and activates the remaining tab when the route tab was closed", () => {
		const { result } = renderActions();
		act(() => result.current.closeOthers(view("task-2")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "task-2" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual(["task-2"]);
	});

	it("closes tabs to the right and activates the clicked task when the route tab was closed", () => {
		routerMocks.params.sessionId = "task-2";
		const { result } = renderActions();
		act(() => result.current.closeToRight(view("task-1")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "task-1" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual(["task-1"]);
	});

	it("does not navigate when close-to-right leaves the routed tab open", () => {
		const { result } = renderActions();
		act(() => result.current.closeToRight(view("task-1")));

		expect(routerMocks.navigate).not.toHaveBeenCalled();
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual(["task-1"]);
	});

	it("keeps the head selected when closing every task to its right", () => {
		routerMocks.params.sessionId = "task-2";
		const { result } = renderActions();
		act(() => result.current.closeToRight(view("orch-1", "project-1", "head")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "orch-1" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs).toEqual([]);
	});

	it("returns to the project board when an anchor closes its task tabs", () => {
		useTopbarTabsStore.setState((state) => ({
			tabs: {
				...state.tabs,
				groups: state.tabs.groups.map((item) => item.id === "project-1"
					? { ...item, head: { ...item.head, sessionId: null } }
					: item),
			},
		}));
		const { result } = renderActions();
		act(() => result.current.closeToRight(view(null, "project-1", "head")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId",
			params: { projectId: "project-1" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs).toEqual([]);
	});

	it("closes every task and selects the group head when the route task is removed", () => {
		const { result } = renderActions();
		act(() => result.current.closeAll(view("task-2")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "orch-1" },
		});
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs).toEqual([]);
	});

	it("does not navigate when close-all removes a task outside the routed group", () => {
		routerMocks.params.sessionId = "task-3";
		const { result } = renderActions();
		act(() => result.current.closeAll(view("task-1")));

		expect(routerMocks.navigate).not.toHaveBeenCalled();
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs).toEqual([]);
	});

	it("returns to the standalone sessions list after closing all scratchpads", () => {
		routerMocks.params.projectId = undefined;
		routerMocks.params.sessionId = "scratch-1";
		const { result } = renderActions();
		act(() => result.current.closeAll(view("scratch-2", STANDALONE_WORKSPACE_ID, "scratch")));

		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/sessions" });
		expect(useTopbarTabsStore.getState().tabs.groups.map((group) => group.id)).toEqual(["project-1", "project-2"]);
	});

	it("navigates from a closed group to a neighboring remaining group", () => {
		const { result } = renderActions();
		act(() => result.current.closeGroup("project-1"));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-2", sessionId: "orch-2" },
		});
	});

	it("navigates to the remaining group when closing other groups", () => {
		const { result } = renderActions();
		act(() => result.current.closeOtherGroups("project-2"));

		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-2", sessionId: "orch-2" },
		});
	});

	it("uses the standalone sessions route when no standalone tabs remain", () => {
		routerMocks.params.projectId = undefined;
		routerMocks.params.sessionId = "scratch-1";
		useTopbarTabsStore.setState({
			tabs: { version: 1, groups: [group(STANDALONE_WORKSPACE_ID, null, ["scratch-1"])] },
		});
		const { result } = renderActions();
		act(() => result.current.closeGroup(STANDALONE_WORKSPACE_ID));

		expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/sessions" });
	});

	it("toggles collapse without navigating", () => {
		const { result } = renderActions();
		act(() => result.current.toggleCollapsed("project-1"));

		expect(useTopbarTabsStore.getState().tabs.groups[0].collapsed).toBe(true);
		expect(routerMocks.navigate).not.toHaveBeenCalled();
	});
});
