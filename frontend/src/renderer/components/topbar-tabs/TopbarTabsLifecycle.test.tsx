import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TOPBAR_TABS, type TopbarGroup } from "../../lib/topbar-tabs";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useUiStore } from "../../stores/ui-store";
import {
	CLOUD_PROJECT_KIND,
	STANDALONE_WORKSPACE_ID,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../../types/workspace";
import { TopbarTabsLifecycle } from "./TopbarTabsLifecycle";

const lifecycleMocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	params: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	workspaces: [] as WorkspaceSummary[],
	localWorkspaces: undefined as WorkspaceSummary[] | undefined,
	routedSession: undefined as WorkspaceSession | undefined,
	directLookupLoading: false,
	directLookupNotFound: false,
	localSuccess: true,
	cloudProjectsSuccess: true,
	cloudProjectsError: false,
	cloudProjectsFetchStatus: "idle" as "idle" | "fetching",
	cloudSessionsSuccess: true,
	cloudSessionsError: false,
	cloudSessionsFetchStatus: "idle" as "idle" | "fetching",
	cloudProjects: [] as Array<{ id: string }>,
	ready: false,
	orgLoading: false,
	orgError: undefined as unknown,
	org: undefined as { id: string } | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => lifecycleMocks.navigate,
	useParams: () => lifecycleMocks.params,
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		isSuccess: lifecycleMocks.localSuccess,
		fetchStatus: lifecycleMocks.localSuccess ? "idle" : "fetching",
		data: lifecycleMocks.localWorkspaces,
	}),
	useQueryClient: () => ({
		getQueryState: (queryKey: unknown[]) => queryKey[0] === "session"
			? {
					status: lifecycleMocks.directLookupNotFound ? "error" : lifecycleMocks.directLookupLoading ? "pending" : "success",
					fetchStatus: lifecycleMocks.directLookupLoading ? "fetching" : "idle",
					error: lifecycleMocks.directLookupNotFound ? { code: "SESSION_NOT_FOUND" } : undefined,
				}
			: undefined,
	}),
}));

vi.mock("../../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: lifecycleMocks.workspaces }),
	useWorkspaceSession: () => ({ data: lifecycleMocks.routedSession, isLoading: lifecycleMocks.directLookupLoading }),
	workspaceQueryOptions: { queryKey: ["lifecycle-workspaces"] },
	useCloudProjectsQuery: () => ({
		isSuccess: lifecycleMocks.cloudProjectsSuccess,
		isError: lifecycleMocks.cloudProjectsError,
		fetchStatus: lifecycleMocks.cloudProjectsFetchStatus,
		data: lifecycleMocks.cloudProjects,
	}),
	useCloudSessionsQuery: () => ({
		isSuccess: lifecycleMocks.cloudSessionsSuccess,
		isError: lifecycleMocks.cloudSessionsError,
		fetchStatus: lifecycleMocks.cloudSessionsFetchStatus,
	}),
}));

vi.mock("../../hooks/useCloudOrg", () => ({
	useCloudOrg: () => ({
		org: lifecycleMocks.org,
		ready: lifecycleMocks.ready,
		isLoading: lifecycleMocks.orgLoading,
		error: lifecycleMocks.orgError,
	}),
}));

function makeSession(
	id: string,
	workspaceId: string,
	options: Partial<WorkspaceSession> = {},
): WorkspaceSession {
	return {
		id,
		workspaceId,
		workspaceName: workspaceId,
		title: id,
		provider: "claude-code",
		status: "working",
		updatedAt: "2026-10-01T00:00:00Z",
		prs: [],
		...options,
	};
}

function makeWorkspace(
	id: string,
	sessions: WorkspaceSession[] = [],
	kind: WorkspaceSummary["kind"] = "single_repo",
): WorkspaceSummary {
	return { id, name: id, kind, path: `/repos/${id}`, sessions };
}

function makeGroup(id: string, tabs: string[], headSessionId: string | null = null): TopbarGroup {
	return {
		id,
		collapsed: false,
		head: { sessionId: headSessionId, mode: "persistent", lastActiveAt: 0 },
		tabs: tabs.map((sessionId, index) => ({ sessionId, mode: "persistent", lastActiveAt: index + 1 })),
	};
}

function setGroups(groups: TopbarGroup[]): void {
	useTopbarTabsStore.setState({ tabs: { version: 1, groups } });
}

