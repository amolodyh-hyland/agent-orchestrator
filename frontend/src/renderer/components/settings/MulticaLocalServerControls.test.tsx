import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_LOCAL_SERVER_STATUS,
	type LocalServerLogsResult,
	type LocalServerResult,
	type LocalServerState,
	type LocalServerStatus,
} from "../../../shared/multica-local-server";
import type { MulticaSettings } from "../../../shared/multica";
import { resetMulticaSyncStoreSubscription } from "../../stores/multica-sync-store";
import { MulticaLocalServerControls } from "./MulticaLocalServerControls";
import { MulticaSettingsSection } from "./MulticaSettingsSection";

type Bridge = NonNullable<typeof window.ao>;
type LocalServerBridge = Bridge["multica"]["localServer"];

const status = (state: LocalServerState, patch: Partial<LocalServerStatus> = {}): LocalServerStatus => ({
	...EMPTY_LOCAL_SERVER_STATUS,
	state,
	folder: "/Users/me/.multica/server",
	canLaunchDocker: true,
	...patch,
});

describe("MulticaLocalServerControls", () => {
	let original: LocalServerBridge;
	let current: LocalServerStatus;
	let listener: ((next: LocalServerStatus) => void) | undefined;
	let fake: { [K in keyof LocalServerBridge]: ReturnType<typeof vi.fn> };

	const ok = async (): Promise<LocalServerResult> => ({ ok: true });

	beforeEach(() => {
		original = window.ao!.multica.localServer;
		current = status("stopped");
		listener = undefined;
		fake = {
			getState: vi.fn(async () => current),
			watch: vi.fn(ok),
			start: vi.fn(ok),
			stop: vi.fn(ok),
			restart: vi.fn(ok),
			cancel: vi.fn(ok),
			setup: vi.fn(ok),
			chooseFolder: vi.fn(ok),
			useDetectedFolder: vi.fn(ok),
			getLogs: vi.fn(async (): Promise<LocalServerLogsResult> => ({ ok: true, lines: [] })),
			onStatus: vi.fn((next: (value: LocalServerStatus) => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			}),
		};
		window.ao!.multica.localServer = fake as unknown as LocalServerBridge;
	});

	afterEach(() => {
		window.ao!.multica.localServer = original;
		vi.useRealTimers();
	});

	const button = (name: string) => screen.getByRole("button", { name });
	const open = async (state: LocalServerState, patch: Partial<LocalServerStatus> = {}) => {
		current = status(state, patch);
		render(<MulticaLocalServerControls />);
		await screen.findByRole("group", { name: "Local Multica server" });
	};

	it("renders nothing when the server is not available here (Cloud or a remote address)", async () => {
		current = { ...EMPTY_LOCAL_SERVER_STATUS, state: "unavailable", unavailableReason: "cloud" };
		const { container } = render(<MulticaLocalServerControls />);
		await waitFor(() => expect(fake.getState).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("says it is the server, not the agent daemon", async () => {
		await open("stopped");
		expect(screen.getByText(/It is not the Multica agent daemon/)).toBeInTheDocument();
	});

	it("starts watching when shown and stops when removed, and does nothing else on its own", async () => {
		const view = render(<MulticaLocalServerControls />);
		await waitFor(() => expect(fake.watch).toHaveBeenCalledWith(true));
		view.unmount();
		expect(fake.watch).toHaveBeenLastCalledWith(false);
		for (const name of ["start", "stop", "restart", "setup", "chooseFolder", "useDetectedFolder", "getLogs"] as const) expect(fake[name]).not.toHaveBeenCalled();
		expect(listener).toBeUndefined();
	});

	it.each<[LocalServerState, string, { start: boolean; stop: boolean; restart: boolean }]>([
		["stopped", "Stopped", { start: true, stop: false, restart: false }],
		["starting", "Starting…", { start: false, stop: true, restart: true }],
		["healthy", "Running", { start: false, stop: true, restart: true }],
		["unhealthy", "Not healthy", { start: true, stop: true, restart: true }],
		["port_conflict", "Port in use", { start: false, stop: false, restart: false }],
		["running_elsewhere", "Running elsewhere", { start: false, stop: false, restart: false }],
		["needs_setup", "Needs setup", { start: false, stop: false, restart: false }],
		["no_folder", "No folder chosen", { start: false, stop: false, restart: false }],
		["invalid_folder", "Folder not usable", { start: false, stop: false, restart: false }],
		["docker_not_installed", "Docker not installed", { start: false, stop: false, restart: false }],
		["compose_missing", "Docker Compose missing", { start: false, stop: false, restart: false }],
		["docker_not_running", "Docker not running", { start: true, stop: false, restart: false }],
		["unknown", "Status unknown", { start: false, stop: false, restart: false }],
	])("%s: shows %s and enables the right buttons", async (state, label, enabled) => {
		await open(state);

		expect(screen.getByRole("status")).toHaveTextContent(label);
		const start = button(state === "docker_not_running" ? "Start Docker and server" : "Start");
		expect(start.hasAttribute("disabled")).toBe(!enabled.start);
		expect(button("Stop").hasAttribute("disabled")).toBe(!enabled.stop);
		expect(button("Restart").hasAttribute("disabled")).toBe(!enabled.restart);
	});

	it("shows why the state is unknown and never offers Start for it", async () => {
		await open("unknown", { error: { code: "inspect_failed", detail: "permission denied" } });

		expect(screen.getByText(/isn't offering Start/)).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the server's state from Docker.");
		expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
		expect(button("Start").hasAttribute("disabled")).toBe(true);
	});

	it("cannot start while Docker is down on a platform where AO can't launch it", async () => {
		await open("docker_not_running", { canLaunchDocker: false });
		expect(button("Start").hasAttribute("disabled")).toBe(true);
		expect(screen.getByText(/Start it yourself/)).toBeInTheDocument();
	});

	it("explains that Start opens Docker Desktop when it can", async () => {
		await open("docker_not_running");
		expect(screen.getByText(/Start opens Docker Desktop/)).toBeInTheDocument();
	});

	it.each<LocalServerState>(["starting_server", "stopping", "restarting", "docker_starting"])("%s: disables everything but Cancel and Cancel calls the main process", async (state) => {
		await open(state);

		for (const name of ["Start", "Stop", "Restart", "Choose folder…"]) expect(button(name).hasAttribute("disabled")).toBe(true);
		await userEvent.click(button("Cancel"));
		expect(fake.cancel).toHaveBeenCalledOnce();
	});

	it("does not offer Cancel while setting up, but still disables everything else", async () => {
		await open("setting_up");
		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
		for (const name of ["Start", "Stop", "Restart", "Choose folder…"]) expect(button(name).hasAttribute("disabled")).toBe(true);
	});

	it("offers Cancel only while something runs", async () => {
		await open("healthy");
		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
	});

	it("runs Start, Stop and Restart once per click", async () => {
		await open("unhealthy");
		await userEvent.click(button("Start"));
		await waitFor(() => expect(fake.start).toHaveBeenCalledOnce());
		await userEvent.click(button("Stop"));
		await waitFor(() => expect(fake.stop).toHaveBeenCalledOnce());
		await userEvent.click(button("Restart"));
		await waitFor(() => expect(fake.restart).toHaveBeenCalledOnce());
	});

	it("offers Set up when the folder has no .env and runs it", async () => {
		await open("needs_setup");
		await userEvent.click(button("Set up local server"));
		await waitFor(() => expect(fake.setup).toHaveBeenCalledOnce());
	});

	it("does not offer Set up in other states", async () => {
		await open("stopped");
		expect(screen.queryByRole("button", { name: "Set up local server" })).not.toBeInTheDocument();
	});

	it("follows the live status pushed by the main process", async () => {
		await open("stopped");
		act(() => listener?.(status("healthy")));
		expect(screen.getByRole("status")).toHaveTextContent("Running");
		act(() => listener?.(status("restarting")));
		expect(screen.getByRole("status")).toHaveTextContent("Restarting…");
	});

	it("shows the failure of an action, with redacted details tucked under Details", async () => {
		fake.start.mockResolvedValue({ ok: false, code: "port_conflict", detail: "port is already allocated" });
		await open("stopped");
		await userEvent.click(button("Start"));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("A port the server needs is already in use.");
		expect(within(alert).getByText("Details")).toBeInTheDocument();
		expect(alert).toHaveTextContent("port is already allocated");
	});

	it("does not report a cancelled operation as an error", async () => {
		fake.start.mockResolvedValue({ ok: false, code: "cancelled" });
		await open("stopped");
		await userEvent.click(button("Start"));
		await waitFor(() => expect(fake.start).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows the last error the main process kept in the status", async () => {
		await open("stopped", { error: { code: "docker_start_timeout" } });
		expect(await screen.findByRole("alert")).toHaveTextContent("Docker didn't become ready in time");
	});

	it("shows the folder, lets the user choose another and adopt a detected one", async () => {
		await open("no_folder", { folder: null, detectedFolder: "/Users/me/code/multica" });

		expect(screen.getByText("Not chosen")).toBeInTheDocument();
		expect(screen.getByText(/Found a Multica stack in Docker: \/Users\/me\/code\/multica/)).toBeInTheDocument();
		await userEvent.click(button("Use this folder"));
		await waitFor(() => expect(fake.useDetectedFolder).toHaveBeenCalledOnce());
		await userEvent.click(button("Choose folder…"));
		await waitFor(() => expect(fake.chooseFolder).toHaveBeenCalledOnce());
	});

	it("notes when the server runs on another port than the Multica URL", async () => {
		await open("healthy", { portMismatch: { published: 3001, configured: 3000 } });
		expect(screen.getByText(/runs on port 3001, but the Multica URL above uses port 3000/)).toBeInTheDocument();
	});

	it("tells the user that Restart does not re-read .env and to retry in the Multica pane", async () => {
		await open("healthy");
		expect(screen.getByText(/Restart does not re-read the .env file/)).toBeInTheDocument();
		expect(screen.getByText(/press Retry in the Multica pane/)).toBeInTheDocument();
	});

	describe("log", () => {
		it("shows the backend log, sign-in codes included, only after it is opened, and refreshes while open", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			fake.getLogs.mockResolvedValue({ ok: true, lines: ["backend-1  | [DEV] Verification code for a@b.c: 123456"] });
			await open("healthy");
			expect(fake.getLogs).not.toHaveBeenCalled();

			await userEvent.click(button("Show log"));

			expect(await screen.findByText(/Verification code for a@b.c: 123456/)).toBeInTheDocument();
			expect(fake.getLogs).toHaveBeenCalledWith("backend");
			expect(screen.getByText(/The log is not saved/)).toBeInTheDocument();
			const calls = fake.getLogs.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3100);
			});
			expect(fake.getLogs.mock.calls.length).toBeGreaterThan(calls);
		});

		it("stops refreshing when hidden and when the block goes away", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			await open("healthy");
			await userEvent.click(button("Show log"));
			await waitFor(() => expect(fake.getLogs).toHaveBeenCalled());
			await userEvent.click(button("Hide log"));
			const calls = fake.getLogs.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(fake.getLogs.mock.calls.length).toBe(calls);
			expect(screen.queryByText("Backend log")).not.toBeInTheDocument();
		});

		it("is not available while the stack has nothing to show a log for", async () => {
			await open("needs_setup");
			expect(button("Show log").hasAttribute("disabled")).toBe(true);
		});

		it("says when there are no lines and shows why logs failed", async () => {
			await open("healthy");
			await userEvent.click(button("Show log"));
			expect(await screen.findByText("No log lines yet.")).toBeInTheDocument();

			fake.getLogs.mockResolvedValue({ ok: false, code: "docker_not_running" });
			act(() => listener?.(status("healthy", { folder: "/Users/me/.multica/server/" })));
			await waitFor(() => expect(screen.getByText("Docker isn't running.")).toBeInTheDocument(), { timeout: 4000 });
		});

		it("closes and forgets the lines when the server goes away", async () => {
			fake.getLogs.mockResolvedValue({ ok: true, lines: ["secret-looking line"] });
			await open("healthy");
			await userEvent.click(button("Show log"));
			await screen.findByText("secret-looking line");

			act(() => listener?.(status("needs_setup")));

			expect(screen.queryByText("secret-looking line")).not.toBeInTheDocument();
		});

		it("keeps the lines in memory only: no browser storage, no console output", async () => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
			// localStorage is a plain stub in these tests; sessionStorage is jsdom's, so spy on both.
			const local = vi.spyOn(window.localStorage, "setItem");
			const session = vi.spyOn(Storage.prototype, "setItem");
			try {
				fake.getLogs.mockResolvedValue({ ok: true, lines: ["[DEV] Verification code for a@b.c: 424242"] });
				window.localStorage.clear();
				window.sessionStorage.clear();
				await open("healthy");
				await userEvent.click(button("Show log"));
				await screen.findByText(/424242/);
				await userEvent.click(button("Copy log"));

				expect(local).not.toHaveBeenCalled();
				expect(session).not.toHaveBeenCalled();
				expect(window.localStorage.getItem("ao-log")).toBeNull();
				for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			} finally {
				local.mockRestore();
				session.mockRestore();
				for (const spy of spies) spy.mockRestore();
			}
		});

		it("does not show old lines when the log is opened again later", async () => {
			fake.getLogs.mockResolvedValueOnce({ ok: true, lines: ["old sign-in line 111111"] });
			await open("healthy");
			await userEvent.click(button("Show log"));
			await screen.findByText("old sign-in line 111111");
			await userEvent.click(button("Hide log"));
			act(() => listener?.(status("needs_setup")));
			fake.getLogs.mockReturnValue(new Promise(() => undefined));
			act(() => listener?.(status("healthy")));

			await userEvent.click(button("Show log"));

			expect(screen.queryByText("old sign-in line 111111")).not.toBeInTheDocument();
			expect(screen.getByText("No log lines yet.")).toBeInTheDocument();
		});
	});
});

