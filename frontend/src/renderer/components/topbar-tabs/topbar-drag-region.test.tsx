import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useUiStore } from "../../stores/ui-store";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { TooltipProvider } from "../ui/tooltip";
import { TopbarTabsRow } from "./TopbarTabsRow";
import { TopbarToolbar } from "./TopbarToolbar";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: "task-1" as string | undefined },
}));
const workspaceQueryMock = vi.hoisted(() => vi.fn());
const platformMocks = vi.hoisted(() => ({ isLinuxPlatform: vi.fn(() => false), isMacPlatform: vi.fn(() => true) }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => routeMocks.navigate, useParams: () => routeMocks.params };
});
vi.mock("../../hooks/useWorkspaceQuery", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../hooks/useWorkspaceQuery")>();
	return { ...actual, useWorkspaceQuery: workspaceQueryMock };
});
vi.mock("../../hooks/useWindowFullScreen", () => ({ useWindowFullScreen: () => false }));
vi.mock("../../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/platform")>();
	return { ...actual, isLinuxPlatform: platformMocks.isLinuxPlatform, isMacPlatform: platformMocks.isMacPlatform };
});

const sessions: WorkspaceSession[] = ["task-1", "task-2"].map((id) => ({
	id,
	workspaceId: "project-1",
	workspaceName: "Project One",
	title: id,
	provider: "codex",
	kind: "worker",
	branch: `ao/${id}`,
	status: "working",
	updatedAt: "2026-10-01T00:00:00Z",
	prs: [],
}));
const workspaces: WorkspaceSummary[] = [
	{ id: "project-1", name: "Project One", path: "/project-1", orchestratorAgent: "codex", kind: "single_repo", sessions },
];

type RegionStyle = CSSStyleDeclaration & { WebkitAppRegion?: string };

function region(element: Element): string {
	return (element as HTMLElement).style ? ((element as HTMLElement).style as RegionStyle).WebkitAppRegion ?? "" : "";
}

/** The app region a pointer over `element` resolves to: its own, else the closest ancestor's. */
function effectiveRegion(element: Element): string {
	for (let node: Element | null = element; node; node = node.parentElement) {
		const declared = region(node);
		if (declared) return declared;
	}
	return "";
}

function tree(children: ReactNode) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

function expectInteractiveNoDrag(container: HTMLElement): void {
	const controls = Array.from(container.querySelectorAll("button, [role='tab']"));
	expect(controls.length).toBeGreaterThan(0);
	for (const control of controls) {
		// Resolved without the control's own declaration: the container above it must already be no-drag.
		const parent = control.parentElement;
		expect(effectiveRegion(parent as Element), control.outerHTML.slice(0, 80)).toBe("no-drag");
	}
}

beforeEach(() => {
	localStorage.clear();
	platformMocks.isMacPlatform.mockReturnValue(true);
	platformMocks.isLinuxPlatform.mockReturnValue(false);
	workspaceQueryMock.mockReturnValue({ data: workspaces });
	useUiStore.setState({ isSidebarOpen: false });
	useTopbarTabsStore.setState({
		tabs: {
			version: 1,
			groups: [{
				id: "project-1",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: sessions.map((session) => ({ sessionId: session.id, mode: "persistent", lastActiveAt: 0 })),
			}],
		},
		density: "comfortable",
		overflow: "scroll",
	});
});

describe("macOS topbar drag regions", () => {
	it("keeps every tab and action inside a no-drag container, never a bare carve-out in a drag ancestor", () => {
		render(tree(<TopbarToolbar actions={<button type="button">Action</button>} />));

		expectInteractiveNoDrag(screen.getByTestId("session-topbar-toolbar"));
	});

	it("keeps the remote session tab strip and the grouped tab row inside no-drag containers", () => {
		const { unmount } = render(tree(<TopbarToolbar actions={null} remoteSessionTab={<button role="tab" type="button">Remote</button>} />));
		expectInteractiveNoDrag(screen.getByTestId("session-topbar-toolbar"));
		unmount();

		render(tree(<TopbarTabsRow />));
		expectInteractiveNoDrag(screen.getByTestId("topbar-tabs-row"));
	});

	it("exposes empty header space for dragging only through dedicated filler elements", () => {
		render(tree(<TopbarToolbar actions={<button type="button">Action</button>} />));

		const filler = screen.getByTestId("topbar-tabs-drag-filler");
		expect(region(filler)).toBe("drag");
		expect(filler).toHaveAttribute("aria-hidden", "true");
		expect(filler.children).toHaveLength(0);
		const toolbar = screen.getByTestId("session-topbar-toolbar");
		const draggers = Array.from(toolbar.querySelectorAll("*")).filter((node) => region(node) === "drag");
		// Besides the filler, only the clearance region that holds the strip may be drag, and the strip carves itself out.
		expect(draggers).toContain(filler);
		expect(draggers.filter((node) => node.querySelector("button, [role='tab']") === null)).toEqual([filler]);
	});

	it("declares no app region on non-mac platforms", () => {
		platformMocks.isMacPlatform.mockReturnValue(false);
		render(tree(<TopbarToolbar actions={<button type="button">Action</button>} />));

		const toolbar = screen.getByTestId("session-topbar-toolbar");
		expect(Array.from(toolbar.querySelectorAll("*")).filter((node) => region(node) !== "")).toEqual([]);
	});

	it("does not let the shared session topbar host stylesheet rule mark the whole header as drag", () => {
		const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
		const rules = css.split("}").filter((rule) => rule.includes("session-topbar-host"));

		expect(rules.filter((rule) => rule.includes("-webkit-app-region"))).toEqual([]);
	});
});
