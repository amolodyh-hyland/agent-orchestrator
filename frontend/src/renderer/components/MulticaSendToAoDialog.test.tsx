import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { MulticaSendRequest } from "../../shared/multica-send-to-ao";
import type { AgentInfo } from "../lib/agent-select-options";
import { CLOUD_PROJECT_KIND, type WorkspaceSession, type WorkspaceSummary } from "../types/workspace";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { EMPTY_MULTICA_SYNC_SNAPSHOT } from "../../shared/multica-status-sync";
import { resetMulticaSyncStoreSubscription, useMulticaSyncStore } from "../stores/multica-sync-store";
import { MulticaSendToAoDialog } from "./MulticaSendToAoDialog";

const mocks = vi.hoisted(() => ({
	workspaces: [] as unknown[],
	readiness: { agents: [] as unknown[] },
	navigate: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: mocks.workspaces }),
	workspaceQueryKey: ["workspaces"],
}));
vi.mock("../hooks/useAgentReadinessQuery", () => ({ useAgentReadinessQuery: () => ({ data: mocks.readiness }) }));
vi.mock("../lib/navigate-to-session", () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock("../lib/multica-send-to-ao", () => ({ createMulticaIssueSession: mocks.create }));

type SendBridge = NonNullable<typeof window.ao>["multicaSend"];

const issue = {
	workspaceSlug: "acme",
	issueIdentifier: "MUL-123",
	title: "Improve onboarding",
	description: "The issue description",
	url: "http://localhost:3000/acme/issues/MUL-123",
};

function workspace(id: string, name: string, sessions: WorkspaceSession[] = [], kind: WorkspaceSummary["kind"] = "single_repo"): WorkspaceSummary {
	return { id, name, kind, path: `/repos/${id}`, sessions } as unknown as WorkspaceSummary;
}

function session(id: string, title: string, overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id,
		title,
		status: "running",
		isTerminated: false,
		...overrides,
	} as unknown as WorkspaceSession;
}

