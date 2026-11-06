import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { discoverMulticaProfiles } from "./multica-daemon-guard";
import { probeMulticaHealth } from "./multica-health-probe";
import type { DelegationRuntimeResolver } from "./multica-delegation-policy";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Listener = { pid: number; uid: number; start: string; executable: string };
type ProcessProbe = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string | Buffer }>;
export type RuntimeProvenanceOptions = {
	homeDirectory: string;
	uid: number;
	inspectListener: (port: number) => Promise<Listener | null>;
	probeHealth: (port: number, timeoutMs: number) => Promise<unknown>;
};

export async function inspectMulticaListener(port: number, platform = process.platform, run: ProcessProbe = exec): Promise<Listener | null> {
	if (platform !== "darwin" && platform !== "linux") return null;
	const options = { timeout: 1000, maxBuffer: 16 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } };
	try {
		const { stdout } = await run(platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpu"], options);
		const match = /^p(\d+)\nu(\d+)\n(?:f\d+\n)*$/.exec(String(stdout));
		if (!match) return null;
		const pid = Number(match[1]), uid = Number(match[2]);
		const result = await run("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,comm="], options);
		const identity = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(String(result.stdout));
		if (!identity || Number(identity[1]) !== uid || path.basename(identity[3]) !== "multica") return null;
		return { pid, uid, start: identity[2], executable: identity[3] };
	} catch { return null; }
}

function origin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
	} catch { return null; }
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createLocalMulticaRuntimeResolver(options: Partial<RuntimeProvenanceOptions> = {}): DelegationRuntimeResolver {
	const home = options.homeDirectory ?? os.homedir();
	const uid = options.uid ?? process.getuid?.();
	const inspect = options.inspectListener ?? ((port) => inspectMulticaListener(port));
	const probe = options.probeHealth ?? probeMulticaHealth;
	const root = path.join(home, ".multica");
	async function read(file: string): Promise<string | null> {
		try {
			const directory = path.dirname(file);
			const canonicalRoot = await realpath(root);
			const canonicalDirectory = await realpath(directory);
			const relative = path.relative(canonicalRoot, canonicalDirectory);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
			for (let current = directory; ; current = path.dirname(current)) {
				const info = await lstat(current);
				if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0) return null;
				if (current === root) break;
				if (path.dirname(current) === current) return null;
			}
			const named = await lstat(file);
			if (!named.isFile() || named.uid !== uid || (named.mode & 0o022) !== 0 || named.size > 256 * 1024) return null;
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const before = await handle.stat();
				if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.uid !== uid || (before.mode & 0o022) !== 0 || before.size > 256 * 1024) return null;
				const bytes = Buffer.alloc(before.size + 1);
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
				const after = await handle.stat();
				if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
				return bytes.subarray(0, bytesRead).toString("utf8");
			} finally { await handle.close(); }
		} catch { return null; }
	}
	async function metadata(profile: string) {
		const directory = profile ? path.join(root, "profiles", profile) : root;
		const values = await Promise.all([read(path.join(directory, "config.json")), read(path.join(directory, "daemon.port")), read(path.join(directory, "daemon.pid")), read(path.join(directory, "bundle-daemon.id")), read(path.join(directory, "daemon.id")), read(path.join(root, "daemon.id"))]);
		if (values[0] === null || values[1] === null || values[2] === null) return null;
		const config = object(JSON.parse(values[0]));
		const record = object(JSON.parse(values[1]));
		const serverOrigin = origin(config?.server_url);
		const pid = Number(values[2].trim());
		if (!serverOrigin || !record || !Number.isSafeInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535 || !Number.isSafeInteger(pid) || pid <= 1 || record.pid !== pid) return null;
		const daemonIds = values.slice(3).filter((value): value is string => value !== null).map((value) => value.trim()).filter((value) => UUID.test(value));
		if (!daemonIds.length) return null;
		return { serverOrigin, pid, port: Number(record.port), daemonIds, fingerprint: createHash("sha256").update(JSON.stringify(values)).digest("hex") };
	}
	return async (binding, runtimeId) => {
		if (uid === undefined || !UUID.test(runtimeId) || !UUID.test(binding.workspaceId) || origin(binding.origin) !== binding.origin) return "unknown";
		try {
			const profiles = ["", ...await discoverMulticaProfiles(path.join(root, "profiles"))];
			if (profiles.length > 32) return "unknown";
			const verified = await Promise.all(profiles.map(async (profile) => {
				try {
					const config = await metadata(profile);
					if (!config || config.serverOrigin !== binding.origin) return false;
					const before = await inspect(config.port);
					if (!before || before.pid !== config.pid || before.uid !== uid) return false;
					const health = object(await probe(config.port, 1000));
					if (!health || health.status !== "running" || health.pid !== before.pid || health.profile !== profile || typeof health.daemon_id !== "string" || !config.daemonIds.includes(health.daemon_id) || origin(health.server_url) !== binding.origin || !Array.isArray(health.workspaces)) return false;
					const owned = health.workspaces.some((value) => {
						const workspace = object(value);
						return workspace?.id === binding.workspaceId && Array.isArray(workspace.runtimes) && workspace.runtimes.includes(runtimeId);
					});
					if (!owned) return false;
					const after = await inspect(config.port);
					const fresh = await metadata(profile);
					return after !== null && JSON.stringify(before) === JSON.stringify(after) && config.fingerprint === fresh?.fingerprint;
				} catch { return false; }
			}));
			return verified.includes(true) ? "local" : "unknown";
		} catch { return "unknown"; }
	};
}
