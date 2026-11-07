import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export type DaemonProcessIdentity = { processStart: string; executable?: string };
export type ProcessIdentityQuery = { command: string; args: string[]; timeout: number };

export function processIdentityQuery(pid: number, platform: NodeJS.Platform): ProcessIdentityQuery {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid process identity PID");
	if (platform !== "win32") return { command: "ps", args: ["-o", "lstart=", "-p", String(pid)], timeout: 2000 };
	const command = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; [pscustomobject]@{processStart=('windows-filetime:'+$p.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)); executable=$p.Path} | ConvertTo-Json -Compress`;
	return { command, args: ["-NoProfile", "-NonInteractive", "-Command", script], timeout: 5000 };
}

export function parseProcessIdentity(stdout: string, platform: NodeJS.Platform): DaemonProcessIdentity | null {
	if (platform !== "win32") {
		const processStart = stdout.trim().replace(/\s+/g, " ");
		return processStart ? { processStart } : null;
	}
	try {
		const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
		if (typeof value.processStart !== "string" || !/^windows-filetime:[1-9][0-9]{0,19}$/.test(value.processStart)) return null;
		if (typeof value.executable !== "string" || !value.executable.trim()) return null;
		return { processStart: value.processStart, executable: value.executable };
	} catch { return null; }
}

export async function readDaemonProcessIdentity(pid: number, platform: NodeJS.Platform, execute: (query: ProcessIdentityQuery) => Promise<string> = async (query) => {
	const { stdout } = await promisify(execFile)(query.command, query.args, { timeout: query.timeout, windowsHide: true, env: { ...process.env, LC_ALL: "C" } });
	return stdout;
}): Promise<DaemonProcessIdentity | null> {
	try { return parseProcessIdentity(await execute(processIdentityQuery(pid, platform)), platform); }
	catch { return null; }
}
