import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MULTICA_ACTION_LOG_READ_CHANNEL,
	type MulticaActionRecord,
} from "../shared/multica-action-log";
import {
	MULTICA_AWARENESS_COMMAND_CHANNEL,
	MULTICA_AWARENESS_GET_STATE_CHANNEL,
	MULTICA_AWARENESS_OPEN_ISSUE_CHANNEL,
	MULTICA_AWARENESS_STATE_CHANNEL,
	type AwarenessCommand,
	type AwarenessCommandResult,
	type AwarenessServerState,
	type AwarenessState,
} from "../shared/multica-awareness";
import type { MulticaIssueLink } from "../shared/multica-issue-links";
import { createMulticaActionLog } from "./multica-action-log";
import { RECONCILE_LINKED_LIMIT } from "./multica-awareness-connection";
import { createMulticaAwareness, type MulticaAwareness, type MulticaAwarenessOptions } from "./multica-awareness";
import { createMulticaCredentials, type SecretVault } from "./multica-credentials";
import type { FetchLike } from "./multica-read-client";
import { createMulticaWatchConfigStore } from "./multica-watch-config";
import { createFakeScheduler, type FakeScheduler } from "./test-support/fake-scheduler";
import { createFakeMulticaServer, fakeIssue, fakeTask, type FakeMulticaServer } from "./test-support/multica-fake-server";

// Fake fixtures only; none of these is a credential of a real server.
const TOKEN_A = "mul_FIXTUREserverATOKEN0001";
const TOKEN_B = "mul_FIXTUREserverBTOKEN0002";
const PROFILE_TOKEN = "mul_FIXTUREprofileTOKEN0003";
const PAGE_TOKEN = "mul_FIXTUREpageTOKEN0004";
const ALL_TOKENS = [TOKEN_A, TOKEN_B, PROFILE_TOKEN, PAGE_TOKEN];

const until = (condition: () => boolean, timeout = 5000) => vi.waitFor(() => expect(condition()).toBe(true), { timeout, interval: 10 });
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

type Fixture = { server: FakeMulticaServer; webUrl: string };

async function startFake(token: string, userId: string, port: number): Promise<Fixture> {
	const server = await createFakeMulticaServer();
	server.addWorkspace({ id: "ws-1", slug: "acme", name: "Acme" });
	server.addWorkspace({ id: "ws-2", slug: "beta", name: "Beta" });
	server.addUser(token, { id: userId, name: `User ${userId}`, workspaceIds: ["ws-1", "ws-2"] });
	server.setIssues("ws-1", [
		fakeIssue({ id: "iss-1", identifier: "MUL-1", assignee_type: "agent", assignee_id: "agent-1", revision: 2 }),
		fakeIssue({ id: "iss-2", identifier: "MUL-2", assignee_type: "member", assignee_id: userId, revision: 1 }),
		fakeIssue({ id: "iss-3", identifier: "MUL-3", revision: 1 }),
	]);
	server.setTasks("ws-1", [fakeTask({ id: "task-1", issue_id: "iss-1", agent_id: "agent-1", status: "running" })]);
	server.setAgents("ws-1", [{ id: "agent-1", workspace_id: "ws-1", name: "Builder", runtime_id: "rt-1", instructions: "PRIVATE INSTRUCTIONS" }]);
	server.setRuntimes("ws-1", [{ id: "rt-1", workspace_id: "ws-1", provider: "claude", daemon_id: "d-1", status: "online", device_info: "PRIVATE DEVICE" }]);
	server.setIssues("ws-2", [fakeIssue({ id: "iss-20", workspace_id: "ws-2", identifier: "BET-1", assignee_type: "agent", assignee_id: "agent-2" })]);
	server.setTasks("ws-2", []);
	return { server, webUrl: `http://127.0.0.1:${port}` };
}

const vault: SecretVault = {
	isProtected: () => true,
	encrypt: (plain) => Buffer.from(`enc:${plain}`),
	decrypt: (blob) => blob.toString().replace(/^enc:/, ""),
};

type Harness = {
	awareness: MulticaAwareness;
	scheduler: FakeScheduler;
	dir: string;
	sent: Array<{ channel: string; payload: unknown }>;
	invoke: (channel: string, payload?: unknown, senderId?: number) => Promise<unknown>;
	cmd: (command: AwarenessCommand) => Promise<AwarenessCommandResult>;
	state: () => AwarenessState;
	serverState: (index?: number) => AwarenessServerState;
	profileReads: ReturnType<typeof vi.fn>;
	profile: { json: string | null };
	links: MulticaIssueLink[];
	navigated: string[];
	pageHost: { activeServerKey: string | null; token: string | null; slug: string | null };
	setEnv: (env: NodeJS.ProcessEnv) => void;
	rebuild: (overrides?: Partial<MulticaAwarenessOptions>) => Promise<void>;
};

