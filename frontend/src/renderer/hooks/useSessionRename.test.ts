import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TOPBAR_TABS, findSession } from "../lib/topbar-tabs";

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock("../lib/rename-session", () => ({ renameSession: renameMock }));

import { useTopbarTabsStore } from "../stores/topbar-tabs-store";
import { useSessionRename } from "./useSessionRename";

function resetTopbarTabsStore(): void {
	useTopbarTabsStore.setState({
		tabs: EMPTY_TOPBAR_TABS,
		overflow: "scroll",
		density: "comfortable",
		colorCoding: false,
		projectColors: {},
		lastEviction: null,
	});
}

beforeEach(() => {
	localStorage.clear();
	resetTopbarTabsStore();
	renameMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("useSessionRename", () => {
	it("persists the session tab only after a successful rename", async () => {
		const session = { id: "sess-rename", title: "Before" };
		useTopbarTabsStore.getState().activateSession({ sessionId: session.id, groupId: "p", kind: "task" });
		const logError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { result } = renderHook(() => useSessionRename(session));

		expect(findSession(useTopbarTabsStore.getState().tabs, session.id)?.mode).toBe("preview");
		renameMock.mockRejectedValueOnce(new Error("rename failed"));
		act(() => {
			result.current.begin();
			result.current.setDraft("Failed title");
		});
		await act(async () => result.current.commit());
		expect(findSession(useTopbarTabsStore.getState().tabs, session.id)?.mode).toBe("preview");

		renameMock.mockResolvedValueOnce(undefined);
		act(() => {
			result.current.begin();
			result.current.setDraft("Renamed");
		});
		await act(async () => result.current.commit());
		expect(renameMock).toHaveBeenLastCalledWith(session.id, "Renamed");
		expect(findSession(useTopbarTabsStore.getState().tabs, session.id)?.mode).toBe("persistent");
		logError.mockRestore();
	});
});
