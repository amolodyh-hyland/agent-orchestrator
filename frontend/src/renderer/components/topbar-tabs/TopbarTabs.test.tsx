import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { projectColorCss } from "../../lib/project-colors";
import { useUiStore } from "../../stores/ui-store";
import {
	STANDALONE_WORKSPACE_ID,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../../types/workspace";
import { TooltipProvider } from "../ui/tooltip";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { TopbarTabs } from "./TopbarTabs";
import * as topbarTabsView from "./topbar-tabs-view";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: "task-1" as string | undefined },
}));
const workspaceQueryMock = vi.hoisted(() => vi.fn());
const renameSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const topbarTabRenderCounts = vi.hoisted(() => ({ byKey: {} as Record<string, number> }));
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let hasResizeObserverOverride = false;

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => routeMocks.navigate,
		useParams: () => routeMocks.params,
	};
});

vi.mock("../../hooks/useWorkspaceQuery", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../hooks/useWorkspaceQuery")>();
	return { ...actual, useWorkspaceQuery: workspaceQueryMock };
});

vi.mock("../../lib/rename-session", () => ({ renameSession: renameSessionMock }));

vi.mock("./TopbarTab", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./TopbarTab")>();
	const { createElement, memo } = await import("react");
	const CountedTopbarTab = memo((props: Parameters<typeof actual.TopbarTab>[0]) => {
		topbarTabRenderCounts.byKey[props.view.key] = (topbarTabRenderCounts.byKey[props.view.key] ?? 0) + 1;
		return createElement(actual.TopbarTab, props);
	});
	return { ...actual, TopbarTab: CountedTopbarTab };
});

