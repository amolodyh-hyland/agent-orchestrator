// @vitest-environment node
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMulticaDaemonService, DAEMON_BUSY_MESSAGE, findMulticaBinary, type ExecFileLike } from "./multica-daemon-cli";

const RUNNING = JSON.stringify({
	status: "running",
	pid: 94028,
	uptime: "1h",
	daemon_id: "d1",
	device_name: "host",
	profile: "",
	server_url: "http://localhost:3000",
	agents: ["claude", "codex"],
	workspaces: [{ id: "w1", runtimes: ["a", "b"] }],
});

describe("findMulticaBinary", () => {
	const base = { home: "/home/u", platform: "darwin" as const };
	const has = (...files: string[]) => (file: string) => files.includes(file);

	it("uses the override alone, and only when it is an absolute executable", () => {
		expect(findMulticaBinary({ ...base, override: "/opt/m/multica", isExecutable: has("/opt/m/multica", "/usr/local/bin/multica") })).toBe("/opt/m/multica");
		expect(findMulticaBinary({ ...base, override: "/opt/m/multica", isExecutable: has("/usr/local/bin/multica") })).toBeNull();
		expect(findMulticaBinary({ ...base, override: "multica", isExecutable: () => true })).toBeNull();
	});

	it("searches PATH then the usual install directories, ignoring relative entries", () => {
		expect(findMulticaBinary({ ...base, pathEnv: "/bin:/x/bin", isExecutable: has("/x/bin/multica") })).toBe("/x/bin/multica");
		expect(findMulticaBinary({ ...base, pathEnv: "", isExecutable: has("/opt/homebrew/bin/multica") })).toBe("/opt/homebrew/bin/multica");
		expect(findMulticaBinary({ ...base, pathEnv: ".:bin", isExecutable: has("bin/multica", "./multica") })).toBeNull();
		expect(findMulticaBinary({ ...base, pathEnv: "/bin", isExecutable: () => false })).toBeNull();
	});
});

function fakeExec(responses: Record<string, { stdout?: string; stderr?: string; error?: Error }> = {}) {
	const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
	const exec: ExecFileLike = (file, args, options, callback) => {
		calls.push({ file, args, timeout: options.timeout });
		const response = responses[args.join(" ")] ?? {};
		queueMicrotask(() => callback(response.error ?? null, response.stdout ?? "", response.stderr ?? ""));
	};
	return { exec, calls };
}

function setup(responses?: Parameters<typeof fakeExec>[0], binary: string | null = "/usr/local/bin/multica") {
	const { exec, calls } = fakeExec(responses);
	const emit = vi.fn();
	const service = createMulticaDaemonService({ emit, findBinary: () => binary, execFile: exec, logPath: "/nonexistent/daemon.log", pollMs: 1000 });
	return { service, emit, calls };
}