beforeEach(() => {
	localStorage.clear();
	lifecycleMocks.navigate.mockReset();
	lifecycleMocks.params.projectId = undefined;
	lifecycleMocks.params.sessionId = undefined;
	lifecycleMocks.workspaces = [makeWorkspace("local-project")];
	lifecycleMocks.localWorkspaces = [makeWorkspace("local-project")];
	lifecycleMocks.routedSession = undefined;
	lifecycleMocks.directLookupLoading = false;
	lifecycleMocks.directLookupNotFound = false;
	lifecycleMocks.localSuccess = true;
	lifecycleMocks.cloudProjectsSuccess = true;
	lifecycleMocks.cloudProjectsError = false;
	lifecycleMocks.cloudProjectsFetchStatus = "idle";
	lifecycleMocks.cloudSessionsSuccess = true;
	lifecycleMocks.cloudSessionsError = false;
	lifecycleMocks.cloudSessionsFetchStatus = "idle";
	lifecycleMocks.cloudProjects = [];
	lifecycleMocks.ready = false;
	lifecycleMocks.orgLoading = false;
	lifecycleMocks.orgError = undefined;
	lifecycleMocks.org = undefined;
	useTopbarTabsStore.setState({ tabs: EMPTY_TOPBAR_TABS, lastEviction: null });
	useUiStore.setState({ globalToasts: [], globalToast: null, globalToastSequence: 0 });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("TopbarTabsLifecycle", () => {
	it("removes terminated session tabs", () => {
		const terminated = makeSession("terminated", "local-project", { status: "terminated", isTerminated: true });
		const liveHead = makeSession("live-head", "local-project");
		const liveTab = makeSession("live-tab", "local-project");
		lifecycleMocks.workspaces = [makeWorkspace("local-project", [terminated, liveHead, liveTab])];
		setGroups([makeGroup("local-project", [terminated.id, liveTab.id], liveHead.id)]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual([liveTab.id]);
	});

	it("removes a vanished session from a known local workspace", () => {
		setGroups([makeGroup("local-project", ["vanished-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("keeps a missing session tab in a cloud workspace", () => {
		lifecycleMocks.workspaces = [makeWorkspace("cloud-project", [], CLOUD_PROJECT_KIND)];
		setGroups([makeGroup("cloud-project", ["cloud-session-not-in-list"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual([
			"cloud-session-not-in-list",
		]);
	});

	it("keeps a routed terminated session until navigating away", () => {
		const terminated = makeSession("terminated-route", "local-project", { status: "terminated", isTerminated: true });
		lifecycleMocks.workspaces = [makeWorkspace("local-project", [terminated])];
		lifecycleMocks.params.sessionId = terminated.id;
		setGroups([makeGroup("local-project", [terminated.id])]);
		const view = render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe(terminated.id);
		expect(lifecycleMocks.navigate).not.toHaveBeenCalled();

		lifecycleMocks.params.sessionId = undefined;
		view.rerender(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("removes a settled missing active session and routes to its nearest surviving tab", () => {
		const head = makeSession("project-head", "local-project");
		const left = makeSession("left-session", "local-project");
		const right = makeSession("right-session", "local-project");
		lifecycleMocks.params.projectId = "local-project";
		lifecycleMocks.params.sessionId = "removed-session";
		lifecycleMocks.workspaces = [makeWorkspace("local-project", [head, left, right])];
		lifecycleMocks.localWorkspaces = lifecycleMocks.workspaces;
		lifecycleMocks.directLookupNotFound = true;
		setGroups([makeGroup("local-project", [left.id, "removed-session", right.id], head.id)]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual([
			left.id,
			right.id,
		]);
		expect(lifecycleMocks.navigate).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "local-project", sessionId: left.id },
		});
	});

	it("keeps a routed cloud session when the local lookup reports it missing", () => {
		const cloudProjectId = "cloud-project-uuid";
		const cloudSessionId = "cloud-session-outside-first-page";
		lifecycleMocks.params.projectId = cloudProjectId;
		lifecycleMocks.params.sessionId = cloudSessionId;
		lifecycleMocks.workspaces = [];
		lifecycleMocks.localWorkspaces = [];
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjects = [{ id: cloudProjectId }];
		lifecycleMocks.directLookupNotFound = true;
		setGroups([makeGroup(cloudProjectId, [cloudSessionId])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs.map((tab) => tab.sessionId)).toEqual([
			cloudSessionId,
		]);
		expect(lifecycleMocks.navigate).not.toHaveBeenCalled();
	});

	it("removes the active group and leaves the app when its project is authoritatively gone", () => {
		lifecycleMocks.params.projectId = "removed-project";
		lifecycleMocks.params.sessionId = "removed-project-session";
		lifecycleMocks.workspaces = [];
		lifecycleMocks.localWorkspaces = [];
		lifecycleMocks.ready = true;
		lifecycleMocks.directLookupNotFound = true;
		setGroups([makeGroup("removed-project", ["removed-project-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
		expect(lifecycleMocks.navigate).toHaveBeenCalledWith({ to: "/" });
	});

	it("keeps an active missing session while its direct lookup is loading", () => {
		lifecycleMocks.params.projectId = "local-project";
		lifecycleMocks.params.sessionId = "loading-session";
		lifecycleMocks.directLookupLoading = true;
		setGroups([makeGroup("local-project", ["loading-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("loading-session");
		expect(lifecycleMocks.navigate).not.toHaveBeenCalled();
	});

	it("does not prune before the local workspace query settles", () => {
		lifecycleMocks.localSuccess = false;
		lifecycleMocks.localWorkspaces = undefined;
		lifecycleMocks.workspaces = [];
		setGroups([makeGroup("local-project", ["unresolved-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("unresolved-session");
	});

	it("closes a removed cloud project group once cloud lists settle", () => {
		lifecycleMocks.workspaces = [];
		lifecycleMocks.localWorkspaces = [];
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjectsSuccess = true;
		lifecycleMocks.cloudProjectsFetchStatus = "idle";
		lifecycleMocks.cloudSessionsSuccess = true;
		lifecycleMocks.cloudSessionsFetchStatus = "idle";
		setGroups([makeGroup("cp-removed-project", ["cloud-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("keeps a UUID-shaped unknown group while the organization lookup is loading", () => {
		const unknownProjectId = "7c2a1f2d-4f42-4e5b-92d4-a67e8b9c0d1e";
		lifecycleMocks.ready = true;
		lifecycleMocks.orgLoading = true;
		lifecycleMocks.org = undefined;
		setGroups([makeGroup(unknownProjectId, ["unknown-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].id).toBe(unknownProjectId);
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("unknown-session");
	});

	it("keeps an unknown group while cloud projects are loading", () => {
		const unknownProjectId = "7c2a1f2d-4f42-4e5b-92d4-a67e8b9c0d1e";
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjectsSuccess = false;
		lifecycleMocks.cloudProjectsFetchStatus = "fetching";
		setGroups([makeGroup(unknownProjectId, ["unknown-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("unknown-session");
	});

	it("keeps all tabs when the cloud pipeline has an error", () => {
		const unknownProjectId = "7c2a1f2d-4f42-4e5b-92d4-a67e8b9c0d1e";
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjectsSuccess = false;
		lifecycleMocks.cloudProjectsError = true;
		setGroups([makeGroup(unknownProjectId, ["unknown-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("unknown-session");
	});

	it("drops an unknown group only after local and cloud queries settle successfully", () => {
		const unknownProjectId = "7c2a1f2d-4f42-4e5b-92d4-a67e8b9c0d1e";
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjectsSuccess = false;
		lifecycleMocks.cloudProjectsFetchStatus = "fetching";
		setGroups([makeGroup(unknownProjectId, ["unknown-session"])]);
		const view = render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].id).toBe(unknownProjectId);

		lifecycleMocks.cloudProjectsSuccess = true;
		lifecycleMocks.cloudProjectsFetchStatus = "idle";
		view.rerender(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("keeps a known cloud project group when its session is missing", () => {
		const cloudProjectId = "cloud-project-uuid";
		lifecycleMocks.workspaces = [];
		lifecycleMocks.localWorkspaces = [];
		lifecycleMocks.ready = true;
		lifecycleMocks.org = { id: "org-1" };
		lifecycleMocks.cloudProjects = [{ id: cloudProjectId }];
		setGroups([makeGroup(cloudProjectId, ["missing-cloud-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].sessionId).toBe("missing-cloud-session");
	});

	it("removes an anchor-head group with no tabs", () => {
		setGroups([makeGroup("local-project", [])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("removes a missing standalone session tab", () => {
		const standaloneWorkspace = makeWorkspace(
			STANDALONE_WORKSPACE_ID,
			[makeSession("other-scratch-session", STANDALONE_WORKSPACE_ID)],
		);
		lifecycleMocks.workspaces = [standaloneWorkspace];
		lifecycleMocks.localWorkspaces = [standaloneWorkspace];
		setGroups([makeGroup(STANDALONE_WORKSPACE_ID, ["missing-scratchpad-session"])]);

		render(<TopbarTabsLifecycle />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("shows and clears one eviction toast for an eviction nonce", () => {
		useTopbarTabsStore.setState({ lastEviction: { count: 2, nonce: 7 } });
		const view = render(<TopbarTabsLifecycle />);

		expect(useUiStore.getState().globalToast?.title).toBe(
			"Closed 2 tabs to stay within the 100-tab limit",
		);
		expect(useTopbarTabsStore.getState().lastEviction).toBeNull();

		view.rerender(<TopbarTabsLifecycle />);

		expect(useUiStore.getState().globalToasts).toHaveLength(1);
	});

	it("does not write tabs to storage when nothing changes", () => {
		const session = makeSession("live-session", "local-project");
		lifecycleMocks.workspaces = [makeWorkspace("local-project", [session])];
		setGroups([makeGroup("local-project", [session.id])]);
		const storagePrototypeWrite = vi.spyOn(Storage.prototype, "setItem");
		const localStorageWrite = vi.spyOn(window.localStorage, "setItem");

		render(<TopbarTabsLifecycle />);

		expect(storagePrototypeWrite).not.toHaveBeenCalled();
		expect(localStorageWrite).not.toHaveBeenCalled();
	});
});