const sessions: WorkspaceSession[] = [
	{
		id: "orch-1",
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: "Orchestrator",
		provider: "codex",
		kind: "orchestrator",
		branch: "main",
		status: "working",
		activity: { state: "active", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	},
	{
		id: "task-1",
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: "Task One",
		provider: "codex",
		kind: "worker",
		branch: "ao/task-1",
		status: "working",
		activity: { state: "active", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	},
	{
		id: "task-2",
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: "Task Two",
		provider: "codex",
		kind: "worker",
		branch: "ao/task-2",
		status: "working",
		activity: { state: "idle", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	},
	{
		id: "task-3",
		workspaceId: "project-2",
		workspaceName: "Project Two",
		title: "Task Three",
		provider: "codex",
		kind: "worker",
		branch: "ao/task-3",
		status: "working",
		activity: { state: "idle", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	},
];

const workspaces: WorkspaceSummary[] = [
	{
		id: "project-1",
		name: "Project One",
		path: "/project-1",
		orchestratorAgent: "codex",
		kind: "single_repo",
		sessions: sessions.filter((session) => session.workspaceId === "project-1"),
	},
	{
		id: "project-2",
		name: "Project Two",
		path: "/project-2",
		orchestratorAgent: "codex",
		kind: "single_repo",
		sessions: sessions.filter((session) => session.workspaceId === "project-2"),
	},
];

function group(
	id: string,
	headSessionId: string | null,
	tabSessionIds: string[],
	collapsed = false,
) {
	return {
		id,
		collapsed,
		head: { sessionId: headSessionId, mode: "persistent" as const, lastActiveAt: 0 },
		tabs: tabSessionIds.map((sessionId) => ({ sessionId, mode: "persistent" as const, lastActiveAt: 0 })),
	};
}

function setTabs(groups = [
	group("project-1", "orch-1", ["task-1", "task-2"]),
	group("project-2", null, ["task-3"]),
]) {
	useTopbarTabsStore.setState({
		tabs: { version: 1, groups },
		overflow: "scroll",
		density: "comfortable",
		colorCoding: false,
		projectColors: {},
	});
}

function tree(children: ReactNode = <TopbarTabs />, queryClient = new QueryClient()) {
	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

function renderTabs(props: React.ComponentProps<typeof TopbarTabs> = {}, queryClient = new QueryClient()) {
	return render(tree(<TopbarTabs {...props} />, queryClient));
}

beforeEach(() => {
	localStorage.clear();
	routeMocks.navigate.mockReset();
	routeMocks.params.projectId = "project-1";
	routeMocks.params.sessionId = "task-1";
	workspaceQueryMock.mockReset();
	workspaceQueryMock.mockReturnValue({ data: workspaces });
	renameSessionMock.mockReset().mockResolvedValue(undefined);
	topbarTabRenderCounts.byKey = {};
	useUiStore.setState({ resolvedTheme: "light" });
	setTabs();
});

afterEach(() => {
	vi.restoreAllMocks();
	if (hasResizeObserverOverride) {
		if (resizeObserverDescriptor) Object.defineProperty(window, "ResizeObserver", resizeObserverDescriptor);
		else Reflect.deleteProperty(window, "ResizeObserver");
	}
	resizeObserverDescriptor = undefined;
	hasResizeObserverOverride = false;
});

describe("TopbarTabs", () => {
	it("renders one options trigger per tab and routes session actions only to the active tab", async () => {
		const actions = {
			menuItems: <><DropdownMenuItem>Switch to chat UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
		};
		renderTabs({ tabAction: () => actions });

		const wrappers = screen.getAllByTestId("topbar-tab");
		expect(screen.getAllByRole("button", { name: "Tab options" })).toHaveLength(wrappers.length);
		for (const wrapper of wrappers) {
			expect(within(wrapper).getAllByRole("button", { name: "Tab options" })).toHaveLength(1);
		}
		expect(document.querySelectorAll("[data-session-actions-trigger]")).toHaveLength(0);

		const activeTab = screen.getByRole("tab", { name: /Task One/ });
		const activeWrapper = activeTab.closest<HTMLElement>('[data-testid="topbar-tab"]')!;
		await userEvent.click(within(activeWrapper).getByRole("button", { name: "Tab options" }));
		const activeMenu = await screen.findByRole("menu");
		const activeItems = within(activeMenu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
		expect(activeItems.slice(0, 2)).toEqual(["Switch to chat UI", "Switch agent"]);

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
		const inactiveTab = screen.getByRole("tab", { name: /Task Two/ });
		const inactiveWrapper = inactiveTab.closest<HTMLElement>('[data-testid="topbar-tab"]')!;
		await userEvent.click(within(inactiveWrapper).getByRole("button", { name: "Tab options" }));
		const inactiveMenu = await screen.findByRole("menu");
		expect(within(inactiveMenu).queryByRole("menuitem", { name: "Switch to chat UI" })).not.toBeInTheDocument();
		expect(within(inactiveMenu).queryByRole("menuitem", { name: "Switch agent" })).not.toBeInTheDocument();
	});

	it("keeps session actions reachable when the routed session is the orchestrator head", async () => {
		routeMocks.params.sessionId = "orch-1";
		const actions = {
			menuItems: <><DropdownMenuItem>Switch to chat UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
		};
		renderTabs({ tabAction: () => actions });
		const head = screen.getByRole("tab", { name: "Project One" });
		const wrapper = head.closest<HTMLElement>('[data-testid="topbar-tab"]')!;
		await userEvent.click(within(wrapper).getByRole("button", { name: "Tab options" }));
		const menu = await screen.findByRole("menu");
		expect(within(menu).getAllByRole("menuitem").slice(0, 2).map((item) => item.textContent?.trim())).toEqual([
			"Switch to chat UI",
			"Switch agent",
		]);
	});

	it("renders groups in order with their heads and tabs", () => {
		renderTabs();

		const groups = screen.getAllByTestId("topbar-tab-group");
		expect(groups.map((item) => item.getAttribute("data-group-id"))).toEqual(["project-1", "project-2"]);
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(5);
		expect(tabs[0]).toHaveTextContent("Project One");
		expect(tabs[1]).toHaveTextContent("Task One");
		expect(tabs[2]).toHaveTextContent("Task Two");
		expect(tabs[3]).toHaveTextContent("Project Two");
		expect(tabs[4]).toHaveTextContent("Task Three");
	});

	it("applies each enabled project accent to every tab in that group", () => {
		useTopbarTabsStore.setState({
			colorCoding: true,
			projectColors: { "project-1": 2, "project-2": 8 },
		});
		renderTabs();

		for (const [groupId, slot] of [["project-1", 2], ["project-2", 8]] as const) {
			const wrappers = screen.getAllByTestId("topbar-tab").filter((wrapper) => wrapper.getAttribute("data-group-id") === groupId);
			expect(wrappers.length).toBeGreaterThan(0);
			for (const wrapper of wrappers) {
				expect(wrapper.style.getPropertyValue("--project-accent")).toBe(projectColorCss(slot, "light"));
				expect(wrapper.querySelector("[data-testid='topbar-tab-accent-indicator']")).toBeInTheDocument();
			}
		}
	});

	it("hides tabs from a collapsed group and shows the hidden count", () => {
		setTabs([group("project-1", "orch-1", ["task-1", "task-2"], true)]);
		renderTabs();

		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(screen.getByText("+2")).toBeInTheDocument();
		expect(screen.queryByText("Task One")).not.toBeInTheDocument();
	});

	it("adds a separator before the first tab of each group after the first", () => {
		renderTabs();

		const wrappers = screen.getAllByTestId("topbar-tab");
		expect(wrappers[0]).not.toHaveClass("shadow-[inset_1px_0_0_var(--bridge-border-strong)]");
		expect(wrappers[3]).toHaveClass("shadow-[inset_1px_0_0_var(--bridge-border-strong)]");
		expect(wrappers[4]).not.toHaveClass("shadow-[inset_1px_0_0_var(--bridge-border-strong)]");
	});

	it("uses store density and overflow attributes and puts the wrap spacer first", () => {
		useTopbarTabsStore.setState({ density: "compact", overflow: "wrap" });
		renderTabs({ actionsReservePx: 72 });

		const tabList = screen.getByRole("tablist", { name: "Project tabs" });
		expect(tabList).toHaveAttribute("data-density", "compact");
		expect(tabList).toHaveAttribute("data-overflow", "wrap");
		expect(tabList).toHaveClass("scrollbar-none");
		expect(tabList.style.getPropertyValue("--topbar-actions-w")).toBe("72px");
		expect(tabList.style.marginRight).toBe("");
		expect(tabList.firstElementChild).toHaveClass("topbar-tabs__actions-spacer");
		expect((tabList.firstElementChild as HTMLElement).style.float).toBe("right");
		expect((tabList.firstElementChild as HTMLElement).style.width).toBe("var(--topbar-actions-w)");
		expect((tabList.firstElementChild as HTMLElement).style.height).toBe("var(--topbar-row-h)");
		expect(screen.queryByRole("button", { name: "Scroll tabs right" })).not.toBeInTheDocument();
	});

	it("reserves the actions column while the wrapped strip overflows vertically", () => {
		useTopbarTabsStore.setState({ overflow: "wrap" });
		let notifyResize: () => void = () => undefined;
		class ReportingResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				notifyResize = () => callback([], this as unknown as ResizeObserver);
			}
			observe() {}
			disconnect() {}
		}
		resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
		hasResizeObserverOverride = true;
		Object.defineProperty(window, "ResizeObserver", {
			configurable: true,
			writable: true,
			value: ReportingResizeObserver,
		});
		const { container } = renderTabs({ actionsReservePx: 72 });
		const tabList = screen.getByRole("tablist");
		let scrollHeight = 100;
		let clientHeight = 100;
		Object.defineProperty(tabList, "scrollHeight", { configurable: true, get: () => scrollHeight });
		Object.defineProperty(tabList, "clientHeight", { configurable: true, get: () => clientHeight });
		const spacer = container.querySelector<HTMLElement>(".topbar-tabs__actions-spacer");
		expect(spacer).not.toBeNull();
		expect(tabList).not.toHaveAttribute("data-wrap-scrolling", "true");
		expect(tabList.style.paddingRight).toBe("");

		scrollHeight = 140;
		act(() => notifyResize());
		expect(tabList).toHaveAttribute("data-wrap-scrolling", "true");
		expect(tabList.style.paddingRight).toBe("var(--topbar-actions-w)");
		expect(tabList.style.getPropertyValue("--topbar-actions-w")).toBe("72px");
		expect(spacer).toHaveClass("topbar-tabs__actions-spacer");

		scrollHeight = clientHeight;
		act(() => notifyResize());
		expect(tabList).not.toHaveAttribute("data-wrap-scrolling", "true");
		expect(tabList.style.paddingRight).toBe("");
	});

	it("clips scroll mode at the actions width and reveals chevrons only for overflow", async () => {
		renderTabs({ actionsReservePx: 64 });
		const tabList = screen.getByRole("tablist");
		const viewport = screen.getByTestId("topbar-tabs-viewport");
		expect(viewport).toHaveClass("topbar-tabs__viewport");
		expect(tabList.parentElement).toBe(viewport);
		expect(viewport.style.getPropertyValue("--topbar-actions-w")).toBe("64px");
		expect(tabList.style.marginRight).toBe("var(--topbar-actions-w)");
		expect(tabList.style.paddingRight).toBe("");
		expect(tabList.style.getPropertyValue("--topbar-actions-w")).toBe("64px");
		expect(screen.queryByRole("button", { name: "Scroll tabs right" })).not.toBeInTheDocument();

		let scrollLeft = 0;
		Object.defineProperty(tabList, "scrollWidth", { configurable: true, value: 500 });
		Object.defineProperty(tabList, "clientWidth", { configurable: true, value: 250 });
		Object.defineProperty(tabList, "scrollLeft", {
			configurable: true,
			get: () => scrollLeft,
			set: (value: number) => { scrollLeft = value; },
		});
		const scrollBy = vi.fn();
		Object.defineProperty(tabList, "scrollBy", { configurable: true, value: scrollBy });
		fireEvent.scroll(tabList);
		const rightChevron = await screen.findByRole("button", { name: "Scroll tabs right" });
		expect(rightChevron.parentElement).toBe(viewport);
		expect(viewport.querySelector(".topbar-tabs__scroll-fade--right")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Scroll tabs left" })).not.toBeInTheDocument();
		await userEvent.click(rightChevron);
		expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior: "smooth" });
		scrollLeft = 100;
		fireEvent.scroll(tabList);
		const leftChevron = await screen.findByRole("button", { name: "Scroll tabs left" });
		expect(leftChevron.parentElement).toBe(viewport);
		expect(viewport.querySelector(".topbar-tabs__scroll-fade--left")).toBeInTheDocument();
	});

	it("hides scroll controls when the viewport is narrower than both chevrons", () => {
		renderTabs();
		const tabList = screen.getByRole("tablist");
		let clientWidth = 55;
		Object.defineProperty(tabList, "scrollWidth", { configurable: true, value: 500 });
		Object.defineProperty(tabList, "clientWidth", { configurable: true, get: () => clientWidth });
		fireEvent.scroll(tabList);
		expect(screen.queryByRole("button", { name: "Scroll tabs right" })).not.toBeInTheDocument();
		expect(tabList.querySelector(".topbar-tabs__scroll-fade")).toBeNull();

		clientWidth = 56;
		fireEvent.scroll(tabList);
		expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeInTheDocument();
	});

	it("moves focus with arrow, Home, and End keys without activating a tab", () => {
		renderTabs();
		const tabList = screen.getByRole("tablist");
		const tabs = within(tabList).getAllByRole("tab");
		tabs[1].focus();
		fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
		expect(tabs[2]).toHaveFocus();
		fireEvent.keyDown(tabs[2], { key: "Home" });
		expect(tabs[0]).toHaveFocus();
		fireEvent.keyDown(tabs[0], { key: "End" });
		expect(tabs.at(-1)).toHaveFocus();
		expect(routeMocks.navigate).not.toHaveBeenCalled();
	});

	it("leaves caret navigation in the inline rename input alone", async () => {
		const user = userEvent.setup();
		renderTabs();
		const tab = screen.getByRole("tab", { name: /Task One/ });
		tab.focus();
		await user.keyboard("{F2}");

		const input = screen.getByRole("textbox", { name: "Rename Task One" });
		expect(input).toHaveFocus();
		await user.keyboard("{ArrowLeft}{Home}");
		expect(input).toHaveFocus();
		expect(screen.queryByRole("tab", { name: /Task One/ })).not.toBeInTheDocument();
		expect(renameSessionMock).not.toHaveBeenCalled();
	});

	it("offers rename and handles F2 on a non-session route without a caller callback", async () => {
		const user = userEvent.setup();
		routeMocks.params.sessionId = undefined;
		renderTabs();
		const tab = screen.getByRole("tab", { name: /Task One/ });
		const wrapper = tab.closest<HTMLElement>('[data-testid="topbar-tab"]');
		expect(wrapper).not.toBeNull();
		await user.click(within(wrapper!).getByRole("button", { name: "Tab options" }));
		await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const menuInput = screen.getByRole("textbox", { name: "Rename Task One" });
		fireEvent.keyDown(menuInput, { key: "Escape" });

		const taskTab = screen.getByRole("tab", { name: /Task One/ });
		taskTab.focus();
		await user.keyboard("{F2}");
		const input = screen.getByRole("textbox", { name: "Rename Task One" });
		await user.clear(input);
		await user.type(input, "Renamed off route");
		await user.keyboard("{Enter}");
		await waitFor(() => expect(renameSessionMock).toHaveBeenCalledWith("task-1", "Renamed off route"));
	});

	it("keeps only the active tab tabbable and falls back to the first rendered tab", () => {
		const { rerender } = renderTabs();
		const selectedTabList = screen.getByRole("tablist");
		const selectedTabs = within(selectedTabList).getAllByRole("tab");
		expect(selectedTabs.filter((tab) => tab.tabIndex === 0)).toEqual([selectedTabs[1]]);

		routeMocks.params.sessionId = "not-rendered";
		rerender(tree(<TopbarTabs />));
		const unselectedTabs = within(screen.getByRole("tablist")).getAllByRole("tab");
		expect(unselectedTabs.filter((tab) => tab.tabIndex === 0)).toEqual([unselectedTabs[0]]);
	});

	it("reveals the active tab inside the clipped viewport and reruns when the reserve changes", () => {
		const revealScrollLeftSpy = vi.spyOn(topbarTabsView, "computeRevealScrollLeft");
		const queryClient = new QueryClient();
		const view = renderTabs({ actionsReservePx: 300 }, queryClient);
		const tabList = screen.getByRole("tablist");
		const activeWrapper = screen.getByRole("tab", { name: /Task Two/ }).closest<HTMLElement>('[data-testid="topbar-tab"]');
		expect(activeWrapper).not.toBeNull();
		Object.defineProperty(tabList, "clientWidth", { configurable: true, value: 800 });
		Object.defineProperty(tabList, "scrollLeft", { configurable: true, value: 0, writable: true });
		const scrollTo = vi.fn();
		Object.defineProperty(tabList, "scrollTo", { configurable: true, value: scrollTo });
		const rect = (left: number, right: number) => ({
			bottom: 36,
			height: 36,
			left,
			right,
			top: 0,
			width: right - left,
			x: left,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
		Object.defineProperty(tabList, "getBoundingClientRect", { configurable: true, value: () => rect(0, 800) });
		Object.defineProperty(tabList, "scrollWidth", { configurable: true, value: 1000 });
		Object.defineProperty(activeWrapper!, "getBoundingClientRect", { configurable: true, value: () => rect(600, 850) });
		fireEvent.scroll(tabList);

		routeMocks.params.sessionId = "task-2";
		view.rerender(tree(<TopbarTabs actionsReservePx={300} />, queryClient));
		expect(revealScrollLeftSpy).toHaveBeenLastCalledWith(expect.objectContaining({ actionsReservePx: 0 }));
		expect(scrollTo).toHaveBeenLastCalledWith({ left: 78, behavior: "smooth" });
		const callsBeforeReserveChange = revealScrollLeftSpy.mock.calls.length;

		view.rerender(tree(<TopbarTabs actionsReservePx={400} />, queryClient));
		expect(revealScrollLeftSpy).toHaveBeenCalledTimes(callsBeforeReserveChange + 1);
		expect(revealScrollLeftSpy).toHaveBeenLastCalledWith(expect.objectContaining({ actionsReservePx: 0 }));
		expect(scrollTo).toHaveBeenLastCalledWith({ left: 78, behavior: "smooth" });
	});

	it("does not reveal the active tab again when manual scrolling changes chevron visibility", async () => {
		routeMocks.params.sessionId = "orch-1";
		const queryClient = new QueryClient();
		const view = renderTabs({}, queryClient);
		const tabList = screen.getByRole("tablist");
		const wrappers = screen.getAllByTestId("topbar-tab");
		let scrollLeft = 0;
		Object.defineProperty(tabList, "clientWidth", { configurable: true, value: 400 });
		Object.defineProperty(tabList, "scrollWidth", { configurable: true, value: 1200 });
		Object.defineProperty(tabList, "scrollLeft", {
			configurable: true,
			get: () => scrollLeft,
			set: (value: number) => { scrollLeft = value; },
		});
		const rect = (left: number, right: number) => ({
			bottom: 36,
			height: 36,
			left,
			right,
			top: 0,
			width: right - left,
			x: left,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
		Object.defineProperty(tabList, "getBoundingClientRect", { configurable: true, value: () => rect(0, 400) });
		wrappers.forEach((wrapper, index) => {
			Object.defineProperty(wrapper, "getBoundingClientRect", {
				configurable: true,
				value: () => rect(index * 180 - scrollLeft, (index + 1) * 180 - scrollLeft),
			});
		});
		const scrollBy = vi.fn();
		const scrollTo = vi.fn();
		Object.defineProperty(tabList, "scrollBy", { configurable: true, value: scrollBy });
		Object.defineProperty(tabList, "scrollTo", { configurable: true, value: scrollTo });
		fireEvent.scroll(tabList);
		const rightChevron = await screen.findByRole("button", { name: "Scroll tabs right" });
		await userEvent.click(rightChevron);
		expect(scrollBy).toHaveBeenCalledWith({ left: 320, behavior: "smooth" });
		scrollLeft = 320;
		fireEvent.scroll(tabList);

		expect(await screen.findByRole("button", { name: "Scroll tabs left" })).toBeInTheDocument();
		expect(scrollLeft).toBe(320);
		expect(scrollTo).not.toHaveBeenCalled();

		routeMocks.params.sessionId = "task-3";
		view.rerender(tree(<TopbarTabs />, queryClient));
		expect(scrollTo).toHaveBeenCalledWith({ left: 528, behavior: "smooth" });
	});

	it("attaches overflow behavior after wrap switches to scroll and detaches it on return", async () => {
		useTopbarTabsStore.setState({ overflow: "wrap" });
		renderTabs();
		const tabList = screen.getByRole("tablist");
		Object.defineProperty(tabList, "scrollWidth", { configurable: true, value: 500 });
		Object.defineProperty(tabList, "clientWidth", { configurable: true, value: 250 });
		const scrollBy = vi.fn();
		Object.defineProperty(tabList, "scrollBy", { configurable: true, value: scrollBy });
		const wheelEvent = () => new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });

		const wrapWheel = wheelEvent();
		tabList.dispatchEvent(wrapWheel);
		expect(wrapWheel.defaultPrevented).toBe(false);
		expect(screen.queryByRole("button", { name: "Scroll tabs right" })).not.toBeInTheDocument();

		act(() => useTopbarTabsStore.setState({ overflow: "scroll" }));
		expect(await screen.findByRole("button", { name: "Scroll tabs right" })).toBeInTheDocument();
		const scrollWheel = wheelEvent();
		tabList.dispatchEvent(scrollWheel);
		expect(scrollWheel.defaultPrevented).toBe(true);
		expect(scrollBy).toHaveBeenCalledWith({ left: 80 });

		act(() => useTopbarTabsStore.setState({ overflow: "wrap" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Scroll tabs right" })).not.toBeInTheDocument());
		const returnedToWrapWheel = wheelEvent();
		tabList.dispatchEvent(returnedToWrapWheel);
		expect(returnedToWrapWheel.defaultPrevented).toBe(false);
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("renders an accessible empty tablist while keeping its reserved row", () => {
		setTabs([]);
		const { container } = renderTabs({ actionsReservePx: 48 });

		const tabList = screen.getByRole("tablist", { name: "Project tabs" });
		expect(tabList).toHaveAttribute("data-testid", "topbar-tabs");
		expect(tabList).toHaveClass("topbar-tabs");
		expect(tabList.childElementCount).toBe(0);
		expect(tabList.style.getPropertyValue("--topbar-actions-w")).toBe("48px");
		expect(screen.getByTestId("topbar-tabs-viewport")).toHaveClass("topbar-tabs__viewport");
		expect(container.querySelector("[role=tab]")).not.toBeInTheDocument();
	});

	it("renders standalone session tabs without a project head", () => {
		const scratch = {
			id: STANDALONE_WORKSPACE_ID,
			collapsed: false,
			head: { sessionId: null, mode: "persistent" as const, lastActiveAt: 0 },
			tabs: [{ sessionId: "scratch-1", mode: "persistent" as const, lastActiveAt: 0 }],
		};
		workspaceQueryMock.mockReturnValue({ data: workspaces });
		useTopbarTabsStore.setState({ colorCoding: true, projectColors: { [STANDALONE_WORKSPACE_ID]: 4 } });
		routeMocks.params.sessionId = "scratch-1";
		setTabs([scratch]);
		renderTabs();

		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(screen.getByRole("tab")).toHaveTextContent("scratch-1");
		expect(screen.getByTestId("topbar-tab")).not.toHaveAttribute("data-accent");
		expect(screen.getByTestId("topbar-tab").querySelector("[data-testid^='topbar-tab-accent-']")).not.toBeInTheDocument();
	});

	it("does not render tabs again for an unrelated workspace session update", () => {
		setTabs([group("project-1", "orch-1", ["task-1", "task-2"])]);
		const unrelatedSession = {
			...sessions[3],
			id: "unrelated-session",
			workspaceId: "project-1",
			workspaceName: "Project One",
			title: "Unrelated before",
		};
		const initialWorkspaces = [{ ...workspaces[0], sessions: [...workspaces[0].sessions, unrelatedSession] }];
		const updatedUnrelatedSession = { ...unrelatedSession, title: "Unrelated after" };
		const queryClient = new QueryClient();
		workspaceQueryMock.mockReturnValue({ data: initialWorkspaces });
		const view = renderTabs({}, queryClient);
		expect(Object.values(topbarTabRenderCounts.byKey)).toEqual([1, 1, 1]);

		workspaceQueryMock.mockReturnValue({
			data: [{ ...workspaces[0], sessions: [...workspaces[0].sessions, updatedUnrelatedSession] }],
		});
		view.rerender(tree(<TopbarTabs />, queryClient));
		expect(Object.values(topbarTabRenderCounts.byKey)).toEqual([1, 1, 1]);
	});
});
