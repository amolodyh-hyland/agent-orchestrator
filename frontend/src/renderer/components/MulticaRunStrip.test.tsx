import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AWARENESS_STATE } from "../../shared/multica-awareness";
import type { WorkspaceSession } from "../types/workspace";
import { awarenessRun, awarenessState } from "../test/multica-awareness-fixtures";
import { useMulticaAwarenessStore } from "../stores/multica-awareness-store";
import { MulticaRunStrip } from "./MulticaRunStrip";

const navigate = vi.fn();
const sessions: WorkspaceSession[] = [];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: [{ id: "p1", sessions }] }),
}));

describe("MulticaRunStrip", () => {
	let openIssue: ReturnType<typeof vi.fn>;
	let original: typeof window.ao extends infer B ? B : never;

	beforeEach(() => {
		sessions.length = 0;
		navigate.mockReset();
		openIssue = vi.fn(async () => true);
		original = window.ao!.multicaAwareness as never;
		window.ao!.multicaAwareness = { ...window.ao!.multicaAwareness, openIssue, getState: async () => useMulticaAwarenessStore.getState().state } as never;
	});
	afterEach(() => {
		window.ao!.multicaAwareness = original as never;
		useMulticaAwarenessStore.setState({ state: EMPTY_AWARENESS_STATE });
	});

	it("renders nothing until a workspace is switched on", () => {
		useMulticaAwarenessStore.setState({ state: EMPTY_AWARENESS_STATE });
		const { container } = render(<MulticaRunStrip />);
		expect(container).toBeEmptyDOMElement();

		const off = awarenessState();
		off.servers[0].workspaces[0].watch = false;
		useMulticaAwarenessStore.setState({ state: off });
		const second = render(<MulticaRunStrip />);
		expect(second.container).toBeEmptyDOMElement();
	});

	it("shows one card per issue with server, workspace, identifier, title, agent, state and assignee", () => {
		useMulticaAwarenessStore.setState({ state: awarenessState({ runs: [awarenessRun(), awarenessRun({ id: "t2", issueId: "i2", status: "queued", startedAt: null })] }) });
		render(<MulticaRunStrip />);
		const strip = screen.getByTestId("multica-run-strip");
		expect(within(strip).getByRole("heading", { name: "Run by Multica" })).toBeInTheDocument();
		const cards = within(strip).getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		expect(cards[0]).toHaveAttribute("data-state", "running");
		expect(cards[0]).toHaveTextContent("Multica Cloud");
		expect(cards[0]).toHaveTextContent("acme");
		expect(cards[0]).toHaveTextContent("MUL-1");
		expect(cards[0]).toHaveTextContent("Fix the board");
		expect(cards[0]).toHaveTextContent("Agent: Builder");
		expect(cards[0]).toHaveTextContent("Assigned to Builder");
		expect(cards[1]).toHaveAttribute("data-state", "queued");
		expect(cards[1]).toHaveTextContent("Assigned to you");
	});

	it("puts a failed run in the attention lane ahead of running ones and a finished one in recent", () => {
		useMulticaAwarenessStore.setState({
			state: awarenessState({
				runs: [
					awarenessRun({ id: "t1", status: "completed", endedAt: new Date().toISOString() }),
					awarenessRun({ id: "t2", issueId: "i2", status: "failed", endedAt: new Date().toISOString() }),
				],
			}),
		});
		render(<MulticaRunStrip />);
		const cards = screen.getAllByRole("listitem");
		expect(cards.map((card) => card.getAttribute("data-lane"))).toEqual(["attention", "recent"]);
	});

	it("shows a leader chip, an autopilot chip and the retrying state", () => {
		useMulticaAwarenessStore.setState({
			state: awarenessState({ runs: [awarenessRun({ isLeaderTask: true, autopilotRunId: "ap", status: "failed", retryPending: true, endedAt: new Date().toISOString() })] }),
		});
		render(<MulticaRunStrip />);
		const card = screen.getByRole("listitem");
		expect(card).toHaveTextContent("Squad leader");
		expect(card).toHaveTextContent("Autopilot");
		expect(card).toHaveTextContent("Retrying");
	});

	it("shows an issue with a live linked AO session once, as contested, with a link to the session", async () => {
		sessions.push({ id: "s1", workspaceId: "p1", title: "Session one", status: "working" } as WorkspaceSession);
		useMulticaAwarenessStore.setState({
			state: awarenessState({ links: [{ sessionId: "s1", projectId: "p1", workspaceSlug: "acme", issueIdentifier: "MUL-1", createdAt: "2026-10-10T10:00:00Z", serverKey: "cloud" }] }),
		});
		render(<MulticaRunStrip />);
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		expect(screen.getByRole("listitem")).toHaveTextContent("Contested");
		await userEvent.click(screen.getByRole("button", { name: "Open session" }));
		expect(navigate).toHaveBeenCalledWith({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId: "p1", sessionId: "s1" } });
	});

	it("opens the issue in Multica through the typed bridge", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaRunStrip />);
		await userEvent.click(screen.getByRole("button", { name: "Open MUL-1 in Multica" }));
		expect(openIssue).toHaveBeenCalledWith({ serverKey: "cloud", workspaceSlug: "acme", identifier: "MUL-1" });
	});

	it("says so when the issue cannot be opened because Multica shows another server", async () => {
		openIssue.mockResolvedValue(false);
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaRunStrip />);
		expect(screen.queryByRole("alert")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Open MUL-1 in Multica" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Switch Multica to this server in Settings to open the issue.");
		openIssue.mockResolvedValue(true);
		await userEvent.click(screen.getByRole("button", { name: "Open MUL-1 in Multica" }));
		await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("explains an empty strip and offers no badge, banner or notification", () => {
		useMulticaAwarenessStore.setState({ state: awarenessState({ runs: [] }) });
		render(<MulticaRunStrip />);
		expect(screen.getByText("No Multica runs right now.")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("opens the who-is-working view from the strip", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaRunStrip />);
		await userEvent.click(screen.getByRole("button", { name: "Who is working on what" }));
		const dialog = await screen.findByTestId("multica-who-dialog");
		expect(within(dialog).getByRole("heading", { name: "Who is working on what" })).toBeInTheDocument();
		expect(within(dialog).getByTestId("multica-who-table")).toBeInTheDocument();
	});
});
