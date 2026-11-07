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
		if (!identity || Number(identity[1]) !== uid || platform === "darwin" && !path.isAbsolute(identity[3])) return null;
		const executable = await realpath(platform === "linux" ? `/proc/${pid}/exe` : identity[3]);
		const mappings = await run(platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fpn"], options);
		const lines = String(mappings.stdout).trim().split("\n");
		if (lines[0] !== `p${pid}` || lines.slice(1).some(line => line.startsWith("p"))) return null;
		const images = await Promise.all(lines.filter(line => line.startsWith("n/")).map(line => realpath(line.slice(1)).catch(() => null)));
		if (!images.includes(executable)) return null;
		return { pid, uid, start: identity[2], executable };
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
	// Decisions 28/29 trust same-user principals and their profile records; these
	// checks detect mismatched binaries, not a malicious user rewriting both.
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
		if (typeof config?.daemon_binary_path !== "string" || !path.isAbsolute(config.daemon_binary_path)) return null;
		const executable = await realpath(config.daemon_binary_path);
		let sha256 = config.daemon_binary_sha256;
		if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256))) return null;
		let manifestRaw: string | null = null;
		try {
			manifestRaw = await readBinaryManifest(path.join(path.dirname(executable), "bundle-manifest.json"));
			if (manifestRaw !== null) {
				const manifest = object(JSON.parse(manifestRaw));
				const entries = Array.isArray(manifest?.binaries) ? manifest.binaries.map(object).filter(entry => entry?.file === path.basename(executable)) : [];
				if (entries.length !== 1 || typeof entries[0]?.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entries[0].sha256)) return null;
				if (typeof sha256 === "string" && sha256.toLowerCase() !== entries[0].sha256.toLowerCase()) return null;
				sha256 = entries[0].sha256;
			}
		} catch { return null; }
		const pid = Number(values[2].trim());
		if (!serverOrigin || !record || !Number.isSafeInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535 || !Number.isSafeInteger(pid) || pid <= 1 || record.pid !== pid) return null;
		const daemonIds = values.slice(3).filter((value): value is string => value !== null).map((value) => value.trim()).filter((value) => UUID.test(value));
		if (!daemonIds.length) return null;
		return { serverOrigin, pid, port: Number(record.port), daemonIds, executable, sha256: typeof sha256 === "string" ? sha256.toLowerCase() : null,
			fingerprint: createHash("sha256").update(JSON.stringify([...values, executable, manifestRaw])).digest("hex") };
	}
	async function readBinaryManifest(file: string): Promise<string | null> {
		let handle;
		try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.uid !== uid && info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size > 256 * 1024) throw new Error("untrusted manifest");
			const bytes = Buffer.alloc(info.size + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			const after = await handle.stat();
			if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("changed manifest");
			return bytes.subarray(0, bytesRead).toString("utf8");
		} finally { await handle.close(); }
	}
	async function binaryMatches(config: { executable: string; sha256: string | null }, listener: Listener): Promise<boolean> {
		if (listener.executable !== config.executable || await realpath(listener.executable) !== config.executable) return false;
		const handle = await open(config.executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.uid !== uid && info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size > 256 * 1024 * 1024) return false;
			if (config.sha256 === null) return true;
			const digest = createHash("sha256");
			for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
			const after = await handle.stat();
			return info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs && digest.digest("hex") === config.sha256;
		} finally { await handle.close(); }
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
					if (!before || before.pid !== config.pid || before.uid !== uid || !await binaryMatches(config, before)) return false;
					const health = object(await probe(config.port, 1000));
					if (!health || health.status !== "running" || health.pid !== before.pid || health.profile !== profile || typeof health.daemon_id !== "string" || !config.daemonIds.includes(health.daemon_id) || origin(health.server_url) !== binding.origin || !Array.isArray(health.workspaces)) return false;
					const owned = health.workspaces.some((value) => {
						const workspace = object(value);
						return workspace?.id === binding.workspaceId && Array.isArray(workspace.runtimes) && workspace.runtimes.includes(runtimeId);
					});
					if (!owned) return false;
					const after = await inspect(config.port);
					const fresh = await metadata(profile);
					return after !== null && JSON.stringify(before) === JSON.stringify(after) && config.fingerprint === fresh?.fingerprint && await binaryMatches(config, after);
				} catch { return false; }
			}));
			return verified.includes(true) ? "local" : "unknown";
		} catch { return "unknown"; }
	};
}
