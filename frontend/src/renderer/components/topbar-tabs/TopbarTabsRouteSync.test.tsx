import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TOPBAR_TABS } from "../../lib/topbar-tabs";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { STANDALONE_WORKSPACE_ID, type WorkspaceSession } from "../../types/workspace";
import type { CloudCpSession } from "../../lib/cloud-cp/types";
import { TopbarTabsRouteSync } from "./TopbarTabsRouteSync";

const route = vi.hoisted(() => ({
	params: { hostId: undefined as string | undefined, projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	href: "/",
	session: undefined as { id: string; workspaceId: string; kind?: string } | undefined,
	workspaceSession: undefined as WorkspaceSession | undefined,
	cloudSession: undefined as CloudCpSession | undefined,
	cloudOrgId: undefined as string | undefined,
	cloudError: false,
}));
let currentTime = 100;

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useParams: () => route.params,
		useRouterState: ({ select }: { select: (state: { location: { href: string } }) => unknown }) =>
			select({ location: { href: route.href } }),
	};
});

vi.mock("../../hooks/useWorkspaceQuery", () => ({
	useWorkspaceScope: () => ({ data: route.session ? { session: route.session } : undefined }),
	useWorkspaceSession: (sessionId: string, _hostId?: string, localLookupEnabled = true) => ({
		data: localLookupEnabled && route.workspaceSession?.id === sessionId ? route.workspaceSession : undefined,
	}),
	useCloudSessionQuery: (_orgId: string | undefined, _sessionId: string, enabled = true) => ({
		data: enabled ? route.cloudSession : undefined,
		isError: route.cloudError,
	}),
	toCloudWorkspaceSession: (session: CloudCpSession, project: { id: string; displayName: string }, _orgId: string) =>
		makeSession(session.id, project.id, session.kind === "orchestrator" ? "orchestrator" : "worker"),
}));

vi.mock("../../hooks/useCloudOrg", () => ({
	useCloudOrg: () => ({ org: route.cloudOrgId ? { id: route.cloudOrgId } : undefined }),
}));

function makeSession(
	id: string,
	workspaceId: string,
	kind: WorkspaceSession["kind"] = "worker",
): WorkspaceSession {
	return {
		id,
		workspaceId,
		workspaceName: workspaceId,
		title: id,
		provider: "claude-code",
		kind,
		status: "working",
		updatedAt: "2026-06-10T00:00:00Z",
		prs: [],
	};
}

function setRoute(input: {
	hostId?: string;
	projectId?: string;
	sessionId?: string;
	href: string;
	session?: WorkspaceSession;
	workspaceSession?: WorkspaceSession;
	cloudSession?: CloudCpSession;
	cloudOrgId?: string;
}) {
	route.params.hostId = input.hostId;
	route.params.projectId = input.projectId;
	route.params.sessionId = input.sessionId;
	route.href = input.href;
	route.session = input.session;
	route.workspaceSession = input.workspaceSession;
	route.cloudSession = input.cloudSession;
	route.cloudOrgId = input.cloudOrgId;
	route.cloudError = false;
}