async function createHarness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-awareness-"));
	const scheduler = createFakeScheduler();
	const handlers = new Map<string, (event: { sender: { id: number } }, payload: unknown) => unknown>();
	const sent: Harness["sent"] = [];
	const profileReads = vi.fn();
	const profile = { json: null as string | null };
	const links: MulticaIssueLink[] = [];
	const navigated: string[] = [];
	const pageHost: Harness["pageHost"] = { activeServerKey: null, token: null, slug: null };
	const credentials = createMulticaCredentials({
		stateDir: dir,
		vault,
		readProfileConfig: async (name) => {
			profileReads(name);
			return profile.json;
		},
	});
	const watchStore = createMulticaWatchConfigStore(dir);
	const actionLog = createMulticaActionLog(dir);
	let currentEnv = env;
	let awareness: MulticaAwareness | undefined;

	const build = async (overrides: Partial<MulticaAwarenessOptions> = {}) => {
		awareness?.dispose();
		handlers.clear();
		awareness = createMulticaAwareness({
			ipcMain: { handle: (channel, fn) => void handlers.set(channel, fn as never), removeHandler: (channel) => void handlers.delete(channel) },
			shellWebContents: { id: 1, isDestroyed: () => false, send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) },
			watchStore,
			credentials,
			actionLog,
			fetch: fetch as unknown as FetchLike,
			get env() {
				return currentEnv;
			},
			listLinks: async () => links,
			getHost: () => ({
				getServer: () => (pageHost.activeServerKey ? ({ key: pageHost.activeServerKey } as never) : null),
				navigatePath: (target: string) => {
					navigated.push(target);
					return true;
				},
				evaluateInPage: async (script: string, serverKey?: string) => {
					if (serverKey !== undefined && serverKey !== pageHost.activeServerKey) return undefined;
					const context = vm.createContext({
						localStorage: {
							getItem: (key: string) => (key === "multica_token" ? pageHost.token : key === "multica_tabs" ? JSON.stringify({ state: { activeWorkspaceSlug: pageHost.slug } }) : null),
						},
						document: { title: "x" },
						fetch,
						AbortController,
						setTimeout,
						clearTimeout,
						JSON,
					});
					return await vm.runInContext(script, context);
				},
			}),
			scheduler,
			random: () => 0.5,
			// Generous by default so the fake clock does not have to drive the read queue; the budget has its own tests.
			readBudget: { perMinute: 600_000, burst: 10_000 },
			...overrides,
		});
		await awareness.start();
	};
	await build();

	const invoke = async (channel: string, payload?: unknown, senderId = 1) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return await handler({ sender: { id: senderId } }, payload);
	};
	const harness: Harness = {
		get awareness() {
			return awareness as MulticaAwareness;
		},
		scheduler,
		dir,
		sent,
		invoke,
		cmd: (command) => invoke(MULTICA_AWARENESS_COMMAND_CHANNEL, command) as Promise<AwarenessCommandResult>,
		state: () => awareness!.getState(),
		serverState: (index = 0) => awareness!.getState().servers[index],
		profileReads,
		profile,
		links,
		navigated,
		pageHost,
		setEnv: (next) => {
			currentEnv = next;
		},
		rebuild: build,
	};
	return harness;
}

