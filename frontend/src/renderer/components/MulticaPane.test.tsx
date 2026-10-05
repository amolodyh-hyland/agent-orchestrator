import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaViewState } from "../../shared/multica";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { MulticaSendRequest } from "../../shared/multica-send-to-ao";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";
import { MulticaPane } from "./MulticaPane";

const router = vi.hoisted(() => ({ pathname: "/" }));
const navigation = vi.hoisted(() => ({ navigateToSession: vi.fn() }));
let sendRequestListener: ((request: MulticaSendRequest) => void) | undefined;

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
			select({ location: { pathname: router.pathname } }),
	};
});

vi.mock("../lib/navigate-to-session", () => ({ useNavigateToSession: () => navigation.navigateToSession }));
vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery: () => ({ data: [] }), workspaceQueryKey: ["workspaces"] }));
vi.mock("../hooks/useAgentReadinessQuery", () => ({ useAgentReadinessQuery: () => ({ data: { agents: [] } }) }));
vi.mock("./MulticaStatusPublisher", () => ({ MulticaStatusPublisher: () => <div data-testid="multica-status-publisher" /> }));

const URL = "http://localhost:3000/";
type Bridge = NonNullable<typeof window.ao>;

describe("MulticaPane", () => {
	let originalMultica: Bridge["multica"];
	let originalMulticaLinks: Bridge["multicaLinks"];
	let originalMulticaSend: Bridge["multicaSend"];
	let toggleListener: (() => void) | undefined;
	let removeToggleListener: ReturnType<typeof vi.fn>;
	let openSessionListener: ((target: { projectId: string; sessionId: string }) => void) | undefined;
	let removeOpenSessionListener: ReturnType<typeof vi.fn>;
	let removeSendListener: ReturnType<typeof vi.fn>;
	let originalLinksLoad: ReturnType<typeof useMulticaLinksStore.getState>["load"];
	let current: MulticaViewState;

	function renderPane() {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return { ...render(<QueryClientProvider client={queryClient}><MulticaPane /></QueryClientProvider>), queryClient };
	}

	function showView(view: MulticaViewState) {
		current = view;
		useMulticaStore.setState({ view });
	}

	beforeEach(() => {
		originalLinksLoad = useMulticaLinksStore.getState().load;
		router.pathname = "/";
		originalMultica = { ...window.ao!.multica };
		originalMulticaLinks = { ...window.ao!.multicaLinks };
		originalMulticaSend = { ...window.ao!.multicaSend };
		removeToggleListener = vi.fn();
		removeOpenSessionListener = vi.fn();
		removeSendListener = vi.fn();
		sendRequestListener = undefined;
		openSessionListener = undefined;
		navigation.navigateToSession.mockReset();
		toggleListener = undefined;
		current = { active: false, status: "unconfigured", url: "" };
		window.ao!.multica.getState = vi.fn(async () => current);
		window.ao!.multica.setActive = vi.fn(async (active: boolean): Promise<MulticaViewState> => ({ ...current, active }));
		window.ao!.multica.reload = vi.fn(async () => current);
		window.ao!.multica.onToggleShortcut = vi.fn((listener: () => void) => {
			toggleListener = listener;
			return removeToggleListener as unknown as () => void;
		});
		window.ao!.multicaLinks.onOpenSession = vi.fn((listener: (target: { projectId: string; sessionId: string }) => void) => {
			openSessionListener = listener;
			return removeOpenSessionListener as unknown as () => void;
		});
		window.ao!.multicaSend.onRequest = vi.fn((listener) => {
			sendRequestListener = listener;
			return removeSendListener as unknown as () => void;
		});
		showView(current);
	});

	afterEach(() => {
		Object.assign(window.ao!.multica, originalMultica);
		Object.assign(window.ao!.multicaLinks, originalMulticaLinks);
		Object.assign(window.ao!.multicaSend, originalMulticaSend);
		useMulticaLinksStore.setState({ load: originalLinksLoad });
		useUiStore.getState().closeSettings();
	});

	it("loads the issue links once on mount, without the chip", () => {
		const loadLinks = vi.fn(async () => undefined);
		useMulticaLinksStore.setState({ load: loadLinks });
		renderPane();

		expect(loadLinks).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("multica-issue-link-chip")).not.toBeInTheDocument();
	});

	it("loads and follows issue links through the pane", async () => {
		vi.resetModules();
		const linkedIssue: MulticaIssueLink = {
			sessionId: "s1",
			projectId: "p1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		let onChangedListener: ((links: MulticaIssueLink[]) => void) | undefined;
		window.ao!.multicaLinks.list = vi.fn(async () => [linkedIssue]);
		window.ao!.multicaLinks.onChanged = vi.fn((listener: (links: MulticaIssueLink[]) => void) => {
			onChangedListener = listener;
			return () => undefined;
		});

		const [{ act, render }, { QueryClient, QueryClientProvider }, { useMulticaLinksStore: freshLinksStore }, { MulticaPane: FreshMulticaPane }] = await Promise.all([
			import("@testing-library/react"),
			import("@tanstack/react-query"),
			import("../stores/multica-links-store"),
			import("./MulticaPane"),
		]);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		await act(async () => {
			render(<QueryClientProvider client={queryClient}><FreshMulticaPane /></QueryClientProvider>);
		});

		expect(freshLinksStore.getState().links).toEqual([linkedIssue]);
		await act(async () => onChangedListener?.([]));
		expect(freshLinksStore.getState().links).toEqual([]);
	});

	it("renders nothing while AO is the active view", () => {
		showView({ active: false, status: "ready", url: URL });
		renderPane();
		expect(screen.queryByTestId("multica-pane")).not.toBeInTheDocument();
	});

	it("shows a clear empty state with a way to settings when no URL is set", async () => {
		showView({ active: true, status: "unconfigured", url: "" });
		renderPane();

		expect(screen.getByText("Multica URL is not set")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open settings" }));

		expect(useUiStore.getState().settingsModal).toMatchObject({ scope: "global", section: "general" });
	});

	it("shows a loading state while the page loads", () => {
		showView({ active: true, status: "loading", url: URL });
		renderPane();
		expect(screen.getByText("Loading Multica…")).toBeInTheDocument();
	});

	it("shows the unreachable server and lets the user retry", async () => {
		showView({ active: true, status: "error", url: URL, error: "ERR_CONNECTION_REFUSED" });
		renderPane();

		expect(screen.getByText("Can't reach Multica")).toBeInTheDocument();
		expect(screen.getByText(`Check that the Multica server is running at ${URL}, then try again.`)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(window.ao!.multica.reload).toHaveBeenCalledOnce();
	});

	it("renders no status message while the page is live, since the view covers the window", () => {
		showView({ active: true, status: "ready", url: URL });
		renderPane();

		expect(screen.queryByText("Can't reach Multica")).not.toBeInTheDocument();
		expect(screen.queryByText("Loading Multica…")).not.toBeInTheDocument();
	});

	it("shows why the page could not be loaded", () => {
		showView({ active: true, status: "error", url: URL, error: "Multica desktop bundle not found." });
		renderPane();
		expect(screen.getByText("Multica desktop bundle not found.")).toBeInTheDocument();
	});

	it("switches with the keyboard shortcut, in both directions", () => {
		renderPane();
		expect(toggleListener).toBeDefined();

		act(() => toggleListener?.());
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(true);

		act(() => showView({ active: true, status: "ready", url: URL }));
		act(() => toggleListener?.());
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(false);
	});

	it("stops listening for the shortcut when unmounted", () => {
		const { unmount } = renderPane();
		unmount();
		expect(removeToggleListener).toHaveBeenCalledOnce();
	});

	it("navigates to sessions opened from Multica and unsubscribes on unmount", () => {
		const { unmount } = renderPane();
		act(() => openSessionListener?.({ projectId: "p", sessionId: "s" }));

		expect(navigation.navigateToSession).toHaveBeenCalledExactlyOnceWith("p", "s");
		unmount();
		expect(removeOpenSessionListener).toHaveBeenCalledOnce();
	});

	it("returns to AO when the user navigates inside AO", () => {
		showView({ active: true, status: "ready", url: URL });
		const { rerender, queryClient } = renderPane();
		expect(window.ao!.multica.setActive).not.toHaveBeenCalled();

		router.pathname = "/sessions/abc";
		rerender(<QueryClientProvider client={queryClient}><MulticaPane /></QueryClientProvider>);

		expect(window.ao!.multica.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("does not message the main process on navigation while AO is showing", () => {
		const { rerender, queryClient } = renderPane();

		router.pathname = "/sessions/abc";
		rerender(<QueryClientProvider client={queryClient}><MulticaPane /></QueryClientProvider>);

		expect(window.ao!.multica.setActive).not.toHaveBeenCalled();
	});

	it("mounts the Send to AO dialog and displays a request from the bridge", () => {
		renderPane();
		act(() => sendRequestListener?.({ ok: false, reason: "no_issue" }));

		expect(screen.getByRole("heading", { name: "Send to AO" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Open a Multica issue, then try again.");
	});

	it("mounts the Multica status publisher", () => {
		renderPane();
		expect(screen.getByTestId("multica-status-publisher")).toBeInTheDocument();
	});
});
