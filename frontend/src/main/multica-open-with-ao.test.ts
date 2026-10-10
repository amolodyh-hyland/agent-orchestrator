// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildOpenWithAoActionUrl,
	type OpenWithAoPagePayload,
	type OpenWithAoSnapshot,
} from "../shared/multica-open-with-ao";
import { buildOpenWithAoRemoveScript, buildOpenWithAoScript } from "./multica-open-with-ao-script";
import { buildReadWorkspaceSlugScript, createMulticaOpenWithAo, type MulticaOpenWithAoOptions } from "./multica-open-with-ao";

vi.mock("./multica-open-with-ao-script", () => ({
	buildOpenWithAoScript: vi.fn((payload: OpenWithAoPagePayload) => `window.__aoOpenWithAo(${JSON.stringify(payload)})`),
	buildOpenWithAoRemoveScript: vi.fn(() => "window.__aoOpenWithAoRemove()"),
}));

const NONCE = "nonce-1234567890";

function session(id: string, projectId: string) {
	return {
		id,
		projectId,
		label: id,
		tone: "working" as const,
		stateLabel: "Working",
		detail: "",
		stale: false,
		terminated: false,
		updatedAt: 1,
	};
}

function snapshot(projectIds: string[] = ["project-1"]): OpenWithAoSnapshot {
	return {
		daemon: "ready",
		stale: false,
		projects: projectIds.map((projectId) => ({
			id: projectId,
			name: projectId,
			orchestrator: session(`${projectId}-orchestrator`, projectId),
			sessions: [session(`${projectId}-worker`, projectId)],
			moreCount: 0,
		})),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function setup(overrides: Partial<MulticaOpenWithAoOptions> = {}) {
	const order: string[] = [];
	const host = {
		runInAoWorld: vi.fn((_script: string) => order.push("runInAoWorld")),
		evaluateInPage: vi.fn(async (_script: string): Promise<unknown> => {
			order.push("evaluateInPage");
			return JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" });
		}),
	};
	let issue: { identifier: string; title: string } | null = { identifier: "MUL-1", title: "Fix login" };
	let links: ReadonlyArray<{ sessionId: string; issueIdentifier: string; projectId: string; workspaceSlug?: string }> = [];
	const addLink = vi.fn(async (_link: { sessionId: string; projectId: string; workspaceSlug: string; issueIdentifier: string }) => {
		order.push("addLink");
		return true;
	});
	const openSession = vi.fn((_target: { projectId: string; sessionId: string }) => order.push("openSession"));
	const requestNewTask = vi.fn((_projectId: string) => order.push("requestNewTask"));
	const options: MulticaOpenWithAoOptions = {
		getHost: () => host,
		getCurrentIssue: () => issue,
		getLinks: () => links,
		addLink,
		openSession,
		requestNewTask,
		createNonce: () => NONCE,
		...overrides,
	};
	const service = createMulticaOpenWithAo(options);
	return {
		service,
		host,
		order,
		addLink,
		openSession,
		requestNewTask,
		setIssue: (next: { identifier: string; title: string } | null) => {
			issue = next;
		},
		setLinks: (next: ReadonlyArray<{ sessionId: string; issueIdentifier: string; projectId: string; workspaceSlug?: string }>) => {
			links = next;
		},
	};
}

function openUrl(projectId: string, sessionId: string, nonce = NONCE, workspaceSlug = "acme"): string {
	return buildOpenWithAoActionUrl({ kind: "open", projectId, sessionId, nonce, workspaceSlug });
}

function openUrlWithoutWorkspace(projectId: string, sessionId: string, nonce = NONCE): string {
	return buildOpenWithAoActionUrl({ kind: "open", projectId, sessionId, nonce });
}

function newTaskUrl(projectId: string, nonce = NONCE): string {
	return buildOpenWithAoActionUrl({ kind: "new-task", projectId, nonce });
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Multica Open in AO snapshot and refresh", () => {
	it("rejects an invalid snapshot without changing the stored snapshot", () => {
		const t = setup();
		const first = snapshot();
		expect(t.service.setSnapshot(first)).toEqual({ ok: true });
		expect(t.service.setSnapshot({ ...first, unknown: true })).toEqual({ ok: false });

		t.service.refresh();
		expect(buildOpenWithAoScript).toHaveBeenCalledTimes(2);
		expect(vi.mocked(buildOpenWithAoScript).mock.calls[1][0].projects[0].id).toBe("project-1");
	});

	it("skips an identical snapshot and refreshes when it changes", () => {
		const t = setup();
		const first = snapshot();
		expect(t.service.setSnapshot(first)).toEqual({ ok: true });
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);

		expect(t.service.setSnapshot(JSON.parse(JSON.stringify(first)) as OpenWithAoSnapshot)).toEqual({ ok: true });
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);

		expect(t.service.setSnapshot(snapshot(["project-2"]))).toEqual({ ok: true });
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(2);
	});

	it("injects the script with the nonce and current issue and builds link flags and deduction", () => {
		const t = setup({
			getLinks: () => [{ sessionId: "project-2-worker", issueIdentifier: "MUL-1", projectId: "project-2" }],
		});
		t.service.setSnapshot(snapshot(["project-1", "project-2"]));

		expect(t.host.runInAoWorld).toHaveBeenCalledOnce();
		const script = t.host.runInAoWorld.mock.calls[0][0];
		expect(script).toContain("__aoOpenWithAo");
		expect(script).toContain(NONCE);
		expect(script).toContain("MUL-1");
		const payload = vi.mocked(buildOpenWithAoScript).mock.calls[0][0];
		expect(payload.nonce).toBe(NONCE);
		expect(payload.issue).toEqual({ identifier: "MUL-1", title: "Fix login" });
		expect(payload.deducedProjectId).toBe("project-2");
		expect(payload.deduction).toBe("linked");
		expect(payload.projects.find((project) => project.id === "project-2")).toMatchObject({
			linked: true,
			sessions: [{ id: "project-2-worker", linked: true }],
			orchestrator: { linked: false },
		});
		expect(payload.projects.find((project) => project.id === "project-1")?.linked).toBe(false);
	});

	it("runs the remove script when there is no issue", () => {
		const t = setup({ getCurrentIssue: () => null });
		t.service.setSnapshot(snapshot());

		expect(buildOpenWithAoRemoveScript).toHaveBeenCalledOnce();
		expect(t.host.runInAoWorld).toHaveBeenCalledExactlyOnceWith("window.__aoOpenWithAoRemove()");
		expect(buildOpenWithAoScript).not.toHaveBeenCalled();
	});

	it("does not throw or inject when the host is missing", () => {
		const t = setup({ getHost: () => undefined });
		expect(() => t.service.setSnapshot(snapshot())).not.toThrow();
		expect(() => t.service.refresh()).not.toThrow();
		expect(buildOpenWithAoScript).not.toHaveBeenCalled();
	});
});

