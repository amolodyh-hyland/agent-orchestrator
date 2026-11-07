import { beforeEach, expect, it } from "vitest";
import { useSplitPanesStore, SPLIT_GROUPS_STORAGE_KEY } from "../stores/split-panes-store";
import { groupContaining, layoutBoxes, leafKeys, parseStoredGroups } from "./pane-split";
import { canSplitSessionTab, selectedSessionTabsGroup, sessionTabFromKey, sessionTabKey, sessionTabPaneScope, splitSessionTabRight } from "./session-tab-panes";
const a = { sessionId: "a", projectId: "one" };
const b = { sessionId: "b", projectId: "two" };
const groups = () => useSplitPanesStore.getState().groupsBySession[sessionTabPaneScope()] ?? [];
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); useSplitPanesStore.setState({ groupsBySession: {} }); });

it("round-trips full-session leaves and rejects malformed keys", () => {
	expect(sessionTabFromKey(sessionTabKey(a))).toEqual(a);
	expect(sessionTabFromKey(sessionTabKey({ sessionId: 'id/:"' }))).toEqual({ sessionId: 'id/:"', projectId: undefined });
	for (const key of ["session", 'session-view:{', 'session-view:[1,"id"]', 'session-view:[null,""]']) expect(sessionTabFromKey(key)).toBeUndefined();
});
it("persists equal-width session leaves through the upstream store without changing auxiliary groups", () => {
	useSplitPanesStore.getState().splitBeside("session-a", "session", "shell-1", "bottom");
	const auxiliary = useSplitPanesStore.getState().groupsBySession["session-a"];
	selectedSessionTabsGroup([a, b, { sessionId: "c" }]);
	const [group] = groups();
	expect(leafKeys(group.root)).toEqual([a, b, { sessionId: "c" }].map(sessionTabKey));
	for (const box of layoutBoxes(group.root).leaves.values()) expect(box.w).toBeCloseTo(1 / 3);
	expect(useSplitPanesStore.getState().groupsBySession["session-a"]).toBe(auxiliary);
	expect(parseStoredGroups(localStorage.getItem(SPLIT_GROUPS_STORAGE_KEY))[sessionTabPaneScope()]).toEqual(groups());
	const scope = sessionTabPaneScope();
	expect(sessionTabPaneScope()).toBe(scope);
	sessionStorage.clear();
	expect(sessionTabPaneScope()).not.toBe(scope);
});
it("focuses an existing native owner, preserves its geometry, and caps new session panes at four", () => {
	splitSessionTabRight(a, a);
	expect(groups()).toEqual([]);
	splitSessionTabRight(b, a);
	const [group] = groups();
	splitSessionTabRight(a, b);
	expect(groups()[0].root).toBe(group.root);
	expect(groups()[0].focus).toBe(sessionTabKey(a));
	splitSessionTabRight({ sessionId: "c" }, a);
	splitSessionTabRight({ sessionId: "d" }, a);
	expect(canSplitSessionTab({ sessionId: "e" }, a)).toBe(false);
	splitSessionTabRight({ sessionId: "e" }, a);
	expect(leafKeys(groups()[0].root)).toHaveLength(4);
	for (const box of layoutBoxes(groups()[0].root).leaves.values()) expect(box.w).toBeCloseTo(0.25);
	expect(canSplitSessionTab(b, a)).toBe(true);
	splitSessionTabRight(b, a);
	expect(groupContaining(groups(), sessionTabKey(b))?.focus).toBe(sessionTabKey(b));
});
