import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCockpit, COCKPIT_SELECTION_KEY } from "./ProjectCockpit";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("../lib/api-client", () => ({ apiClient: { GET: mocks.get, POST: mocks.post, PATCH: mocks.patch, DELETE: mocks.del }, hasTrustedApiBaseUrl: () => true }));
vi.mock("../lib/telemetry", () => ({ captureRendererEvent: vi.fn() }));
vi.mock("../hooks/useCloudCp", () => ({ useCloudCp: () => ({ ready: false }) }));
vi.mock("../hooks/useCloudOrg", () => ({ useCloudOrg: () => ({ ready: false }) }));

const at = "2026-10-23T00:00:00Z";
let projects: Array<{ id: string; name: string; path: string }>;
let failed: Set<string>;
let unknownTimestamp: boolean;
const sessions = [
	{ id: "a-c", projectId: "a", displayName: "Old coordinator", kind: "orchestrator", status: "no_signal", statusReadiness: "ready", updatedAt: at, activity: { state: "idle" }, prs: [] },
	{ id: "b-1", projectId: "b", displayName: "Archived worker", kind: "worker", isTerminated: true, status: "terminated", statusReadiness: "ready", updatedAt: at, activity: { state: "exited" }, prs: [] },
];

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
	const root = createRootRoute({ component: Outlet });
	const cockpit = createRoute({ getParentRoute: () => root, path: "/cockpit", component: ProjectCockpit });
	const board = createRoute({ getParentRoute: () => root, path: "/projects/$projectId", component: () => <p>Source board</p> });
	const router = createRouter({ routeTree: root.addChildren([cockpit, board]), history: createMemoryHistory({ initialEntries: ["/cockpit"] }) });
	const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
	return { ...view, client, router };
}

beforeEach(() => {
	localStorage.clear();
	failed = new Set();
	unknownTimestamp = false;
	projects = [{ id: "a", name: "Alpha", path: "/a" }, { id: "b", name: "Beta", path: "/b" }, { id: "c", name: "Excluded", path: "/c" }];
	vi.clearAllMocks();
	mocks.get.mockImplementation(async (path, options) => {
		if (path === "/api/v1/runs/monitoring") return { data: { runs: [] } };
		if (path === "/api/v1/projects") return { data: { projects } };
		if (path === "/api/v1/sessions") {
			expect(options).toEqual({ params: { query: { readOnly: true } } });
			return { data: { sessions: unknownTimestamp ? sessions.map((session) => ({ ...session, updatedAt: "", statusReadiness: "checking" })) : sessions } };
		}
		if (path === "/api/v1/reports") {
			const id = options.params.query.projectId;
			if (failed.has(id)) throw new Error("unavailable");
			return { data: { reports: [{ id: `r-${id}`, sessionId: `${id}-1`, projectId: id, state: "done", note: `${id} claim <script>send()</script>`, outputs: [{ reference: "https://example.invalid/steer", kind: "artifact" }], createdAt: at, repeatCount: 1 }, { id: "foreign", projectId: "foreign", note: "Foreign secret" }] } };
		}
		throw new Error(`Unexpected read ${path}`);
	});
});
afterEach(cleanup);

function assertReadOnly() {
	expect(mocks.post).not.toHaveBeenCalled();
	expect(mocks.patch).not.toHaveBeenCalled();
	expect(mocks.del).not.toHaveBeenCalled();
	expect(mocks.get.mock.calls.every(([path]) => ["/api/v1/projects", "/api/v1/sessions", "/api/v1/reports", "/api/v1/runs/monitoring"].includes(path))).toBe(true);
}

