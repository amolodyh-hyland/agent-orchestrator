import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SOCKET_BACKOFF_MAX_MS,
	SOCKET_DEAD_AFTER_MS,
	createWorkspaceSocket,
	isNoisyFrame,
	reconnectDelayMs,
	type WorkspaceSocket,
	type WorkspaceSocketState,
	type WorkspaceSocketStop,
} from "./multica-ws-client";
import { createFakeScheduler, type FakeScheduler } from "./test-support/fake-scheduler";
import { createFakeMulticaServer, type FakeMulticaServer } from "./test-support/multica-fake-server";

const TOKEN = "mul_FIXTUREwsClientTOKEN0001";
const until = (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 4000, interval: 10 });

describe("reconnect delay", () => {
	it("doubles from 1 s to 60 s with 50 to 150 percent jitter", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => reconnectDelayMs(attempt, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
		expect(reconnectDelayMs(1, 0)).toBe(500);
		expect(reconnectDelayMs(1, 1)).toBe(1500);
		expect(reconnectDelayMs(20, 1)).toBe(SOCKET_BACKOFF_MAX_MS * 1.5);
		for (let sample = 0; sample < 100; sample += 1) {
			const delay = reconnectDelayMs(3, Math.random());
			expect(delay).toBeGreaterThanOrEqual(2000);
			expect(delay).toBeLessThanOrEqual(6000);
		}
	});
});

describe("noisy frame filter", () => {
	it("recognises the high-volume frames by their suffix", () => {
		expect(isNoisyFrame('{"actor_id":"","actor_type":"system","payload":{"task_id":"t"},"type":"task:message"}')).toBe(true);
		expect(isNoisyFrame('{"actor_id":"","actor_type":"system","payload":{},"type":"task:progress"}')).toBe(true);
		expect(isNoisyFrame('{"actor_id":"","actor_type":"system","payload":{},"type":"daemon:heartbeat"}')).toBe(true);
		expect(isNoisyFrame('{"actor_id":"","actor_type":"system","payload":{},"type":"task:running"}')).toBe(false);
		expect(isNoisyFrame('{"payload":{"x":"\\"type\\":\\"task:message\\"}"},"type":"issue:updated"}')).toBe(false);
	});
});

