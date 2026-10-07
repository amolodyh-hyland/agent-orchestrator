import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { TooltipProvider } from "../ui/tooltip";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { TopbarToolbar } from "./TopbarToolbar";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: "task-1" as string | undefined },
}));
const workspaceQueryMock = vi.hoisted(() => vi.fn());

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

const sessions: WorkspaceSession[] = [
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
];

const workspaces: WorkspaceSummary[] = [
	{
		id: "project-1",
		name: "Project One",
		path: "/project-1",
		orchestratorAgent: "codex",
		kind: "single_repo",
		sessions,
	},
];

function setTabs(): void {
	useTopbarTabsStore.setState({
		tabs: {
			version: 1,
			groups: [{
				id: "project-1",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: sessions.map((session) => ({
					sessionId: session.id,
					mode: "persistent",
					lastActiveAt: 0,
				})),
			}],
		},
		density: "comfortable",
		overflow: "scroll",
	});
}

function tree(children: ReactNode) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

function renderToolbar({ actions = <button type="button">Action</button>, ...props }: Partial<ComponentProps<typeof TopbarToolbar>> = {}) {
	return render(tree(<TopbarToolbar {...props} actions={actions} />));
}

beforeEach(() => {
	localStorage.clear();
	routeMocks.navigate.mockReset();
	routeMocks.params.projectId = "project-1";
	routeMocks.params.sessionId = "task-1";
	workspaceQueryMock.mockReset();
	workspaceQueryMock.mockReturnValue({ data: workspaces });
	setTabs();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("TopbarToolbar", () => {
	it("reserves the rounded-up rendered ResizeObserver width for the tab list", () => {
		class ReportingResizeObserver {
			constructor(private readonly callback: ResizeObserverCallback) {}

			observe(target: Element): void {
				this.callback([{
					target,
					borderBoxSize: [{ inlineSize: 71.2, blockSize: 36 }],
					contentRect: new DOMRect(0, 0, 71.2, 36),
				} as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
			}

			unobserve(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal("ResizeObserver", ReportingResizeObserver);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 40.2, 36));

		renderToolbar();

		expect(screen.getByRole("tablist", { name: "Project tabs" }).style.getPropertyValue("--topbar-actions-w")).toBe("41px");
	});

	it("omits the actions region and reserves no width when actions are hidden", () => {
		renderToolbar({ hideActions: true });

		expect(screen.queryByTestId("session-action-region")).not.toBeInTheDocument();
		expect(screen.getByRole("tablist", { name: "Project tabs" }).style.getPropertyValue("--topbar-actions-w")).toBe("0px");
	});

	it("renders the secondary row only when sub-tabs are truthy", () => {
		const view = renderToolbar({ subTabs: <div>secondary tab</div> });
		expect(screen.getByTestId("session-sub-tabs")).toHaveTextContent("secondary tab");

		view.rerender(tree(<TopbarToolbar actions={<button type="button">Action</button>} subTabs={null} />));
		expect(screen.queryByTestId("session-sub-tabs")).not.toBeInTheDocument();
	});

	it("uses the density from the tab store and keeps the compact CSS hook", () => {
		const view = renderToolbar();
		const toolbar = screen.getByTestId("session-topbar-toolbar");
		expect(toolbar).toHaveClass("topbar-toolbar");
		expect(toolbar).toHaveAttribute("data-density", "comfortable");

		act(() => useTopbarTabsStore.setState({ density: "compact" }));
		view.rerender(tree(<TopbarToolbar actions={<button type="button">Action</button>} />));
		expect(screen.getByTestId("session-topbar-toolbar")).toHaveAttribute("data-density", "compact");
		expect(document.querySelector('.topbar-toolbar[data-density="compact"]')).toBeInTheDocument();
	});

	it("returns to the active session and navigates when another session is selected", async () => {
		const user = userEvent.setup();
		const onSelectActiveSession = vi.fn();
		renderToolbar({ onSelectActiveSession });

		await user.click(screen.getByRole("tab", { name: "Task One · Codex · Working" }));
		expect(onSelectActiveSession).toHaveBeenCalledOnce();
		expect(routeMocks.navigate).not.toHaveBeenCalled();

		await user.click(screen.getByRole("tab", { name: /^Task Two · Codex/ }));
		expect(routeMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "task-2" },
		});
	});

	it("forwards Ctrl+Tab from the grouped tab and leaves arrow navigation to the tab list", () => {
		const onTabsKeyDown = vi.fn();
		renderToolbar({ onTabsKeyDown });
		const tab = screen.getByRole("tab", { name: "Task One · Codex · Working" });

		fireEvent.keyDown(tab, { key: "Tab", ctrlKey: true });
		expect(onTabsKeyDown).toHaveBeenCalledOnce();

		onTabsKeyDown.mockClear();
		fireEvent.keyDown(tab, { key: "ArrowRight" });
		expect(onTabsKeyDown).not.toHaveBeenCalled();
	});

	it("merges session actions into the single active tab menu", async () => {
		renderToolbar({
			tabAction: {
				menuItems: <><DropdownMenuItem>Switch to chat UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
			},
		});

		const activeTab = screen.getByRole("tab", { name: "Task One · Codex · Working" });
		const activeWrapper = activeTab.closest<HTMLElement>('[data-testid="topbar-tab"]')!;
		expect(within(activeWrapper).getAllByRole("button", { name: "Tab options" })).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Session actions" })).not.toBeInTheDocument();
		expect(document.querySelectorAll("[data-session-actions-trigger]")).toHaveLength(0);

		await userEvent.click(within(activeWrapper).getByRole("button", { name: "Tab options" }));
		const activeMenu = await screen.findByRole("menu");
		expect(within(activeMenu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
			"Switch to chat UI",
			"Switch agent",
			"Rename",
			"Close",
			"Close other tabs",
			"Close to the right",
			"Close all",
			"Copy session link",
		]);

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
		const inactiveTab = screen.getByRole("tab", { name: /^Task Two · Codex/ });
		const inactiveWrapper = inactiveTab.closest<HTMLElement>('[data-testid="topbar-tab"]')!;
		await userEvent.click(within(inactiveWrapper).getByRole("button", { name: "Tab options" }));
		const inactiveMenu = await screen.findByRole("menu");
		expect(within(inactiveMenu).queryByRole("menuitem", { name: "Switch to chat UI" })).not.toBeInTheDocument();
		expect(within(inactiveMenu).queryByRole("menuitem", { name: "Switch agent" })).not.toBeInTheDocument();
	});
});
