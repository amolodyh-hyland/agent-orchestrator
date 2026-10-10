import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AWARENESS_STATE, type AwarenessCommand, type AwarenessCommandResult } from "../../../shared/multica-awareness";
import { awarenessState } from "../../test/multica-awareness-fixtures";
import { useMulticaAwarenessStore } from "../../stores/multica-awareness-store";
import { MulticaAwarenessSettings } from "./MulticaAwarenessSettings";

describe("MulticaAwarenessSettings", () => {
	let commands: AwarenessCommand[];
	let original: unknown;

	beforeEach(() => {
		commands = [];
		original = window.ao!.multicaAwareness;
		window.ao!.multicaAwareness = {
			...window.ao!.multicaAwareness,
			getState: async () => useMulticaAwarenessStore.getState().state,
			command: vi.fn(async (command: AwarenessCommand): Promise<AwarenessCommandResult> => {
				commands.push(command);
				return { ok: true, state: useMulticaAwarenessStore.getState().state };
			}),
		} as never;
		window.ao!.multicaActionLog.read = vi.fn(async () => []);
	});
	afterEach(() => {
		window.ao!.multicaAwareness = original as never;
		useMulticaAwarenessStore.setState({ state: EMPTY_AWARENESS_STATE });
	});

	it("starts with everything off: master switch off, no servers", () => {
		useMulticaAwarenessStore.setState({ state: EMPTY_AWARENESS_STATE });
		render(<MulticaAwarenessSettings />);
		expect(screen.getByRole("heading", { name: "Multica awareness (read-only)" })).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Watch Multica" })).not.toBeChecked();
		expect(screen.queryByTestId("multica-awareness-server")).toBeNull();
	});

	it("sends the master, server and workspace switches as separate commands", async () => {
		const state = awarenessState({ masterEnabled: false });
		state.servers[0].enabled = false;
		state.servers[0].workspaces[0].watch = false;
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaAwarenessSettings />);
		await userEvent.click(screen.getByRole("switch", { name: "Watch Multica" }));
		await userEvent.click(screen.getByRole("switch", { name: "Watch Multica Cloud" }));
		await userEvent.click(screen.getByRole("switch", { name: "Watch Acme" }));
		expect(commands).toEqual([
			{ type: "setMaster", enabled: true },
			{ type: "setServerEnabled", serverKey: "cloud", enabled: true },
			{ type: "setWorkspaceWatch", serverKey: "cloud", workspaceId: "w1", watch: true },
		]);
	});

	it("shows the server status and the workspace state", () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaAwarenessSettings />);
		// The server row and its workspace row both read Live.
		expect(screen.getAllByText("Live")).toHaveLength(2);
	});

	it("asks for explicit consent before the CLI profile token is read and sends it only on confirm", async () => {
		const state = awarenessState();
		state.servers[0].credentialSource = "profile";
		state.servers[0].status = "no_credential";
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaAwarenessSettings />);
		expect(screen.getByText(/needs your consent/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Review and allow…" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/never write to Multica from here/)).toBeInTheDocument();
		expect(commands).toEqual([]);
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(commands).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Review and allow…" }));
		await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow reading" }));
		expect(commands).toEqual([{ type: "grantConsent", serverKey: "cloud" }]);
	});

	it("lets consent be withdrawn once given", async () => {
		const state = awarenessState();
		state.servers[0].credentialSource = "profile";
		state.servers[0].consentGranted = true;
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaAwarenessSettings />);
		await userEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));
		expect(commands).toEqual([{ type: "revokeConsent", serverKey: "cloud" }]);
	});

	it("takes a pasted token in a masked field, sends it once and clears the field; the token is never shown back", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaAwarenessSettings />);
		const field = screen.getByLabelText("Personal token");
		expect(field).toHaveAttribute("type", "password");
		await userEvent.type(field, "mul_FIXTUREtypedTOKEN");
		await userEvent.click(screen.getByRole("button", { name: "Save token" }));
		expect(commands).toEqual([{ type: "setToken", serverKey: "cloud", token: "mul_FIXTUREtypedTOKEN" }]);
		await waitFor(() => expect(screen.getByLabelText("Personal token")).toHaveValue(""));
		expect(screen.getByText("A token is stored, encrypted by the system.")).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("mul_FIXTUREtypedTOKEN");
	});

	it("warns when a pasted token can only be held in memory", () => {
		const state = awarenessState({ tokenStoragePersistent: false });
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaAwarenessSettings />);
		expect(screen.getByText(/this session only/)).toBeInTheDocument();
	});

	it("explains page-only mode", async () => {
		const state = awarenessState();
		state.servers[0].credentialSource = "page";
		useMulticaAwarenessStore.setState({ state });
		render(<MulticaAwarenessSettings />);
		expect(screen.getByText(/AO holds no token/)).toBeInTheDocument();
		expect(screen.queryByLabelText("Personal token")).toBeNull();
	});

	it("shows a command failure and the kill switch", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState({ killSwitch: true }) });
		window.ao!.multicaAwareness.command = vi.fn(async () => ({ ok: false, reason: "socket_cap" }) as AwarenessCommandResult);
		render(<MulticaAwarenessSettings />);
		expect(screen.getByText(/AO_MULTICA_WATCH=0/)).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Watch Multica" })).toBeDisabled();
	});

	it("shows a refused workspace switch as an error", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		window.ao!.multicaAwareness.command = vi.fn(async () => ({ ok: false, reason: "socket_cap" }) as AwarenessCommandResult);
		render(<MulticaAwarenessSettings />);
		await userEvent.click(screen.getByRole("switch", { name: "Watch Acme" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Socket limit reached");
	});

	it("adds a server by address and removes one", async () => {
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaAwarenessSettings />);
		await userEvent.type(screen.getByLabelText("Local or self-hosted server address"), "http://localhost:3000");
		await userEvent.click(screen.getByRole("button", { name: "Add server" }));
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(commands).toEqual([
			{ type: "addServer", mode: "local", customUrl: "http://localhost:3000", apiUrl: "" },
			{ type: "removeServer", serverKey: "cloud" },
		]);
	});

	it("shows the activity log read-only and filtered by kind", async () => {
		const read = vi.fn(async () => [{ v: 1 as const, id: "r1", ts: "2026-10-10T10:00:00.000Z", kind: "connect" as const, direction: "local" as const, actor: "system" as const, identifier: "MUL-1", result: { ok: true } }]);
		window.ao!.multicaActionLog.read = read;
		useMulticaAwarenessStore.setState({ state: awarenessState() });
		render(<MulticaAwarenessSettings />);
		await userEvent.click(screen.getByRole("button", { name: "Show activity" }));
		const log = await screen.findByTestId("multica-activity-log");
		expect(within(log).getByText("MUL-1")).toBeInTheDocument();
		await userEvent.selectOptions(within(log).getByRole("combobox"), "pause");
		expect(read).toHaveBeenLastCalledWith({ kind: "pause" });
		expect(within(log).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Export JSON"]);
	});
});
