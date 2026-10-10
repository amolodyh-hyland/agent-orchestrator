import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { MulticaSyncLinkView, MulticaSyncSnapshot } from "../../shared/multica-status-sync";
import { resetMulticaSyncStoreSubscription, useMulticaSyncStore } from "../stores/multica-sync-store";
import { MulticaLinkSyncControls } from "./MulticaLinkSyncControls";

type Bridge = NonNullable<typeof window.ao>["multicaSync"];

const link: MulticaIssueLink = {
	sessionId: "s-1",
	projectId: "project-1",
	workspaceSlug: "acme",
	issueIdentifier: "MUL-1",
	createdAt: "2026-10-01T00:00:00.000Z",
};
const ref = { sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" };

const view = (overrides: Partial<MulticaSyncLinkView> = {}): MulticaSyncLinkView => ({
	...ref,
	enabled: true,
	state: "synced",
	reason: null,
	multicaStatus: "in_progress",
	aoStatus: "in_progress",
	lastSyncAt: null,
	canResume: false,
	canReopen: false,
	...overrides,
});

const snapshot = (links: MulticaSyncLinkView[], settings: Partial<MulticaSyncSnapshot["settings"]> = {}, killSwitch = false): MulticaSyncSnapshot => ({
	settings: { enabled: true, moveOutOfBacklog: true, ...settings },
	killSwitch,
	links,
});

describe("MulticaLinkSyncControls", () => {
	let original: Bridge;

	beforeEach(() => {
		original = { ...window.ao!.multicaSync };
		resetMulticaSyncStoreSubscription();
		window.ao!.multicaSync.setLink = vi.fn(async () => snapshot([view()]));
		window.ao!.multicaSync.resume = vi.fn(async () => snapshot([view()]));
		window.ao!.multicaSync.reopen = vi.fn(async () => snapshot([view()]));
		window.ao!.multicaSync.syncNow = vi.fn(async () => snapshot([view()]));
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaSync, original);
	});

	const show = (next: MulticaSyncSnapshot) => {
		window.ao!.multicaSync.getState = vi.fn(async () => next);
		useMulticaSyncStore.setState({ snapshot: next });
		return render(<MulticaLinkSyncControls link={link} />);
	};

	it("is off by default: the switch is unchecked and nothing is shown about a sync that is not running", () => {
		show(snapshot([], { enabled: true }));

		expect(screen.getByRole("switch", { name: "Keep MUL-1 updated" })).not.toBeChecked();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(window.ao!.multicaSync.setLink).not.toHaveBeenCalled();
	});

	it("turns the sync on for this link with one click", async () => {
		show(snapshot([view({ enabled: false, state: "off" })]));

		await userEvent.click(screen.getByRole("switch", { name: "Keep MUL-1 updated" }));

		expect(window.ao!.multicaSync.setLink).toHaveBeenCalledExactlyOnceWith({ ...ref, enabled: true });
	});

	it("turns the sync off again", async () => {
		show(snapshot([view()]));
		const toggle = screen.getByRole("switch", { name: "Keep MUL-1 updated" });
		expect(toggle).toBeChecked();

		await userEvent.click(toggle);

		expect(window.ao!.multicaSync.setLink).toHaveBeenCalledExactlyOnceWith({ ...ref, enabled: false });
	});

	it("cannot be turned on while the master switch is off, and says where to turn it on", () => {
		show(snapshot([], { enabled: false }));

		expect(screen.getByRole("switch", { name: "Keep MUL-1 updated" })).toBeDisabled();
		expect(screen.getByText("Turn on “Update Multica ticket status” in Settings first.")).toBeInTheDocument();
	});

	it("cannot be turned on while the kill switch is set", () => {
		show(snapshot([], {}, true));
		expect(screen.getByRole("switch", { name: "Keep MUL-1 updated" })).toBeDisabled();
		expect(screen.getByText("Turned off for this run by AO_MULTICA_SYNC=0.")).toBeInTheDocument();
	});

	it("shows the state, the reason and what each side shows", () => {
		show(snapshot([view({ state: "paused", reason: "changed_in_multica", multicaStatus: "todo", aoStatus: "in_review", canResume: true })]));

		expect(screen.getByText("Paused")).toBeInTheDocument();
		expect(screen.getByText("Someone changed the status in Multica, so AO stopped.")).toBeInTheDocument();
		expect(screen.getByText("Multica: To do · AO: In review")).toBeInTheDocument();
	});

	it("shows a custom status by its own name", () => {
		show(snapshot([view({ multicaStatus: "qa_review", aoStatus: null })]));
		expect(screen.getByText("Multica: qa_review")).toBeInTheDocument();
	});

	it("names a refusal and an error", () => {
		const { unmount } = show(snapshot([view({ state: "refused", reason: "driven_by_multica" })]));
		expect(screen.getByText("Not updated")).toBeInTheDocument();
		expect(screen.getByText("A Multica agent owns this ticket.")).toBeInTheDocument();
		unmount();

		show(snapshot([view({ state: "error", reason: "signed_out" })]));
		expect(screen.getByText("Not synced")).toBeInTheDocument();
		expect(screen.getByText("Sign in to Multica to resume.")).toBeInTheDocument();
	});

	it("explains a sub-issue refusal", () => {
		show(snapshot([view({ state: "refused", reason: "sub_issue_parent" })]));
		expect(screen.getByText(/This is a sub-issue: changing its status can wake the agent that owns the parent/)).toBeInTheDocument();
	});

	it("resumes a link paused because someone changed the status", async () => {
		show(snapshot([view({ state: "paused", reason: "changed_in_multica", canResume: true })]));

		await userEvent.click(screen.getByRole("button", { name: "Resume" }));

		expect(window.ao!.multicaSync.resume).toHaveBeenCalledExactlyOnceWith(ref);
		expect(screen.queryByRole("button", { name: "Reopen…" })).not.toBeInTheDocument();
	});

	it("reopens a closed issue only after the user confirms", async () => {
		show(snapshot([view({ state: "paused", reason: "closed_in_multica", canReopen: true })]));
		expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Reopen…" }));

		expect(window.ao!.multicaSync.reopen).not.toHaveBeenCalled();
		expect(await screen.findByText("Reopen MUL-1 in Multica?")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));

		await waitFor(() => expect(window.ao!.multicaSync.reopen).toHaveBeenCalledExactlyOnceWith({ ...ref, confirmed: true }));
	});

	it("does not reopen when the user cancels", async () => {
		show(snapshot([view({ state: "paused", reason: "closed_in_multica", canReopen: true })]));

		await userEvent.click(screen.getByRole("button", { name: "Reopen…" }));
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		expect(window.ao!.multicaSync.reopen).not.toHaveBeenCalled();
	});

	it("offers Sync now on an error and sends it", async () => {
		show(snapshot([view({ state: "error", reason: "unreachable" })]));

		await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

		expect(window.ao!.multicaSync.syncNow).toHaveBeenCalledExactlyOnceWith(ref);
	});

	it("shows nothing about a different link", () => {
		show(snapshot([view({ sessionId: "other", state: "paused", reason: "changed_in_multica", canResume: true })]));
		expect(screen.queryByText("Paused")).not.toBeInTheDocument();
	});
});
