import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { bootstrapDaemonBeforeFeatures, readDaemonStartupLink } from "./desktop-daemon-bootstrap";
import { createSafeStorageVault } from "./multica-awareness-env";

it("spawns and completes the daemon handshake before an unanswered credential request starts", async () => {
	const events: string[] = [];
	let resolveApproval!: (value: boolean) => void;
	const vault = createSafeStorageVault({
		isAsyncEncryptionAvailable: () => { events.push("credential"); return new Promise((resolve) => { resolveApproval = resolve; }); },
		encryptStringAsync: async () => Buffer.from("ciphertext"),
		decryptStringAsync: async () => ({ result: "fixture", shouldReEncrypt: false }),
	}, "darwin");
	let pending: Promise<boolean> | undefined;
	await bootstrapDaemonBeforeFeatures({
		start: async () => { events.push("spawn"); }, status: () => ({ state: "starting" }),
		handshake: async () => { events.push("handshake"); return true; }, cancelled: () => false,
		initializeFeatures: async () => { pending = vault.isProtected(); },
	});
	expect(events).toEqual(["spawn", "handshake", "credential"]);
	let ticked = false;
	await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 1));
	expect(ticked).toBe(true);
	resolveApproval(false);
	expect(await pending).toBe(false);
});

it("does not initialize features while a daemon handshake is pending or after cancellation", async () => {
	const initializeFeatures = vi.fn(async () => {});
	let cancelled = false;
	await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "starting" }), handshake: async () => false,
		cancelled: () => cancelled, initializeFeatures, wait: async () => { expect(initializeFeatures).not.toHaveBeenCalled(); cancelled = true; },
	});
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("captures the daemon launch link even if readiness wins the record-poll race", async () => {
	const events: string[] = [];
	await bootstrapDaemonBeforeFeatures({
		start: async () => { events.push("start"); }, status: () => ({ state: "ready", port: 3001, pid: 123 }),
		handshake: async () => { events.push("link"); return true; }, cancelled: () => false,
		initializeFeatures: async () => { events.push("features"); },
	});
	expect(events).toEqual(["start", "link", "features"]);
});

it("accepts only the daemon's exact live-launch identity and unchanged ciphertext paths", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-daemon-link-"));
	try {
		await mkdir(path.join(dir, "startup"));
		const identity = { pid: 123, processStart: "fixture-start", executable: process.execPath, spawnedAt: Date.now() };
		const record = { ...identity, launchId: "daemon-launch", startedAt: Math.floor(identity.spawnedAt / 1000) };
		const file = path.join(dir, "startup", "daemon-launch.json");
		await writeFile(file, JSON.stringify(record));
		expect(await readDaemonStartupLink(path.dirname(file), identity)).toEqual({ pid: 123, launchId: "daemon-launch" });
		for (const values of [{ pid: 124 }, { processStart: "reused-pid" }, { executable: "/missing" }, { launchId: "wrong-launch" }, { startedAt: 0 }]) {
			await writeFile(file, JSON.stringify({ ...record, ...values }));
			expect(await readDaemonStartupLink(path.dirname(file), identity)).toBeNull();
		}
		await writeFile(file, "{corrupt");
		expect(await readDaemonStartupLink(path.dirname(file), identity)).toBeNull();
	} finally { await rm(dir, { recursive: true, force: true }); }
});
