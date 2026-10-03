import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaViewState } from "../../shared/multica";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";
import { MulticaPane } from "./MulticaPane";

const router = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
			select({ location: { pathname: router.pathname } }),
	};
});

const URL = "http://localhost:3000/";
type Bridge = NonNullable<typeof window.ao>;

describe("MulticaPane", () => {
	let originalMultica: Bridge["multica"];
	let toggleListener: (() => void) | undefined;
	let removeToggleListener: ReturnType<typeof vi.fn>;
	let current: MulticaViewState;

	function showView(view: MulticaViewState) {
		current = view;
		useMulticaStore.setState({ view });
	}

	beforeEach(() => {
		router.pathname = "/";
		originalMultica = { ...window.ao!.multica };
		removeToggleListener = vi.fn();
		toggleListener = undefined;
		current = { active: false, status: "unconfigured", url: "" };
		window.ao!.multica.getState = vi.fn(async () => current);
		window.ao!.multica.setActive = vi.fn(async (active: boolean): Promise<MulticaViewState> => ({ ...current, active }));
		window.ao!.multica.reload = vi.fn(async () => current);
		window.ao!.multica.onToggleShortcut = vi.fn((listener: () => void) => {
			toggleListener = listener;
			return removeToggleListener as unknown as () => void;
		});
		showView(current);
	});

	afterEach(() => {
		Object.assign(window.ao!.multica, originalMultica);
		useUiStore.getState().closeSettings();
	});

	it("renders nothing while AO is the active view", () => {
		showView({ active: false, status: "ready", url: URL });
		render(<MulticaPane />);
		expect(screen.queryByTestId("multica-pane")).not.toBeInTheDocument();
	});

	it("shows a clear empty state with a way to settings when no URL is set", async () => {
		showView({ active: true, status: "unconfigured", url: "" });
		render(<MulticaPane />);

		expect(screen.getByText("Multica URL is not set")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open settings" }));

		expect(useUiStore.getState().settingsModal).toMatchObject({ scope: "global", section: "general" });
	});

	it("shows a loading state while the page loads", () => {
		showView({ active: true, status: "loading", url: URL });
		render(<MulticaPane />);
		expect(screen.getByText("Loading Multica…")).toBeInTheDocument();
	});

	it("shows the unreachable server and lets the user retry", async () => {
		showView({ active: true, status: "error", url: URL, error: "ERR_CONNECTION_REFUSED" });
		render(<MulticaPane />);

		expect(screen.getByText("Can't reach Multica")).toBeInTheDocument();
		expect(screen.getByText(`Check that the Multica server is running at ${URL}, then try again.`)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(window.ao!.multica.reload).toHaveBeenCalledOnce();
	});

	it("renders no status message while the page is live, since the view covers the window", () => {
		showView({ active: true, status: "ready", url: URL });
		render(<MulticaPane />);

		expect(screen.queryByText("Can't reach Multica")).not.toBeInTheDocument();
		expect(screen.queryByText("Loading Multica…")).not.toBeInTheDocument();
	});

	it("shows why the page could not be loaded", () => {
		showView({ active: true, status: "error", url: URL, error: "Multica desktop bundle not found." });
		render(<MulticaPane />);
		expect(screen.getByText("Multica desktop bundle not found.")).toBeInTheDocument();
	});

	it("switches with the keyboard shortcut, in both directions", () => {
		render(<MulticaPane />);
		expect(toggleListener).toBeDefined();

		act(() => toggleListener?.());
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(true);

		act(() => showView({ active: true, status: "ready", url: URL }));
		act(() => toggleListener?.());
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(false);
	});

	it("stops listening for the shortcut when unmounted", () => {
		const { unmount } = render(<MulticaPane />);
		unmount();
		expect(removeToggleListener).toHaveBeenCalledOnce();
	});

	it("returns to AO when the user navigates inside AO", () => {
		showView({ active: true, status: "ready", url: URL });
		const { rerender } = render(<MulticaPane />);
		expect(window.ao!.multica.setActive).not.toHaveBeenCalled();

		router.pathname = "/sessions/abc";
		rerender(<MulticaPane />);

		expect(window.ao!.multica.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("does not message the main process on navigation while AO is showing", () => {
		const { rerender } = render(<MulticaPane />);

		router.pathname = "/sessions/abc";
		rerender(<MulticaPane />);

		expect(window.ao!.multica.setActive).not.toHaveBeenCalled();
	});
});
