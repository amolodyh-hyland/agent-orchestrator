import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatFixture } from "../../lib/chat-fixture";
import type { ConversationPlan, ConversationSnapshot } from "../../types/conversation";
import { InlineTurnPlan, SessionTodoLayout, SessionTodoPanel } from "./SessionTodoPanel";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/host-clients", () => ({ clientForSessionHost: () => ({ GET: get }) }));

const plan: ConversationPlan = { steps: Array.from({ length: 7 }, (_, index) => ({
	text: `Task ${index + 1}`, status: index < 3 ? "completed" : "pending",
})) };
const snapshot: ConversationSnapshot = { ...chatFixture, turns: [{
	id: "turn-1", state: "running", requestedAt: "2026-11-06T00:00:00Z", plan,
}] };
const observed = new Map<Element, ResizeObserverCallback>();

beforeEach(() => {
	localStorage.clear();
	get.mockReset();
	vi.stubGlobal("ResizeObserver", class {
		constructor(private callback: ResizeObserverCallback) {}
		observe(element: Element) { observed.set(element, this.callback); }
		unobserve(element: Element) { observed.delete(element); }
		disconnect() { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element); }
	});
});
afterEach(() => { cleanup(); observed.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function resize(container: HTMLElement, width = 900, height = 500) {
	const pane = container.querySelector<HTMLElement>("[data-todo-placement]")!;
	expect(pane).not.toBeNull();
	act(() => observed.get(pane)?.([{
		target: pane, contentRect: DOMRectReadOnly.fromRect({ width, height }),
		borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
	}], {} as ResizeObserver));
	return pane;
}

function layout(placement?: string, sessionKey = "session-1", value = snapshot) {
	return <SessionTodoLayout snapshot={value} placement={placement} sessionKey={sessionKey}>
		<div data-testid="transcript"><InlineTurnPlan plan={value.turns[0]?.plan ?? plan} live /></div>
	</SessionTodoLayout>;
}

describe("session Todo placement", () => {
	it.each([undefined, "default"])("keeps the current inline placement for %s", (placement) => {
		const { container } = render(layout(placement));
		expect(within(screen.getByTestId("transcript")).getByRole("region", { name: "Agent plan" })).toBeInTheDocument();
		expect(container.querySelector("[data-session-todo]")).toBeNull();
		expect(container.querySelector("[data-todo-placement]")).toHaveAttribute("data-todo-placement", "default");
	});

	it("moves the latest plan into the top-right overlay and keeps its collapsed count", async () => {
		const { container } = render(layout("top-right"));
		const pane = resize(container);
		expect(pane).toHaveAttribute("data-todo-placement", "top-right");
		expect(screen.getByTestId("transcript")).toBeEmptyDOMElement();
		const overlay = container.querySelector<HTMLElement>("[data-session-todo]")!;
		expect(overlay).toHaveClass("absolute", "right-3", "top-3", "bg-background");
		fireEvent.click(within(overlay).getByRole("button", { name: "Collapse plan" }));
		expect(within(overlay).getByRole("button", { name: "Expand plan" })).toHaveTextContent("3/7");
		await waitFor(() => expect(screen.queryByRole("list")).not.toBeInTheDocument());
		fireEvent.click(within(overlay).getByRole("button", { name: "Expand plan" }));
		expect(screen.getByRole("list")).toBeInTheDocument();
	});

	it("remembers explicit collapse per session across remounts and plan updates", () => {
		const first = render(layout("top-right"));
		resize(first.container);
		fireEvent.click(screen.getByRole("button", { name: "Collapse plan" }));
		first.unmount();
		const second = render(layout("top-right"));
		resize(second.container);
		expect(screen.getByRole("button", { name: "Expand plan" })).toHaveTextContent("3/7");
		second.rerender(layout("top-right", "session-2"));
		expect(screen.getByRole("button", { name: "Collapse plan" })).toBeInTheDocument();
		const finished = { ...snapshot, turns: [{ ...snapshot.turns[0], plan: { steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })) } }] };
		second.rerender(layout("top-right", "session-1", finished));
		expect(within(second.container.querySelector<HTMLElement>("[data-session-todo]")!).getByRole("button", { name: "Expand plan" })).toHaveTextContent("7/7");
	});

	it.each([[639, 500], [900, 279]])("falls back inline at %sx%s and restores floating placement on resize", (width, height) => {
		const { container } = render(layout("top-right"));
		const pane = resize(container, width, height);
		expect(pane).toHaveAttribute("data-todo-placement", "default");
		expect(within(screen.getByTestId("transcript")).getByRole("region", { name: "Agent plan" })).toBeInTheDocument();
		expect(container.querySelector("[data-session-todo]")).toBeNull();
		resize(container, 640, 280);
		expect(screen.getAllByRole("region", { name: "Agent plan" })).toHaveLength(1);
		expect(container.querySelector("[data-session-todo]")).not.toBeNull();
		resize(container, width, height);
		expect(container.querySelector("[data-session-todo]")).toBeNull();
	});

	it("measures each pane independently", () => {
		const first = render(layout("top-right", "session-1"));
		const second = render(layout("top-right", "session-2"));
		resize(first.container, 900);
		resize(second.container, 400);
		expect(first.container.querySelector("[data-session-todo]")).not.toBeNull();
		expect(second.container.querySelector("[data-session-todo]")).toBeNull();
	});

	it.each([[639, 500], [900, 279]])("transfers the focused toggle both ways at %sx%s without scrolling", (width, height) => {
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		const { container } = render(layout("top-right"));
		const transcript = screen.getByTestId("transcript");
		transcript.scrollTop = 120;
		resize(container);
		const floating = screen.getByRole("button", { name: "Collapse plan" });
		floating.focus();
		expect(floating).toHaveFocus();
		resize(container, width, height);
		const inline = within(transcript).getByRole("button", { name: "Collapse plan" });
		expect(inline).toHaveFocus();
		expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
		expect(transcript.scrollTop).toBe(120);
		resize(container);
		expect(within(container.querySelector<HTMLElement>("[data-session-todo]")!).getByRole("button", { name: "Collapse plan" })).toHaveFocus();
		expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
		expect(transcript.scrollTop).toBe(120);
	});

	it("retains the focused floating toggle until blur when its inline turn is not mounted", () => {
		const { container } = render(<SessionTodoLayout snapshot={snapshot} placement="top-right" sessionKey="session-1">
			<div data-testid="transcript">Older history</div>
		</SessionTodoLayout>);
		resize(container);
		screen.getByRole("button", { name: "Collapse plan" }).focus();
		resize(container, 400);
		expect(screen.getByRole("button", { name: "Collapse plan" })).toHaveFocus();
		act(() => screen.getByRole("button", { name: "Collapse plan" }).blur());
		expect(container.querySelector("[data-session-todo]")).toBeNull();
	});

	it("floats only the newest eligible plan while keeping older plans inline", () => {
		const newer: ConversationPlan = { steps: [{ text: "Current task", status: "in_progress" }] };
		const value = { ...snapshot, turns: [...snapshot.turns, { ...snapshot.turns[0], id: "newer", plan: newer }] };
		const { container } = render(<SessionTodoLayout snapshot={value} placement="top-right" sessionKey="session-1">
			<div data-testid="transcript"><InlineTurnPlan plan={plan} /><InlineTurnPlan plan={newer} /></div>
		</SessionTodoLayout>);
		resize(container);
		expect(within(screen.getByTestId("transcript")).getByText("3/7")).toBeInTheDocument();
		expect(within(screen.getByTestId("transcript")).queryByText("Current task")).not.toBeInTheDocument();
		expect(within(container.querySelector<HTMLElement>("[data-session-todo]")!).getByText("Current task")).toBeInTheDocument();
	});

	it("does not float absent, superseded, cancelled or rolled-back plans", () => {
		const { container } = render(layout("top-right", "session-1", { ...snapshot, turns: [
			{ ...snapshot.turns[0], plan: { ...plan, superseded: true } },
			{ ...snapshot.turns[0], id: "cancelled", state: "cancelled" },
			{ ...snapshot.turns[0], id: "rolled-back", rolledBack: true },
			{ ...snapshot.turns[0], id: "empty", plan: { steps: [] } },
		] }));
		expect(container.querySelector("[data-todo-placement]")).toHaveAttribute("data-todo-placement", "default");
	});

	it("reads placement from the owning project's persisted config", async () => {
		get.mockResolvedValue({ data: { project: { config: { todoPlacement: "top-right" } } } });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { container } = render(<QueryClientProvider client={client}>
			<SessionTodoPanel snapshot={snapshot} projectId="project-1"><InlineTurnPlan plan={plan} /></SessionTodoPanel>
		</QueryClientProvider>);
		await waitFor(() => expect(observed.has(container.querySelector("[data-todo-placement]")!)).toBe(true));
		resize(container);
		expect(get).toHaveBeenCalledWith("/api/v1/projects/{id}", { params: { path: { id: "project-1" } } });
		expect(container.querySelector("[data-session-todo]")).not.toBeNull();
		client.clear();
	});

	it("keeps the default placement if project config cannot be read", async () => {
		get.mockResolvedValue({ error: { message: "offline" } });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { container } = render(<QueryClientProvider client={client}>
			<SessionTodoPanel snapshot={snapshot} projectId="project-1"><InlineTurnPlan plan={plan} /></SessionTodoPanel>
		</QueryClientProvider>);
		await waitFor(() => expect(client.getQueryData(["project-config", "project-1"])).toBeNull());
		expect(screen.getByRole("region", { name: "Agent plan" })).toBeInTheDocument();
		expect(container.querySelector("[data-session-todo]")).toBeNull();
		client.clear();
	});
});
