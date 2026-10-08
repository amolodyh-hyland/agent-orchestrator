import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useUiStore } from "../../stores/ui-store";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { TooltipProvider } from "../ui/tooltip";
import { TopbarTabsRow } from "./TopbarTabsRow";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: undefined as string | undefined },
}));
const workspaceQueryMock = vi.hoisted(() => vi.fn());
const platformMocks = vi.hoisted(() => ({
	isLinuxPlatform: vi.fn(() => false),
	isMacPlatform: vi.fn(() => false),
}));
const fullScreenMock = vi.hoisted(() => vi.fn(() => false));

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

vi.mock("../../hooks/useWindowFullScreen", () => ({ useWindowFullScreen: fullScreenMock }));

vi.mock("../../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/platform")>();
	return {
		...actual,
		isLinuxPlatform: platformMocks.isLinuxPlatform,
		isMacPlatform: platformMocks.isMacPlatform,
	};
});

const session: WorkspaceSession = {
	id: "task-1",
	workspaceId: "project-1",
	workspaceName: "Project One",
	title: "Task One",
	provider: "codex",
	kind: "worker",
	branch: "ao/task-1",
	status: "working",
	updatedAt: "2026-10-01T00:00:00Z",
	prs: [],
};

const workspaces: WorkspaceSummary[] = [{
	id: "project-1",
	name: "Project One",
	path: "/project-1",
	orchestratorAgent: "codex",
	kind: "single_repo",
	sessions: [session],
}];

function setTabs(groups = [{
	id: "project-1",
	collapsed: false,
	head: { sessionId: null, mode: "persistent" as const, lastActiveAt: 0 },
	tabs: [{ sessionId: session.id, mode: "persistent" as const, lastActiveAt: 0 }],
}]): void {
	useTopbarTabsStore.setState({
		tabs: { version: 1, groups },
		density: "comfortable",
		overflow: "scroll",
		colorCoding: false,
		projectColors: {},
	});
}

function tree(children: ReactNode) {
	return (
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

function renderRow() {
	return render(tree(<TopbarTabsRow />));
}

beforeEach(() => {
	localStorage.clear();
	routeMocks.navigate.mockReset();
	routeMocks.params.projectId = "project-1";
	routeMocks.params.sessionId = undefined;
	workspaceQueryMock.mockReset();
	workspaceQueryMock.mockReturnValue({ data: workspaces });
	platformMocks.isLinuxPlatform.mockReturnValue(false);
	platformMocks.isMacPlatform.mockReturnValue(false);
	fullScreenMock.mockReturnValue(false);
	useUiStore.setState({ isSidebarOpen: true });
	setTabs();
});

describe("TopbarTabsRow", () => {
	it("renders nothing when there are no tab groups", () => {
		setTabs([]);
		renderRow();

		expect(screen.queryByTestId("topbar-tabs-row")).not.toBeInTheDocument();
	});

	it("renders the full-width tab strip on a board route with no action reserve", () => {
		renderRow();

		const row = screen.getByTestId("topbar-tabs-row");
		const tabs = screen.getByRole("tablist", { name: "Project tabs" });
		expect(row).toHaveAttribute("data-density", "comfortable");
		expect(row).toHaveClass("topbar-toolbar", "bg-sidebar");
		expect(screen.getByRole("tab", { name: "Project One" })).toBeInTheDocument();
		expect(tabs.style.getPropertyValue("--topbar-actions-w")).toBe("0px");
	});

	it("uses a no-drag tab viewport and draggable titlebar clearance with the sidebar closed", () => {
		platformMocks.isMacPlatform.mockReturnValue(true);
		useUiStore.setState({ isSidebarOpen: false });
		renderRow();

		const strip = screen.getByTestId("topbar-tabs-row-strip");
		expect(strip).toHaveClass("session-topbar-titlebar-clearance-mac");
		expect((strip.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBeUndefined();
		expect(
			(screen.getByTestId("topbar-tabs-viewport").style as CSSStyleDeclaration & { WebkitAppRegion?: string })
				.WebkitAppRegion,
		).toBe("no-drag");
		expect(
			(screen.getByTestId("topbar-tabs-row-surface").style as CSSStyleDeclaration & { WebkitAppRegion?: string })
				.WebkitAppRegion,
		).toBe("drag");
	});

	it("keeps macOS titlebar clearance in native fullscreen when the sidebar is closed", () => {
		platformMocks.isMacPlatform.mockReturnValue(true);
		useUiStore.setState({ isSidebarOpen: false });
		fullScreenMock.mockReturnValue(true);
		renderRow();

		expect(screen.getByTestId("topbar-tabs-row-strip")).toHaveClass("session-topbar-titlebar-clearance-mac");
	});

	it("uses Linux titlebar clearance with the sidebar closed", () => {
		platformMocks.isLinuxPlatform.mockReturnValue(true);
		useUiStore.setState({ isSidebarOpen: false });
		renderRow();

		expect(screen.getByTestId("topbar-tabs-row-strip")).toHaveClass("session-topbar-titlebar-clearance-linux");
		expect(screen.getByTestId("topbar-tabs-row-strip").getAttribute("style")).toBeNull();
	});

	it("applies the compact density attribute", () => {
		useTopbarTabsStore.setState({ density: "compact" });
		renderRow();

		expect(screen.getByTestId("topbar-tabs-row")).toHaveAttribute("data-density", "compact");
		expect(screen.getByRole("tablist", { name: "Project tabs" })).toHaveAttribute("data-density", "compact");
	});
});
