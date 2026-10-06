// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMulticaDaemonOwnerStore,
	healthPortForProfile,
	listRunningMulticaDaemons,
	MULTICA_PROFILE_DISCOVERY_MAX_DEPTH,
	MULTICA_OWNER_MARKER_NAME,
	type MulticaDaemonGuardOptions,
	type MulticaDaemonScanResult,
	type ProfileDiscoveryFs,
	type RunningMulticaDaemon,
} from "./multica-daemon-guard";

let temporaryDirectory: string | undefined;

afterEach(() => {
	if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

function guard(overrides: Partial<MulticaDaemonGuardOptions> = {}) {
	temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-guard-"));
	const homeDirectory = temporaryDirectory;
	const profilesDirectory = path.join(homeDirectory, ".multica", "profiles");
	mkdirSync(profilesDirectory, { recursive: true });
	const files = new Map<string, string>();
	const fileReads: string[] = [];
	const health = new Map<number, unknown | null>();
	const probeCalls: number[] = [];
	const alive = new Set<number>();
	const multica = new Set<number>();
	const profileFs: ProfileDiscoveryFs = {
		readdir: async (directory) => readdir(directory, { withFileTypes: true }),
		realpath,
		stat,
	};
	const options: MulticaDaemonGuardOptions = {
		homeDirectory,
		probeHealth: async (port) => {
			probeCalls.push(port);
			return health.get(port) ?? null;
		},
		readFile: async (file) => {
			fileReads.push(file);
			return files.get(file) ?? null;
		},
		profileFs,
		isPidAlive: (pid) => alive.has(pid),
		isMulticaProcess: (pid) => multica.has(pid),
		...overrides,
	};
	const addProfile = (profile: string): string => {
		const profilePath = path.join(profilesDirectory, profile);
		mkdirSync(profilePath, { recursive: true });
		writeFileSync(path.join(profilePath, "config.json"), "{}");
		return profilePath;
	};
	return { options, files, fileReads, health, probeCalls, alive, multica, homeDirectory, profilesDirectory, addProfile };
}

const known = (daemons: RunningMulticaDaemon[]): MulticaDaemonScanResult => ({ state: "known", daemons });

describe("Multica daemon guard", () => {
	it("lists the default, named, and desktop-localhost profiles with health identity", async () => {
		const state = guard();
		state.addProfile("desktop-localhost");
		state.addProfile("work");
		state.health.set(healthPortForProfile(""), { status: "running", pid: 100, profile: "", daemon_id: "default-id", server_url: "https://default.test" });
		state.health.set(healthPortForProfile("work"), { status: "starting", pid: 101, profile: "work", daemon_id: "work-id", server_url: "https://work.test" });
		state.health.set(healthPortForProfile("desktop-localhost"), { status: "running", pid: 102, profile: "desktop-localhost", daemon_id: "desktop-id", server_url: "https://desktop.test" });

		const daemons = await listRunningMulticaDaemons(state.options);

		expect(daemons).toEqual(known([
			{ profiles: [""], profile: "", port: 19514, pid: 100, daemonId: "default-id", serverUrl: "https://default.test" },
			{ profiles: ["desktop-localhost"], profile: "desktop-localhost", port: healthPortForProfile("desktop-localhost"), pid: 102, daemonId: "desktop-id", serverUrl: "https://desktop.test" },
			{ profiles: ["work"], profile: "work", port: healthPortForProfile("work"), pid: 101, daemonId: "work-id", serverUrl: "https://work.test" },
		]));
	});

	it("uses the health payload profile when it differs from the probed profile", async () => {
		const state = guard();
		state.health.set(healthPortForProfile(""), { status: "running", pid: 100, profile: "reported-profile", daemon_id: "daemon" });

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([
			{ profiles: ["reported-profile"], profile: "reported-profile", port: 19514, pid: 100, daemonId: "daemon" },
		]));
	});

	it("reports a colliding health port once using the responder's profile", async () => {
		const state = guard();
		state.addProfile("ab");
		state.addProfile("ba");
		state.health.set(healthPortForProfile("ab"), { status: "running", pid: 201, profile: "ba", daemon_id: "collision" });

		const daemons = await listRunningMulticaDaemons(state.options);

		expect(healthPortForProfile("ab")).toBe(healthPortForProfile("ba"));
		expect(daemons).toEqual(known([{ profiles: ["ba"], profile: "ba", port: healthPortForProfile("ab"), pid: 201, daemonId: "collision" }]));
	});

	it("discovers nested names and maps them to the nested daemon pid path", async () => {
		const state = guard();
		state.addProfile("team/dev");
		state.health.set(healthPortForProfile("team/dev"), { status: "running", pid: 301, profile: "team/dev" });

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([
			{ profiles: ["team/dev"], profile: "team/dev", port: healthPortForProfile("team/dev"), pid: 301 },
		]));
		expect(state.fileReads).toContain(path.join(state.profilesDirectory, "team", "dev", "daemon.pid"));
	});

	it.skipIf(process.platform === "win32")("follows a directory symlink whose target stays inside the profiles root", async () => {
		const state = guard();
		const target = state.addProfile("actual-profile");
		symlinkSync(target, path.join(state.profilesDirectory, "linked-profile"), "dir");
		state.health.set(healthPortForProfile("linked-profile"), { status: "running", pid: 302, profile: "linked-profile" });

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([
			{ profiles: ["linked-profile"], profile: "linked-profile", port: healthPortForProfile("linked-profile"), pid: 302 },
		]));
		expect(state.fileReads).toContain(path.join(state.profilesDirectory, "linked-profile", "daemon.pid"));
	});

	it.skipIf(process.platform === "win32")("skips a directory symlink that points outside the profiles root", async () => {
		const state = guard();
		const outside = path.join(state.homeDirectory, ".multica", "outside-profile");
		mkdirSync(outside, { recursive: true });
		writeFileSync(path.join(outside, "config.json"), "{}");
		symlinkSync(outside, path.join(state.profilesDirectory, "outside"), "dir");

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([]));
		expect(state.probeCalls).toEqual([19514]);
	});

	it.skipIf(process.platform === "win32")("skips a directory symlink cycle", async () => {
		const state = guard();
		state.addProfile("team/dev");
		symlinkSync(path.join(state.profilesDirectory, "team"), path.join(state.profilesDirectory, "team", "dev", "loop"), "dir");
		state.health.set(healthPortForProfile("team/dev"), { status: "running", pid: 303, profile: "team/dev" });

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([
			{ profiles: ["team/dev"], profile: "team/dev", port: healthPortForProfile("team/dev"), pid: 303 },
		]));
	});

	it("returns unknown when profile discovery reaches its depth bound", async () => {
		const state = guard();
		const profile = Array.from({ length: MULTICA_PROFILE_DISCOVERY_MAX_DEPTH + 1 }, (_, index) => `level${index + 1}`).join("/");
		state.addProfile(profile);

		expect(await listRunningMulticaDaemons(state.options)).toEqual({ state: "unknown" });
	});

	it("returns unknown when profile discovery reaches its entry bound", async () => {
		const state = guard();
		for (let index = 0; index <= 500; index++) writeFileSync(path.join(state.profilesDirectory, `entry-${index}`), "");

		expect(await listRunningMulticaDaemons(state.options)).toEqual({ state: "unknown" });
	});

	it("ignores a stale pid file when the health port does not answer", async () => {
		const state = guard();
		const pidPath = path.join(state.homeDirectory, ".multica", "daemon.pid");
		state.files.set(pidPath, "98765\n");

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([]));
	});

	it("ignores a live pid reused by an unrelated process", async () => {
		const state = guard();
		const pidPath = path.join(state.homeDirectory, ".multica", "daemon.pid");
		state.files.set(pidPath, "44\n");
		state.alive.add(44);
		state.multica.delete(44);

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([]));
	});

	it("counts a live Multica process when health does not answer", async () => {
		const state = guard();
		const pidPath = path.join(state.homeDirectory, ".multica", "daemon.pid");
		state.files.set(pidPath, "44\n");
		state.alive.add(44);
		state.multica.add(44);

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([{ profiles: [""], profile: "", port: 19514, pid: 44 }]));
	});

	it("keeps conservative live-pid behavior on Windows", async () => {
		const state = guard({ platform: "win32", isMulticaProcess: undefined });
		state.files.set(path.join(state.homeDirectory, ".multica", "daemon.pid"), "44");
		state.alive.add(44);

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([{ profiles: [""], profile: "", port: 19514, pid: 44 }]));
	});

	it.each([{}, [], null, "not json", { status: "stopped", pid: 45 }])("ignores an invalid health payload %j", async (payload) => {
		const state = guard();
		state.health.set(19514, payload);

		expect(await listRunningMulticaDaemons(state.options)).toEqual(known([]));
	});

	it("preserves an unknown result when the health probe cannot run", async () => {
		const state = guard({ probeHealth: async () => { throw new Error("probe failed"); } });

		expect(await listRunningMulticaDaemons(state.options)).toEqual({ state: "unknown" });
	});

	it("preserves an unknown result when process identity cannot be checked", async () => {
		const state = guard({ isMulticaProcess: () => undefined });
		state.files.set(path.join(state.homeDirectory, ".multica", "daemon.pid"), "44");
		state.alive.add(44);

		expect(await listRunningMulticaDaemons(state.options)).toEqual({ state: "unknown" });
	});
});

