import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";
import {
	isTopbarSessionClosed,
	markTopbarSessionClosed,
	resetNavigationHistoryForTests,
} from "../lib/navigation-history";

const bridgeSetActive = vi.hoisted(() => vi.fn((_active: boolean) => Promise.resolve()));

const { history, navigate, setActive } = vi.hoisted(() => {
	type Location = { href: string; state: Record<string, unknown> };
	type Event = { location: Location; action: { type: string } };
	const listeners = new Set<(event: Event) => void>();
	const history = {
		location: { href: "#/sessions", state: { __TSR_index: 0 } } as Location,
		listeners,
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(href: string, state: Record<string, unknown>, type: string) {
			this.location = { href, state };
			for (const listener of [...listeners]) listener({ location: this.location, action: { type } });
		},
		push(href: string, state?: Record<string, unknown>) {
			this.emit(href, state ?? {}, "PUSH");
		},
		replace(href: string, state?: Record<string, unknown>) {
			this.emit(href, state ?? {}, "REPLACE");
		},
		back: vi.fn(),
		forward: vi.fn(),
		canGoBack: () => true,
	};
	return { history, navigate: vi.fn(), setActive: vi.fn() };
});

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useRouter: () => ({ history }),
	useRouterState: () => ({ location: { href: history.location.href } }),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: { multica: { setActive: bridgeSetActive, getState: vi.fn(), onState: vi.fn(), reload: vi.fn() } },
}));

import { NavigationHistorySync } from "./NavigationHistorySync";

const originalSetActive = useMulticaStore.getState().setActive;

describe("NavigationHistorySync", () => {
	beforeEach(() => {
		history.listeners.clear();
		history.location = { href: "#/sessions", state: { __TSR_index: 0 } };
		navigate.mockClear();
		history.back.mockClear();
		history.forward.mockClear();
		setActive.mockClear();
		useUiStore.setState({ settingsModal: null });
		useMulticaStore.setState({
			view: { active: false, status: "ready", url: "https://multica.test" },
			isLoaded: true,
			setActive,
		});
	});

	it("records an AO route change as visible AO after leaving Multica", () => {
		useMulticaStore.setState({ view: { active: true, status: "ready", url: "https://multica.test" } });
		render(<NavigationHistorySync />);

		act(() => history.emit("#/projects/project-2/sessions/worker-2", { __TSR_index: 1 }, "PUSH"));

		expect(setActive).toHaveBeenCalledWith(false, { recordHistory: false });
		expect(history.location.state).toMatchObject({
			__aoNavigation: {
				multicaActive: false,
				href: "#/projects/project-2/sessions/worker-2",
			},
		});
	});

	it("does not message Multica when AO is already active", () => {
		render(<NavigationHistorySync />);

		act(() => history.emit("#/projects/project-2/sessions/worker-2", { __TSR_index: 1 }, "PUSH"));

		expect(setActive).not.toHaveBeenCalled();
	});

	it("restores the Multica shell state when traversing to a recorded entry", () => {
		render(<NavigationHistorySync />);
		const href = "#/sessions/worker-2";

		act(() => history.emit(href, {
			__TSR_index: 1,
			__aoNavigation: {
				version: 1,
				href,
				settingsModal: null,
				multicaActive: true,
			},
		}, "POP"));

		expect(setActive).toHaveBeenCalledWith(true, { recordHistory: false });
		expect(history.location.state.__aoNavigation).toMatchObject({ multicaActive: true });
	});

	it("records and restores Settings modal history", () => {
		render(<NavigationHistorySync />);
		const settingsModal = { scope: "global" as const, section: "general" as const };

		act(() => useUiStore.setState({ settingsModal }));
		const settingsState = history.location.state;
		expect(settingsState.__aoNavigation).toMatchObject({ settingsModal });
		act(() => useUiStore.setState({ settingsModal: null }));
		act(() => history.emit(history.location.href, settingsState, "POP"));

		expect(useUiStore.getState().settingsModal).toEqual(settingsModal);
	});

	it("skips a closed local session when traversing backward", () => {
		history.location = { href: "#/sessions/worker-2", state: { __TSR_index: 2 } };
		markTopbarSessionClosed("worker-1");
		render(<NavigationHistorySync />);

		act(() => history.emit("#/sessions/worker-1", { __TSR_index: 1 }, "POP"));

		expect(history.back).toHaveBeenCalledTimes(1);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("skips a closed local session when traversing forward", () => {
		history.location = { href: "#/sessions/worker-1", state: { __TSR_index: 1 } };
		render(<NavigationHistorySync />);
		act(() => history.emit("#/sessions/worker-3", { __TSR_index: 3 }, "PUSH"));
		act(() => history.emit("#/sessions/worker-1", { __TSR_index: 1 }, "POP"));
		markTopbarSessionClosed("worker-2");

		act(() => history.emit("#/sessions/worker-2", { __TSR_index: 2 }, "POP"));

		expect(history.forward).toHaveBeenCalledTimes(1);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("restores Multica on Back while the hide request from leaving it is still pending", () => {
		bridgeSetActive.mockClear();
		useMulticaStore.setState({
			view: { active: true, status: "ready", url: "https://multica.test" },
			setActive: originalSetActive,
		});
		const multicaState = { __aoNavigation: { version: 1, href: "#/sessions", settingsModal: null, multicaActive: true } };
		history.location = { href: "#/sessions", state: { __TSR_index: 0, ...multicaState } };
		render(<NavigationHistorySync />);

		// Leave Multica for an AO route; the main process has not acknowledged the hide yet.
		act(() => history.emit("#/sessions/worker-2", { __TSR_index: 1 }, "PUSH"));
		expect(useMulticaStore.getState().view.active).toBe(true);
		act(() => history.emit("#/sessions", { __TSR_index: 0, ...multicaState }, "POP"));

		expect(bridgeSetActive.mock.calls.map(([active]) => active)).toEqual([false, true]);
	});

	it("reopens a closed local session after a direct route visit", () => {
		markTopbarSessionClosed("worker-1");
		render(<NavigationHistorySync />);

		act(() => history.emit("#/sessions/worker-1", { __TSR_index: 1 }, "PUSH"));

		expect(isTopbarSessionClosed("worker-1")).toBe(false);
	});
});

afterEach(() => {
	useMulticaStore.setState({ setActive: originalSetActive });
	resetNavigationHistoryForTests();
});