describe("Multica Open in AO actions", () => {
	it("returns false for non-prefixed URLs and leaves dependencies untouched", () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		t.host.runInAoWorld.mockClear();
		t.order.length = 0;

		expect(t.service.handleActionUrl("https://example.com")).toBe(false);
		expect(t.order).toEqual([]);
		expect(t.openSession).not.toHaveBeenCalled();
		expect(t.requestNewTask).not.toHaveBeenCalled();
	});

	it("swallows invalid URLs, wrong nonces, unknown projects and unknown sessions", () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		t.host.evaluateInPage.mockClear();
		t.order.length = 0;

		expect(t.service.handleActionUrl("ao://multica/open-with-ao/invalid")).toBe(true);
		expect(t.service.handleActionUrl(openUrl("project-1", "project-1-worker", "wrong-nonce-123456"))).toBe(true);
		expect(t.service.handleActionUrl(openUrl("unknown", "worker-1"))).toBe(true);
		expect(t.service.handleActionUrl(openUrl("project-1", "unknown-session"))).toBe(true);
		expect(t.order).toEqual([]);
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.openSession).not.toHaveBeenCalled();
	});

	it("opens an orchestrator directly without reading a slug or adding a link", () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		expect(t.service.handleActionUrl(openUrl("project-1", "project-1-orchestrator"))).toBe(true);

		expect(t.openSession).toHaveBeenCalledExactlyOnceWith({ projectId: "project-1", sessionId: "project-1-orchestrator" });
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.addLink).not.toHaveBeenCalled();
	});

	it("reads the slug, adds an issue link, then opens an unlinked worker", async () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		expect(t.service.handleActionUrl(openUrl("project-1", "project-1-worker", NONCE, "acme"))).toBe(true);
		await flushPromises();

		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();
		expect(t.host.evaluateInPage.mock.calls[0][0]).toBe(buildReadWorkspaceSlugScript());
		expect(t.addLink).toHaveBeenCalledExactlyOnceWith({
			sessionId: "project-1-worker",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});
		expect(t.openSession).toHaveBeenCalledExactlyOnceWith({ projectId: "project-1", sessionId: "project-1-worker" });
		expect(t.order).toEqual(["runInAoWorld", "evaluateInPage", "addLink", "openSession"]);
	});

	it("opens a worker immediately when it is already linked to the current issue", () => {
		const t = setup({ getLinks: () => [{ sessionId: "project-1-worker", issueIdentifier: "MUL-1", projectId: "project-1" }] });
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));

		expect(t.openSession).toHaveBeenCalledOnce();
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.addLink).not.toHaveBeenCalled();
	});

	it("opens without linking when the workspace read contains a different issue title", async () => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(JSON.stringify({ slug: "acme", title: "BETA-9: Different issue" }));
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it("does not link the clicked issue when the page title changes before the workspace read resolves", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();

		t.setIssue({ identifier: "BETA-9", title: "Different issue" });
		pending.resolve(JSON.stringify({ slug: "workspace-b", title: "BETA-9: Different issue" }));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it("does not link the same identifier after switching workspaces while the read is pending", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker", NONCE, "workspace-a"));
		await flushPromises();

		t.setIssue({ identifier: "MUL-1", title: "Different issue" });
		pending.resolve(JSON.stringify({ slug: "workspace-b", title: "MUL-1: Different issue" }));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledExactlyOnceWith({ projectId: "project-1", sessionId: "project-1-worker" });
	});

	it("opens without linking when the action has no captured workspace slug", async () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrlWithoutWorkspace("project-1", "project-1-worker"));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledExactlyOnceWith({ projectId: "project-1", sessionId: "project-1-worker" });
	});

	it.each([
		null,
		undefined,
		"bad JSON",
		JSON.stringify({ slug: "bad slug", title: "MUL-1: Fix login" }),
		JSON.stringify({ slug: "a".repeat(64), title: "MUL-1: Fix login" }),
		JSON.stringify({ slug: "acme", title: "x".repeat(501) }),
		JSON.stringify({ slug: "acme", title: "MUL-1: Fix login", extra: true }),
	])("opens without adding a link when the page returns an invalid workspace context (%s)", async (context) => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(context);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it("opens after the workspace slug read times out", async () => {
		vi.useFakeTimers();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();
		await vi.advanceTimersByTimeAsync(2000);
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it.each(["reject", "resolve false"] as const)("opens when addLink %s", async (result) => {
		const t = setup();
		if (result === "reject") t.addLink.mockRejectedValueOnce(new Error("save failed"));
		else t.addLink.mockResolvedValueOnce(false);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();

		expect(t.addLink).toHaveBeenCalledOnce();
		expect(t.openSession).toHaveBeenCalledOnce();
		expect(t.addLink.mock.invocationCallOrder[0]).toBeLessThan(t.openSession.mock.invocationCallOrder[0]);
	});

	it("ignores a second click while the same worker open is pending", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();
		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();

		pending.resolve(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));
		await flushPromises();
		expect(t.addLink).toHaveBeenCalledOnce();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it("rechecks the current issue after the workspace read resolves", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();
		t.setIssue({ identifier: "BETA-9", title: "Different issue" });
		pending.resolve(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));
		await flushPromises();

		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).toHaveBeenCalledOnce();
	});

	it("opens a worker without linking when there is no current issue", () => {
		const t = setup({ getCurrentIssue: () => null });
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));

		expect(t.openSession).toHaveBeenCalledOnce();
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.addLink).not.toHaveBeenCalled();
	});

	it("starts a new task only for an existing project while an issue is open", () => {
		const t = setup();
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(newTaskUrl("project-1"));
		t.service.handleActionUrl(newTaskUrl("unknown-project"));

		expect(t.requestNewTask).toHaveBeenCalledExactlyOnceWith("project-1");
		expect(t.openSession).not.toHaveBeenCalled();
	});

	it("does not start a new task without a current issue", () => {
		const t = setup({ getCurrentIssue: () => null });
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(newTaskUrl("project-1"));

		expect(t.requestNewTask).not.toHaveBeenCalled();
	});

	it("swallows prefixed URLs and ignores pending work after disposal", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.setSnapshot(snapshot());
		t.service.handleActionUrl(openUrl("project-1", "project-1-worker"));
		await flushPromises();
		t.service.dispose();
		pending.resolve(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));
		await flushPromises();

		expect(t.service.setSnapshot(snapshot(["another"]))).toEqual({ ok: false });
		expect(t.service.handleActionUrl(openUrl("project-1", "project-1-worker"))).toBe(true);
		t.service.refresh();
		expect(t.addLink).not.toHaveBeenCalled();
		expect(t.openSession).not.toHaveBeenCalled();
		expect(t.host.runInAoWorld).toHaveBeenCalledOnce();
	});

	it("throws for a custom nonce that fails nonce validation", () => {
		expect(() => setup({ createNonce: () => "bad" })).toThrowError("invalid open-with-ao nonce");
	});
});

