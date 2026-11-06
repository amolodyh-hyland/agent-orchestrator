import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseProcessIdentity, processIdentityQuery } from "./daemon-process-identity";

export type DesktopPhase = "desktop-bootstrap" | "single-instance-check" | "electron-ready" | "version-policy" | "telemetry-policy" | "settings" | "daemon-discovery" | "shell-environment" | "daemon-spawn" | "daemon-handshake" | "window-runtime" | "renderer-ready" | "ready" | "failed";
export type CredentialOperation = "cloud-read" | "cloud-write" | "multica-capability" | "multica-encrypt" | "multica-decrypt";
type Operation = { operation: CredentialOperation; waitReason: "keychain-access"; startedAt: number };
export type DesktopStartupRecord = {
	version: 1;
	kind: "desktop";
	launchId: string;
	pid: number;
	processStart: string;
	executable: string;
	appVersion: string;
	startedAt: number;
	updatedAt: number;
	phase: DesktopPhase;
	stageStartedAt: number;
	heartbeatAt: number;
	heartbeatUptimeMs: number;
	clockDiscontinuity: boolean;
	powerState: "awake" | "suspended";
	waitReason: "keychain-access" | null;
	waitOperation: CredentialOperation | null;
	waitStartedAt: number | null;
	operations: Record<string, Operation>;
	lastCredentialResult?: { operation: CredentialOperation; result: "completed" | "unavailable"; durationMs: number };
	daemon?: { pid: number; launchId?: string };
};

export function desktopProcessStart(): string {
	try {
		const query = processIdentityQuery(process.pid, process.platform);
		const stdout = execFileSync(query.command, query.args, {
			encoding: "utf8", timeout: query.timeout, windowsHide: true, env: { ...process.env, LC_ALL: "C" },
		});
		return parseProcessIdentity(stdout, process.platform)?.processStart ?? "";
	} catch { return ""; }
}

export function createDesktopStartup(options: {
	directory: string; executable: string; appVersion: string; processStart: string;
	now?: () => number; uptime?: () => number; heartbeatMs?: number;
}) {
	const now = options.now ?? Date.now;
	const uptime = options.uptime ?? (() => performance.now());
	const seconds = () => Math.floor(now() / 1000);
	const directory = path.join(options.directory, "startup", "desktop");
	let executable = options.executable;
	try { executable = realpathSync(executable); } catch { /* Retain the supplied identity for diagnostics. */ }
	const record: DesktopStartupRecord = {
		version: 1, kind: "desktop", launchId: randomUUID(), pid: process.pid,
		processStart: options.processStart, executable, appVersion: options.appVersion,
		startedAt: seconds(), updatedAt: seconds(), phase: "desktop-bootstrap", stageStartedAt: seconds(),
		heartbeatAt: seconds(), heartbeatUptimeMs: uptime(), clockDiscontinuity: false,
		powerState: "awake", waitReason: null, waitOperation: null, waitStartedAt: null, operations: {},
	};
	const file = path.join(directory, `${record.launchId}.json`);
	function write() {
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			record.updatedAt = seconds();
			const pending = Object.values(record.operations)[0];
			record.waitOperation = pending?.operation ?? null;
			record.waitStartedAt = pending?.startedAt ?? null;
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, file);
			const directoryFd = openSync(directory, "r");
			try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		} catch { /* Startup diagnostics must not prevent daemon startup. */ }
		finally { try { unlinkSync(temporary); } catch { /* Already renamed or not created. */ } }
	}
	write();
	function heartbeat() {
		const time = seconds();
		if (time < record.heartbeatAt || time - record.heartbeatAt > 90) record.clockDiscontinuity = true;
		record.heartbeatAt = time;
		record.heartbeatUptimeMs = uptime();
		write();
	}
	const timer = setInterval(heartbeat, options.heartbeatMs ?? 5000);
	timer.unref();
	return {
		file,
		heartbeat,
		identify(processStart: string) { record.processStart = processStart; write(); },
		phase(phase: DesktopPhase) { record.phase = phase; record.stageStartedAt = seconds(); write(); },
		linkDaemon(pid: number, launchId?: string) { record.daemon = { pid, launchId: launchId ?? (record.daemon?.pid === pid ? record.daemon.launchId : undefined) }; write(); },
		power(state: "awake" | "suspended") { record.powerState = state; record.clockDiscontinuity = true; heartbeat(); },
		beginCredential(operation: CredentialOperation) {
			const id = randomUUID();
			const began = uptime();
			record.operations[id] = { operation, waitReason: "keychain-access", startedAt: seconds() };
			record.waitReason = "keychain-access";
			write();
			return (result: "completed" | "unavailable") => {
				delete record.operations[id];
				record.waitReason = Object.keys(record.operations).length ? "keychain-access" : null;
				record.lastCredentialResult = { operation, result, durationMs: Math.max(0, uptime() - began) };
				write();
			};
		},
		dispose() { clearInterval(timer); },
	};
}

export type DesktopStartup = ReturnType<typeof createDesktopStartup>;
let activeStartup: DesktopStartup | undefined;
export function setDesktopStartup(startup: DesktopStartup | undefined) { activeStartup = startup; }
export async function credentialAccess<T>(operation: CredentialOperation, action: () => Promise<T>): Promise<T> {
	const finish = activeStartup?.beginCredential(operation);
	try { const result = await action(); finish?.(result === false ? "unavailable" : "completed"); return result; }
	catch (error) { finish?.("unavailable"); throw error; }
}