describe("workspace socket", () => {
	let server: FakeMulticaServer;
	let scheduler: FakeScheduler;
	let sockets: WorkspaceSocket[];
	let frames: string[];
	let states: Array<[WorkspaceSocketState, number]>;
	let stops: WorkspaceSocketStop[];
	let lives: number;

	beforeEach(async () => {
		server = await createFakeMulticaServer();
		server.addWorkspace({ id: "ws-1", slug: "acme", name: "Acme" });
		server.addUser(TOKEN, { id: "user-1", name: "Fixture", workspaceIds: ["ws-1"] });
		scheduler = createFakeScheduler();
		sockets = [];
		frames = [];
		states = [];
		stops = [];
		lives = 0;
	});
	afterEach(async () => {
		for (const socket of sockets) socket.stop();
		await server.close();
	});

	const open = (overrides: { token?: string | null; workspaceId?: string; wsUrl?: string } = {}) => {
		const socket = createWorkspaceSocket({
			wsUrl: overrides.wsUrl ?? server.wsUrl,
			workspaceId: overrides.workspaceId ?? "ws-1",
			getToken: () => (overrides.token === undefined ? TOKEN : overrides.token),
			onFrame: (raw) => frames.push(raw),
			onLive: () => {
				lives += 1;
			},
			onState: (state, attempt) => states.push([state, attempt]),
			onStop: (reason) => stops.push(reason),
			scheduler,
			random: () => 0.5,
		});
		sockets.push(socket);
		socket.start();
		return socket;
	};

	it("authenticates with the token as the first frame and never puts it in the URL or an Origin header", async () => {
		open();
		await until(() => lives === 1);
		expect(server.authTokens()).toEqual([TOKEN]);
		const [upgrade] = server.requests;
		expect(upgrade.query).toEqual({ workspace_id: "ws-1" });
		expect(JSON.stringify(upgrade)).not.toContain(TOKEN);
		expect(upgrade.origin).toBeUndefined();
		expect(states.map(([state]) => state)).toEqual(["connecting", "authenticating", "live"]);
	});

	it("delivers frames and drops the noisy ones before they reach the caller", async () => {
		open();
		await until(() => lives === 1);
		server.broadcast("ws-1", { type: "task:message", payload: { task_id: "t", content: "PRIVATE" } });
		server.broadcast("ws-1", { type: "task:progress" });
		server.broadcast("ws-1", { type: "daemon:heartbeat" });
		server.broadcast("ws-1", { type: "task:running", payload: { task_id: "t1" } });
		await until(() => frames.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0]).type).toBe("task:running");
		expect(frames.join("")).not.toContain("PRIVATE");
	});

	it("reconnects after a drop with a delay that doubles, and goes live again each time", async () => {
		open();
		await until(() => lives === 1);
		server.dropSockets();
		await until(() => states.at(-1)?.[0] === "backoff");
		expect(states.at(-1)).toEqual(["backoff", 1]);
		await scheduler.advance(900);
		expect(server.connectionAttempts()).toBe(1);
		await scheduler.advance(200);
		await until(() => lives === 2);
		expect(server.connectionAttempts()).toBe(2);

		// Dropped again within two minutes: the attempt counter keeps climbing.
		server.dropSockets();
		await until(() => states.at(-1)?.[0] === "backoff");
		expect(states.at(-1)).toEqual(["backoff", 2]);
		await scheduler.advance(1900);
		expect(server.connectionAttempts()).toBe(2);
		await scheduler.advance(200);
		await until(() => lives === 3);
	});

	it("resets the back-off after two minutes live", async () => {
		open();
		await until(() => lives === 1);
		server.dropSockets();
		await until(() => states.at(-1)?.[0] === "backoff");
		await scheduler.advance(1100);
		await until(() => lives === 2);
		// The real server pings every 54 s; stand in for that with a frame per step so the connection is not judged dead.
		for (let step = 0; step < 5; step += 1) {
			await scheduler.advance(25_000);
			const before = frames.length;
			server.broadcast("ws-1", { type: "task:running", payload: { task_id: "t" } });
			await until(() => frames.length === before + 1);
		}
		server.dropSockets();
		await until(() => states.at(-1)?.[0] === "backoff" && states.at(-1)?.[1] === 1);
		expect(states.at(-1)).toEqual(["backoff", 1]);
	});

	it("keeps a server that refuses connections at a bounded retry rate", async () => {
		server.rejectUpgrades(500);
		open();
		await until(() => states.at(-1)?.[0] === "backoff");
		for (let step = 0; step < 12; step += 1) {
			await scheduler.advance(SOCKET_BACKOFF_MAX_MS * 1.5);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(server.connectionAttempts()).toBeLessThanOrEqual(14);
		expect(stops).toEqual([]);
	});

	it("stops for good on an invalid token and never retries", async () => {
		open({ token: "mul_WRONG000000000000" });
		await until(() => stops.length === 1);
		expect(stops).toEqual(["unauthorized"]);
		expect(states.at(-1)?.[0]).toBe("stopped");
		await scheduler.advance(30 * 60_000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(server.connectionAttempts()).toBe(1);
	});

	it("stops for good when the token is revoked while live", async () => {
		open();
		await until(() => lives === 1);
		server.revokeToken(TOKEN);
		await until(() => stops.length === 1);
		expect(stops).toEqual(["unauthorized"]);
		await scheduler.advance(30 * 60_000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(server.connectionAttempts()).toBe(1);
	});

	it("stops this workspace when the user is not a member", async () => {
		server.addWorkspace({ id: "ws-2", slug: "other", name: "Other" });
		open({ workspaceId: "ws-2" });
		await until(() => stops.length === 1);
		expect(stops).toEqual(["no_access"]);
		await scheduler.advance(10 * 60_000);
		expect(server.connectionAttempts()).toBe(1);
	});

	it("maps an HTTP refusal of the upgrade to a stop reason", async () => {
		for (const [status, reason] of [[401, "unauthorized"], [403, "no_access"], [404, "gone"]] as const) {
			stops = [];
			server.rejectUpgrades(status);
			const socket = open();
			await until(() => stops.length === 1);
			expect(stops).toEqual([reason]);
			socket.stop();
		}
	});

	it("does not connect without a token", async () => {
		open({ token: null });
		await until(() => stops.length === 1);
		expect(stops).toEqual(["unauthorized"]);
		expect(server.connectionAttempts()).toBe(0);
	});

	it("treats a socket that goes silent for two minutes as dead and reconnects", async () => {
		server.holdAuth(true);
		open();
		await until(() => server.connectionAttempts() === 1);
		await scheduler.advance(SOCKET_DEAD_AFTER_MS - 1000);
		expect(server.connectionAttempts()).toBe(1);
		await scheduler.advance(2000);
		expect(states.map(([state]) => state)).toContain("backoff");
		await scheduler.advance(1500);
		await until(() => server.connectionAttempts() === 2);
	});

	it("reconnects after an oversize frame closes the socket", async () => {
		open();
		await until(() => lives === 1);
		server.broadcastRaw("ws-1", "x".repeat(2 * 1024 * 1024));
		await until(() => states.at(-1)?.[0] === "backoff");
		await scheduler.advance(1500);
		await until(() => lives === 2);
		expect(frames).toEqual([]);
	});

	it("stays quiet after stop()", async () => {
		const socket = open();
		await until(() => lives === 1);
		socket.stop();
		const seen = states.length;
		server.dropSockets();
		await scheduler.advance(10 * 60_000);
		expect(states).toHaveLength(seen);
		expect(socket.state()).toBe("stopped");
		expect(server.connectionAttempts()).toBe(1);
	});
});
