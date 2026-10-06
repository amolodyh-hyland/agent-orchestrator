// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_BUSY_MESSAGE, type MulticaDaemonService } from "./multica-daemon-cli";
import {
	createHostedMulticaDaemonControl,
	createModeAwareMulticaDaemonService,
	hostedMulticaCliEnv,
	isMulticaHostingEnabled,
	mapHostedStatus,
	type HostedMulticaDaemonControl,
	type HostedMulticaDaemonStatus,
} from "./multica-daemon-hosted";

function response(status: number, body: unknown) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeCli(): MulticaDaemonService {
	return {
		getStatus: vi.fn(async () => ({ state: "stopped" as const })),
		start: vi.fn(async () => ({ success: true })),
		stop: vi.fn(async () => ({ success: true })),
		restart: vi.fn(async () => ({ success: true })),
		isInstalled: vi.fn(async () => false),
		refreshBinary: vi.fn(),
		probeRuntimes: vi.fn(async () => ({ probeResult: "error" as const })),
		startLogStream: vi.fn(),
		stopLogStream: vi.fn(),
		startPolling: vi.fn(),
		dispose: vi.fn(),
	};
}

function fakeHosted(status: HostedMulticaDaemonStatus = { state: "stopped" }): HostedMulticaDaemonControl {
	return {
		getStatus: vi.fn(async () => status),
		start: vi.fn(async () => ({ success: true })),
		stop: vi.fn(async () => ({ success: true })),
		restart: vi.fn(async () => ({ success: true })),
	};
}

describe("isMulticaHostingEnabled and daemon environment", () => {
	it.each(["1", " true ", "ON", "TrUe"])('enables hosting for "%s"', (value) => {
		expect(isMulticaHostingEnabled({ AO_MULTICA_DAEMON: value })).toBe(true);
	});

	it.each([undefined, "", "0", "yes", " off "])('does not enable hosting for %j', (value) => {
		expect(isMulticaHostingEnabled({ AO_MULTICA_DAEMON: value })).toBe(false);
	});

	it("adds a found CLI path only when hosting is enabled and no override is set", () => {
		const findBinary = vi.fn(() => "/opt/multica");
		expect(hostedMulticaCliEnv({ AO_MULTICA_DAEMON: "1" }, findBinary)).toEqual({ AO_MULTICA_CLI: "/opt/multica" });
		expect(findBinary).toHaveBeenCalledTimes(1);
		expect(hostedMulticaCliEnv({ AO_MULTICA_DAEMON: "0" }, findBinary)).toEqual({});
		expect(hostedMulticaCliEnv({ AO_MULTICA_DAEMON: "on", AO_MULTICA_CLI: "/chosen/multica" }, findBinary)).toEqual({});
		expect(hostedMulticaCliEnv({ AO_MULTICA_DAEMON: "on" }, () => null)).toEqual({});
	});
});

describe("mapHostedStatus", () => {
	it.each([
		["disabled", "stopped", undefined],
		["stopped", "stopped", undefined],
		["starting", "starting", undefined],
		["running", "running", undefined],
		["backoff", "starting", undefined],
		["failed", "stopped", undefined],
		["external", "running", true],
	] as const)("maps %s to %s", (state, expected, externallyManaged) => {
		const status = mapHostedStatus({ state });
		expect(status.state).toBe(expected);
		if (externallyManaged) expect(status.externallyManaged).toBe(true);
		else expect(status).not.toHaveProperty("externallyManaged");
	});

	it("maps health fields, sanitizes agents, and computes compact uptime", () => {
		const agents = ["Claude", "valid_name-2", "bad provider", ...Array.from({ length: 70 }, (_, index) => `agent-${index}`)];
		const status = mapHostedStatus(
			{
				state: "running",
				pid: 42,
				profile: "desktop-localhost",
				startedAt: "2025-01-01T00:00:00.000Z",
				health: {
					daemonId: "daemon-1",
					deviceName: "laptop",
					serverUrl: "http://localhost:3000",
					agents,
					workspaceCount: 3,
				},
			},
			Date.parse("2025-01-01T01:02:03.000Z"),
		);

		expect(status).toMatchObject({
			state: "running",
			pid: 42,
			profile: "desktop-localhost",
			daemonId: "daemon-1",
			deviceName: "laptop",
			serverUrl: "http://localhost:3000",
			workspaceCount: 3,
			uptime: "1h2m3s",
		});
		expect(status.agents).toHaveLength(64);
		expect(status.agents?.slice(0, 2)).toEqual(["Claude", "valid_name-2"]);
		expect(status.agents).not.toContain("bad provider");
	});

	it("omits an invalid start time and formats exact hours compactly", () => {
		expect(mapHostedStatus({ state: "running", startedAt: "not a date" })).not.toHaveProperty("uptime");
		expect(mapHostedStatus({ state: "running", startedAt: "2025-01-01T00:00:00Z" }, Date.parse("2025-01-01T01:00:00Z")).uptime).toBe("1h");
	});
});

