// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_BUSY_MESSAGE, type MulticaDaemonService } from "./multica-daemon-cli";
import {
	createHostedMulticaDaemonControl,
	createHostedFetchJson,
	createModeAwareMulticaDaemonService,
	hostedMulticaCliEnv,
	hostedMulticaLogPath,
	isMulticaHostingEnabled,
	mapHostedStatus,
	type HostedMulticaDaemonControl,
	type HostedMulticaDaemonStatus,
	type HostedStatusRead,
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
		stopPolling: vi.fn(),
		dispose: vi.fn(),
	};
}

function fakeHosted(status: HostedMulticaDaemonStatus = { state: "stopped" }): HostedMulticaDaemonControl {
	const getStatus = vi.fn(async () => status);
	return {
		getStatus,
		getStatusResult: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4400", available: true, status: await getStatus() })),
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

	it("uses the 65 second default timeout for hosted lifecycle actions", async () => {
		const calls: number[] = [];
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async (_url, _init, timeoutMs) => {
				calls.push(timeoutMs);
				return response(200, { daemon: { state: "running" } });
			},
		});
		await control.start();
		expect(calls).toEqual([65_000]);
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

	it("maps external status from the live health pid and omits stale uptime", () => {
		const status = mapHostedStatus(
			{
				state: "external",
				enabled: true,
				pid: 0,
				startedAt: "2020-01-01T00:00:00Z",
				health: { pid: 946, daemonId: "external-1" },
			},
			Date.parse("2025-01-01T00:00:00Z"),
		);

		expect(status).toMatchObject({ state: "running", externallyManaged: true, pid: 946, daemonId: "external-1" });
		expect(status).not.toHaveProperty("uptime");
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "946"]) ("omits an invalid external health pid %j", (pid) => {
		expect(mapHostedStatus({ state: "external", health: { pid } })).not.toHaveProperty("pid");
	});
});

describe("hostedMulticaLogPath", () => {
	it("uses the default path for an empty or default profile", () => {
		expect(hostedMulticaLogPath("/home/u", undefined)).toBe("/home/u/.multica/daemon.log");
		expect(hostedMulticaLogPath("/home/u", " default ")).toBe("/home/u/.multica/daemon.log");
	});

	it("uses a named profile path and falls back for hostile names", () => {
		expect(hostedMulticaLogPath("/home/u", " work ")).toBe("/home/u/.multica/profiles/work/daemon.log");
		for (const name of [".", "..", "a/b", "a\\b", "bad\0name"]) {
			expect(hostedMulticaLogPath("/home/u", name)).toBe("/home/u/.multica/daemon.log");
		}
	});
});

