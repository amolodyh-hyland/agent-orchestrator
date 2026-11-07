import { beforeEach, expect, it } from "vitest";
import { useTabSelectionStore } from "./tab-selection-store";

const store = () => useTabSelectionStore.getState();
const a = { sessionId: "a", projectId: "one" };
const b = { sessionId: "b", projectId: "two" };
beforeEach(() => store().clear());

it("toggles tabs starting with the active session, and plain selection replaces them", () => {
	store().select(b, true, a);
	expect(store().selected).toEqual([a, b]);
	store().select(b, true);
	expect(store().selected).toEqual([a]);
	store().select(a, true);
	expect(store().selected).toEqual([]);
	store().select(a, false);
	store().select(b, false);
	expect(store().selected).toEqual([b]);
	store().clear();
	expect(store().selected).toEqual([]);
});

it("distinguishes sessions with the same ID in different projects", () => {
	store().select(a, false);
	store().select({ ...a, projectId: "two" }, true);
	expect(store().selected).toHaveLength(2);
});
