// @vitest-environment node
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMulticaDaemonService,
	DAEMON_BUSY_MESSAGE,
	findMulticaBinary,
	type ExecFileLike,
	type MulticaDaemonServiceOptions,
} from "./multica-daemon-cli";
import { createMulticaDaemonOwnerStore, healthPortForProfile, type RunningMulticaDaemon } from "./multica-daemon-guard";

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

	it("checks the bundled executable before PATH and only when it is absolute and executable", () => {
		expect(
			findMulticaBinary({
				...base,
				bundledPath: "/resources/multica-cli/multica",
				pathEnv: "/bin",
				isExecutable: has("/resources/multica-cli/multica", "/bin/multica"),
			}),
		).toBe("/resources/multica-cli/multica");
		expect(findMulticaBinary({ ...base, bundledPath: "relative/multica", isExecutable: () => false })).toBeNull();
		expect(findMulticaBinary({ ...base, bundledPath: "/missing/multica", pathEnv: "/bin", isExecutable: has("/bin/multica") })).toBe("/bin/multica");
	});

	it("searches PATH then the usual install directories, ignoring relative entries", () => {
		expect(findMulticaBinary({ ...base, pathEnv: "/bin:/x/bin", isExecutable: has("/x/bin/multica") })).toBe("/x/bin/multica");
		expect(findMulticaBinary({ ...base, pathEnv: "", isExecutable: has("/opt/homebrew/bin/multica") })).toBe("/opt/homebrew/bin/multica");
		expect(findMulticaBinary({ ...base, pathEnv: ".:bin", isExecutable: has("bin/multica", "./multica") })).toBeNull();
		expect(findMulticaBinary({ ...base, pathEnv: "/bin", isExecutable: () => false })).toBeNull();
	});
});

function fakeExec(responses: Record<string, { stdout?: string; stderr?: string; error?: Error }> = {}) {
	const calls: Array<{ file: string; args: string[]; timeout: number; env?: NodeJS.ProcessEnv }> = [];
	const exec: ExecFileLike = (file, args, options, callback) => {
		calls.push({ file, args, timeout: options.timeout, ...(options.env ? { env: options.env } : {}) });
		const response = responses[args.join(" ")] ?? {};
		queueMicrotask(() => callback(response.error ?? null, response.stdout ?? "", response.stderr ?? ""));
	};
	return { exec, calls };
}

function setup(
	responses?: Parameters<typeof fakeExec>[0],
	binary: string | null = "/usr/local/bin/multica",
	serviceOptions: Partial<MulticaDaemonServiceOptions> = {},
) {
	const { exec, calls } = fakeExec(responses);
	const emit = vi.fn();
	const service = createMulticaDaemonService({ emit, findBinary: () => binary, execFile: exec, logPath: "/nonexistent/daemon.log", pollMs: 1000, ...serviceOptions });
	return { service, emit, calls };
}

