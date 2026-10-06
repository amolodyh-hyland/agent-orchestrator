import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonStatus } from "../shared/multica-daemon";

export const MULTICA_DEFAULT_HEALTH_PORT = 19514;
export const MULTICA_HEALTH_TIMEOUT_MS = 1000;
export const MULTICA_OWNER_MARKER_NAME = "multica-daemon-owner.json";

export type MulticaHealthPayload = {
	pid?: number;
	profile?: string;
	daemon_id?: string;
	server_url?: string;
};

export type RunningMulticaDaemon = {
	profiles: string[];
	port: number;
	pid?: number;
	daemonId?: string;
	serverUrl?: string;
};

export type MulticaDaemonGuardOptions = {
	homeDirectory: string;
	probeHealth: (port: number, timeoutMs: number) => Promise<MulticaHealthPayload | null>;
	readFile: (file: string) => Promise<string | null>;
	listDirectories: (directory: string) => Promise<string[]>;
	isPidAlive: (pid: number) => boolean;
};

export type MulticaDaemonOwnerMarker = {
	pid: number;
	profile: string;
	startedAt: string;
};

export type MulticaDaemonOwnerStore = {
	isOwnedDaemon: (status: DaemonStatus) => boolean;
	write: (status: DaemonStatus) => Promise<void>;
	remove: () => Promise<void>;
};

export function healthPortForProfile(profile: string): number {
	if (profile === "") return MULTICA_DEFAULT_HEALTH_PORT;
	let sum = 0;
	for (const byte of Buffer.from(profile, "utf8")) sum += byte;
	return MULTICA_DEFAULT_HEALTH_PORT + 1 + (sum % 1000);
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
		if (!isValidPid(marker.pid) || typeof marker.profile !== "string" || typeof marker.startedAt !== "string") return null;
		return { pid: marker.pid, profile: marker.profile, startedAt: marker.startedAt };
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

export function createMulticaDaemonOwnerStore(stateDirectory: string): MulticaDaemonOwnerStore {
	const markerPath = path.join(stateDirectory, MULTICA_OWNER_MARKER_NAME);
	return {
		isOwnedDaemon: (status) => {
			if (!isValidPid(status.pid)) return false;
			return readMulticaDaemonOwnerMarkerSync(stateDirectory)?.pid === status.pid;
		},
		write: async (status) => {
			if (!isValidPid(status.pid)) throw new Error("cannot record Multica daemon ownership without a pid");
			const marker: MulticaDaemonOwnerMarker = {
				pid: status.pid,
				profile: status.profile ?? "",
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

export async function listRunningMulticaDaemons(options: MulticaDaemonGuardOptions): Promise<RunningMulticaDaemon[]> {
	const multicaDirectory = path.join(options.homeDirectory, ".multica");
	const profileDirectory = path.join(multicaDirectory, "profiles");
	const namedProfiles = await options.listDirectories(profileDirectory);
	const profiles = ["", ...new Set(namedProfiles.filter((profile) => profile.length > 0))];
	const byPort = new Map<number, { profiles: string[]; pids: Array<number | undefined> }>();
	for (const profile of profiles) {
		const port = healthPortForProfile(profile);
		const profilePath = profile === "" ? multicaDirectory : path.join(profileDirectory, profile);
		const group = byPort.get(port) ?? { profiles: [], pids: [] };
		group.profiles.push(profile);
		group.pids.push(parsePid(await options.readFile(path.join(profilePath, "daemon.pid"))));
		byPort.set(port, group);
	}

	const results = await Promise.all(
		[...byPort.entries()].map(async ([port, group]): Promise<RunningMulticaDaemon | null> => {
			const health = await options.probeHealth(port, MULTICA_HEALTH_TIMEOUT_MS);
			const livePid = group.pids.find((pid): pid is number => pid !== undefined && options.isPidAlive(pid));
			if (health === null && livePid === undefined) return null;
			const daemon: RunningMulticaDaemon = { profiles: group.profiles, port };
			const pid = isValidPid(health?.pid) ? health.pid : livePid;
			if (pid !== undefined) daemon.pid = pid;
			if (typeof health?.daemon_id === "string") daemon.daemonId = health.daemon_id;
			if (typeof health?.server_url === "string") daemon.serverUrl = health.server_url;
			return daemon;
		}),
	);
	return results.filter((daemon): daemon is RunningMulticaDaemon => daemon !== null);
}
