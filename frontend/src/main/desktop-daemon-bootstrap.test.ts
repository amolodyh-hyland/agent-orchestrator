import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { bootstrapDaemonBeforeFeatures, bootstrapDaemonWithRecovery, readDaemonStartupLink } from "./desktop-daemon-bootstrap";
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
		attachment: () => "daemon-123",
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
		attachment: () => "daemon-123",
		cancelled: () => cancelled, initializeFeatures, wait: async () => { expect(initializeFeatures).not.toHaveBeenCalled(); cancelled = true; },
	});
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("captures the daemon launch link even if readiness wins the record-poll race", async () => {
	const events: string[] = [];
	await bootstrapDaemonBeforeFeatures({
		start: async () => { events.push("start"); }, status: () => ({ state: "ready", port: 3001, pid: 123 }),
		attachment: () => "daemon-123",
		handshake: async () => { events.push("link"); return true; }, cancelled: () => false,
		initializeFeatures: async () => { events.push("features"); },
	});
	expect(events).toEqual(["start", "link", "features"]);
});

it("does not release features for a ready daemon with an unverified handshake", async () => {
	const initializeFeatures = vi.fn(async () => {});
	const handshake = vi.fn(async () => false);
	let now = 0;
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "ready", port: 3001, pid: 123 }),
		attachment: () => "daemon-123", handshake, cancelled: () => false, initializeFeatures,
		now: () => now, timeoutMs: 2, wait: async () => { now++; },
	});
	expect(result).toEqual({ state: "unverified" });
	expect(handshake).toHaveBeenCalledTimes(2);
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("keeps verifying when starting changes to ready after a false handshake", async () => {
	let ready = false;
	const events: string[] = [];
	const handshake = vi.fn(async () => { events.push("handshake"); return ready; });
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ready ? { state: "ready", pid: 123 } : { state: "starting" },
		attachment: () => "daemon-123", handshake, cancelled: () => false,
		initializeFeatures: async () => { events.push("features"); },
		wait: async () => { events.push("ready"); ready = true; },
	});
	expect(result).toEqual({ state: "verified" });
	expect(events).toEqual(["handshake", "ready", "handshake", "features"]);
});

for (const state of ["error", "stopped"] as const) it(`does not release features after ${state} before spawn`, async () => {
	const handshake = vi.fn(async () => true);
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state }), attachment: () => null,
		handshake, cancelled: () => false, initializeFeatures,
	});
	expect(result).toEqual({ state: "failed" });
	expect(handshake).not.toHaveBeenCalled();
	expect(initializeFeatures).not.toHaveBeenCalled();
});

for (const verified of [false, true]) it(`honors cancellation during a ${verified ? "successful" : "failed"} handshake`, async () => {
	let cancelled = false;
	let complete!: (value: boolean) => void;
	const initializeFeatures = vi.fn(async () => {});
	const pending = bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "starting" }), attachment: () => "daemon-123",
		handshake: () => new Promise((resolve) => { complete = resolve; }), cancelled: () => cancelled, initializeFeatures,
	});
	await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
	cancelled = true;
	complete(verified);
	expect(await pending).toEqual({ state: "cancelled" });
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("reports a rejected start without releasing features", async () => {
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => { throw new Error("spawn failed"); }, status: () => ({ state: "starting" }),
		attachment: () => null, handshake: async () => true, cancelled: () => false, initializeFeatures,
	});
	expect(result).toEqual({ state: "failed" });
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("re-verifies a replacement attachment instead of releasing on the previous handshake", async () => {
	let attachment = "daemon-123";
	const initializeFeatures = vi.fn(async () => {});
	const handshake = vi.fn(async () => {
		if (handshake.mock.calls.length === 1) attachment = "daemon-456";
		return true;
	});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "ready" }), attachment: () => attachment,
		handshake, cancelled: () => false, initializeFeatures,
		wait: async () => { expect(initializeFeatures).not.toHaveBeenCalled(); },
	});
	expect(result).toEqual({ state: "verified" });
	expect(handshake).toHaveBeenCalledTimes(2);
	expect(initializeFeatures).toHaveBeenCalledOnce();
});

it("does not release a positive handshake if the daemon fails before it completes", async () => {
	let failed = false;
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: failed ? "error" : "starting" }), attachment: () => "daemon-123",
		handshake: async () => { failed = true; return true; }, cancelled: () => false, initializeFeatures,
	});
	expect(result).toEqual({ state: "failed" });
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("keeps legacy starts without an attachment behind the safe unverified path", async () => {
	let now = 0;
	const handshake = vi.fn(async () => true);
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonBeforeFeatures({
		start: async () => {}, status: () => ({ state: "ready" }), attachment: () => null,
		handshake, cancelled: () => false, initializeFeatures,
		now: () => now, timeoutMs: 1, wait: async () => { now++; },
	});
	expect(result).toEqual({ state: "unverified" });
	expect(handshake).not.toHaveBeenCalled();
	expect(initializeFeatures).not.toHaveBeenCalled();
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

it("retries verification in process and opens features only after the retry succeeds", async () => {
	let now = 0;
	let verified = false;
	const initializeFeatures = vi.fn(async () => {});
	const recover = vi.fn(async () => {
		expect(initializeFeatures).not.toHaveBeenCalled();
		verified = true;
		return "retry" as const;
	});
	const result = await bootstrapDaemonWithRecovery({
		start: async () => {}, status: () => ({ state: "ready", pid: 123 }), attachment: () => "daemon-123",
		handshake: async () => verified, cancelled: () => false, initializeFeatures, recover,
		now: () => now, timeoutMs: 1, wait: async () => { now++; },
	});
	expect(result).toEqual({ state: "verified" });
	expect(recover).toHaveBeenCalledWith("unverified");
	expect(initializeFeatures).toHaveBeenCalledOnce();
});

it("leaves a failed start closed when the user declines recovery", async () => {
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonWithRecovery({
		start: async () => {}, status: () => ({ state: "error" }), attachment: () => null,
		handshake: async () => true, cancelled: () => false, initializeFeatures,
		recover: async () => "leave-running",
	});
	expect(result).toEqual({ state: "failed" });
	expect(initializeFeatures).not.toHaveBeenCalled();
});

it("honors cancellation while the native recovery dialog is pending", async () => {
	let cancelled = false;
	const start = vi.fn(async () => {});
	const initializeFeatures = vi.fn(async () => {});
	const result = await bootstrapDaemonWithRecovery({
		start, status: () => ({ state: "error" }), attachment: () => null,
		handshake: async () => true, cancelled: () => cancelled, initializeFeatures,
		recover: async () => { cancelled = true; return "retry"; },
	});
	expect(result).toEqual({ state: "cancelled" });
	expect(start).toHaveBeenCalledOnce();
	expect(initializeFeatures).not.toHaveBeenCalled();
});
