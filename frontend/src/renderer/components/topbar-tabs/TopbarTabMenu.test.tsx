import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useUiStore } from "../../stores/ui-store";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { STANDALONE_WORKSPACE_ID, type WorkspaceSession } from "../../types/workspace";
import { TopbarTab, type SessionTabActions, type TopbarTabProps } from "./TopbarTab";
import { useTopbarTabMenu } from "./TopbarTabMenu";
import { TopbarTabs } from "./TopbarTabs";
import type { TopbarTabView } from "./topbar-tabs-view";
import { ContextMenuItem } from "../ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { SwitchAgentDialog } from "../SwitchAgentDialog";
import { TerminalSwitchAgentButton } from "../TerminalSwitchAgentButton";
import { TooltipProvider } from "../ui/tooltip";

const routerMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: "project-1" as string | undefined, sessionId: undefined as string | undefined },
}));

const menuMocks = vi.hoisted(() => ({
	openOrchestrator: vi.fn(),
	useProjectOrchestratorAction: vi.fn(),
	useWorkspaceScope: vi.fn(),
	useWorkspaceQuery: vi.fn(),
}));

const switchAgentApiMocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => routerMocks.navigate,
	useParams: () => routerMocks.params,
}));

vi.mock("../../hooks/useProjectOrchestratorAction", () => ({
	useProjectOrchestratorAction: menuMocks.useProjectOrchestratorAction,
}));

vi.mock("../../hooks/useWorkspaceQuery", () => ({
	useWorkspaceScope: menuMocks.useWorkspaceScope,
	useWorkspaceQuery: menuMocks.useWorkspaceQuery,
}));

