import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";

export async function native(operation, { target, pid, processStart, port } = {}) {
	const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
	const args = ["-NoProfile", "-NonInteractive", "-File", path.join(path.dirname(fileURLToPath(import.meta.url)), "native.ps1"), "-Operation", operation];
	if (target) args.push("-Target", target);
	if (pid) args.push("-ProcessId", String(pid));
	if (processStart) args.push("-Started", processStart);
	if (port) args.push("-Port", String(port));
	const { stdout } = await promisify(execFile)(powershell, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
	return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

export const samePath = (a, b) => typeof a === "string" && typeof b === "string" && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
export const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.processStart === b.processStart && samePath(a.executable, b.executable) && a.ownerSid === b.ownerSid;
export async function readJson(file) {
	try { return JSON.parse(await readFile(file, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function verifyProbe(run, probe, identity, daemonExe) {
	if (!run || !Number.isSafeInteger(run.pid) || run.pid <= 1 || !Number.isSafeInteger(run.port) || run.port < 1 || run.port > 65535 || !run.appRunId || run.owner !== "app" || probe?.pid !== run.pid || probe.service !== "agent-orchestrator-daemon" || !["ok", "ready"].includes(probe.status) || !samePath(probe.executablePath, daemonExe) || identity?.pid !== run.pid || !samePath(identity.executable, daemonExe) || !/^windows-filetime:[1-9][0-9]+$/.test(identity.processStart)) throw new Error("Unverified daemon ownership or health");
}

export async function request(port, route, body) {
	const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}), signal: AbortSignal.timeout(3000), redirect: "error" });
	if (!response.ok) throw new Error(`Daemon ${route} returned ${response.status}`);
	return await response.json();
}

export async function verifiedDaemon(runFile, daemonExe, { inspect = (pid) => native("inspect", { pid }), probe = request, listener = (pid, port) => native("listener", { pid, port }) } = {}) {
	const run = await readJson(runFile);
	if (!run) return null;
	const first = await inspect(run.pid);
	if (!first) return null;
	await listener(run.pid, run.port);
	const health = await probe(run.port, "/healthz");
	verifyProbe(run, health, first, daemonExe);
	const ready = await probe(run.port, "/readyz");
	verifyProbe(run, ready, first, daemonExe);
	const startup = path.join(path.dirname(runFile), "startup");
	const records = [];
	for (const file of await readdir(startup)) {
		if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
		const record = await readJson(path.join(startup, file));
		if (record?.pid === run.pid && record.processStart === first.processStart && samePath(record.executable, daemonExe) && record.phase === "ready") records.push(record);
	}
	if (records.length !== 1 || !sameProcess(first, await inspect(run.pid)) || JSON.stringify(run) !== JSON.stringify(await readJson(runFile))) throw new Error("Daemon startup identity changed or is unverified");
	await listener(run.pid, run.port);
	return { run, identity: first, startup: records[0] };
}

export async function waitGone(identity, { inspect = (pid) => native("inspect", { pid }), timeout = 60000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
	const until = Date.now() + timeout;
	do {
		const current = await inspect(identity.pid);
		if (!current) return;
		if (!sameProcess(identity, current)) throw new Error("PID was reused; leaving processes untouched");
		await sleep(500);
	} while (Date.now() < until);
	throw new Error("Graceful shutdown timed out; leaving installation intact");
}