describe("multica awareness service", () => {
	let a: Fixture;
	let h: Harness;
	const keyA = () => `http://127.0.0.1:3001|${a.server.origin}`;

	beforeEach(async () => {
		a = await startFake(TOKEN_A, "user-a", 3001);
		h = await createHarness();
	});
	afterEach(async () => {
		h.awareness.dispose();
		expect(a.server.writes()).toEqual([]);
		await a.server.close();
		// A late log line or settings write may still be landing; retry the removal rather than racing it.
		await rm(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
	});

	/** Adds the fake server, gives it a pasted token and switches the server (not the workspaces) on. */
	async function connect(options: { source?: "pasted" | "profile" | "page"; master?: boolean } = {}): Promise<void> {
		expect(await h.cmd({ type: "addServer", mode: "local", customUrl: a.webUrl, apiUrl: a.server.origin })).toMatchObject({ ok: true });
		const source = options.source ?? "pasted";
		await h.cmd({ type: "setCredentialSource", serverKey: keyA(), source });
		if (source === "pasted") expect(await h.cmd({ type: "setToken", serverKey: keyA(), token: TOKEN_A })).toMatchObject({ ok: true });
		await h.cmd({ type: "setServerEnabled", serverKey: keyA(), enabled: true });
		if (options.master !== false) await h.cmd({ type: "setMaster", enabled: true });
	}
	const watch = async (workspaceId: string, on = true) => h.cmd({ type: "setWorkspaceWatch", serverKey: keyA(), workspaceId, watch: on });
	const live = (workspaceId = "ws-1") => h.serverState().workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.state === "live";

	describe("nothing is watched by default", () => {
		it("starts with everything off and sends no request", async () => {
			await settle(100);
			expect(h.state()).toMatchObject({ masterEnabled: false, servers: [], issues: [], runs: [] });
			expect(a.server.requests).toEqual([]);
			expect(a.server.connectionAttempts()).toBe(0);
		});

		it("does nothing for a configured server until the master switch is on", async () => {
			await connect({ master: false });
			await settle(100);
			expect(h.serverState().status).toBe("off");
			expect(a.server.requests).toEqual([]);
		});

		it("connects a switched-on server but opens no socket and reads no workspace until one is switched on", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			expect(h.serverState().meId).toBe("user-a");
			expect(h.serverState().workspaces.map((workspace) => [workspace.slug, workspace.watch, workspace.state])).toEqual([
				["acme", false, "idle"],
				["beta", false, "idle"],
			]);
			expect(a.server.connectionAttempts()).toBe(0);
			expect(a.server.requests.map((request) => request.path).sort()).toEqual(["/api/me", "/api/workspaces"]);
			expect(h.state().issues).toEqual([]);
		});

		it("watches only the workspaces the user switched on", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live("ws-1"));
			expect(a.server.liveSockets()).toBe(1);
			expect(a.server.liveSockets("ws-2")).toBe(0);
			expect(a.server.requests.some((request) => request.workspaceId === "ws-2")).toBe(false);
		});

		it("persists the choices and starts the same way after a restart", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			await h.rebuild();
			await until(() => live());
			expect(h.serverState().workspaces.find((workspace) => workspace.workspaceId === "ws-1")?.watch).toBe(true);
			expect(h.state().masterEnabled).toBe(true);
		});

		it("stops everything when the master switch is turned off", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			await h.cmd({ type: "setMaster", enabled: false });
			await until(() => a.server.liveSockets() === 0);
			expect(h.serverState().status).toBe("off");
			expect(h.state().issues).toEqual([]);
		});
	});

	describe("read model through the service", () => {
		beforeEach(async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
		});

		it("reconciles on connect: runs, agents, runtimes and the issues of interest, without private fields", async () => {
			const state = h.state();
			expect(state.runs.map((run) => [run.id, run.status, run.issueId, run.agentId])).toEqual([["task-1", "running", "iss-1", "agent-1"]]);
			expect(state.issues.map((issue) => issue.identifier).sort()).toEqual(["MUL-1", "MUL-2"]);
			expect(state.agents.map((agent) => agent.name)).toEqual(["Builder"]);
			expect(state.runtimes).toEqual([expect.objectContaining({ id: "rt-1", provider: "claude", daemonId: "d-1" })]);
			const json = JSON.stringify(state);
			for (const secret of ["PRIVATE", "work_dir", "/Users/someone"]) expect(json).not.toContain(secret);
		});

		it("applies task frames as they arrive", async () => {
			a.server.broadcast("ws-1", { type: "task:queued", payload: { task_id: "task-2", agent_id: "agent-1", issue_id: "iss-2", status: "queued" } });
			await until(() => h.state().runs.some((run) => run.id === "task-2"));
			a.server.broadcast("ws-1", { type: "task:running", payload: { task_id: "task-2", agent_id: "agent-1", issue_id: "iss-2", status: "running" } });
			await until(() => h.state().runs.find((run) => run.id === "task-2")?.status === "running");
			a.server.broadcast("ws-1", { type: "task:completed", payload: { task_id: "task-2", agent_id: "agent-1", issue_id: "iss-2", status: "completed" } });
			await until(() => h.state().runs.find((run) => run.id === "task-2")?.status === "completed");
		});

		it("applies issue frames by revision and drops one that is deleted", async () => {
			a.server.broadcast("ws-1", { type: "issue:updated", payload: { issue: fakeIssue({ id: "iss-2", identifier: "MUL-2", title: "Renamed", assignee_type: "member", assignee_id: "user-a", revision: 5, description: "PRIVATE UPDATE" }) } });
			await until(() => h.state().issues.find((issue) => issue.id === "iss-2")?.title === "Renamed");
			a.server.broadcast("ws-1", { type: "issue:updated", payload: { issue: fakeIssue({ id: "iss-2", identifier: "MUL-2", title: "Stale", assignee_type: "member", assignee_id: "user-a", revision: 4 }) } });
			await settle();
			expect(h.state().issues.find((issue) => issue.id === "iss-2")?.title).toBe("Renamed");
			expect(JSON.stringify(h.state())).not.toContain("PRIVATE");
			a.server.broadcast("ws-1", { type: "issue:deleted", payload: { issue_id: "iss-2" } });
			await until(() => !h.state().issues.some((issue) => issue.id === "iss-2"));
			expect(h.state().deleted).toEqual([{ serverKey: keyA(), workspaceId: "ws-1", identifier: "MUL-2" }]);
		});

		it("keeps no issue outside the interest set", async () => {
			a.server.broadcast("ws-1", { type: "issue:created", payload: { issue: fakeIssue({ id: "iss-9", identifier: "MUL-9", revision: 1 }) } });
			await settle(60);
			expect(h.state().issues.some((issue) => issue.id === "iss-9")).toBe(false);
		});

		it("ignores the high-volume frames", async () => {
			const before = JSON.stringify(h.state());
			a.server.broadcast("ws-1", { type: "task:message", payload: { task_id: "task-1", content: "PRIVATE MESSAGE" } });
			a.server.broadcast("ws-1", { type: "task:progress", payload: {} });
			await settle(60);
			expect(JSON.stringify(h.state())).toBe(before);
		});

		it("pushes state to the shell, throttled", async () => {
			const before = h.sent.length;
			for (let index = 0; index < 5; index += 1) {
				a.server.broadcast("ws-1", { type: "task:queued", payload: { task_id: `burst-${index}`, agent_id: "agent-1", issue_id: "iss-1", status: "queued" } });
			}
			await until(() => h.state().runs.filter((run) => run.id.startsWith("burst-")).length === 5);
			await h.scheduler.advance(300);
			const pushes = h.sent.slice(before).filter((entry) => entry.channel === MULTICA_AWARENESS_STATE_CHANNEL);
			expect(pushes.length).toBeGreaterThanOrEqual(1);
			expect(pushes.length).toBeLessThan(5);
			expect((pushes.at(-1)!.payload as AwarenessState).runs.filter((run) => run.id.startsWith("burst-"))).toHaveLength(5);
		});
	});

	describe("gap reconciliation after a reconnect", () => {
		it("converges on the server's truth by GET, with no replay", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			expect(h.state().runs.map((run) => run.status)).toEqual(["running"]);

			// While the socket is down: task-1 finishes (and drops out of the snapshot's active set), a new run starts, an issue changes.
			a.server.dropSockets();
			await until(() => h.serverState().workspaces[0].state === "backoff");
			a.server.setTasks("ws-1", [fakeTask({ id: "task-9", issue_id: "iss-2", agent_id: "agent-1", status: "queued" })]);
			a.server.setIssues("ws-1", [
				fakeIssue({ id: "iss-1", identifier: "MUL-1", assignee_type: "agent", assignee_id: "agent-1", revision: 3, status: "in_progress", status_category: "in_progress" }),
				fakeIssue({ id: "iss-2", identifier: "MUL-2", assignee_type: "member", assignee_id: "user-a", revision: 4 }),
			]);
			await h.scheduler.advance(1500);
			await until(() => live());
			await until(() => h.state().runs.some((run) => run.id === "task-9"));

			const runs = Object.fromEntries(h.state().runs.map((run) => [run.id, run]));
			expect(runs["task-9"].status).toBe("queued");
			// task-1 was active, is no longer listed: marked "ended, outcome unknown" and read once from the task-runs route.
			expect(runs["task-1"].outcomeUnknown || runs["task-1"].status !== "running").toBe(true);
			expect(h.state().issues.find((issue) => issue.id === "iss-1")).toMatchObject({ revision: 3, status: "in_progress" });
			expect(a.server.requestsTo("/api/agent-task-snapshot").length).toBeGreaterThanOrEqual(2);
		});

		it("applies frames that arrive during the reconcile, after the fetched state", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			const hold = a.server.hold("/api/agent-task-snapshot");
			await watch("ws-1");
			await until(() => hold.reached());
			// The socket is live and the snapshot is in flight: this frame is buffered, then applied over the fetched state.
			await until(() => a.server.liveSockets() === 1);
			a.server.broadcast("ws-1", { type: "task:queued", payload: { task_id: "task-late", agent_id: "agent-1", issue_id: "iss-2", status: "queued" } });
			await settle(60);
			expect(h.state().runs).toEqual([]);
			hold.release();
			await until(() => live());
			expect(h.state().runs.map((run) => run.id).sort()).toEqual(["task-1", "task-late"]);
		});

		it("does not let a buffered older frame move a run back after the snapshot", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			const hold = a.server.hold("/api/agent-task-snapshot");
			await watch("ws-1");
			await until(() => hold.reached());
			await until(() => a.server.liveSockets() === 1);
			a.server.broadcast("ws-1", { type: "task:queued", payload: { task_id: "task-1", agent_id: "agent-1", issue_id: "iss-1", status: "queued" } });
			await settle(60);
			hold.release();
			await until(() => live());
			expect(h.state().runs.find((run) => run.id === "task-1")?.status).toBe("running");
		});
	});

	describe("read budget and bounds", () => {
		it("reads at most 20 linked issues per reconcile", async () => {
			const identifiers = Array.from({ length: 30 }, (_, index) => `MUL-${100 + index}`);
			a.server.setIssues("ws-1", identifiers.map((identifier, index) => fakeIssue({ id: `iss-l${index}`, identifier, revision: 1 })));
			for (const identifier of identifiers) h.links.push({ sessionId: `s-${identifier}`, projectId: "p", workspaceSlug: "acme", issueIdentifier: identifier, createdAt: "2026-10-10T10:00:00Z", serverKey: keyA() });
			await h.rebuild();
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			const gets = a.server.requests.filter((request) => /^\/api\/issues\/MUL-/.test(request.path));
			expect(gets).toHaveLength(RECONCILE_LINKED_LIMIT);
			expect(h.state().issues.filter((issue) => issue.identifier.startsWith("MUL-1")).length).toBeGreaterThanOrEqual(RECONCILE_LINKED_LIMIT);
		});
	});

	describe("read budget", () => {
		it("sends at most ten reads at once and the rest only as the clock refills the bucket", async () => {
			const identifiers = Array.from({ length: 30 }, (_, index) => `MUL-${100 + index}`);
			a.server.setIssues("ws-1", identifiers.map((identifier, index) => fakeIssue({ id: `iss-l${index}`, identifier, revision: 1 })));
			for (const identifier of identifiers) h.links.push({ sessionId: `s-${identifier}`, projectId: "p", workspaceSlug: "acme", issueIdentifier: identifier, createdAt: "2026-10-10T10:00:00Z", serverKey: keyA() });
			await h.rebuild({ readBudget: undefined });
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => a.server.requests.filter((request) => request.path !== "/ws").length >= 10);
			await settle(80);
			expect(a.server.requests.filter((request) => request.path !== "/ws")).toHaveLength(10);
			expect(live()).toBe(false);
			// One more read per simulated second: the reconcile finishes as the clock moves, never faster than 60 a minute.
			await vi.waitFor(
				async () => {
					await h.scheduler.advance(1000);
					expect(live()).toBe(true);
				},
				{ timeout: 8000, interval: 20 },
			);
			// 2 server reads, 3 workspace reads, 3 issue lists and 20 linked issues: 28 in all, but never more than ten at once.
			expect(a.server.requests.filter((request) => request.path !== "/ws").length).toBeLessThanOrEqual(30);
		});
	});

	describe("socket cap", () => {
		it("refuses to watch more workspaces than maxSockets", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			expect(await h.cmd({ type: "setMaxSockets", value: 1 })).toMatchObject({ ok: true });
			expect(await watch("ws-1")).toMatchObject({ ok: true });
			expect(await watch("ws-2")).toEqual({ ok: false, reason: "socket_cap" });
			await until(() => live("ws-1"));
			expect(a.server.liveSockets()).toBe(1);
		});

		it("never opens more sockets than the cap even if the file asks for more", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await watch("ws-2");
			await until(() => live("ws-1") && live("ws-2"));
			await h.cmd({ type: "setMaxSockets", value: 1 });
			await until(() => a.server.liveSockets() === 1);
			expect(h.serverState().workspaces.filter((workspace) => workspace.watch)).toHaveLength(2);
			expect(h.serverState().workspaces.filter((workspace) => workspace.state === "live")).toHaveLength(1);
		});

		it("caps the setting itself at eight", async () => {
			expect(await h.cmd({ type: "setMaxSockets", value: 9 })).toEqual({ ok: false, reason: "invalid_request" });
			expect(await h.cmd({ type: "setMaxSockets", value: 8 })).toMatchObject({ ok: true });
		});

		it("opens at most eight sockets across servers", async () => {
			const workspaces = Array.from({ length: 9 }, (_, index) => ({ id: `w${index}`, slug: `w${index}`, name: `W${index}` }));
			for (const workspace of workspaces) a.server.addWorkspace(workspace);
			a.server.addUser(TOKEN_A, { id: "user-a", name: "A", workspaceIds: workspaces.map((workspace) => workspace.id) });
			await connect();
			await until(() => h.serverState().workspaces.length >= 9);
			const results: AwarenessCommandResult[] = [];
			for (const workspace of workspaces) results.push(await watch(workspace.id));
			expect(results.filter((result) => result.ok)).toHaveLength(8);
			expect(results.at(-1)).toEqual({ ok: false, reason: "socket_cap" });
			await until(() => a.server.liveSockets() === 8);
			expect(a.server.liveSockets()).toBeLessThanOrEqual(8);
		});
	});

	describe("credentials and consent", () => {
		it("does not read the CLI profile without consent and reports no credential", async () => {
			h.profile.json = JSON.stringify({ server_url: a.server.origin, token: PROFILE_TOKEN });
			a.server.addUser(PROFILE_TOKEN, { id: "user-a", name: "A", workspaceIds: ["ws-1", "ws-2"] });
			await connect({ source: "profile" });
			await until(() => h.serverState().status === "no_credential");
			expect(h.profileReads).not.toHaveBeenCalled();
			expect(a.server.requests).toEqual([]);
		});

		it("reads the profile after consent, sends its token only to that server, and stops again when consent is withdrawn", async () => {
			h.profile.json = JSON.stringify({ server_url: a.server.origin, token: PROFILE_TOKEN });
			a.server.addUser(PROFILE_TOKEN, { id: "user-a", name: "A", workspaces: [], workspaceIds: ["ws-1", "ws-2"] } as never);
			await connect({ source: "profile" });
			await until(() => h.serverState().status === "no_credential");
			await h.cmd({ type: "grantConsent", serverKey: keyA() });
			await until(() => h.serverState().status === "live");
			expect(h.profileReads).toHaveBeenCalled();
			expect(a.server.requests.every((request) => request.authorization === `Bearer ${PROFILE_TOKEN}`)).toBe(true);
			await watch("ws-1");
			await until(() => live());
			await h.cmd({ type: "revokeConsent", serverKey: keyA() });
			await until(() => a.server.liveSockets() === 0);
			expect(h.serverState().status).toBe("no_credential");
		});

		it("refuses a profile that records another server", async () => {
			h.profile.json = JSON.stringify({ server_url: "https://api.other.example", token: PROFILE_TOKEN });
			await connect({ source: "profile" });
			await h.cmd({ type: "grantConsent", serverKey: keyA() });
			await until(() => h.serverState().status === "no_credential");
			expect(a.server.requests).toEqual([]);
		});

		it("never exposes a token in the state, the pushes, the settings file or the action log", async () => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			a.server.revokeToken(TOKEN_A);
			await until(() => h.serverState().status === "signed_out");
			await h.scheduler.advance(400);
			const everything = JSON.stringify([h.state(), h.sent, await h.invoke(MULTICA_ACTION_LOG_READ_CHANNEL, {})]);
			const files = await Promise.all((await readdir(h.dir)).filter((name) => !name.startsWith("multica-credentials")).map((name) => readFile(path.join(h.dir, name), "utf8")));
			for (const token of ALL_TOKENS) {
				expect(everything).not.toContain(token);
				for (const content of files) expect(content).not.toContain(token);
				for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
			}
			// The pasted token is stored only in the encrypted credentials file.
			const credentialsFile = await readFile(path.join(h.dir, "multica-credentials.json"), "utf8");
			expect(credentialsFile).toContain(Buffer.from(`enc:${TOKEN_A}`).toString("base64"));
			vi.restoreAllMocks();
		});

		it("restarts only that server when its credential changes and drops the old token", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			const attemptsBefore = a.server.connectionAttempts();
			a.server.addUser(TOKEN_B, { id: "user-a", name: "A", workspaceIds: ["ws-1", "ws-2"] });
			await h.cmd({ type: "setToken", serverKey: keyA(), token: TOKEN_B });
			await until(() => a.server.connectionAttempts() > attemptsBefore && live());
			expect(a.server.authTokens().at(-1)).toBe(TOKEN_B);
			a.server.revokeToken(TOKEN_A);
			await settle(60);
			expect(h.serverState().status).not.toBe("signed_out");
		});
	});

	describe("401 stops reconnecting", () => {
		it("moves the server to signed_out without a retry storm until the credential changes", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			a.server.revokeToken(TOKEN_A);
			await until(() => h.serverState().status === "signed_out");
			const attempts = a.server.connectionAttempts();
			const requests = a.server.requests.length;
			await h.scheduler.advance(60 * 60_000);
			await settle(100);
			expect(a.server.connectionAttempts()).toBe(attempts);
			expect(a.server.requests.length).toBe(requests);
			expect(a.server.liveSockets()).toBe(0);
			const log = (await h.invoke(MULTICA_ACTION_LOG_READ_CHANNEL, { kind: "signed_out" })) as MulticaActionRecord[];
			expect(log).toHaveLength(1);
			expect(log[0]).toMatchObject({ kind: "signed_out", serverKey: keyA(), direction: "local", actor: "system" });

			a.server.addUser(TOKEN_B, { id: "user-a", name: "A", workspaceIds: ["ws-1", "ws-2"] });
			await h.cmd({ type: "setToken", serverKey: keyA(), token: TOKEN_B });
			await until(() => h.serverState().status === "live" && live());
		});

		it("reports signed_out when the first request is refused", async () => {
			await h.cmd({ type: "addServer", mode: "local", customUrl: a.webUrl, apiUrl: a.server.origin });
			await h.cmd({ type: "setCredentialSource", serverKey: keyA(), source: "pasted" });
			await h.cmd({ type: "setToken", serverKey: keyA(), token: "mul_FIXTUREwrongTOKEN0009" });
			await h.cmd({ type: "setServerEnabled", serverKey: keyA(), enabled: true });
			await h.cmd({ type: "setMaster", enabled: true });
			await until(() => h.serverState().status === "signed_out");
			await h.scheduler.advance(30 * 60_000);
			expect(a.server.requests.filter((request) => request.path === "/api/me")).toHaveLength(1);
		});

		it("backs off while the server is unreachable instead of hammering it", async () => {
			a.server.failNext("/api/me", { status: 503, count: 100 });
			await connect();
			await until(() => h.serverState().status === "unreachable");
			for (let step = 0; step < 6; step += 1) {
				await h.scheduler.advance(10 * 60_000);
				await settle(20);
			}
			expect(a.server.requestsTo("/api/me").length).toBeLessThanOrEqual(10);
		});
	});

	describe("per-server isolation", () => {
		it("sends each server only its own token and cancels only the server that is switched off", async () => {
			const b = await startFake(TOKEN_B, "user-b", 3002);
			try {
				const keyB = `http://127.0.0.1:3002|${b.server.origin}`;
				await connect();
				await h.cmd({ type: "addServer", mode: "local", customUrl: b.webUrl, apiUrl: b.server.origin });
				await h.cmd({ type: "setCredentialSource", serverKey: keyB, source: "pasted" });
				await h.cmd({ type: "setToken", serverKey: keyB, token: TOKEN_B });
				await h.cmd({ type: "setServerEnabled", serverKey: keyB, enabled: true });
				await until(() => h.serverState(0).status === "live" && h.serverState(1).status === "live");
				await watch("ws-1");
				await h.cmd({ type: "setWorkspaceWatch", serverKey: keyB, workspaceId: "ws-1", watch: true });
				await until(() => a.server.liveSockets() === 1 && b.server.liveSockets() === 1);

				for (const request of a.server.requests) if (request.authorization) expect(request.authorization).toBe(`Bearer ${TOKEN_A}`);
				for (const request of b.server.requests) if (request.authorization) expect(request.authorization).toBe(`Bearer ${TOKEN_B}`);
				expect(a.server.authTokens().every((token) => token === TOKEN_A)).toBe(true);
				expect(b.server.authTokens().every((token) => token === TOKEN_B)).toBe(true);
				// Their models are separate.
				expect(new Set(h.state().issues.map((issue) => issue.serverKey))).toEqual(new Set([keyA(), keyB]));

				const attemptsB = b.server.connectionAttempts();
				await h.cmd({ type: "setServerEnabled", serverKey: keyA(), enabled: false });
				await until(() => a.server.liveSockets() === 0);
				expect(b.server.liveSockets()).toBe(1);
				expect(b.server.connectionAttempts()).toBe(attemptsB);
				expect(h.state().issues.every((issue) => issue.serverKey === keyB)).toBe(true);
				expect(b.server.writes()).toEqual([]);
			} finally {
				await b.server.close();
			}
		});

		it("a 401 on one server leaves the other live", async () => {
			const b = await startFake(TOKEN_B, "user-b", 3002);
			try {
				const keyB = `http://127.0.0.1:3002|${b.server.origin}`;
				await connect();
				await h.cmd({ type: "addServer", mode: "local", customUrl: b.webUrl, apiUrl: b.server.origin });
				await h.cmd({ type: "setCredentialSource", serverKey: keyB, source: "pasted" });
				await h.cmd({ type: "setToken", serverKey: keyB, token: TOKEN_B });
				await h.cmd({ type: "setServerEnabled", serverKey: keyB, enabled: true });
				await watch("ws-1");
				await h.cmd({ type: "setWorkspaceWatch", serverKey: keyB, workspaceId: "ws-1", watch: true });
				await until(() => a.server.liveSockets() === 1 && b.server.liveSockets() === 1);
				a.server.revokeToken(TOKEN_A);
				await until(() => h.serverState(0).status === "signed_out");
				expect(h.serverState(1).status).toBe("live");
				expect(b.server.liveSockets()).toBe(1);
			} finally {
				await b.server.close();
			}
		});
	});

	describe("page-only mode (T1)", () => {
		it("reads through the page, holds no token and watches only the page's workspace", async () => {
			a.server.addUser(PAGE_TOKEN, { id: "user-a", name: "A", workspaceIds: ["ws-1", "ws-2"] });
			h.pageHost.activeServerKey = keyA();
			h.pageHost.token = PAGE_TOKEN;
			h.pageHost.slug = "acme";
			await connect({ source: "page" });
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await watch("ws-2");
			await until(() => h.state().runs.some((run) => run.id === "task-1"));
			const workspaces = h.serverState().workspaces;
			expect(workspaces.find((workspace) => workspace.workspaceId === "ws-1")).toMatchObject({ transport: "page", state: "live" });
			expect(workspaces.find((workspace) => workspace.workspaceId === "ws-2")?.state).toBe("idle");
			expect(a.server.connectionAttempts()).toBe(0);
			expect(h.profileReads).not.toHaveBeenCalled();
			expect(a.server.requests.every((request) => request.authorization === `Bearer ${PAGE_TOKEN}`)).toBe(true);
			expect(await readFile(path.join(h.dir, "multica-watch.json"), "utf8")).not.toContain(PAGE_TOKEN);
		});

		it("pauses while the page shows another server", async () => {
			h.pageHost.activeServerKey = "cloud";
			h.pageHost.token = PAGE_TOKEN;
			await connect({ source: "page" });
			await until(() => h.serverState().status === "paused");
			expect(a.server.requests).toEqual([]);
		});
	});

	describe("executor lookup and opening an issue", () => {
		it("finds an issue by identifier with its agent names, and refuses an ambiguous identifier", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			expect(h.awareness.lookup(keyA(), "mul-1")).toMatchObject({ issue: { id: "iss-1" }, agentNames: ["Builder"], meId: "user-a" });
			expect(h.awareness.lookup(keyA(), "MUL-3")).toBeNull();
			expect(h.awareness.lookup("cloud", "MUL-1")).toBeNull();
			a.server.setIssues("ws-2", [fakeIssue({ id: "iss-dup", workspace_id: "ws-2", identifier: "MUL-1", assignee_type: "agent", assignee_id: "agent-2" })]);
			await watch("ws-2");
			await until(() => live("ws-2"));
			expect(h.awareness.lookup(keyA(), "MUL-1")).toBeNull();
		});

		it("opens an issue only on the selected server with a valid reference", async () => {
			await connect();
			const open = (payload: unknown) => h.invoke(MULTICA_AWARENESS_OPEN_ISSUE_CHANNEL, payload);
			h.pageHost.activeServerKey = keyA();
			expect(await open({ serverKey: keyA(), workspaceSlug: "Acme", identifier: "MUL-0" })).toBe(false);
			expect(await open({ serverKey: keyA(), workspaceSlug: "Acme", identifier: "MUL-1" })).toBe(true);
			expect(h.navigated).toEqual(["/acme/issues/MUL-1"]);
			expect(await open({ serverKey: "cloud", workspaceSlug: "acme", identifier: "MUL-1" })).toBe(false);
			expect(await open({ serverKey: keyA(), workspaceSlug: "../x", identifier: "MUL-1" })).toBe(false);
			expect(await open({ serverKey: keyA(), workspaceSlug: "acme" })).toBe(false);
		});
	});

	describe("IPC and the kill switch", () => {
		it("serves only the shell and accepts only well-formed commands", async () => {
			expect(await h.invoke(MULTICA_AWARENESS_GET_STATE_CHANNEL, undefined, 99)).toMatchObject({ servers: [], masterEnabled: false });
			expect(await h.invoke(MULTICA_AWARENESS_COMMAND_CHANNEL, { type: "setMaster", enabled: true }, 99)).toEqual({ ok: false, reason: "invalid_request" });
			expect(h.state().masterEnabled).toBe(false);
			for (const bad of [{ type: "request", path: "/api/issues" }, { type: "setMaster" }, null, "setMaster"]) {
				expect(await h.invoke(MULTICA_AWARENESS_COMMAND_CHANNEL, bad)).toEqual({ ok: false, reason: "invalid_request" });
			}
			expect(await h.invoke(MULTICA_ACTION_LOG_READ_CHANNEL, {}, 99)).toEqual([]);
			expect(await h.cmd({ type: "setServerEnabled", serverKey: "nope", enabled: true })).toEqual({ ok: false, reason: "unknown_server" });
			expect(await h.cmd({ type: "addServer", mode: "local", customUrl: "http://example.com", apiUrl: "" })).toEqual({ ok: false, reason: "invalid_server" });
		});

		it("AO_MULTICA_WATCH=0 starts nothing and refuses to switch anything on", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await h.rebuild();
			h.setEnv({ AO_MULTICA_WATCH: "0" });
			await h.rebuild();
			expect(h.state().killSwitch).toBe(true);
			expect(h.serverState().status).toBe("off");
			const requests = a.server.requests.length;
			expect(await h.cmd({ type: "setMaster", enabled: true })).toEqual({ ok: false, reason: "kill_switch" });
			expect(await watch("ws-1")).toEqual({ ok: false, reason: "kill_switch" });
			await settle(80);
			expect(a.server.requests.length).toBe(requests);
		});
	});

	describe("action log", () => {
		it("records settings changes and connection lifecycle, never a token", async () => {
			await connect();
			await until(() => h.serverState().status === "live");
			await watch("ws-1");
			await until(() => live());
			const log = (await h.invoke(MULTICA_ACTION_LOG_READ_CHANNEL, {})) as MulticaActionRecord[];
			const kinds = log.map((entry) => entry.kind);
			expect(kinds).toContain("setting_changed");
			expect(kinds).toContain("connect");
			const triggers = log.filter((entry) => entry.kind === "setting_changed").map((entry) => entry.trigger);
			expect(triggers).toEqual(expect.arrayContaining(["setMaster:true", "setServerEnabled:true", "setCredentialSource:pasted", "setToken", "setWorkspaceWatch:true"]));
			expect(JSON.stringify(log)).not.toContain(TOKEN_A);
			// Every record of this layer is local, and none is a write toward Multica.
			expect(log.every((entry) => entry.direction === "local")).toBe(true);
		});
	});
});
