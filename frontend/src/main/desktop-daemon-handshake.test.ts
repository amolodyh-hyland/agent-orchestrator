import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDaemonLaunch } from "../shared/daemon-launch";
import { type DaemonProber } from "../shared/daemon-attach";
import { bootstrapDaemonBeforeFeatures, verifyDesktopDaemonHandshake } from "./desktop-daemon-bootstrap";
import { readDaemonProcessIdentity, type ProcessIdentityQuery } from "./daemon-process-identity";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(platform: NodeJS.Platform = "darwin") {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ao-verified-handshake-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const executable = path.join(directory, platform === "win32" ? "ao.exe" : "ao");
	await writeFile(executable, "fixture executable");
	await mkdir(path.join(directory, "startup"));
	const runFile = path.join(directory, "running.json");
	const at = Date.now();
	const processStart = platform === "win32" ? "windows-filetime:134121123456789123" : "Mon Nov 9 00:00:00 2026";
	const run = { pid: 4242, port: 3001, startedAt: new Date(at).toISOString(), appRunId: "desktop-launch" };
	const record = { launchId: "daemon-launch", pid: run.pid, processStart, executable, startedAt: Math.floor(at / 1000) };
	const recordFile = path.join(directory, "startup/daemon-launch.json");
	await writeFile(runFile, JSON.stringify(run));
	await writeFile(recordFile, JSON.stringify(record));
	const execute = vi.fn(async (query: ProcessIdentityQuery) => {
		if (platform === "win32") {
			expect(query.command).toMatch(/powershell\.exe$/);
			expect(query.args.at(-1)).toContain("Get-Process -Id 4242");
			return JSON.stringify({ processStart, executable });
		}
		expect(query.command).toBe("ps");
		expect(query.args.at(-1)).toBe("4242");
		return processStart;
	});
	const probe = vi.fn<DaemonProber>(async (_port, endpoint) => ({ status: endpoint === "healthz" ? "ok" : "ready", service: "agent-orchestrator-daemon", pid: run.pid, executablePath: executable }));
	const options = {
		runFile, platform, launch: { command: executable, shell: false }, spawned: { at, appRunId: run.appRunId, wrapperPid: run.pid }, probe,
		identityError: () => null,
		processIdentity: (pid: number, target: NodeJS.Platform) => readDaemonProcessIdentity(pid, target, execute),
	};
	return { directory, executable, run, runFile, record, recordFile, execute, probe, options };
}

it("opens the Windows feature gate through native identity verification with no Unix ps", async () => {
	const f = await fixture("win32");
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "ready", pid: f.run.pid }), attachment: () => "windows-launch",
		handshake: async () => (await verifyDesktopDaemonHandshake(f.options)) !== null,
		cancelled: () => false, initializeFeatures,
	});
	expect(result).toEqual({ state: "verified" });
	expect(f.execute).toHaveBeenCalledTimes(2);
	expect(f.execute.mock.calls.every(([query]) => query.command !== "ps")).toBe(true);
	expect(initializeFeatures).toHaveBeenCalledOnce();
});

it("verifies a configured command with arguments using the daemon identity instead of its wrapper PID", async () => {
	const f = await fixture();
	const launch = resolveDaemonLaunch({ AO_DAEMON_COMMAND: `${f.executable} daemon --port=0` }, true, f.directory, f.directory, f.directory, "darwin");
	expect(launch).toMatchObject({ shell: true, source: "configured" });
	const wrapperPid = 2121;
	const options = { ...f.options, launch: launch!, spawned: { ...f.options.spawned, wrapperPid } };
	let verifiedPid: number | undefined;
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "ready", pid: wrapperPid }), attachment: () => `wrapper-${wrapperPid}`,
		handshake: async () => {
			const link = await verifyDesktopDaemonHandshake(options);
			verifiedPid = link?.pid;
			return link !== null;
		},
		cancelled: () => false,
		initializeFeatures: async () => { expect(verifiedPid).toBe(f.run.pid); },
	});
	expect(result).toEqual({ state: "verified" });
	expect(verifiedPid).not.toBe(wrapperPid);
	expect(f.probe.mock.calls).toEqual([[3001, "healthz"], [3001, "readyz"]]);
});

it("does not accept a different process PID for a direct executable launch", async () => {
	const f = await fixture();
	expect(await verifyDesktopDaemonHandshake({ ...f.options, spawned: { ...f.options.spawned, wrapperPid: 2121 } })).toBeNull();
});

for (const values of [{ appRunId: "other-launch" }, { startedAt: "2020-01-01T00:00:00Z" }]) it(`rejects a run file not correlated to this spawn: ${JSON.stringify(values)}`, async () => {
	const f = await fixture();
	await writeFile(f.runFile, JSON.stringify({ ...f.run, ...values }));
	expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
	expect(f.probe).not.toHaveBeenCalled();
});

it("requires matching live daemon service, PID, readiness, and install identity", async () => {
	const f = await fixture();
	for (const values of [{ service: "foreign" }, { pid: 2121 }, { executablePath: "/missing" }, { status: "starting" }]) {
		f.probe.mockImplementationOnce(async () => ({ status: "ok", service: "agent-orchestrator-daemon", pid: f.run.pid, executablePath: f.executable, ...values }));
		expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
	}
	expect(await verifyDesktopDaemonHandshake({ ...f.options, identityError: () => "foreign install" })).toBeNull();
});

it("does not replace native identity with readiness on Windows failure or PID reuse", async () => {
	const f = await fixture("win32");
	expect(await verifyDesktopDaemonHandshake({ ...f.options, processIdentity: async () => null })).toBeNull();
	f.execute.mockResolvedValueOnce(JSON.stringify({ processStart: f.record.processStart, executable: f.executable }));
	f.execute.mockResolvedValueOnce(JSON.stringify({ processStart: "windows-filetime:134121123456789124", executable: f.executable }));
	expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
});

it("rejects a Windows executable mismatch and a startup record for a different process", async () => {
	const f = await fixture("win32");
	const other = path.join(f.directory, "other.exe");
	await writeFile(other, "fixture");
	f.execute.mockResolvedValueOnce(JSON.stringify({ processStart: f.record.processStart, executable: other }));
	expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
	await writeFile(f.recordFile, JSON.stringify({ ...f.record, pid: 2121 }));
	expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
});

it("rejects a run-file replacement during live verification", async () => {
	const f = await fixture();
	f.probe.mockImplementation(async (_port, endpoint) => {
		if (endpoint === "readyz") await writeFile(f.runFile, JSON.stringify({ ...f.run, pid: 9999 }));
		return { status: endpoint === "healthz" ? "ok" : "ready", service: "agent-orchestrator-daemon", pid: f.run.pid, executablePath: f.executable };
	});
	expect(await verifyDesktopDaemonHandshake(f.options)).toBeNull();
});

it("verifies an adopted daemon only when the run file matches the current attachment", async () => {
	const f = await fixture();
	const options = { ...f.options, spawned: undefined, attachedPid: f.run.pid };
	expect((await verifyDesktopDaemonHandshake(options))?.pid).toBe(f.run.pid);
	expect(await verifyDesktopDaemonHandshake({ ...options, attachedPid: 2121 })).toBeNull();
	expect(JSON.parse(await readFile(f.runFile, "utf8")).pid).toBe(f.run.pid);
});
