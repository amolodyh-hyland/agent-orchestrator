import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AWARENESS_STATE } from "../../shared/multica-awareness";
import type { WorkspaceSession } from "../types/workspace";
import { awarenessState } from "../test/multica-awareness-fixtures";
import { useMulticaAwarenessStore } from "../stores/multica-awareness-store";
import { MulticaWhoDialog } from "./MulticaWhoDialog";

const navigate = vi.fn();
const sessions: WorkspaceSession[] = [];
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: [{ id: "p1", sessions }] }) }));

describe("MulticaWhoDialog", () => {
	beforeEach(() => {
		sessions.length = 0;
		navigate.mockReset();
	});
	afterEach(() => useMulticaAwarenessStore.setState({ state: EMPTY_AWARENESS_STATE }));

	it("joins Multica runs and AO sessions by issue with executor, who, state and flags", () => {
		sessions.push({ id: "s1", workspaceId: "p1", title: "Session one", status: "working" } as WorkspaceSession, { id: "s2", workspaceId: "p1", title: "Loose session", status: "working" } as WorkspaceSession);
		useMulticaAwarenessStore.setState({
			state: awarenessState({ links: [{ sessionId: "s1", projectId: "p1", workspaceSlug: "acme", issueIdentifier: "MUL-1", createdAt: "2026-10-10T10:00:00Z", serverKey: "cloud" }] }),
		});
		render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
		const rows = within(screen.getByTestId("multica-who-table")).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveAttribute("data-executor", "contested");
		expect(rows[0]).toHaveTextContent("MUL-1");
		expect(rows[0]).toHaveTextContent("Builder");
		expect(rows[0]).toHaveTextContent("Session one");
		expect(rows[0]).toHaveTextContent("Running");
		expect(rows[0]).toHaveTextContent("Contested");
		expect(rows[1]).toHaveAttribute("data-executor", "human");
		expect(rows[1]).toHaveTextContent("You");
		expect(screen.getByText("AO sessions with no Multica link")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Loose session" })).toBeInTheDocument();
	});

	it("filters to the issues assigned to the signed-in user", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
		await userEvent.click(screen.getByRole("switch", { name: "Mine only" }));
		const rows = within(screen.getByTestId("multica-who-table")).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("MUL-2");
	});

	it("filters by server", async () => {
		const state = awarenessState();
		state.servers.push({ ...state.servers[0], serverKey: "other", label: "Other server" });
		state.issues.push({ ...state.issues[0], serverKey: "other", id: "i9", identifier: "OTH-1", title: "Elsewhere" });
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
		await userEvent.selectOptions(screen.getByRole("combobox", { name: /Server/ }), "other");
		const rows = within(screen.getByTestId("multica-who-table")).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("OTH-1");
	});

	it("offers no action on an issue, only opening it or its session", () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
		const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
		expect(names.filter((name) => /hand ?off|cancel|assign|stop|start/i.test(name ?? ""))).toEqual([]);
	});

	it("says so when the issue cannot be opened because Multica shows another server", async () => {
		const original = window.ao!.multicaAwareness.openIssue;
		window.ao!.multicaAwareness.openIssue = vi.fn(async () => false);
		try {
			useMulticaAwarenessStore.setState({ state: awarenessState() });
			render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
			await userEvent.click(screen.getAllByRole("button", { name: "Open MUL-1 in Multica" })[0]);
			expect(await screen.findByRole("alert")).toHaveTextContent("Switch Multica to this server");
		} finally {
			window.ao!.multicaAwareness.openIssue = original;
		}
	});

	it("says so when there is nothing to show", () => {
		useMulticaAwarenessStore.setState({ state: awarenessState({ issues: [], runs: [] }) });
		render(<MulticaWhoDialog open onOpenChange={() => undefined} />);
		expect(screen.getByText("Nothing to show yet.")).toBeInTheDocument();
	});
});
