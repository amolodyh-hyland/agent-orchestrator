import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonStatus } from "../shared/multica-daemon";

export const MULTICA_DEFAULT_HEALTH_PORT = 19514;
export const MULTICA_HEALTH_TIMEOUT_MS = 1000;
export const MULTICA_OWNER_MARKER_NAME = "multica-daemon-owner.json";

export type MulticaHealthPayload = {
	status?: string;
	pid?: number;
	profile?: string;
	daemon_id?: string;
	server_url?: string;
};

export type RunningMulticaDaemon = {
	profiles: string[];
	port: number;
	profile?: string;
	pid?: number;
	daemonId?: string;
	serverUrl?: string;
};

export type MulticaDaemonScanResult = { state: "known"; daemons: RunningMulticaDaemon[] } | { state: "unknown" };

export type MulticaDaemonGuardOptions = {
	homeDirectory: string;
	probeHealth: (port: number, timeoutMs: number) => Promise<unknown | null>;
	readFile: (file: string) => Promise<string | null>;
	profileFs?: ProfileDiscoveryFs;
	isPidAlive: (pid: number) => boolean;
	platform?: NodeJS.Platform;
	isMulticaProcess?: (pid: number) => boolean | undefined | Promise<boolean | undefined>;
};

export const MULTICA_PROFILE_DISCOVERY_MAX_DEPTH = 6;
export const MULTICA_PROFILE_DISCOVERY_MAX_ENTRIES = 500;

export type ProfileDiscoveryEntry = {
	name: string;
	isDirectory: () => boolean;
	isSymbolicLink: () => boolean;
};

export type ProfileDiscoveryFs = {
	readdir: (directory: string) => Promise<ProfileDiscoveryEntry[]>;
	realpath: (file: string) => Promise<string>;
	stat: (file: string) => Promise<{ isDirectory: () => boolean }>;
};

const defaultProfileDiscoveryFs: ProfileDiscoveryFs = {
	readdir: async (directory) => readdir(directory, { withFileTypes: true }),
	realpath,
	stat,
};

export type MulticaDaemonOwnerMarker = {
	pid: number;
	profile: string;
	daemonId?: string;
	processStart?: string;
	startedAt: string;
};

export type MulticaDaemonOwnerStore = {
	isOwnedDaemon: (status: DaemonStatus) => Promise<boolean>;
	write: (status: DaemonStatus) => Promise<void>;
	remove: () => Promise<void>;
};

export type OwnerStoreOptions = {
	platform?: NodeJS.Platform;
	readProcessStart?: (pid: number) => Promise<string | undefined>;
	execFile?: (
		file: string,
		args: string[],
		options: { timeout: number; maxBuffer: number; windowsHide: boolean },
		callback: (error: Error | null, stdout: string | Buffer) => void,
	) => unknown;
};

export function healthPortForProfile(profile: string): number {
	if (profile === "") return MULTICA_DEFAULT_HEALTH_PORT;
	let sum = 0;
	for (const byte of Buffer.from(profile, "utf8")) sum += byte;
	return MULTICA_DEFAULT_HEALTH_PORT + 1 + (sum % 1000);
}

function isInsideDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function discoverMulticaProfiles(
	profilesRoot: string,
	fs: ProfileDiscoveryFs = defaultProfileDiscoveryFs,
): Promise<string[]> {
	let rootRealPath: string;
	try {
		rootRealPath = await fs.realpath(profilesRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!(await fs.stat(rootRealPath)).isDirectory()) throw new Error("Multica profiles root is not a directory");

	const profiles = new Set<string>();
	let entriesSeen = 0;
	const walk = async (directory: string, logicalDirectory: string, depth: number, ancestors: Set<string>): Promise<void> => {
		const entries = await fs.readdir(directory);
		for (const entry of entries) {
			entriesSeen++;
			if (entriesSeen > MULTICA_PROFILE_DISCOVERY_MAX_ENTRIES) throw new Error("Multica profile discovery entry limit exceeded");
			if (entry.name === "config.json" && !entry.isDirectory()) {
				const profile = path.relative(profilesRoot, logicalDirectory).split(path.sep).join("/");
				if (profile && profile !== ".") profiles.add(profile);
			}

			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const childPath = path.join(directory, entry.name);
			let childRealPath: string;
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const childStat = await fs.stat(childPath);
					if (!childStat.isDirectory()) continue;
					childRealPath = await fs.realpath(childPath);
					isDirectory = true;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT" || code === "ELOOP") continue;
					throw error;
				}
			} else {
				childRealPath = await fs.realpath(childPath);
			}
			if (!isDirectory) continue;
			if (!isInsideDirectory(rootRealPath, childRealPath)) {
				if (entry.isSymbolicLink()) throw new Error("Multica profile symlink resolves outside the profiles root");
				continue;
			}
			if (ancestors.has(childRealPath)) continue;
			const childDepth = depth + 1;
			if (childDepth > MULTICA_PROFILE_DISCOVERY_MAX_DEPTH) throw new Error("Multica profile discovery depth limit exceeded");
			const childAncestors = new Set(ancestors);
			childAncestors.add(childRealPath);
			await walk(childPath, path.join(logicalDirectory, entry.name), childDepth, childAncestors);
		}
	};

	await walk(profilesRoot, profilesRoot, 0, new Set([rootRealPath]));
	return [...profiles].sort();
}

function parsePid(value: string | null): number | undefined {
	if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
	const pid = Number(value.trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isValidPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseOwnerMarker(value: string | null): MulticaDaemonOwnerMarker | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const marker = parsed as Record<string, unknown>;
		if (
			!isValidPid(marker.pid) ||
			typeof marker.profile !== "string" ||
			typeof marker.startedAt !== "string" ||
			(marker.daemonId !== undefined && typeof marker.daemonId !== "string") ||
			(marker.processStart !== undefined && typeof marker.processStart !== "string")
		)
			return null;
		return {
			pid: marker.pid,
			profile: marker.profile,
			...(typeof marker.daemonId === "string" ? { daemonId: marker.daemonId } : {}),
			...(typeof marker.processStart === "string" ? { processStart: marker.processStart } : {}),
			startedAt: marker.startedAt,
		};
	} catch {
		return null;
	}
}

export function readMulticaDaemonOwnerMarkerSync(stateDirectory: string): MulticaDaemonOwnerMarker | null {
	try {
		return parseOwnerMarker(readFileSync(path.join(stateDirectory, MULTICA_OWNER_MARKER_NAME), "utf8"));
	} catch {
		return null;
	}
}

async function readProcessStart(
	pid: number,
	platform: NodeJS.Platform,
	exec: NonNullable<OwnerStoreOptions["execFile"]>,
): Promise<string | undefined> {
	if (platform !== "darwin" && platform !== "linux") return undefined;
	return new Promise((resolve) => {
		exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
			const value = error ? "" : String(stdout).trim();
			resolve(value || undefined);
		});
	});
}

export function createMulticaDaemonOwnerStore(stateDirectory: string, options: OwnerStoreOptions = {}): MulticaDaemonOwnerStore {
	const markerPath = path.join(stateDirectory, MULTICA_OWNER_MARKER_NAME);
	const platform = options.platform ?? process.platform;
	const exec = options.execFile ?? ((file, args, execOptions, callback) => nodeExecFile(file, args, execOptions, (error, stdout) => callback(error, stdout)));
	const getProcessStart = options.readProcessStart ?? ((pid) => readProcessStart(pid, platform, exec));
	return {
		isOwnedDaemon: async (status) => {
			if (platform === "win32" || !isValidPid(status.pid)) return false;
			const marker = readMulticaDaemonOwnerMarkerSync(stateDirectory);
			if (!marker || marker.pid !== status.pid || marker.profile !== (status.profile ?? "") || !marker.processStart) return false;
			if (marker.daemonId !== undefined && marker.daemonId !== status.daemonId) return false;
			let processStart: string | undefined;
			try {
				processStart = await getProcessStart(status.pid);
			} catch {
				return false;
			}
			return Boolean(processStart) && marker.processStart === processStart;
		},
		write: async (status) => {
			if (!isValidPid(status.pid)) throw new Error("cannot record Multica daemon ownership without a pid");
			const processStart = await getProcessStart(status.pid);
			const marker: MulticaDaemonOwnerMarker = {
				pid: status.pid,
				profile: status.profile ?? "",
				...(status.daemonId !== undefined ? { daemonId: status.daemonId } : {}),
				...(processStart !== undefined ? { processStart } : {}),
				startedAt: new Date().toISOString(),
			};
			await mkdir(stateDirectory, { recursive: true });
			const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, JSON.stringify(marker), { encoding: "utf8", mode: 0o600, flag: "wx" });
				await chmod(temporaryPath, 0o600);
				await rename(temporaryPath, markerPath);
			} finally {
				await rm(temporaryPath, { force: true });
			}
		},
		remove: async () => {
			await rm(markerPath, { force: true });
		},
	};
}

