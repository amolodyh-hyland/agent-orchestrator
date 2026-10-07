import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignProjectColorSlot, projectColorCss } from "../../lib/project-colors";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useUiStore } from "../../stores/ui-store";
import { STANDALONE_WORKSPACE_ID } from "../../types/workspace";
import { useProjectColors } from "./useProjectColors";

const workspaceQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: workspaceQueryMock,
}));

const workspaces = [
	{ id: "project-a" },
	{ id: STANDALONE_WORKSPACE_ID },
	{ id: "project-b" },
] as never[];

beforeEach(() => {
	workspaceQueryMock.mockReset().mockReturnValue({ data: workspaces });
	useTopbarTabsStore.setState({ colorCoding: false, projectColors: {} });
	useUiStore.setState({ resolvedTheme: "light" });
});

describe("useProjectColors", () => {
	it("does not assign colours while colour coding is disabled", () => {
		const { result } = renderHook(() => useProjectColors());

		expect(result.current.enabled).toBe(false);
		expect(result.current.accentFor("project-a")).toBeUndefined();
		expect(workspaceQueryMock).toHaveBeenCalledWith({ subscribed: false });
		expect(useTopbarTabsStore.getState().projectColors).toEqual({});
	});

	it("assigns workspace colours in stable order and excludes the standalone group", async () => {
		useTopbarTabsStore.setState({ colorCoding: true });
		renderHook(() => useProjectColors());

		await waitFor(() => {
			expect(useTopbarTabsStore.getState().projectColors).toEqual({
				"project-a": assignProjectColorSlot("project-a", new Set()),
				"project-b": assignProjectColorSlot(
					"project-b",
					new Set([assignProjectColorSlot("project-a", new Set())]),
				),
			});
		});
		expect(workspaceQueryMock).toHaveBeenCalledWith({ subscribed: true });
	});

	it("resolves an assigned accent only while enabled and follows the theme", () => {
		useTopbarTabsStore.setState({ colorCoding: true, projectColors: { "project-a": 4 } });
		const { result } = renderHook(() => useProjectColors());

		expect(result.current.accentFor("project-a")).toBe(projectColorCss(4, "light"));
		expect(result.current.accentFor(undefined)).toBeUndefined();

		act(() => useUiStore.setState({ resolvedTheme: "dark" }));
		expect(result.current.accentFor("project-a")).toBe(projectColorCss(4, "dark"));
	});
});
