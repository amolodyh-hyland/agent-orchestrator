import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { EMPTY_TOPBAR_TABS, findSession } from "../lib/topbar-tabs";
import { useTopbarTabsStore } from "../stores/topbar-tabs-store";
import { settingsQueryKey, type Settings } from "./useSettings";
import { cloudSessionsQueryKey } from "./useWorkspaceQuery";

const restoreMocks = vi.hoisted(() => ({
	post: vi.fn(),
	cloudRestore: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: restoreMocks.post },
	apiErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock("./useCloudCp", () => ({
	createRendererCloudCpClient: vi.fn(() => ({ restoreSession: restoreMocks.cloudRestore })),
}));

import { useRestoreSession } from "./useRestoreSession";

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

function restoreTestWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

beforeEach(() => {
	resetTopbarTabsStore();
	restoreMocks.post.mockReset();
	restoreMocks.cloudRestore.mockReset();
});

describe("useRestoreSession", () => {
	it("promotes a successfully restored local session", async () => {
		const sessionId = "restore-local";
		restoreMocks.post.mockResolvedValue({ data: { restoreMode: "resumed" }, error: undefined });
		useTopbarTabsStore.getState().activateSession({ sessionId, groupId: "project-1", kind: "task" });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result } = renderHook(() => useRestoreSession(), {
			wrapper: restoreTestWrapper(queryClient),
		});

		let outcome!: Awaited<ReturnType<typeof result.current>>;
		await act(async () => {
			outcome = await result.current(sessionId);
		});

		expect(outcome).toEqual({ status: "success" });
		expect(findSession(useTopbarTabsStore.getState().tabs, sessionId)?.mode).toBe("persistent");
	});

	it("promotes a successfully restored Cloud session", async () => {
		const sessionId = "restore-cloud";
		const baseUrl = "https://cloud.example.test";
		const orgId = "org-1";
		restoreMocks.cloudRestore.mockResolvedValue(undefined);
		useTopbarTabsStore.getState().activateSession({ sessionId, groupId: "project-1", kind: "task" });
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(settingsQueryKey, { cloudControlPlaneUrl: baseUrl } as Settings);
		queryClient.setQueryData([...cloudSessionsQueryKey, baseUrl, orgId], [{ id: sessionId, workerEpoch: 4 }]);
		const { result } = renderHook(() => useRestoreSession(), {
			wrapper: restoreTestWrapper(queryClient),
		});

		let outcome!: Awaited<ReturnType<typeof result.current>>;
		await act(async () => {
			outcome = await result.current(sessionId);
		});

		expect(outcome).toEqual({ status: "success" });
		expect(restoreMocks.cloudRestore).toHaveBeenCalledWith(orgId, sessionId);
		expect(findSession(useTopbarTabsStore.getState().tabs, sessionId)?.mode).toBe("persistent");
	});
});
