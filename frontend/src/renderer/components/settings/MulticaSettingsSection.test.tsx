import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaSetSettingsRequest, MulticaSetSettingsResult, MulticaSettings } from "../../../shared/multica";
import { EMPTY_MULTICA_SYNC_SNAPSHOT, type MulticaSyncSnapshot } from "../../../shared/multica-status-sync";
import { resetMulticaSyncStoreSubscription, useMulticaSyncStore } from "../../stores/multica-sync-store";
import { MulticaSettingsSection } from "./MulticaSettingsSection";

type Bridge = NonNullable<typeof window.ao>;

const LOCAL: MulticaSettings = { mode: "local", customUrl: "http://localhost:3000", apiUrl: "" };

describe("MulticaSettingsSection", () => {
	let original: Bridge["multica"];

	const acceptAll = () =>
		vi.fn(
			async (request: MulticaSetSettingsRequest): Promise<MulticaSetSettingsResult> => ({
				ok: true,
				settings: { mode: request.mode, customUrl: request.customUrl, apiUrl: request.apiUrl ?? "" },
			}),
		);

	beforeEach(() => {
		original = { ...window.ao!.multica };
		window.ao!.multica.getSettings = vi.fn(async () => LOCAL);
		window.ao!.multica.setSettings = acceptAll();
	});

	afterEach(() => {
		Object.assign(window.ao!.multica, original);
	});

	async function open() {
		render(<MulticaSettingsSection />);
		await screen.findByText("http://localhost:3000");
	}

	async function chooseMode(label: string) {
		await userEvent.click(screen.getByRole("button", { name: "Server" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: label }));
	}

	async function editUrl(value: string) {
		await userEvent.click(screen.getByRole("button", { name: "Edit Multica URL" }));
		const input = screen.getByRole("textbox", { name: "Multica URL" });
		await userEvent.clear(input);
		await userEvent.type(input, `${value}{Enter}`);
	}

	it("shows the saved server under a Multica heading, local by default with its address", async () => {
		await open();

		expect(screen.getByRole("heading", { name: "Multica" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Local / self-hosted");
		expect(screen.queryByRole("button", { name: "Save and switch" })).not.toBeInTheDocument();
	});

	it("switches to Multica Cloud only after the change is applied, and warns about sign-in and data first", async () => {
		await open();

		await chooseMode("Multica Cloud");

		expect(window.ao!.multica.setSettings).not.toHaveBeenCalled();
		expect(screen.getByText(/has its own accounts and data/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit Multica URL" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		await waitFor(() =>
			expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith({ mode: "cloud", customUrl: "http://localhost:3000", apiUrl: "" }),
		);
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save and switch" })).not.toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Multica Cloud");
		expect(screen.getByText(/multica login --profile ao-multica\.ai/)).toBeInTheDocument();
	});

	it("explains what a switch leaves behind, in a polite live region the buttons are described by", async () => {
		await open();

		await chooseMode("Multica Cloud");

		const notes = screen.getByText(/has its own accounts and data/).closest("[role='status']")!;
		expect(notes).toHaveAttribute("aria-live", "polite");
		expect(notes).toHaveTextContent("Issue links made on the other server stay hidden");
		expect(notes).toHaveTextContent("keeps running");
		expect(notes).toHaveTextContent("hosted daemon only serves the default local server");
		expect(screen.getByRole("button", { name: "Save and switch" })).toHaveAttribute("aria-describedby", notes.id);
	});

	it("warns when only the API address of the same web address changes, since that is another server", async () => {
		await open();

		await userEvent.click(screen.getByRole("button", { name: "Edit API URL (optional)" }));
		const input = screen.getByRole("textbox", { name: "API URL (optional)" });
		await userEvent.type(input, "https://api.other.example.com{Enter}");

		expect(screen.getByText(/has its own accounts and data/)).toBeInTheDocument();
	});

	it("announces that the server is being checked", async () => {
		let finish!: (result: MulticaSetSettingsResult) => void;
		window.ao!.multica.setSettings = vi.fn(() => new Promise<MulticaSetSettingsResult>((resolve) => (finish = resolve)));
		await open();
		await chooseMode("Multica Cloud");

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		expect(screen.getAllByRole("status").some((node) => node.textContent === "Checking the server…")).toBe(true);
		finish({ ok: true, settings: { mode: "cloud", customUrl: "http://localhost:3000", apiUrl: "" } });
		await waitFor(() => expect(screen.queryByRole("button", { name: "Save and switch" })).not.toBeInTheDocument());
	});

	it("applies a custom URL and shows the CLI sign-in command for that server", async () => {
		await open();

		await editUrl("https://multica.example.com");
		expect(screen.getByText(/multica setup self-host --profile ao-multica\.example\.com/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		await waitFor(() =>
			expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith({
				mode: "local",
				customUrl: "https://multica.example.com",
				apiUrl: "",
			}),
		);
		expect(await screen.findByText("https://multica.example.com")).toBeInTheDocument();
	});

	it("drops a stale API URL when the server address changes", async () => {
		window.ao!.multica.getSettings = vi.fn(async () => ({ mode: "local" as const, customUrl: "https://multica.example.com", apiUrl: "https://multica.example.com" }));
		render(<MulticaSettingsSection />);
		await screen.findAllByText("https://multica.example.com");

		await editUrl("https://other.example.com");
		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		await waitFor(() =>
			expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith({ mode: "local", customUrl: "https://other.example.com", apiUrl: "" }),
		);
	});

	it("turns Multica off when the address is cleared", async () => {
		await open();

		await editUrl("");

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));
		await waitFor(() => expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith({ mode: "local", customUrl: "", apiUrl: "" }));
		expect(await screen.findByText("Not set")).toBeInTheDocument();
	});

	it.each([
		["insecure_http", "Use https:// for a server on the internet. Plain http:// is only allowed for localhost and private networks."],
		["path_not_allowed", "Enter the server address without a path."],
		["invalid_url", "Enter a valid http:// or https:// address."],
	] as const)("shows %s as an error that cannot be forced", async (error, message) => {
		window.ao!.multica.setSettings = vi.fn(async () => ({ ok: false as const, error, forceable: false }));
		await open();
		await editUrl("http://multica.example.com");

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		expect(screen.queryByRole("button", { name: "Save anyway" })).not.toBeInTheDocument();
	});

	it("offers to save anyway when the check failed, and saves with force", async () => {
		const setSettings = vi
			.fn<(request: MulticaSetSettingsRequest) => Promise<MulticaSetSettingsResult>>()
			.mockResolvedValueOnce({ ok: false, error: "unreachable", forceable: true })
			.mockImplementation(acceptAll());
		window.ao!.multica.setSettings = setSettings;
		await open();
		await editUrl("https://multica.example.com");

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the server. Check the address and that it is running.");
		await userEvent.click(screen.getByRole("button", { name: "Save anyway" }));

		await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ customUrl: "https://multica.example.com", force: true })));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});

	it("reports a failed save", async () => {
		window.ao!.multica.setSettings = vi.fn(async () => {
			throw new Error("disk full");
		});
		await open();
		await editUrl("http://localhost:3100");

		await userEvent.click(screen.getByRole("button", { name: "Save and switch" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the Multica URL.");
	});

	it("discards the pending change on cancel", async () => {
		await open();
		await chooseMode("Multica Cloud");

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.getByRole("button", { name: "Server" })).toHaveTextContent("Local / self-hosted");
		expect(window.ao!.multica.setSettings).not.toHaveBeenCalled();
	});

	describe("status sync", () => {
		let originalSync: Bridge["multicaSync"];
		const snapshot = (settings: Partial<MulticaSyncSnapshot["settings"]> = {}, killSwitch = false): MulticaSyncSnapshot => ({
			settings: { enabled: false, moveOutOfBacklog: false, ...settings },
			killSwitch,
			links: [],
		});
		const withSync = (next: MulticaSyncSnapshot) => {
			window.ao!.multicaSync.getState = vi.fn(async () => next);
			useMulticaSyncStore.setState({ snapshot: next });
		};

		beforeEach(() => {
			originalSync = { ...window.ao!.multicaSync };
			resetMulticaSyncStoreSubscription();
			useMulticaSyncStore.setState({ snapshot: EMPTY_MULTICA_SYNC_SNAPSHOT });
			window.ao!.multicaSync.setSettings = vi.fn(async () => snapshot({ enabled: true }));
		});

		afterEach(() => {
			Object.assign(window.ao!.multicaSync, originalSync);
		});

		it("is off by default, with the Backlog move disabled until the master switch is on", async () => {
			withSync(snapshot());
			await open();

			expect(screen.getByRole("switch", { name: "Update Multica ticket status" })).not.toBeChecked();
			expect(screen.getByRole("switch", { name: "Move tickets out of Backlog" })).toBeDisabled();
			expect(window.ao!.multicaSync.setSettings).not.toHaveBeenCalled();
		});

		it("shows the Backlog move off by default, and says it is off by default and why", async () => {
			withSync({ settings: { enabled: true, moveOutOfBacklog: false }, killSwitch: false, links: [] });
			await open();
			expect(screen.getByRole("switch", { name: "Move tickets out of Backlog" })).not.toBeChecked();
			expect(screen.getByText(/Off by default\. When on, starting a session on a ticket in Backlog moves it to In progress\. A ticket in Triage can look like Backlog/)).toBeInTheDocument();
		});

		it("explains what it does and never does", async () => {
			withSync(snapshot());
			await open();

			expect(screen.getByText(/never to Backlog, Blocked or Cancelled, and never changes who it is assigned to/)).toBeInTheDocument();
			expect(screen.getByText(/Each link is switched on separately/)).toBeInTheDocument();
		});

		it("warns that Multica's Triage cannot be seen, so sync should only be turned on for accepted tickets", async () => {
			withSync(snapshot());
			await open();
			expect(screen.getByText(/cannot see whether a ticket is still in Multica’s Triage/)).toBeInTheDocument();
			expect(screen.getByText(/only for tickets that have been accepted/)).toBeInTheDocument();
		});

		it("turns the master switch on", async () => {
			withSync(snapshot());
			await open();

			await userEvent.click(screen.getByRole("switch", { name: "Update Multica ticket status" }));

			expect(window.ao!.multicaSync.setSettings).toHaveBeenCalledExactlyOnceWith({ enabled: true });
		});

		it("turns the Backlog move on only when asked, once the master switch is on, and off again", async () => {
			withSync(snapshot({ enabled: true }));
			await open();
			const toggle = screen.getByRole("switch", { name: "Move tickets out of Backlog" });
			expect(toggle).not.toBeChecked();

			await userEvent.click(toggle);
			expect(window.ao!.multicaSync.setSettings).toHaveBeenLastCalledWith({ moveOutOfBacklog: true });
		});

		it("turns the Backlog move off again when it was on", async () => {
			withSync(snapshot({ enabled: true, moveOutOfBacklog: true }));
			await open();
			await userEvent.click(screen.getByRole("switch", { name: "Move tickets out of Backlog" }));
			expect(window.ao!.multicaSync.setSettings).toHaveBeenLastCalledWith({ moveOutOfBacklog: false });
		});

		it("disables both switches and says why while AO_MULTICA_SYNC=0 is set", async () => {
			withSync(snapshot({ enabled: true }, true));
			await open();

			expect(screen.getByRole("switch", { name: "Update Multica ticket status" })).toBeDisabled();
			expect(screen.getByRole("switch", { name: "Move tickets out of Backlog" })).toBeDisabled();
			expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Turned off for this run by AO_MULTICA_SYNC=0.");
		});
	});
});
