// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMulticaDaemonOwnerStore,
	healthPortForProfile,
	listRunningMulticaDaemons,
	MULTICA_OWNER_MARKER_NAME,
	type MulticaDaemonGuardOptions,
	type MulticaHealthPayload,
} from "./multica-daemon-guard";

let temporaryDirectory: string | undefined;

afterEach(() => {
	if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

function guard(overrides: Partial<MulticaDaemonGuardOptions> = {}) {
	const homeDirectory = "/home/test-user";
	const files = new Map<string, string>();
	const directories = new Map<string, string[]>();
	const health = new Map<number, MulticaHealthPayload | null>();
	const alive = new Set<number>();
	const options: MulticaDaemonGuardOptions = {
		homeDirectory,
		probeHealth: async (port) => health.get(port) ?? null,
		readFile: async (file) => files.get(file) ?? null,
		listDirectories: async (directory) => directories.get(directory) ?? [],
		isPidAlive: (pid) => alive.has(pid),
		...overrides,
	};
	return { options, files, directories, health, alive, homeDirectory };
}

describe("Multica daemon guard", () => {
	it("lists the default, named, and desktop-localhost profiles with health identity", async () => {
		const state = guard();
		const multicaDirectory = path.join(state.homeDirectory, ".multica");
		const profilesDirectory = path.join(multicaDirectory, "profiles");
		state.directories.set(profilesDirectory, ["desktop-localhost", "work"]);
		state.health.set(healthPortForProfile(""), { pid: 100, profile: "", daemon_id: "default-id", server_url: "https://default.test" });
		state.health.set(healthPortForProfile("work"), { pid: 101, profile: "work", daemon_id: "work-id", server_url: "https://work.test" });
		state.health.set(healthPortForProfile("desktop-localhost"), { pid: 102, profile: "desktop-localhost", daemon_id: "desktop-id", server_url: "https://desktop.test" });

		const daemons = await listRunningMulticaDaemons(state.options);

		expect(daemons).toEqual([
			{ profiles: [""], port: 19514, pid: 100, daemonId: "default-id", serverUrl: "https://default.test" },
			{ profiles: ["desktop-localhost"], port: healthPortForProfile("desktop-localhost"), pid: 102, daemonId: "desktop-id", serverUrl: "https://desktop.test" },
			{ profiles: ["work"], port: healthPortForProfile("work"), pid: 101, daemonId: "work-id", serverUrl: "https://work.test" },
		]);
	});

	it("reports a colliding health port once with every mapped profile name", async () => {
		const state = guard();
		const profilesDirectory = path.join(state.homeDirectory, ".multica", "profiles");
		state.directories.set(profilesDirectory, ["ab", "ba"]);
		state.health.set(healthPortForProfile("ab"), { pid: 201, profile: "ab", daemon_id: "collision" });

		const daemons = await listRunningMulticaDaemons(state.options);

		expect(healthPortForProfile("ab")).toBe(healthPortForProfile("ba"));
		expect(daemons).toEqual([{ profiles: ["ab", "ba"], port: healthPortForProfile("ab"), pid: 201, daemonId: "collision" }]);
	});

	it("ignores a stale pid file when the health port does not answer", async () => {
		const state = guard();
		const pidPath = path.join(state.homeDirectory, ".multica", "daemon.pid");
		state.files.set(pidPath, "98765\n");

		expect(await listRunningMulticaDaemons(state.options)).toEqual([]);
	});

	it("recognizes a live pid file even when health does not answer", async () => {
		const state = guard();
		const pidPath = path.join(state.homeDirectory, ".multica", "daemon.pid");
		state.files.set(pidPath, "44\n");
		state.alive.add(44);

		expect(await listRunningMulticaDaemons(state.options)).toEqual([{ profiles: [""], port: 19514, pid: 44 }]);
	});
});

describe("Multica daemon owner marker", () => {
	it("writes a marker with mode 0600 and survives service recreation", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		const store = createMulticaDaemonOwnerStore(temporaryDirectory);
		const status = { state: "running" as const, pid: 456, profile: "desktop-localhost" };

		await store.write(status);
		const markerPath = path.join(temporaryDirectory, MULTICA_OWNER_MARKER_NAME);
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { pid: number; profile: string; startedAt: string };
		const recreatedStore = createMulticaDaemonOwnerStore(temporaryDirectory);

		expect(statSync(markerPath).mode & 0o777).toBe(0o600);
		expect(marker).toMatchObject({ pid: 456, profile: "desktop-localhost" });
		expect(marker.startedAt).toEqual(expect.any(String));
		expect(recreatedStore.isOwnedDaemon(status)).toBe(true);
	});

	it("treats malformed markers as absent and removes the marker after stop", async () => {
		temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "multica-owner-"));
		const markerPath = path.join(temporaryDirectory, MULTICA_OWNER_MARKER_NAME);
		const store = createMulticaDaemonOwnerStore(temporaryDirectory);
		const status = { state: "running" as const, pid: 456 };

		writeFileSync(markerPath, "{bad json");
		expect(store.isOwnedDaemon(status)).toBe(false);
		await store.write(status);
		await store.remove();
		expect(() => readFileSync(markerPath)).toThrow();
	});
});