describe("createHostedMulticaDaemonControl", () => {
	it("uses the status and action routes with their respective timeouts", async () => {
		const calls: Array<[string, string | undefined, number]> = [];
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400/",
			timeoutMs: 75_000,
			fetchJson: async (url, init, timeoutMs) => {
				calls.push([url, init.method, timeoutMs]);
				return response(200, { daemon: { state: "running", pid: 23 } });
			},
		});

		expect(await control.getStatus()).toEqual({ state: "running", pid: 23 });
		expect(await control.start()).toEqual({ success: true });
		expect(await control.stop()).toEqual({ success: true });
		expect(await control.restart()).toEqual({ success: true });
		expect(calls).toEqual([
			["http://127.0.0.1:4400/api/v1/multica/status", "GET", 5_000],
			["http://127.0.0.1:4400/api/v1/multica/start", "POST", 75_000],
			["http://127.0.0.1:4400/api/v1/multica/stop", "POST", 75_000],
			["http://127.0.0.1:4400/api/v1/multica/restart", "POST", 75_000],
		]);
	});

	it("returns stopped status and not-ready action errors without a base URL", async () => {
		const fetchJson = vi.fn();
		const control = createHostedMulticaDaemonControl({ baseUrl: () => null, fetchJson });

		expect(await control.getStatus()).toEqual({ state: "stopped" });
		for (const action of [control.start, control.stop, control.restart]) {
			expect(await action()).toEqual({ success: false, error: "The AO daemon is not ready." });
		}
		expect(fetchJson).not.toHaveBeenCalled();
	});

	it.each([
		[
			409,
			"MULTICA_DISABLED",
			"Multica daemon hosting is disabled",
			"The running AO daemon was started without Multica hosting. Restart AO with Multica hosting enabled.",
		],
		[
			409,
			"MULTICA_EXTERNAL",
			"An external Multica daemon is using the profile",
			"A Multica daemon outside AO is running; stop it from where you started it.",
		],
		[503, "MULTICA_UNAVAILABLE", "supervisor is starting", "supervisor is starting"],
	] as const)("maps HTTP %i %s errors", async (status, code, message, expected) => {
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async () => response(status, { error: { code, message } }),
		});

		expect(await control.start()).toEqual({ success: false, error: expected });
	});

	it("uses a short fallback for 503 and preserves other server messages", async () => {
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async () => response(503, {}),
		});
		expect(await control.start()).toEqual({ success: false, error: "The Multica daemon is temporarily unavailable." });
	});

	it.each([
		[new Error("socket closed"), "Unable to reach the AO daemon."],
		[Object.assign(new Error("aborted"), { name: "AbortError" }), "The AO daemon request timed out."],
	])("returns a short network or timeout error", async (error, expected) => {
		const control = createHostedMulticaDaemonControl({ baseUrl: () => "http://127.0.0.1:4400", fetchJson: async () => { throw error; } });
		expect(await control.restart()).toEqual({ success: false, error: expected });
	});

	it("serializes hosted lifecycle actions across control instances", async () => {
		let resolveFirst: ((value: ReturnType<typeof response>) => void) | undefined;
		const first = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: () => new Promise((resolve) => { resolveFirst = resolve; }),
		});
		const second = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async () => response(200, {}),
		});

		const pending = first.start();
		expect(await second.stop()).toEqual({ success: false, error: DAEMON_BUSY_MESSAGE });
		resolveFirst?.(response(200, {}));
		expect(await pending).toEqual({ success: true });
	});
});