describe("Multica Open in AO sync actions", () => {
	const syncUrl = (syncAction: "enable" | "disable" | "resume", projectId = "project-1", sessionId = "project-1-worker", nonce = NONCE) =>
		buildOpenWithAoActionUrl({ kind: "sync", syncAction, projectId, sessionId, nonce });
	const linked = [{ sessionId: "project-1-worker", issueIdentifier: "MUL-1", projectId: "project-1", workspaceSlug: "acme" }];

	it("hands a sync action for a worker linked to the issue on screen to the sync owner, with the link's workspace", () => {
		const onSyncAction = vi.fn();
		const t = setup({ onSyncAction });
		t.setLinks(linked);
		t.service.setSnapshot(snapshot());

		for (const action of ["enable", "disable", "resume"] as const) expect(t.service.handleActionUrl(syncUrl(action))).toBe(true);

		expect(onSyncAction.mock.calls.map(([call]) => call)).toEqual(
			(["enable", "disable", "resume"] as const).map((syncAction) => ({
				syncAction,
				sessionId: "project-1-worker",
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
			})),
		);
		expect(t.openSession).not.toHaveBeenCalled();
		expect(t.addLink).not.toHaveBeenCalled();
	});

	it("ignores a sync action with a wrong nonce, for an unknown project or session, for an orchestrator, or without a link to the issue on screen", () => {
		const onSyncAction = vi.fn();
		const t = setup({ onSyncAction });
		t.setLinks(linked);
		t.service.setSnapshot(snapshot());

		t.service.handleActionUrl(syncUrl("enable", "project-1", "project-1-worker", "other-nonce-12345"));
		t.service.handleActionUrl(syncUrl("enable", "unknown", "project-1-worker"));
		t.service.handleActionUrl(syncUrl("enable", "project-1", "unknown"));
		t.service.handleActionUrl(syncUrl("enable", "project-1", "project-1-orchestrator"));
		t.setIssue({ identifier: "MUL-2", title: "Another" });
		t.service.handleActionUrl(syncUrl("enable"));
		t.setIssue(null);
		t.service.handleActionUrl(syncUrl("enable"));
		t.setIssue({ identifier: "MUL-1", title: "Fix login" });
		t.setLinks([{ sessionId: "project-1-worker", issueIdentifier: "MUL-1", projectId: "project-1" }]);
		t.service.handleActionUrl(syncUrl("enable"));

		expect(onSyncAction).not.toHaveBeenCalled();
	});

	it("swallows a sync action when nothing is listening, and builds the page payload with the sync input", () => {
		const getSync = vi.fn(() => ({ enabled: true, killSwitch: false, views: [] }));
		const t = setup({ getSync });
		t.setLinks(linked);
		t.service.setSnapshot(snapshot());

		expect(t.service.handleActionUrl(syncUrl("disable"))).toBe(true);
		expect(getSync).toHaveBeenCalled();
		const script = vi.mocked(buildOpenWithAoScript).mock.calls.at(-1)?.[0];
		expect(script?.projects[0].sessions[0].sync).toMatchObject({ label: "Keep this ticket updated", action: "enable" });
	});
});

