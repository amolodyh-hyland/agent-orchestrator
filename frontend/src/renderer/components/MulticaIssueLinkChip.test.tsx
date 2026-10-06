import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { useMulticaStore } from "../stores/multica-store";
import { MulticaIssueLinkChip } from "./MulticaIssueLinkChip";
import { TooltipProvider } from "./ui/tooltip";

type Bridge = NonNullable<typeof window.ao>["multicaLinks"];

const link = (overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink => ({
	sessionId: "session-1",
	projectId: "project-1",
	workspaceSlug: "acme",
	issueIdentifier: "MUL-123",
	createdAt: "2026-10-01T00:00:00.000Z",
	...overrides,
});

function renderChip() {
	return render(
		<TooltipProvider>
			<MulticaIssueLinkChip projectId="project-1" sessionId="session-1" />
		</TooltipProvider>,
	);
}

describe("MulticaIssueLinkChip", () => {
	let originalLinksBridge: Bridge;

	beforeEach(() => {
		originalLinksBridge = { ...window.ao!.multicaLinks };
		window.ao!.multicaLinks.list = vi.fn(async () => []);
		window.ao!.multicaLinks.add = vi.fn(async () => ({ ok: false as const, reason: "save_failed" as const }));
		window.ao!.multicaLinks.remove = vi.fn(async () => []);
		window.ao!.multicaLinks.openIssue = vi.fn(async () => true);
		useMulticaLinksStore.setState({ links: [] });
		useMulticaStore.setState({ view: { active: false, status: "ready", url: "http://localhost:3000/" } });
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaLinks, originalLinksBridge);
	});

	it("renders nothing while Multica is unconfigured", () => {
		useMulticaStore.setState({ view: { active: false, status: "unconfigured", url: "" } });
		renderChip();
		expect(screen.queryByTestId("multica-issue-link-chip")).not.toBeInTheDocument();
	});

	it("shows the add control when this session has no linked issue", () => {
		renderChip();
		expect(screen.getByRole("button", { name: "Link Multica issue" })).toBeInTheDocument();
		expect(screen.getByTestId("multica-issue-link-chip").querySelector(".lucide-link-2")).not.toBeNull();
	});

	it("shows the first linked issue and the number of additional links", () => {
		useMulticaLinksStore.setState({ links: [link(), link({ issueIdentifier: "MUL-456" })] });
		renderChip();

		expect(screen.getByTestId("multica-issue-link-chip")).toHaveTextContent("MUL-123+1");
	});

	it("submits the typed issue URL and shows the translated validation error", async () => {
		window.ao!.multicaLinks.add = vi.fn(async () => ({ ok: false as const, reason: "invalid_issue" as const }));
		renderChip();
		await userEvent.click(screen.getByTestId("multica-issue-link-chip"));
		const input = screen.getByPlaceholderText("Multica issue URL");
		await userEvent.type(input, "http://localhost:3000/acme/issues/MUL-123");
		await userEvent.click(screen.getByRole("button", { name: "Link" }));

		expect(window.ao!.multicaLinks.add).toHaveBeenCalledExactlyOnceWith({
			sessionId: "session-1",
			projectId: "project-1",
			issue: "http://localhost:3000/acme/issues/MUL-123",
		});
		expect(await screen.findByText("Paste a Multica issue URL, for example http://localhost:3000/acme/issues/MUL-123.")).toBeInTheDocument();
	});

	it("does not show links for other sessions", async () => {
		useMulticaLinksStore.setState({ links: [link({ sessionId: "other-session", issueIdentifier: "MUL-456" })] });
		renderChip();
		await userEvent.click(screen.getByTestId("multica-issue-link-chip"));

		expect(screen.queryByRole("button", { name: "Open MUL-456 in Multica" })).not.toBeInTheDocument();
	});

	it("opens a linked issue and closes the popover", async () => {
		useMulticaLinksStore.setState({ links: [link()] });
		renderChip();
		await userEvent.click(screen.getByTestId("multica-issue-link-chip"));
		await userEvent.click(screen.getByRole("button", { name: "Open MUL-123 in Multica" }));

		expect(window.ao!.multicaLinks.openIssue).toHaveBeenCalledExactlyOnceWith({ workspaceSlug: "acme", issueIdentifier: "MUL-123" });
		await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink MUL-123" })).not.toBeInTheDocument());
	});

	it("unlinks the selected issue using its session and issue key", async () => {
		useMulticaLinksStore.setState({ links: [link()] });
		renderChip();
		await userEvent.click(screen.getByTestId("multica-issue-link-chip"));
		await userEvent.click(screen.getByRole("button", { name: "Unlink MUL-123" }));

		expect(window.ao!.multicaLinks.remove).toHaveBeenCalledExactlyOnceWith({
			sessionId: "session-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-123",
		});
	});
});
