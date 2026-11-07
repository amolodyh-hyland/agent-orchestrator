import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useContext, useEffect, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionTabsView } from "./SessionTabsView";
import { registerPaneCloseGuard, SessionPaneContext } from "./session-pane-context";
import { useSplitPanesStore, SPLIT_GROUPS_STORAGE_KEY } from "../stores/split-panes-store";
import { useUiStore } from "../stores/ui-store";
import { selectedSessionTabsGroup, sessionTabKey, sessionTabPaneScope } from "../lib/session-tab-panes";
import type { SessionTabSelection } from "../stores/tab-selection-store";
import { useSessionShortcut, runAppShortcut } from "../hooks/useAppShortcut";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), shortcuts: { a: vi.fn(), b: vi.fn() }, mounts: { a: 0, b: 0 } }));
vi.mock("@tanstack/react-router", async (load) => ({ ...await load<typeof import("@tanstack/react-router")>(), useNavigate: () => mocks.navigate }));
const a = { sessionId: "a", projectId: "one" };
const b = { sessionId: "b", projectId: "two" };
function View({ sessionId }: SessionTabSelection) {
	const pane = useContext(SessionPaneContext);
	useEffect(() => { mocks.mounts[sessionId as "a" | "b"] += 1; }, []);
	useSessionShortcut("copy-session-path", mocks.shortcuts[sessionId as "a" | "b"]);
	return <><input aria-label={`Draft ${sessionId}`} defaultValue="" /><button role="tab">Select {sessionId}</button><output>{pane?.autoFocus ? `activate-${sessionId}` : `passive-${sessionId}`}</output></>;
}
function Harness() {
	const [current, setCurrent] = useState(a);
	mocks.navigate.mockImplementation(async (target: { params: SessionTabSelection }) => setCurrent(target.params as typeof a));
	return <SessionTabsView {...current} View={View} />;
}
beforeEach(() => {
	localStorage.clear(); sessionStorage.clear();
	useSplitPanesStore.setState({ groupsBySession: {} });
	useUiStore.setState({ developerMode: true, splitPanes: true });
	mocks.mounts.a = mocks.mounts.b = 0;
	mocks.shortcuts.a.mockClear(); mocks.shortcuts.b.mockClear(); mocks.navigate.mockReset();
});
it("retains self-contained views while grouping, focusing, resizing and closing to one", async () => {
	render(<Harness />);
	fireEvent.change(screen.getByLabelText("Draft a"), { target: { value: "keep me" } });
	act(() => selectedSessionTabsGroup([a, b]));
	expect(mocks.mounts.a).toBe(1);
	const second = screen.getByLabelText("Draft b");
	act(() => second.focus());
	expect(second).toHaveFocus();
	expect(second.closest("[data-session-pane]")).toHaveAttribute("data-focused", "true");
	expect(screen.getByText("passive-b")).toBeInTheDocument();
	act(() => runAppShortcut({ id: "copy-session-path" }));
	expect(mocks.shortcuts.b).toHaveBeenCalledOnce(); expect(mocks.shortcuts.a).not.toHaveBeenCalled();
	const divider = screen.getByRole("separator");
	fireEvent.keyDown(divider, { key: "ArrowLeft" });
	expect(divider).toHaveAttribute("aria-valuenow", "45");
	expect(JSON.parse(localStorage.getItem(SPLIT_GROUPS_STORAGE_KEY)!)[sessionTabPaneScope()][0].root.ratio).toBe(0.45);
	fireEvent.click(screen.getByRole("button", { name: "Close b" }));
	await waitFor(() => expect(screen.queryByTestId("session-panes")).not.toBeInTheDocument());
	expect(screen.getByLabelText("Draft a")).toHaveValue("keep me");
	expect(mocks.mounts.a).toBe(1);
});
it("preserves draft owners and the upstream layout when removal is cancelled", async () => {
	selectedSessionTabsGroup([a, b]); render(<Harness />);
	const guard = vi.fn(async () => false);
	const dispose = registerPaneCloseGuard(sessionTabKey(b), guard);
	const original = useSplitPanesStore.getState().groupsBySession;
	fireEvent.change(screen.getByLabelText("Draft b"), { target: { value: "unsafe text" } });
	fireEvent.click(screen.getByRole("button", { name: "Close b" }));
	await waitFor(() => expect(guard).toHaveBeenCalledOnce());
	expect(useSplitPanesStore.getState().groupsBySession).toBe(original);
	expect(screen.getByLabelText("Draft b")).toHaveValue("unsafe text"); dispose();
});
it("modifier selection in an unfocused leaf does not activate that session", () => {
	selectedSessionTabsGroup([a, b]); render(<Harness />); mocks.navigate.mockClear();
	fireEvent.pointerDown(screen.getByRole("tab", { name: "Select b" }), { metaKey: true, ctrlKey: true });
	expect(mocks.navigate).not.toHaveBeenCalled();
	expect(screen.getByLabelText("Draft a").closest("[data-session-pane]")).toHaveAttribute("data-focused", "true");
});
it("keeps hidden session drafts mounted while the upstream preview is disabled", () => {
	selectedSessionTabsGroup([a, b]); render(<Harness />);
	fireEvent.change(screen.getByLabelText("Draft b"), { target: { value: "keep hidden draft" } });
	act(() => useUiStore.setState({ splitPanes: false }));
	expect(screen.getByLabelText("Draft b")).not.toBeVisible();
	act(() => useUiStore.setState({ splitPanes: true }));
	expect(screen.getByLabelText("Draft b")).toBeVisible();
	expect(screen.getByLabelText("Draft b")).toHaveValue("keep hidden draft"); expect(mocks.mounts.b).toBe(1);
});