function parseHealthPayload(value: unknown): MulticaHealthPayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const payload = value as Record<string, unknown>;
	if (
		(payload.status !== "running" && payload.status !== "starting") ||
		!isValidPid(payload.pid) ||
		typeof payload.daemon_id !== "string" ||
		payload.daemon_id.trim().length === 0
	)
		return null;
	return payload as MulticaHealthPayload;
}

function isMulticaDaemonProcess(pid: number, platform: NodeJS.Platform): Promise<boolean | undefined> {
	if (platform === "win32") return Promise.resolve(true);
	if (platform !== "darwin" && platform !== "linux") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		nodeExecFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 2000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const command = String(stdout).toLowerCase();
			resolve(command.includes("multica") && command.includes("daemon"));
		});
	});
}

export async function listRunningMulticaDaemons(options: MulticaDaemonGuardOptions): Promise<MulticaDaemonScanResult> {
	const multicaDirectory = path.join(options.homeDirectory, ".multica");
	const profileDirectory = path.join(multicaDirectory, "profiles");
	try {
		const namedProfiles = await discoverMulticaProfiles(profileDirectory, options.profileFs);
		const profiles = ["", ...namedProfiles];
		const byPort = new Map<number, { profiles: string[]; pids: Array<{ profile: string; pid: number | undefined }> }>();
		for (const profile of profiles) {
			const port = healthPortForProfile(profile);
			const profilePath = profile === "" ? multicaDirectory : path.join(profileDirectory, profile);
			const group = byPort.get(port) ?? { profiles: [], pids: [] };
			group.profiles.push(profile);
			group.pids.push({ profile, pid: parsePid(await options.readFile(path.join(profilePath, "daemon.pid"))) });
			byPort.set(port, group);
		}
		const results = await Promise.all(
			[...byPort.entries()].map(async ([port, group]): Promise<RunningMulticaDaemon | null> => {
				const health = parseHealthPayload(await options.probeHealth(port, MULTICA_HEALTH_TIMEOUT_MS));
				if (health) {
					const profile = typeof health.profile === "string" ? health.profile : group.profiles[0] ?? "";
					const daemon: RunningMulticaDaemon = { profiles: [profile], profile, port };
					if (isValidPid(health.pid)) daemon.pid = health.pid;
					if (typeof health.daemon_id === "string") daemon.daemonId = health.daemon_id;
					if (typeof health.server_url === "string") daemon.serverUrl = health.server_url;
					return daemon;
				}
				for (const candidate of group.pids) {
					if (candidate.pid === undefined || !options.isPidAlive(candidate.pid)) continue;
					const isMultica = await (options.isMulticaProcess ?? ((pid) => isMulticaDaemonProcess(pid, options.platform ?? process.platform)))(candidate.pid);
					if (isMultica === undefined) throw new Error("could not inspect process identity");
					if (!isMultica) continue;
					return { profiles: [candidate.profile], profile: candidate.profile, port, pid: candidate.pid };
				}
				return null;
			}),
		);
		return { state: "known", daemons: results.filter((daemon): daemon is RunningMulticaDaemon => daemon !== null) };
	} catch {
		return { state: "unknown" };
	}
}