function setupGuardedService(
	stateDirectory: string,
	daemons: RunningMulticaDaemon[] = [],
	responses?: Parameters<typeof fakeExec>[0],
	isPidAlive: (pid: number) => boolean = () => false,
) {
	const { exec, calls } = fakeExec(responses);
	const emit = vi.fn();
	const ownerStore = createMulticaDaemonOwnerStore(stateDirectory, { readProcessStart: async () => "process-1" });
	const service = createMulticaDaemonService({
		emit,
		findBinary: () => "/usr/local/bin/multica",
		execFile: exec,
		logPath: "/nonexistent/daemon.log",
		isOwnedDaemon: ownerStore.isOwnedDaemon,
		listRunningDaemons: async () => ({ state: "known", daemons }),
		writeOwnerMarker: ownerStore.write,
		removeOwnerMarker: ownerStore.remove,
		isPidAlive,
	});
	return { service, emit, calls, ownerStore };
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

	it("uses the packaged not-found message while preserving cli_not_found status", async () => {
		const { exec, calls } = fakeExec();
		const service = createMulticaDaemonService({
			emit: vi.fn(),
			findBinary: () => null,
			cliNotFoundMessage: "The Multica CLI isn't bundled with this build and was not found on PATH",
			execFile: exec,
			logPath: "/nonexistent/daemon.log",
		});

		expect(await service.getStatus()).toEqual({ state: "cli_not_found" });
		expect(await service.restart()).toEqual({
			success: false,
			error: "The Multica CLI isn't bundled with this build and was not found on PATH",
		});
		expect(calls).toHaveLength(0);
	});

	it("starts and stops through the CLI, pushing the transient and the final state", async () => {
		const { service, emit, calls } = setup({ "daemon status --output json": { stdout: RUNNING } }, undefined, { isOwnedDaemon: () => true });

		expect(await service.start()).toEqual({ success: true });

		expect(calls.map((call) => call.args.join(" "))).toEqual(["daemon start", "daemon status --output json"]);
		expect(emit.mock.calls.map(([, status]) => status.state)).toEqual(["starting", "running"]);
		expect(await service.stop()).toEqual({ success: true });
		expect(calls.some((call) => call.args.join(" ") === "daemon stop")).toBe(true);
	});

	it("uses bounded timeouts for lifecycle commands", async () => {
		const { service, calls } = setup({ "daemon status --output json": { stdout: RUNNING } }, undefined, { isOwnedDaemon: () => true, isPidAlive: () => false });

		await service.start();
		await service.stop();
		await service.restart();

		expect(calls.filter((call) => call.args[1] !== "status").map((call) => [call.args[1], call.timeout])).toEqual([
			["start", 60_000],
			["stop", 15_000],
			["restart", 90_000],
		]);
	});

	it("adds launch attribution only for the bundled binary", async () => {
		for (const binaryPath of ["/opt/user/multica", "/usr/local/bin/multica"]) {
			const external = setup({ "daemon status --output json": { stdout: RUNNING } }, binaryPath, { isBundledBinary: () => false });
			await external.service.start();
			await external.service.restart();
			expect(external.calls.filter((call) => call.args[1] === "start" || call.args[1] === "restart").every((call) => call.env === undefined)).toBe(true);
		}

		const bundled = setup(
			{ "daemon status --output json": { stdout: RUNNING } },
			"/resources/multica-cli/multica",
			{ isBundledBinary: (binaryPath) => path.resolve(binaryPath) === "/resources/multica-cli/multica" },
		);
		await bundled.service.start();
		await bundled.service.restart();
		expect(bundled.calls.filter((call) => call.args[1] === "start" || call.args[1] === "restart").map((call) => call.env?.MULTICA_LAUNCHED_BY)).toEqual([
			"desktop",
			"desktop",
		]);
		expect(bundled.calls.filter((call) => call.args[1] === "status").every((call) => call.env === undefined)).toBe(true);
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

	it("can stop and restart polling without disposing the service", async () => {
		vi.useFakeTimers();
		let status = JSON.stringify({ status: "stopped" });
		const calls: string[] = [];
		const exec: ExecFileLike = (_file, args, _options, callback) => {
			calls.push(args.join(" "));
			queueMicrotask(() => callback(null, status, ""));
		};
		const emit = vi.fn();
		const service = createMulticaDaemonService({
			emit,
			findBinary: () => "/usr/local/bin/multica",
			execFile: exec,
			logPath: "/nonexistent/daemon.log",
			pollMs: 1000,
		});

		service.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", { state: "stopped" });

		service.stopPolling();
		status = RUNNING;
		const stoppedCallCount = calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(calls).toHaveLength(stoppedCallCount);
		expect(emit).toHaveBeenCalledTimes(1);

		service.startPolling();
		await vi.advanceTimersByTimeAsync(0);
		expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running" }));
		expect(calls).toHaveLength(stoppedCallCount + 1);

		service.dispose();
		const disposedCallCount = calls.length;
		const disposedPushCount = emit.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(calls).toHaveLength(disposedCallCount);
		expect(emit).toHaveBeenCalledTimes(disposedPushCount);
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

	it("does not reuse a delayed pre-operation status to decide ownership", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const ownerStore = createMulticaDaemonOwnerStore(stateDirectory, { readProcessStart: async () => "process-1" });
			let statusCalls = 0;
			let resolveOldStatus: (() => void) | undefined;
			const calls: string[] = [];
			const exec: ExecFileLike = (_file, args, _options, callback) => {
				const command = args.join(" ");
				calls.push(command);
				if (command === "daemon status --output json") {
					statusCalls += 1;
					if (statusCalls === 1) resolveOldStatus = () => callback(null, '{"status":"stopped"}', "");
					else queueMicrotask(() => callback(null, RUNNING, ""));
				} else queueMicrotask(() => callback(null, "", ""));
			};
			const service = createMulticaDaemonService({
				emit: vi.fn(),
				findBinary: () => "/usr/local/bin/multica",
				execFile: exec,
				logPath: "/nonexistent/daemon.log",
				isOwnedDaemon: ownerStore.isOwnedDaemon,
				writeOwnerMarker: ownerStore.write,
			});
			const oldRead = service.getStatus();
			await vi.waitFor(() => expect(resolveOldStatus).toEqual(expect.any(Function)));

			expect(await service.start()).toEqual({ success: true });
			resolveOldStatus?.();
			expect(await oldRead).toEqual({ state: "stopped" });
			expect(statusCalls).toBe(2);
			expect(calls).toEqual(["daemon status --output json", "daemon start", "daemon status --output json"]);
			expect(await ownerStore.isOwnedDaemon({ state: "running", pid: 94028, profile: "", daemonId: "d1" })).toBe(true);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("rewrites the owner marker on a later successful start", async () => {
		const { exec, calls } = fakeExec({ "daemon status --output json": { stdout: RUNNING } });
		let writes = 0;
		const service = createMulticaDaemonService({
			emit: vi.fn(),
			findBinary: () => "/usr/local/bin/multica",
			execFile: exec,
			logPath: "/nonexistent/daemon.log",
			writeOwnerMarker: async () => {
				writes += 1;
				if (writes === 1) throw new Error("marker disk error");
			},
		});

		expect(await service.start()).toEqual({
			success: false,
			error: "Multica daemon operation succeeded but AO could not update its ownership marker: marker disk error",
		});
		expect(await service.start()).toEqual({ success: true });
		expect(writes).toBe(2);
		expect(calls.filter((call) => call.args.join(" ") === "daemon start")).toHaveLength(2);
	});

	it("refuses start when the profile scan outcome is unknown", async () => {
		const { exec, calls } = fakeExec();
		const service = createMulticaDaemonService({
			emit: vi.fn(),
			findBinary: () => "/usr/local/bin/multica",
			execFile: exec,
			logPath: "/nonexistent/daemon.log",
			listRunningDaemons: async () => ({ state: "unknown" }),
		});

		expect(await service.start()).toEqual({
			success: false,
			error: "Could not verify whether another Multica daemon is running; not starting a second one",
		});
		expect(calls).toHaveLength(0);
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
		const { service, calls } = setup({ "daemon status --output json": { stdout: RUNNING } }, "/usr/local/bin/multica", { isOwnedDaemon: () => true });

		const pending = service.stop();
		service.dispose();
		await pending;

		expect(calls.map((call) => call.args[1])).toEqual(["status", "stop", "status"]);
	});

	const refusalCases: Array<[RunningMulticaDaemon, string]> = [
		[{ profiles: [""], port: 19514, pid: 11 }, "default"],
		[{ profiles: ["desktop-localhost"], port: healthPortForProfile("desktop-localhost"), pid: 12 }, "desktop-localhost"],
	];
	it.each(refusalCases)("refuses start when an unowned %s daemon is running", async (daemon, profile) => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const { service, calls } = setupGuardedService(stateDirectory, [daemon]);

			expect(await service.start()).toEqual({
				success: false,
				error: `A Multica daemon is already running (profile ${profile}, port ${daemon.port}); AO will not start a second one`,
			});
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("allows start when the only running daemon is AO-owned", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const daemon = { profiles: [""], port: 19514, pid: 94028 };
			const { service, calls, ownerStore } = setupGuardedService(stateDirectory, [daemon], { "daemon status --output json": { stdout: RUNNING } });
			await ownerStore.write({ state: "running", pid: 94028, profile: "" });

			expect(await service.start()).toEqual({ success: true });
			expect(calls.some((call) => call.args.join(" ") === "daemon start")).toBe(true);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("refuses to stop a daemon without AO's ownership marker", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const { service, calls } = setupGuardedService(stateDirectory, [], { "daemon status --output json": { stdout: RUNNING } });

			expect(await service.stop()).toEqual({
				success: false,
				error: "No Multica daemon started by AO is running; stop it where it was started",
			});
			expect(calls.some((call) => call.args.join(" ") === "daemon stop")).toBe(false);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("refuses an exit-zero stopped answer without a marker even when the daemon is live on the next read", async () => {
		const responses: string[] = ['{"status":"stopped"}', RUNNING];
		const calls: string[] = [];
		const exec: ExecFileLike = (_file, args, _options, callback) => {
			const command = args.join(" ");
			calls.push(command);
			if (command === "daemon status --output json") queueMicrotask(() => callback(null, responses.shift() ?? RUNNING, ""));
			else queueMicrotask(() => callback(null, "", ""));
		};
		const service = createMulticaDaemonService({ emit: vi.fn(), findBinary: () => "/usr/local/bin/multica", execFile: exec, logPath: "/nonexistent/daemon.log" });

		expect(await service.stop()).toEqual({
			success: false,
			error: "No Multica daemon started by AO is running; stop it where it was started",
		});
		expect(await service.getStatus()).toMatchObject({ state: "running", pid: 94028 });
		expect(calls).toEqual(["daemon status --output json", "daemon status --output json"]);
	});

	it("keeps the marker when a successful stop still reports the owned daemon", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const { service, calls, ownerStore } = setupGuardedService(stateDirectory, [], { "daemon status --output json": { stdout: RUNNING } }, () => true);
			await ownerStore.write({ state: "running", pid: 94028, profile: "" });

			expect(await service.stop()).toEqual({ success: true });
			expect(calls.some((call) => call.args.join(" ") === "daemon stop")).toBe(true);
			expect(await ownerStore.isOwnedDaemon({ state: "running", pid: 94028, profile: "", daemonId: "d1" })).toBe(true);
			expect((await service.getStatus())).toMatchObject({ state: "running", externallyManaged: false });
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it.each([
		{ name: "failed", stdout: "", error: new Error("health unavailable") },
		{ name: "stopped", stdout: '{"status":"stopped"}' },
	])("keeps and reports ownership after a successful stop with a $name post-read while the pid lives", async ({ stdout, error }) => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const ownerStore = createMulticaDaemonOwnerStore(stateDirectory, { readProcessStart: async () => "process-1" });
			await ownerStore.write({ state: "running", pid: 94028, profile: "", daemonId: "d1" });
			let statusReads = 0;
			const emit = vi.fn();
			const exec: ExecFileLike = (_file, args, _options, callback) => {
				if (args.join(" ") === "daemon status --output json") {
					statusReads += 1;
					if (statusReads === 1) queueMicrotask(() => callback(null, RUNNING, ""));
					else queueMicrotask(() => callback(error ?? null, stdout, ""));
				} else queueMicrotask(() => callback(null, "", ""));
			};
			const service = createMulticaDaemonService({
				emit,
				findBinary: () => "/usr/local/bin/multica",
				execFile: exec,
				logPath: "/nonexistent/daemon.log",
				isOwnedDaemon: ownerStore.isOwnedDaemon,
				removeOwnerMarker: ownerStore.remove,
				isPidAlive: () => true,
			});

			expect(await service.stop()).toEqual({ success: true });
			expect(await ownerStore.isOwnedDaemon({ state: "running", pid: 94028, profile: "", daemonId: "d1" })).toBe(true);
			expect(emit).toHaveBeenLastCalledWith("daemon:status", expect.objectContaining({ state: "running", externallyManaged: false }));
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("removes the marker only after the recorded pid is gone", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const ownerStore = createMulticaDaemonOwnerStore(stateDirectory, { readProcessStart: async () => "process-1" });
			await ownerStore.write({ state: "running", pid: 94028, profile: "" });
			let statusReads = 0;
			const calls: string[] = [];
			const exec: ExecFileLike = (_file, args, _options, callback) => {
				const command = args.join(" ");
				calls.push(command);
				if (command === "daemon status --output json") {
					statusReads += 1;
					queueMicrotask(() => callback(null, statusReads === 1 ? RUNNING : '{"status":"stopped"}', ""));
				} else queueMicrotask(() => callback(null, "", ""));
			};
			const service = createMulticaDaemonService({
				emit: vi.fn(),
				findBinary: () => "/usr/local/bin/multica",
				execFile: exec,
				logPath: "/nonexistent/daemon.log",
				isOwnedDaemon: ownerStore.isOwnedDaemon,
				writeOwnerMarker: ownerStore.write,
				removeOwnerMarker: ownerStore.remove,
				isPidAlive: () => false,
			});

			expect(await service.stop()).toEqual({ success: true });
			expect(calls).toEqual(["daemon status --output json", "daemon stop", "daemon status --output json"]);
			expect(await ownerStore.isOwnedDaemon({ state: "running", pid: 94028, profile: "" })).toBe(false);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
	});

	it("refuses to stop when status failed even if a later status might find a live daemon", async () => {
		const { service, calls } = setup({
			"daemon status --output json": { stdout: RUNNING, error: new Error("status failed") },
		});

		expect(await service.stop()).toEqual({
			success: false,
			error: "No Multica daemon started by AO is running; stop it where it was started",
		});
		expect(calls.map((call) => call.args.join(" "))).toEqual(["daemon status --output json"]);
	});

	it.each(["", "not json", "[]", '{"status":"mystery"}'])("refuses to stop with unknown status output %j", async (stdout) => {
		const { service, calls } = setup({ "daemon status --output json": { stdout } }, "/usr/local/bin/multica", { isOwnedDaemon: () => true });

		expect(await service.stop()).toEqual({
			success: false,
			error: "No Multica daemon started by AO is running; stop it where it was started",
		});
		expect(calls.some((call) => call.args[1] === "stop")).toBe(false);
	});

	it("keeps ownership after the service is recreated and serializes two concurrent starts", async () => {
		const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-service-owner-"));
		try {
			const first = setupGuardedService(stateDirectory, [], { "daemon status --output json": { stdout: RUNNING } });
			expect(await first.service.start()).toEqual({ success: true });

			const recreated = setupGuardedService(stateDirectory, [{ profiles: [""], port: 19514, pid: 94028, daemonId: "d1" }], { "daemon status --output json": { stdout: RUNNING } });
			expect(await recreated.service.getStatus()).toMatchObject({ state: "running", externallyManaged: false });
			const other = setupGuardedService(stateDirectory);
			const firstStart = recreated.service.start();
			const secondStart = await other.service.start();

			expect(await firstStart).toEqual({ success: true });

			expect(secondStart).toEqual({ success: false, error: DAEMON_BUSY_MESSAGE });
			expect(recreated.calls.filter((call) => call.args.join(" ") === "daemon start")).toHaveLength(1);
			expect(other.calls).toHaveLength(0);
		} finally {
			rmSync(stateDirectory, { recursive: true, force: true });
		}
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

	it("keeps reading logs after polling stops", async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "daemon-log-polling-"));
		const logPath = path.join(dir, "daemon.log");
		writeFileSync(logPath, "one\n");
		const emit = vi.fn();
		const service = createMulticaDaemonService({ emit, findBinary: () => null, logPath, pollMs: 1000 });

		service.startPolling();
		service.startLogStream();
		await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("daemon:log-line", "one"), { timeout: 3000 });
		service.stopPolling();

		appendFileSync(logPath, "two\n");
		await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("daemon:log-line", "two"), { timeout: 3000 });
		service.dispose();
	});

	it("dispose stops both status polling and the log stream", async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "daemon-log-dispose-"));
		const logPath = path.join(dir, "daemon.log");
		writeFileSync(logPath, "one\n");
		const emit = vi.fn();
		const { exec, calls } = fakeExec({ "daemon status --output json": { stdout: RUNNING } });
		const service = createMulticaDaemonService({
			emit,
			findBinary: () => "/usr/local/bin/multica",
			execFile: exec,
			logPath,
			pollMs: 100,
		});

		service.startPolling();
		service.startLogStream();
		await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("daemon:log-line", "one"), { timeout: 3000 });
		await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 3000 });
		service.dispose();
		const callCount = calls.length;
		const logCount = emit.mock.calls.filter(([channel]) => channel === "daemon:log-line").length;
		appendFileSync(logPath, "two\n");
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(calls).toHaveLength(callCount);
		expect(emit.mock.calls.filter(([channel]) => channel === "daemon:log-line")).toHaveLength(logCount);
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

	it("resolves a function log path each time a stream starts", async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "daemon-log-path-"));
		const firstPath = path.join(dir, "first.log");
		const secondPath = path.join(dir, "second.log");
		writeFileSync(firstPath, "first\n");
		writeFileSync(secondPath, "second\n");
		let currentPath = firstPath;
		const logPath = vi.fn(() => currentPath);
		const emit = vi.fn();
		const service = createMulticaDaemonService({ emit, findBinary: () => null, logPath });

		service.startLogStream();
		await vi.waitFor(() => expect(emit).toHaveBeenLastCalledWith("daemon:log-line", "first"), { timeout: 3000 });
		service.stopLogStream();
		currentPath = secondPath;
		service.startLogStream();
		await vi.waitFor(() => expect(emit).toHaveBeenLastCalledWith("daemon:log-line", "second"), { timeout: 3000 });

		expect(logPath).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenLastCalledWith("daemon:log-line", "second");
		service.dispose();
	});
});
