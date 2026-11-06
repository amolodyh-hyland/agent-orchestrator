import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSION_PANES, readSessionPanes, SESSION_PANES_STORAGE_KEY, useSessionPanesStore } from "./session-panes-store";

const a = { sessionId: "a", projectId: "one" };
const b = { sessionId: "b", projectId: "two" };
const store = () => useSessionPanesStore.getState();

beforeEach(() => {
	sessionStorage.clear();
	useSessionPanesStore.setState({ panes: [], selected: [], focusedId: null, sizes: {} });
});

describe("session panes", () => {
	it("toggles selection starting with the active tab, and plain selection replaces it", () => {
		store().select(b, true, a);
		expect(store().selected).toEqual([a, b]);
		store().select(b, true);
		expect(store().selected).toEqual([a]);
		store().select(b, false);
		expect(store().selected).toEqual([b]);
		store().clearSelection();
		expect(store().selected).toEqual([]);
	});

	it("distinguishes the same session ID in different projects", () => {
		store().select(a, false);
		store().select({ ...a, projectId: "two" }, true);
		expect(store().selected).toHaveLength(2);
	});

	it("opens selected sessions at equal widths and persists focus and resizing per window", () => {
		store().select(a, false);
		store().viewSelected();
		expect(store().panes).toHaveLength(0);
		store().select(b, true);
		store().viewSelected();
		const [left, right] = store().panes;
		expect(store().sizes).toEqual({ [left.id]: 50, [right.id]: 50 });
		store().focus(right.id);
		store().resize({ [left.id]: 40, [right.id]: 60 });
		expect(readSessionPanes()).toEqual({ panes: store().panes, focusedId: right.id, sizes: { [left.id]: 40, [right.id]: 60 } });
	});

	it("inserts to the right of the focused pane, supports duplicate views, and caps at four", () => {
		store().openRight(a);
		const [left, right] = store().panes;
		expect(left.sessionId).toBe(right.sessionId);
		expect(left.id).not.toBe(right.id);
		store().focus(left.id);
		store().openRight(b);
		expect(store().panes.map((pane) => pane.sessionId)).toEqual(["a", "b", "a"]);
		store().openRight(b);
		store().openRight(a);
		expect(store().panes).toHaveLength(MAX_SESSION_PANES);
	});

	it("closes panes without closing sessions and retains a valid focus down to one", () => {
		store().openRight(b, a);
		const [left, right] = store().panes;
		store().close(right.id);
		expect(store().panes).toEqual([left]);
		expect(store().focusedId).toBe(left.id);
		expect(store().sizes).toEqual({ [left.id]: 100 });
		store().close(left.id);
		expect(store().panes).toEqual([]);
		expect(store().focusedId).toBeNull();
	});

	it("routes a tab into the focused pane or focuses an existing pane", () => {
		store().openRight(b, a);
		const [left, right] = store().panes;
		store().followRoute(a);
		expect(store().focusedId).toBe(left.id);
		store().followRoute({ sessionId: "c" });
		expect(store().panes).toEqual([{ id: left.id, sessionId: "c", projectId: undefined }, right]);
	});

	it("ignores corrupt persisted layouts and invalid resize values", () => {
		sessionStorage.setItem(SESSION_PANES_STORAGE_KEY, "{");
		expect(readSessionPanes().panes).toEqual([]);
		store().openRight(a);
		const sizes = store().sizes;
		store().resize({});
		expect(store().sizes).toBe(sizes);
		const panes = store().panes;
		sessionStorage.setItem(SESSION_PANES_STORAGE_KEY, JSON.stringify({ panes: [panes[0], panes[0]] }));
		expect(readSessionPanes().panes).toEqual([]);
	});
});
