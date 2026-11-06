import { beforeEach, expect, it, vi } from "vitest";
import { confirmPaneRemoval, registerPaneCloseGuard, sessionPaneStaysMounted } from "./session-pane-context";
import { useSessionPanesStore } from "../stores/session-panes-store";

beforeEach(() => useSessionPanesStore.setState({ panes: [], sizes: {}, focusedId: null, selected: [] }));

it("keeps draft owners mounted while focusing another visible pane", () => {
	useSessionPanesStore.getState().openRight({ sessionId: "b", projectId: "p" }, { sessionId: "a", projectId: "p" });
	const [left, right] = useSessionPanesStore.getState().panes;
	expect(sessionPaneStaysMounted(left.id, "/projects/p/sessions/b")).toBe(true);
	expect(sessionPaneStaysMounted(right.id, "/projects/p/sessions/a")).toBe(true);
	expect(sessionPaneStaysMounted(left.id, "/projects/p/sessions/c")).toBe(true);
	expect(sessionPaneStaysMounted(right.id, "/projects/p/sessions/c")).toBe(false);
	expect(sessionPaneStaysMounted(right.id, "/projects/p")).toBe(false);
});

it("checks pane draft guards and honors cancellation before removing views", async () => {
	const first = vi.fn().mockResolvedValue(false);
	const second = vi.fn().mockResolvedValue(true);
	const removeFirst = registerPaneCloseGuard("first", first);
	const removeSecond = registerPaneCloseGuard("second", second);
	expect(await confirmPaneRemoval(["first", "second"])).toBe(false);
	expect(second).not.toHaveBeenCalled();
	first.mockResolvedValue(true);
	expect(await confirmPaneRemoval(["first", "second"])).toBe(true);
	expect(second).toHaveBeenCalledTimes(1);
	removeFirst();
	removeSecond();
	expect(await confirmPaneRemoval(["first", "second"])).toBe(true);
	expect(first).toHaveBeenCalledTimes(2);
});
