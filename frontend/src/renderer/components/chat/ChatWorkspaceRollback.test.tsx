/**
 * The per-turn undo control and the honesty of its confirmation.
 *
 * ChatWorkspace takes props only, so these render it directly with a fixture and a
 * spy. What is asserted is deliberately about behaviour a user would notice: the
 * control appears only when an undo can actually work, the confirmation says what is
 * lost, and the turn id that reaches the daemon is the one that was clicked.
 */

import { render as rtlRender, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";
import type { ConversationSnapshot } from "../../types/conversation";
import type { WorkspaceSession, WorkspaceSummary } from "../../types/workspace";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { TooltipProvider } from "../ui/tooltip";

const routeMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
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

function seedChatToolbar(ui: ReactElement): void {
	if (ui.type !== ChatWorkspace) return;
	const props = ui.props as ComponentProps<typeof ChatWorkspace>;
	const sessionId = props.snapshot.sessionId;
	const session: WorkspaceSession = {
		id: sessionId,
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: props.sessionTitle ?? props.snapshot.title ?? sessionId,
		provider: props.snapshot.harness as WorkspaceSession["provider"],
		kind: props.sessionRole ?? "worker",
		branch: "ao/chat-session",
		status: "working",
		activity: { state: "active", lastActivityAt: "2026-10-01T00:00:00Z" },
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
	};
	const workspace: WorkspaceSummary = {
		id: session.workspaceId,
		name: session.workspaceName,
		path: "/tmp/workspace",
		orchestratorAgent: session.provider,
		kind: "single_repo",
		sessions: [session],
	};
	routeMocks.params.projectId = session.workspaceId;
	routeMocks.params.sessionId = sessionId;
	workspaceQueryMock.mockReturnValue({ data: [workspace] });
	useTopbarTabsStore.setState({
		tabs: {
			version: 1,
			groups: [{
				id: session.workspaceId,
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: [{ sessionId, mode: "persistent", lastActiveAt: 0 }],
			}],
		},
	});
}

function render(ui: ReactElement) {
	seedChatToolbar(ui);
	return rtlRender(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	routeMocks.navigate.mockReset();
	routeMocks.params.projectId = undefined;
	routeMocks.params.sessionId = undefined;
	workspaceQueryMock.mockReset().mockReturnValue({ data: [] });
	useTopbarTabsStore.setState({ tabs: { version: 1, groups: [] }, density: "comfortable", overflow: "scroll" });
});

/** A conversation with nothing in flight, which is when an undo is offered. */
function idleSnapshot(): ConversationSnapshot {
	return {
		...chatFixture,
		controller: { state: "ready" },
		turns: chatFixture.turns.map((turn) =>
			turn.state === "running"
				? { ...turn, state: "completed" as const, completedAt: turn.requestedAt }
				: turn,
		),
	};
}

describe("ChatWorkspace rollback", () => {
	it("offers an undo on each settled turn and reports the clicked turn", async () => {
		const onRollback = vi.fn();
		render(<ChatWorkspace snapshot={idleSnapshot()} onRollback={onRollback} />);

		const controls = screen.getAllByRole("button", { name: "Roll back to here" });
		expect(controls.length).toBeGreaterThan(0);

		await userEvent.click(controls[0]!);
		const dialog = screen.getByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));

		// The first settled turn in the fixture is turn-1; the daemon must be given
		// AO's own turn id, which is what the snapshot exposes.
		expect(onRollback).toHaveBeenCalledWith("turn-1");
	});

	it("says the agent forgets, and that the worktree does not change", async () => {
		render(<ChatWorkspace snapshot={idleSnapshot()} onRollback={vi.fn()} />);
		await userEvent.click(screen.getAllByRole("button", { name: "Roll back to here" })[0]!);

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("forget this exchange and everything after it");
		// The provider does not revert files, so a confirmation that implied otherwise
		// would be the one thing a user could not recover from believing.
		expect(dialog.textContent).toContain("left exactly as they are");
		expect(dialog.textContent).toContain("cannot be undone");
	});

	it("does not commit anything when the confirmation is cancelled", async () => {
		const onRollback = vi.fn();
		render(<ChatWorkspace snapshot={idleSnapshot()} onRollback={onRollback} />);

		await userEvent.click(screen.getAllByRole("button", { name: "Roll back to here" })[0]!);
		const dialog = screen.getByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

		expect(onRollback).not.toHaveBeenCalled();
	});

	// The daemon refuses a rollback mid-turn. A control that exists only to be
	// refused is worse than one that waits for the agent to finish.
	it("withholds the control while a turn is in flight", () => {
		render(<ChatWorkspace snapshot={chatFixture} onRollback={vi.fn()} />);
		expect(screen.queryByRole("button", { name: "Roll back to here" })).toBeNull();
	});

	// Feature detection reaches the UI as an absent callback, following how the model
	// picker already hides itself for a provider that offers no choice.
	it("draws no control when the agent cannot undo", () => {
		render(<ChatWorkspace snapshot={idleSnapshot()} />);
		expect(screen.queryByRole("button", { name: "Roll back to here" })).toBeNull();
	});

	// A turn the provider never accepted holds no history to discard, and the daemon
	// refuses it.
	it("draws no control on a turn the provider never accepted", () => {
		const snapshot = idleSnapshot();
		render(
			<ChatWorkspace
				snapshot={{
					...snapshot,
					turns: snapshot.turns.map((turn) => ({ ...turn, providerTurnId: undefined })),
				}}
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Roll back to here" })).toBeNull();
	});

	it("says how much an undo took away", () => {
		const snapshot = idleSnapshot();
		render(
			<ChatWorkspace
				snapshot={{
					...snapshot,
					turns: [
						snapshot.turns[0]!,
						{ ...snapshot.turns[1]!, rolledBack: true },
					],
				}}
				onRollback={vi.fn()}
			/>,
		);
		expect(screen.getByText(/1 turn was rolled back/)).toBeInTheDocument();
		expect(screen.getByText(/no longer remembers it/)).toBeInTheDocument();
	});

	it("surfaces a refusal inside the confirmation rather than closing on it", async () => {
		render(
			<ChatWorkspace
				snapshot={idleSnapshot()}
				onRollback={vi.fn()}
				rollbackError="stop the agent before rolling back: it is in the middle of a turn"
			/>,
		);
		await userEvent.click(screen.getAllByRole("button", { name: "Roll back to here" })[0]!);
		expect(screen.getByRole("alert").textContent).toContain("stop the agent");
	});

	it("shows the thread title in its grouped route tab when there is one", () => {
		render(<ChatWorkspace snapshot={{ ...chatFixture, title: "Fix OAuth Return URL Loss" }} />);
		const routeTab = screen.getByRole("tab", { name: /^Fix OAuth Return URL Loss · Codex/ });
		expect(routeTab.closest('[data-testid="topbar-tab"]')).toHaveAttribute("data-role", "task");
		expect(screen.queryByText("Codex")).toBeNull();
		expect(screen.queryByText(chatFixture.sessionId)).toBeNull();
	});

	it("falls back to the session id when the thread has no name", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);
		expect(screen.getByRole("tab", { name: new RegExp(`^${chatFixture.sessionId} · Codex`) })).toBeInTheDocument();
		expect(screen.queryByText("Codex")).toBeNull();
	});
});
