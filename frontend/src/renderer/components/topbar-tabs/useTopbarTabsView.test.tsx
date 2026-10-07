import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTopbarTabsView } from "./useTopbarTabsView";

const mockState = vi.hoisted(() => ({
	workspaces: [] as Array<{ id: string; name: string; sessions: Array<{ id: string }> }>,
	tabs: {
		groups: [] as Array<{
			id: string;
			collapsed: boolean;
			head: { sessionId: string | null; mode: "persistent" | "preview"; lastActiveAt: number };
			tabs: Array<{ sessionId: string; mode: "persistent" | "preview"; lastActiveAt: number }>;
		}>,
	},
	getSession: vi.fn(),
	orgId: "org-1" as string | undefined,
	ready: true,
}));

vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Scratchpad" }) }));
vi.mock("../../hooks/useCloudCp", () => ({
	useCloudCp: () => ({
		client: { getSession: mockState.getSession },
		baseUrl: "https://cloud.example",
		ready: mockState.ready,
		userId: "user-1",
	}),
}));
vi.mock("../../hooks/useCloudOrg", () => ({
	useCloudOrg: () => ({
		org: mockState.orgId ? { id: mockState.orgId } : undefined,
		ready: mockState.ready,
		isLoading: false,
		error: undefined,
	}),
}));
vi.mock("../../hooks/useWorkspaceQuery", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../hooks/useWorkspaceQuery")>();
	return { ...actual, useWorkspaceQuery: () => ({ data: mockState.workspaces }) };
});
vi.mock("../../stores/topbar-tabs-store", () => ({
	useTopbarTabsStore: (selector: (state: { tabs: typeof mockState.tabs }) => unknown) =>
		selector({ tabs: mockState.tabs }),
}));

function makeWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: PropsWithChildren) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

describe("useTopbarTabsView", () => {
	beforeEach(() => {
		mockState.workspaces = [];
		mockState.tabs.groups = [
			{
				id: "cloud-project",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: [{ sessionId: "cloud-session", mode: "preview", lastActiveAt: 1 }],
			},
		];
		mockState.orgId = "org-1";
		mockState.ready = true;
		mockState.getSession.mockResolvedValue({
			session: {
				id: "cloud-session",
				projectId: "cloud-project",
				displayName: "Resolved Cloud Title",
				harness: "codex",
				kind: "worker",
				interfaceMode: "tui",
				status: "working",
				isTerminated: false,
				activityState: "active",
				prs: [],
				mode: "standard",
			},
		});
	});

	it("resolves opened sessions missing from the workspace list through the cloud lookup", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result, rerender } = renderHook(() => useTopbarTabsView(), { wrapper: makeWrapper(queryClient) });

		await waitFor(() => {
			expect(result.current.groups[0].tabs[0]).toMatchObject({
				label: "Resolved Cloud Title",
				session: { id: "cloud-session", title: "Resolved Cloud Title" },
			});
		});
		expect(mockState.getSession).toHaveBeenCalledWith("org-1", "cloud-session");
		const stableGroups = result.current.groups;
		mockState.workspaces = [{ id: "unrelated-project", name: "Unrelated", sessions: [{ id: "unrelated-session" }] }];
		rerender();
		expect(result.current.groups).toBe(stableGroups);
		queryClient.clear();
	});
});