beforeEach(() => {
	localStorage.clear();
	setRoute({ href: "/" });
	route.cloudError = false;
	useTopbarTabsStore.setState({ tabs: EMPTY_TOPBAR_TABS, lastEviction: null });
	currentTime = 100;
	vi.spyOn(Date, "now").mockImplementation(() => currentTime);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("TopbarTabsRouteSync", () => {
	it("does not open a tab for a host-scoped route that shares its session id with a local session", () => {
		const session = makeSession("worker-1", "project-1");
		setRoute({
			hostId: "box-a",
			projectId: "project-1",
			sessionId: session.id,
			href: `/host/box-a/project/project-1/session/${session.id}`,
			session,
			workspaceSession: session,
		});

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("opens a project worker as a preview tab in its project group", () => {
		const session = makeSession("worker-1", "project-1");
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([
			{
				id: "project-1",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: [{ sessionId: session.id, mode: "preview", lastActiveAt: 100 }],
			},
		]);
	});

	it("sets a project orchestrator as the preview head", () => {
		const session = makeSession("project-1-orchestrator", "project-1", "orchestrator");
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });

		render(<TopbarTabsRouteSync />);

		const group = useTopbarTabsStore.getState().tabs.groups[0];
		expect(group.head).toEqual({ sessionId: session.id, mode: "preview", lastActiveAt: 100 });
		expect(group.tabs).toEqual([]);
	});

	it("treats an undefined-kind orchestrator suffix as a project head", () => {
		const session = { ...makeSession("legacy-project-orchestrator", "project-1"), kind: undefined };
		setRoute({
			projectId: "project-1",
			sessionId: session.id,
			href: `/projects/project-1/sessions/${session.id}`,
			session,
		});

		render(<TopbarTabsRouteSync />);

		const group = useTopbarTabsStore.getState().tabs.groups[0];
		expect(group.head).toEqual({ sessionId: session.id, mode: "preview", lastActiveAt: 100 });
		expect(group.tabs).toEqual([]);
	});

	it("places a standalone session in the standalone group", () => {
		const session = makeSession("standalone-1", STANDALONE_WORKSPACE_ID);
		setRoute({ sessionId: session.id, href: `/sessions/${session.id}`, session });

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups[0]).toMatchObject({
			id: STANDALONE_WORKSPACE_ID,
			tabs: [{ sessionId: session.id, mode: "preview", lastActiveAt: 100 }],
		});
	});

	it("does not activate a routed session before its scope resolves", () => {
		setRoute({ projectId: "project-1", sessionId: "worker-1", href: "/projects/project-1/sessions/worker-1" });

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("does not change tabs on a non-session route", () => {
		setRoute({ href: "/projects/project-1" });

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([]);
	});

	it("does not reactivate on a rerender or workspace refetch for the same route", () => {
		const session = makeSession("worker-1", "project-1");
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });
		const view = render(<TopbarTabsRouteSync />);
		const initialTabs = useTopbarTabsStore.getState().tabs;

		route.session = { ...session };
		view.rerender(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs).toBe(initialTabs);
		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].lastActiveAt).toBe(100);
	});

	it("activates again after navigating away and back to the same session", () => {
		const session = makeSession("worker-1", "project-1");
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });
		const view = render(<TopbarTabsRouteSync />);

		currentTime = 200;
		setRoute({ href: "/projects/project-1" });
		view.rerender(<TopbarTabsRouteSync />);
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });
		view.rerender(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].lastActiveAt).toBe(200);
	});

	it("activates again after returning from an unresolved session route", () => {
		const session = makeSession("worker-1", "project-1");
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });
		const view = render(<TopbarTabsRouteSync />);
		useTopbarTabsStore.setState((state) => ({
			tabs: {
				...state.tabs,
				groups: state.tabs.groups.map((group) =>
					group.id === "project-1" ? { ...group, collapsed: true } : group,
				),
			},
		}));

		currentTime = 200;
		setRoute({ projectId: "project-1", sessionId: "worker-2", href: "/projects/project-1/sessions/worker-2" });
		view.rerender(<TopbarTabsRouteSync />);
		setRoute({ projectId: "project-1", sessionId: session.id, href: `/projects/project-1/sessions/${session.id}`, session });
		view.rerender(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs[0].lastActiveAt).toBe(200);
		expect(useTopbarTabsStore.getState().tabs.groups[0].collapsed).toBe(false);
	});

	it("opens a cloud session from direct lookup when it is absent from list scope", () => {
		const session: CloudCpSession = {
			id: "cloud-worker",
			orgId: "org-1",
			projectId: "cloud-project",
			kind: "worker",
			harness: "claude-code",
			displayName: "Cloud worker",
			branch: "main",
			mode: "standard",
			interfaceMode: "tui",
			deniedCommands: [],
			activityState: "working",
			status: "working",
			runtimeConnected: true,
			isTerminated: false,
			prs: [],
			createdAt: "2026-06-10T00:00:00Z",
			updatedAt: "2026-06-10T00:00:00Z",
		};
		setRoute({
			projectId: "cloud-project",
			sessionId: session.id,
			href: `/projects/cloud-project/sessions/${session.id}`,
			cloudSession: session,
			cloudOrgId: "org-1",
		});

		render(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups).toEqual([
			{
				id: "cloud-project",
				collapsed: false,
				head: { sessionId: null, mode: "persistent", lastActiveAt: 0 },
				tabs: [{ sessionId: session.id, mode: "preview", lastActiveAt: 100 }],
			},
		]);
	});

	it("replaces the current preview in place when another project worker is opened", () => {
		const firstSession = makeSession("worker-1", "project-1");
		const secondSession = makeSession("worker-2", "project-1");
		setRoute({ projectId: "project-1", sessionId: firstSession.id, href: `/projects/project-1/sessions/${firstSession.id}`, session: firstSession });
		const view = render(<TopbarTabsRouteSync />);
		const current = useTopbarTabsStore.getState().tabs;
		useTopbarTabsStore.setState({
			tabs: {
				...current,
				groups: current.groups.map((group) =>
					group.id === "project-1"
						? { ...group, tabs: [...group.tabs, { sessionId: "saved-worker", mode: "persistent", lastActiveAt: 50 }] }
						: group,
				),
			},
		});

		setRoute({ projectId: "project-1", sessionId: secondSession.id, href: `/projects/project-1/sessions/${secondSession.id}`, session: secondSession });
		view.rerender(<TopbarTabsRouteSync />);

		expect(useTopbarTabsStore.getState().tabs.groups[0].tabs).toEqual([
			{ sessionId: secondSession.id, mode: "preview", lastActiveAt: 100 },
			{ sessionId: "saved-worker", mode: "persistent", lastActiveAt: 50 },
		]);
	});
});