describe("MulticaSettingsSection with the local server controls", () => {
	let original: Bridge["multica"];
	const LOCAL: MulticaSettings = { mode: "local", customUrl: "http://localhost:3000", apiUrl: "" };

	beforeEach(() => {
		original = { ...window.ao!.multica };
		resetMulticaSyncStoreSubscription();
	});
	afterEach(() => {
		Object.assign(window.ao!.multica, original);
	});

	it("mounts the controls for a saved Local server and not for Cloud", async () => {
		const getState = vi.fn(async () => status("stopped"));
		window.ao!.multica.localServer = { ...original.localServer, getState };
		window.ao!.multica.getSettings = vi.fn(async () => LOCAL);
		const local = render(<MulticaSettingsSection />);
		await screen.findByRole("group", { name: "Local Multica server" });
		local.unmount();

		getState.mockClear();
		window.ao!.multica.getSettings = vi.fn(async () => ({ ...LOCAL, mode: "cloud" as const }));
		render(<MulticaSettingsSection />);
		await screen.findByRole("heading", { name: "Multica" });
		await waitFor(() => expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Multica Cloud"));
		expect(screen.queryByRole("group", { name: "Local Multica server" })).not.toBeInTheDocument();
		expect(getState).not.toHaveBeenCalled();
	});
});