describe("Project cockpit", () => {
	it("requires selection, reads only selected reports, and shows source times, claims and missing/stale coordinators", async () => {
		const user = userEvent.setup();
		mount();
		await screen.findByRole("checkbox", { name: "Alpha a" });
		expect(mocks.get.mock.calls.filter(([path]) => path === "/api/v1/reports")).toHaveLength(0);
		await user.click(screen.getByRole("checkbox", { name: "Alpha a" }));
		await user.click(screen.getByRole("checkbox", { name: "Beta b" }));
		await screen.findByText("b claim <script>send()</script>");
		const alpha = within(screen.getByRole("region", { name: "Alpha" }));
		const beta = within(screen.getByRole("region", { name: "Beta" }));
		expect(alpha.getByText(/Coordinator facts are old/)).toBeInTheDocument();
		expect(beta.getByText(/Coordinator missing/)).toBeInTheDocument();
		expect(alpha.getByText(/Source updated:/)).toHaveTextContent(/min old/);
		expect(alpha.getByText(/Recorded:/)).toHaveTextContent(/min old/);
		expect(screen.getAllByText(/Reported state \(claim\): done/)).toHaveLength(2);
		expect(screen.queryByText(/Unavailable until/)).not.toBeInTheDocument();
		expect(screen.queryByText("Foreign secret")).not.toBeInTheDocument();
		expect(document.querySelector('script')).toBeNull();
		expect(screen.queryByRole("link", { name: "https://example.invalid/steer" })).not.toBeInTheDocument();
		expect(mocks.get.mock.calls.filter(([path]) => path === "/api/v1/reports").map(([, options]) => options.params.query.projectId).sort()).toEqual(["a", "b"]);
		assertReadOnly();
	});

	it("refreshes, survives a remount, follows only a board link, and retains immutable selection through rename/archive", async () => {
		localStorage.setItem(COCKPIT_SELECTION_KEY, JSON.stringify(["a", "b"]));
		const user = userEvent.setup();
		const first = mount();
		await screen.findByText("b claim <script>send()</script>");
		projects = [{ id: "a", name: "Alpha renamed", path: "/a" }];
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByRole("region", { name: "Alpha renamed" });
		expect(screen.getByText(/Project archived, removed/)).toBeInTheDocument();
		const before = mocks.get.mock.calls.filter(([path, options]) => path === "/api/v1/reports" && options.params.query.projectId === "b").length;
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
		expect(mocks.get.mock.calls.filter(([path, options]) => path === "/api/v1/reports" && options.params.query.projectId === "b")).toHaveLength(before);
		first.unmount(); first.client.clear();
		mount();
		await screen.findByText("a claim <script>send()</script>");
		expect(screen.getByRole("checkbox", { name: "Alpha renamed a" })).toBeChecked();
		await user.click(screen.getByRole("link", { name: "Project board" }));
		await screen.findByText("Source board");
		assertReadOnly();
	});

	it("keeps the other project visible on a report failure and clears deselected data", async () => {
		failed.add("a");
		localStorage.setItem(COCKPIT_SELECTION_KEY, '["a","b"]');
		const user = userEvent.setup();
		mount();
		await screen.findByText(/Report refresh failed/);
		await screen.findByText("b claim <script>send()</script>");
		await user.click(screen.getByRole("checkbox", { name: "Beta b" }));
		expect(screen.queryByText("b claim <script>send()</script>")).not.toBeInTheDocument();
		expect(JSON.parse(localStorage.getItem(COCKPIT_SELECTION_KEY)!)).toEqual(["a"]);
		assertReadOnly();
	});

	it("labels unknown source timestamps and preserves prior reports on refresh failure", async () => {
		unknownTimestamp = true;
		localStorage.setItem(COCKPIT_SELECTION_KEY, '["a"]');
		const user = userEvent.setup();
		mount();
		await screen.findByText("a claim <script>send()</script>");
		expect(screen.getByText("Source updated: Timestamp unavailable")).toBeInTheDocument();
		expect(screen.getByText(/Coordinator facts are old/)).toBeInTheDocument();
		failed.add("a");
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText(/Report refresh failed/);
		expect(screen.getByText("a claim <script>send()</script>")).toBeInTheDocument();
		assertReadOnly();
	});

	it("ignores malformed preferences without reading any reports", async () => {
		localStorage.setItem(COCKPIT_SELECTION_KEY, "broken");
		mount();
		await screen.findByRole("checkbox", { name: "Alpha a" });
		expect(screen.getByText(/Select projects to see/)).toBeInTheDocument();
		assertReadOnly();
	});
});
