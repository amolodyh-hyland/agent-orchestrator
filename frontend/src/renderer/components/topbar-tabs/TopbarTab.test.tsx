import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../../types/workspace";
import { ContextMenuItem } from "../ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipProvider } from "../ui/tooltip";
import { TopbarTab, type TopbarTabProps } from "./TopbarTab";
import type { TopbarTabView } from "./topbar-tabs-view";

vi.mock("../../lib/rename-session", () => ({
	renameSession: vi.fn(),
}));

import { renameSession } from "../../lib/rename-session";

function makeSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id: "task-1",
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: "Build tabs",
		provider: "codex",
		status: "working",
		activity: { state: "active", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
		...overrides,
	};
}

function makeView(overrides: Partial<TopbarTabView> = {}): TopbarTabView {
	const session = makeSession();
	return {
		key: session.id,
		sessionId: session.id,
		role: "task",
		groupId: session.workspaceId,
		mode: "persistent",
		label: session.title,
		session,
		isActive: true,
		isAnchor: false,
		...overrides,
	};
}

function renderTab(props: Partial<TopbarTabProps> = {}, view = makeView()) {
	return render(
		<TooltipProvider>
			<div role="tablist">
				<TopbarTab
					view={view}
					density="comfortable"
					onActivate={vi.fn()}
					onPersist={vi.fn()}
					onClose={vi.fn()}
					{...props}
				/>
			</div>
		</TooltipProvider>,
	);
}