function link(overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink {
	return {
		sessionId: "session-live",
		projectId: "project-one",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-123",
		createdAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

function readinessAgent(id: string, label: string): AgentInfo {
	return {
		id,
		label,
		installation: { state: "installed", freshness: "fresh" },
		authentication: { state: "authorized", freshness: "fresh" },
		effectiveReadiness: "ready",
		usageCount: 0,
		lastUsedAt: null,
	};
}

function renderDialog() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	const rendered = render(
		<QueryClientProvider client={queryClient}>
			<MulticaSendToAoDialog />
		</QueryClientProvider>,
	);
	return { ...rendered, invalidateQueries };
}

describe("MulticaSendToAoDialog", () => {
	let originalSendBridge: SendBridge;
	let listener: ((request: MulticaSendRequest) => void) | undefined;
	let unsubscribe: ReturnType<typeof vi.fn>;

	function sendRequest(request: MulticaSendRequest = { ok: true, issue }) {
		act(() => listener?.(request));
	}

	beforeEach(() => {
		originalSendBridge = { ...window.ao!.multicaSend };
		listener = undefined;
		unsubscribe = vi.fn();
		window.ao!.multicaSend.onRequest = vi.fn((nextListener) => {
			listener = nextListener;
			return unsubscribe as unknown as () => void;
		});
		mocks.workspaces = [workspace("project-one", "Alpha"), workspace("project-two", "Beta")];
		mocks.readiness = { agents: [readinessAgent("codex", "Codex"), readinessAgent("claude-code", "Claude Code")] };
		mocks.navigate.mockReset();
		mocks.create.mockReset().mockResolvedValue({ ok: true, projectId: "project-two", sessionId: "new-session", linked: true });
		useMulticaLinksStore.setState({ links: [] });
		resetMulticaSyncStoreSubscription();
		useMulticaSyncStore.setState({ snapshot: EMPTY_MULTICA_SYNC_SNAPSHOT });
		window.localStorage.removeItem("ao.project-history");
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaSend, originalSendBridge);
	});

	it("renders nothing before a request and unsubscribes on unmount", () => {
		const { container, unmount } = renderDialog();
		expect(container).toBeEmptyDOMElement();
		expect(window.ao!.multicaSend.onRequest).toHaveBeenCalledOnce();
		unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it.each([
		["signed_out", "Sign in to Multica, then try again."],
		["no_issue", "Open a Multica issue, then try again."],
		["unreadable", "Could not read this issue from Multica. Open the issue again and retry."],
	] as const)("shows only the close action for %s", async (reason, message) => {
		renderDialog();
		sendRequest({ ok: false, reason });

		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(message);
		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("heading", { name: "Send to AO" })).not.toBeInTheDocument());
	});

	it("shows the issue and defaults to the most recently opened project", () => {
		window.localStorage.setItem("ao.project-history", JSON.stringify({
			"project-one": "2026-10-01T00:00:00.000Z",
			"project-two": "2026-10-02T00:00:00.000Z",
		}));
		renderDialog();
		sendRequest();

		expect(screen.getByText("MUL-123")).toBeInTheDocument();
		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Beta");
	});

	it("preselects the requested project and submits with it", async () => {
		window.localStorage.setItem("ao.project-history", JSON.stringify({
			"project-one": "2026-10-01T00:00:00.000Z",
			"project-two": "2026-10-02T00:00:00.000Z",
		}));
		renderDialog();
		sendRequest({ ok: true, issue, projectId: "project-one" });

		expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Alpha");
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-one" }));
	});

	it.each(["unknown-project", "cloud-project"])("falls back to the recent project for an ineligible requested project %s", (projectId) => {
		mocks.workspaces = [
			workspace("cloud-project", "Cloud", [], CLOUD_PROJECT_KIND),
			workspace("project-one", "Alpha"),
			workspace("project-two", "Beta"),
		];
		window.localStorage.setItem("ao.project-history", JSON.stringify({
			"project-one": "2026-10-01T00:00:00.000Z",
			"project-two": "2026-10-02T00:00:00.000Z",
		}));
		renderDialog();
		sendRequest({ ok: true, issue, projectId });

		expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Beta");
	});

	it("offers only local projects and defaults to the most recently opened local project", async () => {
		mocks.workspaces = [
			workspace("cloud-project", "Cloud", [session("cloud-session", "Cloud worker")], CLOUD_PROJECT_KIND),
			workspace("project-one", "Alpha"),
			workspace("project-two", "Beta"),
		];
		window.localStorage.setItem("ao.project-history", JSON.stringify({
			"cloud-project": "2026-10-03T00:00:00.000Z",
			"project-one": "2026-10-01T00:00:00.000Z",
			"project-two": "2026-10-02T00:00:00.000Z",
		}));
		useMulticaLinksStore.setState({ links: [link({ projectId: "cloud-project", sessionId: "cloud-session" })] });
		renderDialog();
		sendRequest();

		expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Beta");
		expect(screen.queryByText("Already sent to AO")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
		expect(screen.queryByRole("option", { name: "Cloud" })).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
	});

	it("disables create and explains how to continue when there are no projects", () => {
		mocks.workspaces = [];
		renderDialog();
		sendRequest();

		expect(screen.getByText("No AO projects yet. Add a project first.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
	});

	it("creates with the project default or the selected launchable agent", async () => {
		mocks.create.mockResolvedValue({ ok: false, message: "Try again" });
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		expect(mocks.create).toHaveBeenLastCalledWith({
			issue,
			projectId: "project-one",
			harness: undefined,
			fallbackMessage: "Could not create the session.",
		});

		mocks.create.mockClear().mockResolvedValue({ ok: false, message: "Try again" });
		await userEvent.click(screen.getByRole("combobox", { name: "Project" }));
		await userEvent.click(screen.getByRole("option", { name: "Beta" }));
		await userEvent.click(screen.getByRole("combobox", { name: "Agent" }));
		await userEvent.click(screen.getByRole("option", { name: "Codex" }));
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
		expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "project-two", harness: "codex" }));
	});

	it("shows only active linked sessions and lets the user open one", async () => {
		mocks.workspaces = [workspace("project-one", "Alpha", [
			session("session-live", "Live worker"),
			session("session-ended", "Terminated worker", { isTerminated: true, status: "terminated" as WorkspaceSession["status"] }),
			session("session-unknown", "Unknown worker", { status: "unknown" as WorkspaceSession["status"] }),
		])];
		useMulticaLinksStore.setState({ links: [
			link(),
			link({ sessionId: "session-ended" }),
			link({ sessionId: "session-unknown" }),
			link({ sessionId: "missing-session" }),
		] });
		renderDialog();
		sendRequest();

		expect(screen.getByText("Already sent to AO")).toBeInTheDocument();
		expect(screen.getByText("Alpha: Live worker")).toBeInTheDocument();
		expect(screen.queryByText("Alpha: Terminated worker")).not.toBeInTheDocument();
		expect(screen.queryByText("Alpha: Unknown worker")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send anyway" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "session-live");
	});

	it("keeps create single-flight while a request is pending", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: false }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		renderDialog();
		sendRequest();
		const createButton = screen.getByRole("button", { name: "Create session" });
		await userEvent.click(createButton);
		await userEvent.click(createButton);

		expect(createButton).toBeDisabled();
		expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
		expect(mocks.create).toHaveBeenCalledOnce();
		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: false }));
	});

	it("disables duplicate session Open while creating and re-enables it for the same request", async () => {
		let resolveCreate: ((value: { ok: false; message: string }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		mocks.workspaces = [workspace("project-one", "Alpha", [session("session-live", "Live worker")])];
		useMulticaLinksStore.setState({ links: [link()] });
		renderDialog();
		sendRequest();
		const duplicateOpen = screen.getByRole("button", { name: "Open" });

		await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
		expect(duplicateOpen).toBeDisabled();
		await userEvent.click(duplicateOpen);
		expect(mocks.navigate).not.toHaveBeenCalled();
		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();

		await act(async () => resolveCreate?.({ ok: false, message: "Try again" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
		expect(duplicateOpen).toBeEnabled();
		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
	});

	it("keeps a parked request pending when duplicate Open is clicked during a create", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: false }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		mocks.workspaces = [workspace("project-one", "Alpha", [session("session-live", "Live worker")])];
		useMulticaLinksStore.setState({ links: [link()] });
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
		sendRequest({ ok: true, issue: { ...issue, issueIdentifier: "MUL-456", title: "Second issue" } });

		const duplicateOpen = screen.getByRole("button", { name: "Open" });
		expect(duplicateOpen).toBeDisabled();
		await userEvent.click(duplicateOpen);
		expect(mocks.navigate).not.toHaveBeenCalled();
		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
		expect(screen.queryByText("Second issue")).not.toBeInTheDocument();

		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: false }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The session was created, but the link to this issue could not be saved.");
		expect(screen.getByRole("button", { name: "Open session" })).toBeInTheDocument();
		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
		expect(screen.queryByText("Second issue")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Open session" }));
		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "new-session");
		expect(screen.getByText("Second issue")).toBeInTheDocument();
	});

	it("ignores outside clicks while creating", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: false }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));

		const overlay = document.querySelector(".dialog-overlay");
		expect(overlay).not.toBeNull();
		fireEvent.pointerDown(overlay!);
		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();

		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: false }));
	});

	it("does not invalidate or navigate after a linked create completes after unmount", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: true }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		const { unmount, invalidateQueries } = renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		unmount();

		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: true }));

		expect(mocks.navigate).not.toHaveBeenCalled();
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("does not navigate or throw when an unlinked create completes after unmount", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: false }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		const { unmount } = renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		unmount();

		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: false }));

		expect(mocks.navigate).not.toHaveBeenCalled();
	});

	it("shows the first create's link warning before applying a request received while it was pending", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: false }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		sendRequest({ ok: true, issue: { ...issue, issueIdentifier: "MUL-456", title: "Second issue" } });

		expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
		expect(screen.queryByText("Second issue")).not.toBeInTheDocument();
		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: false }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The session was created, but the link to this issue could not be saved.");
		expect(screen.queryByText("Second issue")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open session" }));

		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "new-session");
		expect(screen.getByText("Second issue")).toBeInTheDocument();
		expect(screen.queryByText("Improve onboarding")).not.toBeInTheDocument();
	});

	it("navigates after a linked create before showing a request received while it was pending", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: true }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		sendRequest({ ok: true, issue: { ...issue, issueIdentifier: "MUL-456", title: "Second issue" } });

		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: true }));

		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "new-session");
		expect(screen.getByText("Second issue")).toBeInTheDocument();
		expect(screen.queryByText("Improve onboarding")).not.toBeInTheDocument();
	});

	it("ignores Escape while creating and closes after the create finishes", async () => {
		let resolveCreate: ((value: { ok: true; sessionId: string; projectId: string; linked: true }) => void) | undefined;
		mocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		await userEvent.keyboard("{Escape}");

		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();
		await act(async () => resolveCreate?.({ ok: true, sessionId: "new-session", projectId: "project-one", linked: true }));

		await waitFor(() => expect(screen.queryByRole("heading", { name: "Send to AO" })).not.toBeInTheDocument());
		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "new-session");
	});

	it("shows API errors and allows retrying", async () => {
		mocks.create
			.mockResolvedValueOnce({ ok: false, message: "The daemon rejected this request." })
			.mockResolvedValueOnce({ ok: true, projectId: "project-one", sessionId: "new-session", linked: true });
		const { invalidateQueries } = renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The daemon rejected this request.");
		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));
		await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("project-one", "new-session"));
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
	});

	it("invalidates workspaces, navigates and closes after a linked session is created", async () => {
		const { invalidateQueries } = renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));

		await waitFor(() => expect(screen.queryByRole("heading", { name: "Send to AO" })).not.toBeInTheDocument());
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-two", "new-session");
	});

	it("keeps an unlinked created session open until the user chooses to open it", async () => {
		mocks.create.mockResolvedValue({ ok: true, projectId: "project-one", sessionId: "unlinked-session", linked: false });
		renderDialog();
		sendRequest();
		await userEvent.click(screen.getByRole("button", { name: "Create session" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("The session was created, but the link to this issue could not be saved.");
		expect(screen.getByRole("button", { name: "Open session" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open session" }));
		expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("project-one", "unlinked-session");
		await waitFor(() => expect(screen.queryByRole("heading", { name: "Send to AO" })).not.toBeInTheDocument());
	});

	it("replaces the current dialog when another request arrives", () => {
		renderDialog();
		sendRequest({ ok: false, reason: "no_issue" });
		sendRequest({ ok: true, issue: { ...issue, issueIdentifier: "MUL-456", title: "Second issue" } });

		expect(screen.getByText("MUL-456")).toBeInTheDocument();
		expect(screen.queryByText("Open a Multica issue, then try again.")).not.toBeInTheDocument();
	});

	describe("Keep this ticket updated", () => {
		const syncOn = () => {
			const snapshot = { settings: { enabled: true, moveOutOfBacklog: true }, killSwitch: false, links: [] };
			window.ao!.multicaSync.getState = vi.fn(async () => snapshot);
			useMulticaSyncStore.setState({ snapshot });
		};

		afterEach(() => {
			vi.mocked(window.ao!.multicaSync.setLink).mockClear();
		});

		it("is unchecked by default and does not turn the sync on", async () => {
			syncOn();
			renderDialog();
			sendRequest();

			const box = screen.getByRole("checkbox", { name: "Keep this ticket updated" });
			expect(box).not.toBeChecked();
			expect(box).toBeEnabled();
			await userEvent.click(screen.getByRole("button", { name: "Create session" }));
			await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());

			expect(window.ao!.multicaSync.setLink).not.toHaveBeenCalled();
		});

		it("turns the sync on for the new link when ticked, once the link exists", async () => {
			syncOn();
			renderDialog();
			sendRequest();

			await userEvent.click(screen.getByRole("checkbox", { name: "Keep this ticket updated" }));
			await userEvent.click(screen.getByRole("button", { name: "Create session" }));
			await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());

			expect(window.ao!.multicaSync.setLink).toHaveBeenCalledExactlyOnceWith({
				sessionId: "new-session",
				workspaceSlug: "acme",
				issueIdentifier: "MUL-123",
				enabled: true,
			});
			expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.ao!.multicaSync.setLink).mock.invocationCallOrder[0]);
		});

		it("does not turn the sync on when the link could not be saved", async () => {
			syncOn();
			mocks.create.mockResolvedValue({ ok: true, projectId: "project-one", sessionId: "unlinked-session", linked: false });
			renderDialog();
			sendRequest();

			await userEvent.click(screen.getByRole("checkbox", { name: "Keep this ticket updated" }));
			await userEvent.click(screen.getByRole("button", { name: "Create session" }));
			await screen.findByRole("alert");

			expect(window.ao!.multicaSync.setLink).not.toHaveBeenCalled();
		});

		it("is unchecked again for the next request", async () => {
			syncOn();
			renderDialog();
			sendRequest();
			await userEvent.click(screen.getByRole("checkbox", { name: "Keep this ticket updated" }));
			expect(screen.getByRole("checkbox", { name: "Keep this ticket updated" })).toBeChecked();

			sendRequest({ ok: true, issue: { ...issue, issueIdentifier: "MUL-456" } });
			expect(screen.getByRole("checkbox", { name: "Keep this ticket updated" })).not.toBeChecked();
		});

		it("is disabled while the master switch is off, with the way to turn it on", async () => {
			renderDialog();
			sendRequest();

			const box = screen.getByRole("checkbox", { name: "Keep this ticket updated" });
			expect(box).toBeDisabled();
			expect(screen.getByText("Turn on “Update Multica ticket status” in Settings first.")).toBeInTheDocument();
			await userEvent.click(screen.getByRole("button", { name: "Create session" }));
			await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
			expect(window.ao!.multicaSync.setLink).not.toHaveBeenCalled();
		});

		it("is disabled while the kill switch is set", () => {
			const snapshot = { settings: { enabled: true, moveOutOfBacklog: true }, killSwitch: true, links: [] };
			window.ao!.multicaSync.getState = vi.fn(async () => snapshot);
			useMulticaSyncStore.setState({ snapshot });
			renderDialog();
			sendRequest();
			expect(screen.getByRole("checkbox", { name: "Keep this ticket updated" })).toBeDisabled();
		});
	});
});