describe("createModeAwareMulticaDaemonService", () => {
	afterEach(() => vi.useRealTimers());

	it("delegates every method to the CLI when hosting is off", async () => {
		const cli = fakeCli();
		const hosted = fakeHosted();
		const service = createModeAwareMulticaDaemonService({ cli, hosted, hostingEnabled: () => false, emit: vi.fn() });

		await service.getStatus();
		await service.start();
		await service.stop();
		await service.restart();
		await service.isInstalled();
		await service.probeRuntimes();
		service.refreshBinary();
		service.startLogStream();
		service.stopLogStream();
		service.startPolling();
		service.dispose();

		expect(cli.getStatus).toHaveBeenCalledOnce();
		expect(cli.start).toHaveBeenCalledOnce();
		expect(cli.stop).toHaveBeenCalledOnce();
		expect(cli.restart).toHaveBeenCalledOnce();
		expect(cli.isInstalled).toHaveBeenCalledOnce();
		expect(cli.probeRuntimes).toHaveBeenCalledOnce();
		expect(cli.refreshBinary).toHaveBeenCalledOnce();
		expect(cli.startLogStream).toHaveBeenCalledOnce();
		expect(cli.stopLogStream).toHaveBeenCalledOnce();
		expect(cli.startPolling).toHaveBeenCalledOnce();
		expect(cli.dispose).toHaveBeenCalledOnce();
		expect(hosted.getStatus).not.toHaveBeenCalled();
		expect(hosted.start).not.toHaveBeenCalled();
		expect(hosted.stop).not.toHaveBeenCalled();
		expect(hosted.restart).not.toHaveBeenCalled();
	});

	it("uses the hosted control and keeps CLI log and binary helpers", async () => {
		const cli = fakeCli();
		const hosted = fakeHosted({ state: "running", pid: 9, health: { agents: ["claude", "codex"] } });
		const service = createModeAwareMulticaDaemonService({ cli, hosted, hostingEnabled: () => true, emit: vi.fn() });

		expect(await service.getStatus()).toMatchObject({ state: "running", pid: 9 });
		expect(await service.start()).toEqual({ success: true });
		expect(await service.stop()).toEqual({ success: true });
		expect(await service.restart()).toEqual({ success: true });
		expect(await service.isInstalled()).toBe(true);
		expect(await service.probeRuntimes()).toMatchObject({ probeResult: "success", runtimeCount: 2 });
		service.refreshBinary();
		service.startLogStream();
		service.stopLogStream();
		service.dispose();

		expect(hosted.getStatus).toHaveBeenCalledTimes(2);
		expect(hosted.start).toHaveBeenCalledOnce();
		expect(hosted.stop).toHaveBeenCalledOnce();
		expect(hosted.restart).toHaveBeenCalledOnce();
		expect(cli.isInstalled).not.toHaveBeenCalled();
		expect(cli.start).not.toHaveBeenCalled();
		expect(cli.refreshBinary).toHaveBeenCalledOnce();
		expect(cli.startLogStream).toHaveBeenCalledOnce();
		expect(cli.stopLogStream).toHaveBeenCalledOnce();
		expect(cli.dispose).toHaveBeenCalledOnce();
	});

	it("emits changed hosted status only, prevents overlapping polls, and stops on dispose", async () => {
		vi.useFakeTimers();
		let resolveFirst: ((status: HostedMulticaDaemonStatus) => void) | undefined;
		const getStatus = vi.fn<() => Promise<HostedMulticaDaemonStatus>>()
			.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
			.mockResolvedValueOnce({ state: "running", pid: 7 })
			.mockResolvedValue({ state: "stopped" });
		const hosted: HostedMulticaDaemonControl = {
			getStatus,
			start: vi.fn(async () => ({ success: true })),
			stop: vi.fn(async () => ({ success: true })),
			restart: vi.fn(async () => ({ success: true })),
		};
		const cli = fakeCli();
		const emit = vi.fn();
		const service = createModeAwareMulticaDaemonService({ cli, hosted, hostingEnabled: () => true, emit, pollMs: 1_000 });

		service.startPolling();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(getStatus).toHaveBeenCalledTimes(1);
		resolveFirst?.({ state: "running", pid: 7 });
		await vi.advanceTimersByTimeAsync(0);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running", pid: 7 }));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(getStatus).toHaveBeenCalledTimes(3);
		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", { state: "stopped" });

		service.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(getStatus).toHaveBeenCalledTimes(3);
		expect(cli.dispose).toHaveBeenCalledOnce();
	});
});