describe("Multica daemon owner marker", () => {
	const storeOptions = { readProcessStart: async () => "Mon Jan  2 15:04:05 2006" };

	it("writes a process identity marker with mode 0600 and survives service recreation", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		const store = createMulticaDaemonOwnerStore(temporaryDirectory, storeOptions);
		const status = { state: "running" as const, pid: 456, profile: "desktop-localhost", daemonId: "d1" };

		await store.write(status);
		const markerPath = path.join(temporaryDirectory, MULTICA_OWNER_MARKER_NAME);
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { pid: number; profile: string; daemonId: string; processStart: string; startedAt: string };
		const recreatedStore = createMulticaDaemonOwnerStore(temporaryDirectory, storeOptions);

		expect(statSync(markerPath).mode & 0o777).toBe(0o600);
		expect(marker).toMatchObject({ pid: 456, profile: "desktop-localhost", daemonId: "d1", processStart: "Mon Jan  2 15:04:05 2006" });
		expect(marker.startedAt).toEqual(expect.any(String));
		expect(await recreatedStore.isOwnedDaemon(status)).toBe(true);
	});

	it("does not own a recycled pid in another profile or with another process start", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		let processStart = "old process";
		const store = createMulticaDaemonOwnerStore(temporaryDirectory, { readProcessStart: async () => processStart });
		const status = { state: "running" as const, pid: 456, profile: "work", daemonId: "d1" };

		await store.write(status);
		expect(await store.isOwnedDaemon({ ...status, profile: "other" })).toBe(false);
		expect(await store.isOwnedDaemon({ ...status, daemonId: "another-daemon" })).toBe(false);
		processStart = "recycled process";
		expect(await store.isOwnedDaemon(status)).toBe(false);
	});

	it("ignores malformed markers and can remove a marker after stop", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		const markerPath = path.join(temporaryDirectory, MULTICA_OWNER_MARKER_NAME);
		const store = createMulticaDaemonOwnerStore(temporaryDirectory, storeOptions);
		const status = { state: "running" as const, pid: 456 };

		writeFileSync(markerPath, "{bad json");
		expect(await store.isOwnedDaemon(status)).toBe(false);
		await store.write(status);
		await store.remove();
		expect(() => readFileSync(markerPath)).toThrow();
	});

	it("uses the required process-start command on macOS and skips it on Windows", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		const calls: string[][] = [];
		const execFile = (file: string, args: string[], _options: { timeout: number; maxBuffer: number; windowsHide: boolean }, callback: (error: Error | null, stdout: string) => void) => {
			calls.push([file, ...args]);
			callback(null, "  process start  \n");
		};
		const darwin = createMulticaDaemonOwnerStore(temporaryDirectory, { platform: "darwin", execFile });
		await darwin.write({ state: "running", pid: 8 });
		expect(calls).toEqual([["ps", "-o", "lstart=", "-p", "8"]]);
		expect(readFileSync(path.join(temporaryDirectory, MULTICA_OWNER_MARKER_NAME), "utf8")).toContain("process start");

		calls.length = 0;
		const windows = createMulticaDaemonOwnerStore(temporaryDirectory, { platform: "win32", execFile });
		await windows.write({ state: "running", pid: 9 });
		expect(calls).toEqual([]);
	});
});