describe("multica daemon service", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads status through the CLI with a fixed argument array and a timeout", async () => {
		const { service, calls } = setup({ "daemon status --output json": { stdout: RUNNING } });

		expect((await service.getStatus()).state).toBe("running");
		expect(calls).toEqual([{ file: "/usr/local/bin/multica", args: ["daemon", "status", "--output", "json"], timeout: 10_000 }]);
	});

	it("maps stopped JSON even when the CLI exits non-zero", async () => {
		const { service } = setup({ "daemon status --output json": { stdout: '{\n  "status": "stopped"\n}', error: new Error("exit 1") } });

		expect(await service.getStatus()).toEqual({ state: "stopped" });
	});

	it("marks running and starting daemons from the ownership predicate", async () => {
		const { service } = setup({ "daemon status --output json": { stdout: RUNNING } });
		const startingOwnership = vi.fn(() => false);
		const startingService = createMulticaDaemonService({
			emit: vi.fn(),
			findBinary: () => "/usr/local/bin/multica",
			execFile: fakeExec({ "daemon status --output json": { stdout: '{"status":"starting","pid":5}' } }).exec,
			logPath: "/nonexistent/daemon.log",
			isOwnedDaemon: startingOwnership,
		});
		const runningOwnership = vi.fn(() => false);
		const externalService = createMulticaDaemonService({
			emit: vi.fn(),
			findBinary: () => "/usr/local/bin/multica",
			execFile: fakeExec({ "daemon status --output json": { stdout: RUNNING } }).exec,
			logPath: "/nonexistent/daemon.log",
			isOwnedDaemon: runningOwnership,
		});

		expect(await service.getStatus()).not.toHaveProperty("externallyManaged");
		expect(await startingService.getStatus()).toMatchObject({ state: "starting", externallyManaged: true });
		expect(startingOwnership).toHaveBeenCalledWith(expect.objectContaining({ state: "starting" }));
		expect(await externalService.getStatus()).toMatchObject({ state: "running", externallyManaged: true });
		expect(await externalService.probeRuntimes()).toMatchObject({ probeResult: "success", runtimeCount: 2 });
		expect(runningOwnership).toHaveBeenCalledTimes(2);
	});

	it("includes ownership changes in polling status pushes", async () => {
		vi.useFakeTimers();
		let owned = true;
		const { exec } = fakeExec({ "daemon status --output json": { stdout: RUNNING } });
		const emit = vi.fn();
		const service = createMulticaDaemonService({
			emit,
			findBinary: () => "/usr/local/bin/multica",
			execFile: exec,
			logPath: "/nonexistent/daemon.log",
			pollMs: 1000,
			isOwnedDaemon: () => owned,
		});

		service.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(emit).toHaveBeenCalledWith("daemon:status", expect.objectContaining({ state: "running", externallyManaged: false }));

		owned = false;
		await vi.advanceTimersByTimeAsync(1000);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running", externallyManaged: true }));
		service.dispose();
	});

	it("reports a missing CLI without running anything", async () => {
		const { service, calls } = setup({}, null);

		expect(await service.getStatus()).toEqual({ state: "cli_not_found" });
		expect(await service.isInstalled()).toBe(false);
		expect(await service.start()).toEqual({ success: false, error: "multica CLI is not installed" });
		expect(calls).toHaveLength(0);
	});

	it("starts and stops through the CLI, pushing the transient and the final state", async () => {
		const { service, emit, calls } = setup({ "daemon status --output json": { stdout: RUNNING } });

		expect(await service.start()).toEqual({ success: true });

		expect(calls.map((call) => call.args.join(" "))).toEqual(["daemon start", "daemon status --output json"]);
		expect(emit.mock.calls.map(([, status]) => status.state)).toEqual(["starting", "running"]);
		expect(await service.stop()).toEqual({ success: true });
		expect(calls.some((call) => call.args.join(" ") === "daemon stop")).toBe(true);
	});

	it("uses bounded timeouts for lifecycle commands", async () => {
		const { service, calls } = setup();

		await service.start();
		await service.stop();
		await service.restart();

		expect(calls.filter((call) => call.args[1] !== "status").map((call) => [call.args[1], call.timeout])).toEqual([
			["start", 60_000],
			["stop", 15_000],
			["restart", 90_000],
		]);
	});

	it("reports a failed command with the CLI's message, truncated", async () => {
		const { service } = setup({ "daemon start": { error: new Error("exit 1"), stderr: "x".repeat(500) } });

		const result = await service.start();

		expect(result.success).toBe(false);
		expect(result.error).toHaveLength(300);
	});

	it("refuses overlapping lifecycle commands", async () => {
		const { service } = setup();

		const first = service.start();
		const second = await service.stop();
		await first;

		expect(second).toEqual({ success: false, error: DAEMON_BUSY_MESSAGE });
	});

	it("pushes status only when it changes and stops polling when disposed", async () => {
		vi.useFakeTimers();
		const { service, emit, calls } = setup({ "daemon status --output json": { stdout: RUNNING } });

		service.startPolling();
		await vi.advanceTimersByTimeAsync(3500);
		expect(emit).toHaveBeenCalledTimes(1);

		service.dispose();
		const before = calls.length;
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls.length).toBe(before);
	});

	it("looks for the CLI again after refreshBinary", async () => {
		let binary: string | null = "/usr/local/bin/multica";
		const { exec } = fakeExec();
		const service = createMulticaDaemonService({ emit: vi.fn(), findBinary: () => binary, execFile: exec, logPath: "/x" });

		expect(await service.isInstalled()).toBe(true);
		binary = null;
		expect(await service.isInstalled()).toBe(true); // still remembered
		service.refreshBinary();
		expect(await service.isInstalled()).toBe(false);
	});

	it("shares one CLI process between concurrent status reads", async () => {
		const { service, calls } = setup({ "daemon status --output json": { stdout: RUNNING } });

		await Promise.all([service.getStatus(), service.getStatus(), service.probeRuntimes(), service.getStatus()]);

		expect(calls).toHaveLength(1);
	});

	it("serializes lifecycle commands across services, so a replaced view cannot overlap an old one", async () => {
		const old = setup();
		const replacement = setup();

		const pending = old.service.restart();
		const overlapping = await replacement.service.start();
		await pending;

		expect(overlapping).toEqual({ success: false, error: DAEMON_BUSY_MESSAGE });
		expect(replacement.calls).toHaveLength(0);
	});

	it("does not launch follow-up commands for a service disposed mid-command", async () => {
		const { service, calls } = setup();

		const pending = service.stop();
		service.dispose();
		await pending;

		expect(calls.map((call) => call.args[1])).toEqual(["stop"]);
	});
});