vi.mock("../../lib/api-client", () => ({
	apiClient: {
		GET: switchAgentApiMocks.get,
		POST: switchAgentApiMocks.post,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

const session: WorkspaceSession = {
	id: "task-1",
	workspaceId: "project-1",
	workspaceName: "Project One",
	title: "Task One",
	provider: "codex",
	status: "working",
	updatedAt: "2026-10-01T00:00:00Z",
	prs: [],
};

function makeView(
	role: TopbarTabView["role"],
	options: { mode?: TopbarTabView["mode"]; anchor?: boolean; groupId?: string } = {},
): TopbarTabView {
	const isAnchor = role === "head" && options.anchor === true;
	const groupId = options.groupId ?? (role === "scratch" ? STANDALONE_WORKSPACE_ID : "project-1");
	const sessionId = isAnchor ? null : role === "head" ? "orch-1" : "task-1";
	return {
		key: sessionId ?? `anchor:${groupId}`,
		sessionId,
		role,
		groupId,
		mode: options.mode ?? "persistent",
		label: role === "head" ? "Project One" : role === "scratch" ? "Scratchpad" : "Task One",
		session: sessionId ? { ...session, id: sessionId, workspaceId: groupId } : undefined,
		isActive: true,
		isAnchor,
	};
}

function tabGroup(view: TopbarTabView) {
	const tabs = view.role === "head"
		? ["task-1", "task-2"]
		: [view.sessionId ?? "task-1", view.role === "scratch" ? "scratch-2" : "task-2"];
	return {
		id: view.groupId,
		collapsed: false,
		head: {
			sessionId: view.role === "head" ? view.sessionId : null,
			mode: view.mode,
			lastActiveAt: 0,
		},
		tabs: tabs.map((sessionId, index) => ({
			sessionId,
			mode: index === 0 ? view.mode : "persistent" as const,
			lastActiveAt: index,
		})),
	};
}

function setTabs(view: TopbarTabView, tabIds?: string[]) {
	const group = tabGroup(view);
	if (tabIds) group.tabs = tabIds.map((sessionId, index) => ({
		sessionId,
		mode: index === 0 ? view.mode : "persistent" as const,
		lastActiveAt: index,
	}));
	useTopbarTabsStore.setState({
		tabs: {
			version: 1,
			groups: [
				group,
				{
					id: "project-2",
					collapsed: false,
					head: { sessionId: "orch-2", mode: "persistent", lastActiveAt: 0 },
					tabs: [{ sessionId: "task-3", mode: "persistent", lastActiveAt: 0 }],
				},
			],
		},
		density: "comfortable",
		overflow: "scroll",
		colorCoding: false,
		projectColors: {},
	});
}

function MenuHarness({ view, tabAction }: { view: TopbarTabView; tabAction?: SessionTabActions }) {
	const renderMenu = useTopbarTabMenu(true);
	return (
		<TopbarTab
			view={view}
			density="comfortable"
			onActivate={vi.fn()}
			onClose={vi.fn()}
			onPersist={vi.fn()}
			onRenamed={vi.fn()}
			renderMenu={renderMenu}
			tabAction={tabAction}
		/>
	);
}

const switchAgentSession: WorkspaceSession = {
	...session,
	kind: "worker",
	branch: "ao/task-1",
	activity: { state: "active", lastActivityAt: "2026-10-01T00:00:00Z" },
};

function SwitchAgentTabHarness() {
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(false);
	const view = makeView("task");
	const renderMenu: TopbarTabProps["renderMenu"] = ({ kind, sessionMenuItems }) => kind === "dropdown" ? (
		<>
			{sessionMenuItems}
			<DropdownMenuSeparator />
			<DropdownMenuItem>Close tab</DropdownMenuItem>
		</>
	) : <ContextMenuItem>Close tab</ContextMenuItem>;
	return (
		<div className="relative" data-testid="terminal-container" ref={setContainer}>
			<TopbarTab
				view={{ ...view, session: switchAgentSession, sessionId: switchAgentSession.id }}
				density="comfortable"
				onActivate={vi.fn()}
				onClose={vi.fn()}
				onPersist={vi.fn()}
				renderMenu={renderMenu}
				tabAction={{
					menuItems: (
						<TerminalSwitchAgentButton
							container={container}
							onOpenChange={setOpen}
							open={open}
							session={switchAgentSession}
							switchError={null}
							variant="menu-item"
						/>
					),
				}}
			/>
			{container ? (
				<SwitchAgentDialog container={container} onOpenChange={setOpen} open={open} session={switchAgentSession} />
			) : null}
		</div>
	);
}

function renderSwitchAgentTab() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
			<TooltipProvider>
				<SwitchAgentTabHarness />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

function fakeMenuExitAnimation(): () => void {
	const original = window.getComputedStyle;
	const real = original.bind(window);
	Object.defineProperty(window, "getComputedStyle", {
		configurable: true,
		writable: true,
		value: (element: Element, pseudo?: string | null) => {
			const styles = real(element, pseudo);
			if (element.getAttribute("role") !== "menu") return styles;
			return new Proxy(styles, {
				get(target, property) {
					if (property === "animationName") {
						return element.getAttribute("data-state") === "closed"
							? "animate-popover-out"
							: "animate-popover-in";
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? (value as () => unknown).bind(target) : value;
				},
			}) as CSSStyleDeclaration;
		},
	});
	return () => Object.defineProperty(window, "getComputedStyle", {
		configurable: true,
		writable: true,
		value: original,
	});
}

function dispatchAnimationEnd(element: Element, animationName: string) {
	const event = new Event("animationend");
	Object.defineProperty(event, "animationName", { value: animationName });
	element.dispatchEvent(event);
}

async function waitForMenuTeardown() {
	await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderTab(view: TopbarTabView, tabAction?: SessionTabActions) {
	previousUnmount?.();
	setTabs(view);
	const rendered = render(<MenuHarness tabAction={tabAction} view={view} />);
	previousUnmount = rendered.unmount;
	return rendered;
}

async function openMenu(kind: "dropdown" | "context") {
	if (kind === "dropdown") {
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
	} else {
		fireEvent.contextMenu(screen.getByTestId("topbar-tab"));
	}
	return screen.findByRole("menu");
}

let clipboardDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;
let previousUnmount: (() => void) | undefined;

beforeEach(() => {
	localStorage.clear();
	routerMocks.navigate.mockReset();
	routerMocks.params.projectId = "project-1";
	routerMocks.params.sessionId = undefined;
	menuMocks.openOrchestrator.mockReset();
	menuMocks.useProjectOrchestratorAction.mockReset().mockReturnValue({ openOrchestrator: menuMocks.openOrchestrator });
	menuMocks.useWorkspaceScope.mockReset().mockReturnValue({
		data: {
			project: { id: "project-1", kind: "single_repo", name: "Project One", orchestratorAgent: "codex" },
			orchestrator: undefined,
		},
	});
	menuMocks.useWorkspaceQuery.mockReset().mockReturnValue({ data: [] });
	switchAgentApiMocks.get.mockReset().mockImplementation(async (path: string, options?: { params?: { path?: { agent?: string } } }) => {
		if (path === "/api/v1/agents/{agent}/models") {
			const agentId = options?.params?.path?.agent ?? "codex";
			return {
				data: {
					agentId,
					allowCustom: false,
					fetchedAt: "2026-10-01T00:00:00Z",
					models: [{ id: agentId === "codex" ? "gpt-5.4" : "claude-opus-4-6", label: "Default" }],
					selectionMode: "catalog",
					source: "test",
					stale: false,
				},
				error: undefined,
				response: { status: 200 },
			};
		}
		return { data: { switches: [] }, error: undefined, response: { status: 200 } };
	});
	switchAgentApiMocks.post.mockReset();
	useUiStore.setState({ newTaskRequest: null, globalToast: null, globalToasts: [], globalToastSequence: 0 });
	clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
	previousUnmount?.();
	previousUnmount = undefined;
	if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	else Reflect.deleteProperty(navigator, "clipboard");
	vi.restoreAllMocks();
});

describe("TopbarTabMenu", () => {
	it("keeps the switch-agent dialog open after selecting it from the active tab menu", async () => {
		renderSwitchAgentTab();

		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));

		const dialog = await screen.findByRole("dialog", { name: "Switch agent" });
		await waitForMenuTeardown();
		const trigger = screen.getByRole("button", { name: "Tab options" });
		expect(screen.getByRole("dialog", { name: "Switch agent" })).toBe(dialog);
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(trigger);
	});

	it("keeps focus inside the switch-agent dialog through the tab menu's exit animation", async () => {
		const restoreStyles = fakeMenuExitAnimation();
		try {
			renderSwitchAgentTab();
			await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
			await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));

			const dialog = await screen.findByRole("dialog", { name: "Switch agent", hidden: true });
			const menu = screen.getByRole("menu");
			expect(menu.getAttribute("data-state")).toBe("closed");
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Tab options", hidden: true }));

			dispatchAnimationEnd(menu, "animate-popover-out");
			await waitForMenuTeardown();

			expect(screen.getByRole("dialog", { name: "Switch agent" })).toBe(dialog);
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Tab options" }));
		} finally {
			restoreStyles();
		}
	});

	it("still closes the switch-agent dialog on a genuine outside click", async () => {
		renderSwitchAgentTab();
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));
		await screen.findByRole("dialog", { name: "Switch agent" });

		await waitForMenuTeardown();
		await userEvent.click(document.body);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("treats a later options-button click as an outside interaction", async () => {
		renderSwitchAgentTab();
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));
		await screen.findByRole("dialog", { name: "Switch agent" });

		await waitForMenuTeardown();
		expect(screen.getByRole("dialog", { name: "Switch agent" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("dismisses the dialog when focus moves to the options button later", async () => {
		renderSwitchAgentTab();
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Switch agent" }));
		await screen.findByRole("dialog", { name: "Switch agent" });
		await waitForMenuTeardown();

		const trigger = screen.getByRole("button", { name: "Tab options" });
		trigger.blur();
		trigger.focus();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("puts active session actions before the tab entries in dropdowns only", async () => {
		const view = makeView("task", { mode: "preview" });
		const tabAction = {
			menuItems: <><DropdownMenuItem>Switch to chat UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
		};
		renderTab(view, tabAction);
		const tab = screen.getByTestId("topbar-tab");
		expect(within(tab).getAllByRole("button", { name: "Tab options" })).toHaveLength(1);
		expect(tab.querySelector("[data-session-actions-trigger]")).not.toBeInTheDocument();

		const dropdown = await openMenu("dropdown");
		expect(within(dropdown).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
			"Switch to chat UI",
			"Switch agent",
			"Rename",
			"Keep open",
			"Close",
			"Close other tabs",
			"Close to the right",
			"Close all",
			"Copy session link",
		]);
		expect(within(dropdown).getAllByRole("separator")).toHaveLength(2);

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
		const context = await openMenu("context");
		expect(within(context).queryByRole("menuitem", { name: "Switch to chat UI" })).not.toBeInTheDocument();
		expect(within(context).queryByRole("menuitem", { name: "Switch agent" })).not.toBeInTheDocument();
		expect(within(context).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
	});

	it("keeps session actions reachable from an active orchestrator head", async () => {
		const tabAction = {
			menuItems: <><DropdownMenuItem>Switch to terminal UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
		};
		renderTab(makeView("head"), tabAction);

		const menu = await openMenu("dropdown");
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
			"Switch to terminal UI",
			"Switch agent",
			"Hide task tabs",
			"New task",
			"Close group",
			"Close to the right",
			"Close other groups",
		]);
	});

	it.each(["dropdown", "context"] as const)("allows a project colour override from the %s head menu", async (kind) => {
		renderTab(makeView("head"));
		useTopbarTabsStore.setState({ colorCoding: true, projectColors: { "project-1": 2 } });

		const menu = await openMenu(kind);
		const palette = within(menu).getByRole("group", { name: "Project colour" });
		const swatches = within(palette).getAllByRole("button", { name: /^Colour \d+ of 10$/ });
		expect(swatches).toHaveLength(10);
		expect(swatches[2]).toHaveAttribute("aria-pressed", "true");
		expect(swatches[5]).toHaveAttribute("aria-pressed", "false");

		await userEvent.click(swatches[5]);

		expect(useTopbarTabsStore.getState().projectColors["project-1"]).toBe(5);
		expect(screen.getByRole("menu")).toBeInTheDocument();
		expect(within(palette).getByRole("button", { name: "Colour 6 of 10" })).toHaveAttribute("aria-pressed", "true");
	});

	it.each([
		[
			"task",
			makeView("task", { mode: "preview" }),
			["Rename", "Keep open", "Close", "Close other tabs", "Close to the right", "Close all", "Copy session link"],
		],
		[
			"orchestrator head",
			makeView("head"),
			["Hide task tabs", "New task", "Close group", "Close to the right", "Close other groups"],
		],
		[
			"anchor head",
			makeView("head", { anchor: true }),
			["Open orchestrator", "Hide task tabs", "New task", "Close group", "Close to the right", "Close other groups"],
		],
		[
			"scratchpad",
			makeView("scratch", { mode: "preview" }),
			["Rename", "Keep open", "Close", "Close other scratchpads", "Close to the right", "Close all", "Copy session link"],
		],
	] as const)("opens the %s menu with the expected entries from the dropdown", async (_name, view, expected) => {
		renderTab(view);
		const menu = await openMenu("dropdown");
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(expected);
	});

	it.each([
		[
			"task",
			makeView("task", { mode: "preview" }),
			["Rename", "Keep open", "Close", "Close other tabs", "Close to the right", "Close all", "Copy session link"],
		],
		[
			"orchestrator head",
			makeView("head"),
			["Hide task tabs", "New task", "Close group", "Close to the right", "Close other groups"],
		],
		[
			"anchor head",
			makeView("head", { anchor: true }),
			["Open orchestrator", "Hide task tabs", "New task", "Close group", "Close to the right", "Close other groups"],
		],
		[
			"scratchpad",
			makeView("scratch", { mode: "preview" }),
			["Rename", "Keep open", "Close", "Close other scratchpads", "Close to the right", "Close all", "Copy session link"],
		],
	] as const)("opens the %s menu with the same entries from right-click", async (_name, view, expected) => {
		renderTab(view);
		const menu = await openMenu("context");
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(expected);
	});

	it("starts inline rename from the menu", async () => {
		renderTab(makeView("task", { mode: "persistent" }));
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		expect(await screen.findByRole("textbox", { name: "Rename Task One" })).toBeInTheDocument();
	});

	it("keeps preview tabs open and closes a selected task", async () => {
		const view = makeView("task", { mode: "preview" });
		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Keep open" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs[0]?.mode).toBe("persistent");

		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: /^Close$/ }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs.map((tab) => tab.sessionId)).toEqual(["task-2"]);
	});

	it("closes other task tabs and scratchpads within their group", async () => {
		const taskView = makeView("task");
		renderTab(taskView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close other tabs" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs.map((tab) => tab.sessionId)).toEqual(["task-1"]);

		const scratchView = makeView("scratch");
		renderTab(scratchView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close other scratchpads" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs.map((tab) => tab.sessionId)).toEqual(["task-1"]);
	});

	it("closes tabs to the right and all task tabs from their menu items", async () => {
		const taskView = makeView("task");
		renderTab(taskView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close to the right" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs.map((tab) => tab.sessionId)).toEqual(["task-1"]);

		renderTab(taskView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close all" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.head.sessionId).toBeNull();
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs).toEqual([]);

		const scratchView = makeView("scratch");
		renderTab(scratchView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close all" }));
		expect(useTopbarTabsStore.getState().tabs.groups.map((group) => group.id)).toEqual(["project-2"]);
	});

	it("closes all tasks from a head without closing the head", async () => {
		const headView = makeView("head");
		renderTab(headView);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close to the right" }));

		expect(useTopbarTabsStore.getState().tabs.groups[0]?.head.sessionId).toBe("orch-1");
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.tabs).toEqual([]);
	});

	it("copies a canonical session link and shows a global toast", async () => {
		renderTab(makeView("task"));
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Copy session link" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("ao://sessions/project-1/task-1"));
		expect(useUiStore.getState().globalToast?.title).toBe("Session link copied");
	});

	it("toggles task visibility, requests a new task, and closes the group", async () => {
		const view = makeView("head", { anchor: true });
		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Hide task tabs" }));
		expect(useTopbarTabsStore.getState().tabs.groups[0]?.collapsed).toBe(true);

		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "New task" }));
		expect(useUiStore.getState().newTaskRequest?.projectId).toBe("project-1");

		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close group" }));
		expect(useTopbarTabsStore.getState().tabs.groups.map((group) => group.id)).toEqual(["project-2"]);
	});

	it("closes other groups and opens the orchestrator from an anchor item", async () => {
		const view = makeView("head", { anchor: true });
		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Close other groups" }));
		expect(useTopbarTabsStore.getState().tabs.groups.map((group) => group.id)).toEqual(["project-1"]);

		routerMocks.params.sessionId = "task-1";
		renderTab(view);
		await openMenu("dropdown");
		await userEvent.click(screen.getByRole("menuitem", { name: "Open orchestrator" }));
		expect(menuMocks.useWorkspaceScope).toHaveBeenCalledWith("project-1", undefined);
		expect(menuMocks.useProjectOrchestratorAction).toHaveBeenCalledWith(expect.objectContaining({
			projectId: "project-1",
			source: "topbar",
			sessionId: "task-1",
		}));
		expect(menuMocks.openOrchestrator).toHaveBeenCalledOnce();
	});

	it("disables group visibility and close-others entries when each only item is alone", async () => {
		const anchor = makeView("head", { anchor: true });
		setTabs(anchor, []);
		useTopbarTabsStore.setState((state) => ({ tabs: { ...state.tabs, groups: state.tabs.groups.slice(0, 1) } }));
		previousUnmount?.();
		const firstRender = render(<MenuHarness view={anchor} />);
		previousUnmount = firstRender.unmount;
		await openMenu("dropdown");
		expect(screen.getByRole("menuitem", { name: "Hide task tabs" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("menuitem", { name: "Close to the right" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("menuitem", { name: "Close other groups" })).toHaveAttribute("aria-disabled", "true");

		const task = makeView("task");
		setTabs(task, ["task-1"]);
		previousUnmount?.();
		const secondRender = render(<MenuHarness view={task} />);
		previousUnmount = secondRender.unmount;
		await openMenu("dropdown");
		expect(screen.getByRole("menuitem", { name: "Close other tabs" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("menuitem", { name: "Close to the right" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("menuitem", { name: "Close all" })).not.toHaveAttribute("aria-disabled", "true");
	});

	it("activates an anchor into the live orchestrator or falls back to its project board", async () => {
		const anchor = makeView("head", { anchor: true });
		setTabs(anchor);
		menuMocks.useWorkspaceQuery.mockReturnValue({ data: [{
			id: "project-1",
			name: "Project One",
			kind: "single_repo",
			path: "/project-1",
			sessions: [],
		}] });
		const firstRender = renderTopbarTabs();
		previousUnmount = firstRender.unmount;
		await userEvent.click(screen.getByRole("tab", { name: "Project One" }));
		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId",
			params: { projectId: "project-1" },
		});

		previousUnmount?.();
		previousUnmount = undefined;
		routerMocks.navigate.mockClear();
		setTabs(anchor);
		const orchestrator: WorkspaceSession = {
			...session,
			id: "orch-1",
			kind: "orchestrator",
		};
		menuMocks.useWorkspaceQuery.mockReturnValue({ data: [{
			id: "project-1",
			name: "Project One",
			kind: "single_repo",
			path: "/project-1",
			sessions: [orchestrator],
		}] });
		const rendered = renderTopbarTabs();
		previousUnmount = rendered.unmount;
		await userEvent.click(screen.getByRole("tab", { name: "Project One" }));
		expect(routerMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "project-1", sessionId: "orch-1" },
		});
	});
});

function renderTopbarTabs() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TopbarTabs />
		</QueryClientProvider>,
	);
}