describe("workspace slug page script", () => {
	function evaluateStoredTabs(value: string | null, title = "MUL-1: Fix login"): unknown {
		const script = buildReadWorkspaceSlugScript();
		const evaluate = new Function(
			"localStorage",
			"document",
			`return ${script};`,
		) as (storage: { getItem: (key: string) => string | null }, page: { title: string }) => unknown;
		return evaluate({ getItem: (key) => (key === "multica_tabs" ? value : null) }, { title });
	}

	it("returns a valid workspace slug in lowercase", () => {
		expect(JSON.parse(evaluateStoredTabs(JSON.stringify({ state: { activeWorkspaceSlug: "Acme_Workspace-2" } })) as string)).toEqual({
			slug: "acme_workspace-2",
			title: "MUL-1: Fix login",
		});
	});

	it("includes the current document title when no workspace is selected", () => {
		expect(JSON.parse(evaluateStoredTabs(null, "MUL-2: Other issue") as string)).toEqual({
			slug: null,
			title: "MUL-2: Other issue",
		});
	});

	it("returns null when localStorage cannot be read", () => {
		const evaluate = new Function("localStorage", "document", `return ${buildReadWorkspaceSlugScript()};`) as (
			storage: { getItem: (key: string) => string | null },
			page: { title: string },
		) => unknown;
		expect(evaluate({ getItem: () => { throw new Error("denied"); } }, { title: "MUL-1: Fix login" })).toBeNull();
	});

	it("returns null for bad stored JSON", () => {
		expect(evaluateStoredTabs("{")).toBeNull();
	});

	it.each([
		["missing workspace", JSON.stringify({ state: {} })],
		["bad slug", JSON.stringify({ state: { activeWorkspaceSlug: "bad slug" } })],
		["too long", JSON.stringify({ state: { activeWorkspaceSlug: "a".repeat(64) } })],
	])("returns a null slug for %s", (_label, storedValue) => {
		expect(JSON.parse(evaluateStoredTabs(storedValue as string) as string)).toEqual({ slug: null, title: "MUL-1: Fix login" });
	});

	describe("executor line", () => {
		const lastPayload = (): OpenWithAoPagePayload => {
			const calls = vi.mocked(buildOpenWithAoScript).mock.calls;
			return calls[calls.length - 1][0];
		};

		it("asks for the line with the live linked sessions of the current issue and puts it in the payload", () => {
			const getExecutorLine = vi.fn(() => ({ display: "ao" as const, text: "Run by: AO session project-1-worker, Working" }));
			const { service, setLinks } = setup({ getExecutorLine });
			setLinks([{ sessionId: "project-1-worker", issueIdentifier: "MUL-1", projectId: "project-1" }]);
			service.setSnapshot(snapshot());
			expect(getExecutorLine).toHaveBeenLastCalledWith({
				issueIdentifier: "MUL-1",
				liveSessions: [{ id: "project-1-worker", label: "project-1-worker", stateLabel: "Working" }],
			});
			expect(lastPayload().executor).toEqual({ display: "ao", text: "Run by: AO session project-1-worker, Working" });
		});

		it("leaves out terminated sessions and sessions linked to another issue", () => {
			const getExecutorLine = vi.fn(() => null);
			const { service, setLinks } = setup({ getExecutorLine });
			setLinks([
				{ sessionId: "project-1-worker", issueIdentifier: "MUL-2", projectId: "project-1" },
				{ sessionId: "gone", issueIdentifier: "MUL-1", projectId: "project-1" },
			]);
			const withTerminated = snapshot();
			withTerminated.projects[0].sessions.push({ ...session("gone", "project-1"), terminated: true });
			service.setSnapshot(withTerminated);
			expect(getExecutorLine).toHaveBeenLastCalledWith({ issueIdentifier: "MUL-1", liveSessions: [] });
		});

		it("has no executor when no provider is given, and survives a provider that throws", () => {
			const plain = setup();
			plain.service.setSnapshot(snapshot());
			expect(lastPayload().executor).toBeNull();
			const throwing = setup({
				getExecutorLine: () => {
					throw new Error("boom");
				},
			});
			throwing.service.setSnapshot(snapshot(["project-2"]));
			expect(lastPayload().executor).toBeNull();
		});
	});
});