describe("multica daemon log stream", () => {
	let dir: string | undefined;
	afterEach(() => {
		vi.useRealTimers();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("sends the tail once, then appended lines, and stops when asked", async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "daemon-log-"));
		const logPath = path.join(dir, "daemon.log");
		writeFileSync(logPath, "one\ntwo\n");
		const emit = vi.fn();
		const service = createMulticaDaemonService({ emit, findBinary: () => null, logPath });
		const lines = () => emit.mock.calls.map(([, line]) => line);

		service.startLogStream();
		await vi.waitFor(() => expect(lines()).toEqual(["one", "two"]), { timeout: 3000 });

		appendFileSync(logPath, "three\npart");
		await vi.waitFor(() => expect(lines()).toEqual(["one", "two", "three"]), { timeout: 3000 });
		appendFileSync(logPath, "ial\n");
		await vi.waitFor(() => expect(lines()).toEqual(["one", "two", "three", "partial"]), { timeout: 3000 });
		expect(emit.mock.calls.every(([channel]) => channel === "daemon:log-line")).toBe(true);

		service.stopLogStream();
		appendFileSync(logPath, "after\n");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(lines()).toHaveLength(4);
	});

	it("never holds more than one line's worth of an unterminated line", async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "daemon-log-"));
		const logPath = path.join(dir, "daemon.log");
		writeFileSync(logPath, "start\n");
		const emit = vi.fn();
		const service = createMulticaDaemonService({ emit, findBinary: () => null, logPath });

		service.startLogStream();
		await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1), { timeout: 3000 });
		appendFileSync(logPath, "x".repeat(20_000));
		await new Promise((resolve) => setTimeout(resolve, 1200));
		appendFileSync(logPath, "\n");
		await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2), { timeout: 3000 });
		service.dispose();

		expect(emit.mock.calls[1][1]).toHaveLength(4096);
	});

	it("waits for a log that does not exist yet", async () => {
		vi.useFakeTimers();
		const emit = vi.fn();
		const service = createMulticaDaemonService({ emit, findBinary: () => null, logPath: "/nonexistent/daemon.log" });

		service.startLogStream();
		await vi.advanceTimersByTimeAsync(2000);
		service.dispose();

		expect(emit).not.toHaveBeenCalled();
	});
});