describe("TopbarTab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("styles preview and persistent task tabs and marks the active tab", () => {
		const { rerender } = renderTab({}, makeView({ mode: "preview" }));
		const previewTab = screen.getByRole("tab");
		expect(previewTab).not.toHaveClass("italic");
		expect(screen.getByText("Build tabs")).toHaveClass("truncate", "italic");
		expect(screen.getByTestId("topbar-tab-active-indicator")).toBeInTheDocument();
		expect(previewTab).toHaveAttribute("aria-selected", "true");
		expect(previewTab).toHaveAttribute("aria-current", "true");

		rerender(
			<TooltipProvider>
				<div role="tablist">
					<TopbarTab
						view={makeView({ mode: "persistent", isActive: false })}
						density="compact"
						onActivate={vi.fn()}
						onPersist={vi.fn()}
						onClose={vi.fn()}
					/>
				</div>
			</TooltipProvider>,
		);
		const persistentTab = screen.getByRole("tab");
		expect(persistentTab).not.toHaveClass("italic");
		expect(screen.getByText("Build tabs")).not.toHaveClass("italic");
		expect(persistentTab).toHaveClass("text-xs", "px-2");
		expect(persistentTab).toHaveAttribute("tabindex", "-1");
		expect(screen.queryByTestId("topbar-tab-active-indicator")).not.toBeInTheDocument();
	});

	it("adds accent layers only while an accent is defined", () => {
		const view = makeView();
		const tab = (accent?: string, tabView = view) => (
			<TooltipProvider>
				<div role="tablist">
					<TopbarTab
						view={tabView}
						density="comfortable"
						onActivate={vi.fn()}
						onPersist={vi.fn()}
						onClose={vi.fn()}
						accent={accent}
					/>
				</div>
			</TooltipProvider>
		);
		const { rerender } = render(tab());
		const wrapper = screen.getByTestId("topbar-tab");
		const unaccentedDom = wrapper.outerHTML;
		expect(wrapper.style.getPropertyValue("--project-accent")).toBe("");
		expect(wrapper).not.toHaveAttribute("data-accent");
		expect(wrapper.querySelector("[data-testid^='topbar-tab-accent-']")).not.toBeInTheDocument();

		rerender(tab("oklch(0.56 0.15 20)"));
		expect(wrapper).toHaveAttribute("data-accent", "true");
		expect(wrapper.style.getPropertyValue("--project-accent")).toBe("oklch(0.56 0.15 20)");
		expect(screen.getByTestId("topbar-tab-accent-indicator")).toHaveAttribute("aria-hidden", "true");
		expect(screen.getByTestId("topbar-tab-accent-tint")).toHaveClass(
			"bg-[color-mix(in_oklch,var(--project-accent)_6%,transparent)]",
		);

		rerender(tab(undefined));
		expect(wrapper.outerHTML).toBe(unaccentedDom);

		const head = makeView({
			key: "anchor:project-1",
			sessionId: null,
			role: "head",
			label: "Project One",
			session: undefined,
			isAnchor: true,
		});
		rerender(tab("oklch(0.56 0.15 20)", head));
		expect(screen.getByTestId("topbar-tab-accent-tint")).toHaveClass(
			"bg-[color-mix(in_oklch,var(--project-accent)_14%,transparent)]",
		);
	});

	it("renders head icon and hidden count and leaves anchors without a status dot", () => {
		const head = makeView({
			key: "anchor:project-1",
			sessionId: null,
			role: "head",
			mode: "persistent",
			label: "Project One",
			session: undefined,
			isAnchor: true,
		});
		renderTab({ hiddenCount: 3 }, head);
		const tab = screen.getByRole("tab", { name: "Project One" });
		expect(tab.querySelector("svg")).toBeInTheDocument();
		expect(tab.querySelector("img")).not.toBeInTheDocument();
		expect(screen.getByText("+3")).toBeInTheDocument();
		expect(screen.getByLabelText("3 hidden tabs")).toBeInTheDocument();
		expect(screen.queryByTestId("topbar-tab-status-dot")).not.toBeInTheDocument();
		expect(screen.getByTestId("topbar-tab")).toHaveAttribute("data-role", "head");
	});

	it("italicizes preview heads and shows the resolved provider avatar", () => {
		const head = makeView({
			key: "head-1",
			sessionId: "head-1",
			role: "head",
			mode: "preview",
			label: "Project One",
			session: makeSession({ id: "head-1", provider: "claude-code" }),
			isActive: false,
			isAnchor: false,
		});
		renderTab({}, head);

		const tab = screen.getByRole("tab", { name: "Project One" });
		expect(tab).not.toHaveClass("italic");
		expect(screen.getByText("Project One")).toHaveClass("italic");
		expect(tab.querySelector('img[aria-hidden="true"]')).toBeInTheDocument();
		expect(screen.getByTestId("topbar-tab-status-dot")).toBeInTheDocument();
		expect(tab.querySelector("svg")).not.toBeInTheDocument();
	});

	it("gives inactive scratchpads prominent head styling while keeping them task tabs", () => {
		const scratch = makeView({ role: "scratch", isActive: false });
		renderTab({}, scratch);

		const tab = screen.getByRole("tab");
		expect(tab).toHaveClass("font-semibold", "text-foreground");
		expect(screen.getByTestId("topbar-tab")).toHaveClass("bg-overlay/55", "text-foreground");
		expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
	});

	it.each(["comfortable", "compact"] as const)("keeps task, head, and scratch tabs flat in %s density", (density) => {
		const cases = [
			makeView(),
			makeView({
				key: "anchor:project-1",
				sessionId: null,
				role: "head",
				label: "Project One",
				session: undefined,
				isAnchor: true,
			}),
			makeView({
				key: "scratch-1",
				role: "scratch",
				groupId: "__standalone__",
				session: makeSession({ workspaceId: "__standalone__" }),
			}),
		];

		for (const view of cases) {
			const rendered = renderTab({ density }, view);
			const wrapper = screen.getByTestId("topbar-tab");
			const button = screen.getByRole("tab");
			for (const element of [wrapper, button]) {
				expect(Array.from(element.classList).some((className) => /^(rounded|border)(-|$)/.test(className))).toBe(false);
				expect(Number.parseFloat(getComputedStyle(element).borderRadius || "0")).toBe(0);
				expect(Number.parseFloat(getComputedStyle(element).borderWidth || "0")).toBe(0);
			}
			rendered.unmount();
		}
	});

	it("uses the orchestrator glyph for an opened head that is still unresolved", () => {
		const head = makeView({
			key: "head-1",
			sessionId: "head-1",
			role: "head",
			label: "Project One",
			session: undefined,
			isActive: false,
			isAnchor: false,
		});
		renderTab({}, head);

		const tab = screen.getByRole("tab", { name: "Project One" });
		expect(tab.querySelector("svg")).toBeInTheDocument();
		expect(tab.querySelector("img")).not.toBeInTheDocument();
	});

	it("activates on click and persists on double-click without a second activation", async () => {
		const onActivate = vi.fn();
		const onPersist = vi.fn();
		renderTab({ onActivate, onPersist });
		const tab = screen.getByRole("tab");

		await userEvent.click(tab);
		expect(onActivate).toHaveBeenCalledTimes(1);
		await userEvent.dblClick(tab);
		expect(onActivate).toHaveBeenCalledTimes(2);
		expect(onPersist).toHaveBeenCalledTimes(1);
	});

	it("closes from the close button and middle-click, including a head", async () => {
		const onActivate = vi.fn();
		const onClose = vi.fn();
		renderTab({ onActivate, onClose });
		const closeButton = screen.getByRole("button", { name: "Close tab" });
		await userEvent.click(closeButton);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onActivate).not.toHaveBeenCalled();

		const head = makeView({ role: "head", isAnchor: true, sessionId: null, session: undefined, label: "Project One" });
		const { unmount } = renderTab({ onClose }, head);
		const wrapper = screen.getAllByTestId("topbar-tab").at(-1)!;
		fireEvent.mouseDown(wrapper, { button: 1 });
		fireEvent(wrapper, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
		expect(onClose).toHaveBeenLastCalledWith(head);
		expect(screen.queryAllByRole("button", { name: "Close tab" })).toHaveLength(1);
		unmount();
	});

	it("centres the close and options buttons around fixed icon boxes", () => {
		const renderMenu = () => null;
		renderTab({ renderMenu });
		for (const label of ["Close tab", "Tab options"]) {
			const button = screen.getByRole("button", { name: label });
			expect(button).toHaveClass("self-center", "items-center");
			expect(button.firstElementChild).toHaveClass("flex", "size-5", "items-center", "justify-center");
		}
	});

	it("starts and commits rename from F2 through the session rename API", async () => {
		const onRenamed = vi.fn();
		const user = userEvent.setup();
		renderTab({ onRenamed });
		const tab = screen.getByRole("tab");
		tab.focus();
		await user.keyboard("{F2}");
		const input = screen.getByRole("textbox", { name: "Rename Build tabs" });
		await user.clear(input);
		await user.type(input, "Renamed tabs");
		await user.keyboard("{Enter}");

		await waitFor(() => expect(renameSession).toHaveBeenCalledWith("task-1", "Renamed tabs"));
		expect(onRenamed).toHaveBeenCalledTimes(1);
	});

	it("does not offer inline rename for cloud sessions without a cloud rename API", async () => {
		const cloudSession = makeSession({ cloud: { orgId: "org-1", sandboxProvider: "coder" } });
		const cloudView = makeView({ session: cloudSession });
		renderTab({}, cloudView);
		const tab = screen.getByRole("tab");

		expect(tab).not.toHaveAttribute("aria-keyshortcuts", "F2");
		tab.focus();
		fireEvent.keyDown(tab, { key: "F2" });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("opens dropdown and context menus with a working rename callback", async () => {
		const onRenamed = vi.fn();
		let dropdownStartRename: (() => void) | undefined;
		const renderMenu = vi.fn(({ kind, startRename }: { kind: "dropdown" | "context"; startRename: () => void }) => {
			if (kind === "dropdown") {
				dropdownStartRename = startRename;
				return <DropdownMenuItem onSelect={startRename}>Rename from menu</DropdownMenuItem>;
			}
			return <ContextMenuItem onSelect={startRename}>Rename from context</ContextMenuItem>;
		});
		renderTab({ onRenamed, renderMenu });
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Rename from menu" }));
		expect(dropdownStartRename).toBeTypeOf("function");
		expect(await screen.findByRole("textbox", { name: "Rename Build tabs" })).toBeInTheDocument();
		expect(renderMenu).toHaveBeenCalledWith(expect.objectContaining({ kind: "dropdown", view: expect.any(Object), startRename: expect.any(Function) }));

		fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Build tabs" }), { key: "Escape" });
		const tab = screen.getByRole("tab");
		fireEvent.contextMenu(tab);
		await screen.findByRole("menuitem", { name: "Rename from context" });
		expect(renderMenu).toHaveBeenCalledWith(expect.objectContaining({ kind: "context", view: expect.any(Object), startRename: expect.any(Function) }));
	});

	it("merges routed session actions into one dropdown and excludes them from the context menu", async () => {
		const action = {
			menuItems: <><DropdownMenuItem>Switch to chat UI</DropdownMenuItem><DropdownMenuItem>Switch agent</DropdownMenuItem></>,
		};
		const renderMenu = ({ kind, sessionMenuItems }: Parameters<NonNullable<TopbarTabProps["renderMenu"]>>[0]) => kind === "dropdown" ? (
			<>
				{sessionMenuItems}
				<DropdownMenuSeparator />
				<DropdownMenuItem>Rename</DropdownMenuItem>
			</>
		) : <ContextMenuItem>Rename from context</ContextMenuItem>;
		renderTab({ tabAction: action, renderMenu });
		const wrapper = screen.getByTestId("topbar-tab");
		expect(within(wrapper).getAllByRole("button", { name: "Tab options" })).toHaveLength(1);
		expect(wrapper.querySelector("[data-session-actions-trigger]")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		let menu = await screen.findByRole("menu");
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
			"Switch to chat UI",
			"Switch agent",
			"Rename",
		]);
		expect(within(menu).getAllByRole("separator")).toHaveLength(1);

		fireEvent.keyDown(document.activeElement ?? wrapper, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
		fireEvent.contextMenu(screen.getByRole("tab"));
		menu = await screen.findByRole("menu");
		expect(within(menu).queryByRole("menuitem", { name: "Switch to chat UI" })).not.toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: "Rename from context" })).toBeInTheDocument();
	});

	it("replaces the options button with inline status and disables the context menu during a switch", () => {
		const tabAction = {
			menuItems: <DropdownMenuItem>Switch to chat UI</DropdownMenuItem>,
			inlineStatus: <span data-testid="interface-switch-status">Switching interface</span>,
		};
		renderTab({ tabAction, renderMenu: () => <DropdownMenuItem>Rename</DropdownMenuItem> });

		expect(screen.getByTestId("interface-switch-status")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Tab options" })).not.toBeInTheDocument();
		fireEvent.contextMenu(screen.getByRole("tab"));
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("does not add session actions to an anchor head without a session", async () => {
		const head = makeView({ role: "head", isAnchor: true, sessionId: null, session: undefined, label: "Project One" });
		const action = { menuItems: <DropdownMenuItem>Switch agent</DropdownMenuItem> };
		renderTab({
			tabAction: action,
			renderMenu: ({ kind, sessionMenuItems }) => kind === "dropdown" ? (
				<>{sessionMenuItems}<DropdownMenuSeparator /><DropdownMenuItem>New task</DropdownMenuItem></>
			) : <ContextMenuItem>New task</ContextMenuItem>,
		}, head);
		await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
		const menu = await screen.findByRole("menu");
		expect(within(menu).queryByRole("menuitem", { name: "Switch agent" })).not.toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: "New task" })).toBeInTheDocument();
	});
});