describe("createHostedMulticaDaemonControl", () => {
	it("uses the status and action routes with their respective timeouts", async () => {
		const calls: Array<[string, string | undefined, number]> = [];
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400/",
			timeoutMs: 65_000,
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
			["http://127.0.0.1:4400/api/v1/multica/start", "POST", 65_000],
			["http://127.0.0.1:4400/api/v1/multica/stop", "POST", 65_000],
			["http://127.0.0.1:4400/api/v1/multica/restart", "POST", 65_000],
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
		["HTML body", async () => { throw new SyntaxError("Unexpected token <"); }],
		["truncated JSON", async () => { throw new SyntaxError("Unexpected end of JSON input"); }],
		["wrong shape", async () => ({ ok: true })],
		["daemon without state", async () => ({ daemon: {} })],
	])("rejects a malformed 2xx response for status and lifecycle calls (%s)", async (_name, json) => {
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async () => ({ ok: true, status: 200, json }),
		});

		expect(await control.getStatus()).toEqual({ state: "stopped" });
		for (const action of [control.start, control.stop, control.restart]) {
			expect(await action()).toEqual({ success: false, error: "The AO daemon sent an unexpected response." });
		}
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
			fetchJson: async () => response(200, { daemon: { state: "running" } }),
		});

		const pending = first.start();
		expect(await second.stop()).toEqual({ success: false, error: DAEMON_BUSY_MESSAGE });
		resolveFirst?.(response(200, { daemon: { state: "running" } }));
		expect(await pending).toEqual({ success: true });
	});

	it("bounds the response body and keeps the timeout armed while reading it", async () => {
		const timedFetch = createHostedFetchJson(async (_url, init) => {
			const signal = init?.signal as AbortSignal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
				},
			});
			return new Response(body, { status: 200 });
		});
		await expect(timedFetch("http://ao", { method: "GET" }, 10)).rejects.toMatchObject({ name: "AbortError" });

		const oversizedFetch = createHostedFetchJson(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024 + 1));
					controller.close();
				},
			});
			return new Response(body, { status: 200 });
		});
		await expect(oversizedFetch("http://ao", { method: "GET" }, 1000)).rejects.toThrow("The AO daemon response is too large.");
	});

	it("releases lifecycle and poll guards after an aborted request", async () => {
		let actionCalls = 0;
		const control = createHostedMulticaDaemonControl({
			baseUrl: () => "http://127.0.0.1:4400",
			fetchJson: async () => {
				actionCalls += 1;
				if (actionCalls === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
				return response(200, { daemon: { state: "running" } });
			},
		});
		expect(await control.start()).toEqual({ success: false, error: "The AO daemon request timed out." });
		expect(await control.stop()).toEqual({ success: true });

		vi.useFakeTimers();
		let reads = 0;
		const hosted = fakeHosted();
		hosted.getStatusResult = vi.fn(async () => {
			reads += 1;
			if (reads === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			return { baseUrl: "http://127.0.0.1:4400", available: true, status: { state: "running", pid: 7 } };
		});
		const emit = vi.fn();
		const service = createModeAwareMulticaDaemonService({
			cli: fakeCli(),
			hosted,
			hostingEnabled: () => true,
			baseUrl: () => "http://127.0.0.1:4400",
			emit,
		});
		service.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reads).toBe(2);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running", pid: 7 }));
		service.dispose();
		vi.useRealTimers();
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

	it("delegates every method to the CLI when the ready daemon reports disabled", async () => {
		const cli = fakeCli();
		const hosted = fakeHosted({ state: "disabled", enabled: false });
		const service = createModeAwareMulticaDaemonService({
			cli,
			hosted,
			hostingEnabled: () => true,
			baseUrl: () => "http://127.0.0.1:4400",
			emit: vi.fn(),
		});

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
		await Promise.resolve();
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
		expect(hosted.start).not.toHaveBeenCalled();
		expect(hosted.stop).not.toHaveBeenCalled();
		expect(hosted.restart).not.toHaveBeenCalled();
		expect(service.getMode()).toBe("cli");
	});

	it("stops CLI polling on hosted mode without disposing its log stream", async () => {
		vi.useFakeTimers();
		const emit = vi.fn();
		let disposed = false;
		let cliPolling = false;
		let pollTimer: NodeJS.Timeout | undefined;
		let logTimer: NodeJS.Timeout | undefined;
		let logCount = 0;
		const cli: MulticaDaemonService = {
			getStatus: vi.fn(async () => ({ state: "stopped" as const })),
			start: vi.fn(async () => ({ success: true })),
			stop: vi.fn(async () => ({ success: true })),
			restart: vi.fn(async () => ({ success: true })),
			isInstalled: vi.fn(async () => true),
			refreshBinary: vi.fn(),
			probeRuntimes: vi.fn(async () => ({ probeResult: "error" as const })),
			startLogStream: vi.fn(() => {
				if (disposed || logTimer) return;
				logTimer = setInterval(() => emit("daemon:log-line", `line-${++logCount}`), 250);
			}),
			stopLogStream: vi.fn(() => {
				if (logTimer) clearInterval(logTimer);
				logTimer = undefined;
			}),
			startPolling: vi.fn(() => {
				if (disposed || pollTimer) return;
				cliPolling = true;
				pollTimer = setInterval(() => emit("daemon:status", { state: "stopped" }), 500);
			}),
			stopPolling: vi.fn(() => {
				if (pollTimer) clearInterval(pollTimer);
				pollTimer = undefined;
				cliPolling = false;
			}),
			dispose: vi.fn(() => {
				if (disposed) return;
				disposed = true;
				if (pollTimer) clearInterval(pollTimer);
				pollTimer = undefined;
				cliPolling = false;
				if (logTimer) clearInterval(logTimer);
				logTimer = undefined;
			}),
		};
		const hosted = fakeHosted();
		const statusReads: HostedStatusRead[] = [
			{ baseUrl: "http://127.0.0.1:4400", available: false },
			{ baseUrl: "http://127.0.0.1:4400", available: true, status: { state: "running", enabled: true, pid: 18 } },
			{ baseUrl: "http://127.0.0.1:4400", available: true, status: { state: "disabled", enabled: false } },
		];
		hosted.getStatusResult = vi.fn(async () => statusReads.shift() ?? { baseUrl: "http://127.0.0.1:4400", available: true, status: { state: "disabled" } });
		const service = createModeAwareMulticaDaemonService({
			cli,
			hosted,
			hostingEnabled: () => false,
			baseUrl: () => "http://127.0.0.1:4400",
			emit,
			pollMs: 1_000,
		});

		service.startLogStream();
		service.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(cli.startPolling).toHaveBeenCalledOnce();
		expect(cliPolling).toBe(true);
		expect(service.getMode()).toBe("cli");

		await vi.advanceTimersByTimeAsync(2_000);
		expect(service.getMode()).toBe("hosted");
		expect(cli.stopPolling).toHaveBeenCalledOnce();
		expect(cliPolling).toBe(false);
		expect(cli.dispose).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith("daemon:status", expect.objectContaining({ state: "running", pid: 18 }));
		const logCountAfterSwitch = emit.mock.calls.filter(([channel]) => channel === "daemon:log-line").length;
		expect(logCountAfterSwitch).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(500);
		expect(emit.mock.calls.filter(([channel]) => channel === "daemon:log-line").length).toBeGreaterThan(logCountAfterSwitch);

		await vi.advanceTimersByTimeAsync(1_500);
		expect(service.getMode()).toBe("cli");
		expect(cli.startPolling).toHaveBeenCalledTimes(2);
		expect(cliPolling).toBe(true);
		const hostedPushCount = emit.mock.calls.filter(([, status]) => (status as { pid?: number }).pid === 18).length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(emit.mock.calls.filter(([, status]) => (status as { pid?: number }).pid === 18)).toHaveLength(hostedPushCount);

		service.dispose();
		expect(cli.dispose).toHaveBeenCalledOnce();
	});

	it("uses the hosted control and keeps CLI log and binary helpers", async () => {
		const cli = fakeCli();
		const hosted = fakeHosted({ state: "running", pid: 9, health: { agents: ["claude", "codex"] } });
		const service = createModeAwareMulticaDaemonService({
			cli,
			hosted,
			hostingEnabled: () => false,
			baseUrl: () => "http://127.0.0.1:4400",
			emit: vi.fn(),
		});

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

		expect(hosted.getStatus).toHaveBeenCalledTimes(4);
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

	it("shares one pending status decision across simultaneous service calls", async () => {
		let resolveStatus: ((status: HostedMulticaDaemonStatus) => void) | undefined;
		const hosted = fakeHosted();
		hosted.getStatusResult = vi.fn<() => Promise<HostedStatusRead>>(
			() =>
				new Promise((resolve) => {
					resolveStatus = (status) => resolve({ baseUrl: "http://127.0.0.1:4400", available: true, status });
				}),
		);
		const service = createModeAwareMulticaDaemonService({
			cli: fakeCli(),
			hosted,
			hostingEnabled: () => false,
			baseUrl: () => "http://127.0.0.1:4400",
			emit: vi.fn(),
		});

		const status = service.getStatus();
		const start = service.start();
		expect(hosted.getStatusResult).toHaveBeenCalledOnce();
		resolveStatus?.({ state: "running", enabled: true, pid: 2 });
		expect(await status).toMatchObject({ state: "running", pid: 2 });
		expect(await start).toEqual({ success: true });
		service.dispose();
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
			getStatusResult: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4400", available: true, status: await getStatus() })),
			start: vi.fn(async () => ({ success: true })),
			stop: vi.fn(async () => ({ success: true })),
			restart: vi.fn(async () => ({ success: true })),
		};
		const cli = fakeCli();
		const emit = vi.fn();
		const service = createModeAwareMulticaDaemonService({ cli, hosted, hostingEnabled: () => true, emit, pollMs: 5_000 });

		service.startPolling();
		await vi.advanceTimersByTimeAsync(6_000);
		expect(getStatus).toHaveBeenCalledTimes(1);
		resolveFirst?.({ state: "running", pid: 7 });
		await vi.advanceTimersByTimeAsync(0);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running", pid: 7 }));

		await vi.advanceTimersByTimeAsync(5_000);
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(getStatus).toHaveBeenCalledTimes(3);
		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", { state: "stopped" });

		service.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(getStatus).toHaveBeenCalledTimes(3);
		expect(cli.dispose).toHaveBeenCalledOnce();
	});
});
