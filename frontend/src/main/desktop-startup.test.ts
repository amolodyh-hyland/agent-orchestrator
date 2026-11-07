import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDesktopStartup, credentialAccess, setDesktopStartup, type DesktopStartupRecord } from "./desktop-startup";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ao-desktop-startup-"));
	let clock = 1000000;
	const startup = createDesktopStartup({ directory, executable: process.execPath, appVersion: "test", processStart: "fixture-start", now: () => clock, uptime: () => clock, heartbeatMs: 60000 });
	setDesktopStartup(startup);
	cleanups.push(async () => { startup.dispose(); await rm(directory, { recursive: true, force: true }); });
	return { startup, directory, advance: (ms: number) => { clock += ms; }, read: async () => JSON.parse(await readFile(startup.file, "utf8")) as DesktopStartupRecord };
}

it("writes the bootstrap record immediately, atomically and owner-only", async () => {
	const f = await fixture();
	expect(await f.read()).toMatchObject({ version: 1, kind: "desktop", phase: "desktop-bootstrap", pid: process.pid, processStart: "fixture-start", appVersion: "test" });
	expect((await stat(f.startup.file)).mode & 0o777).toBe(0o600);
	expect((await stat(path.dirname(f.startup.file))).mode & 0o777).toBe(0o700);
	expect(await readdir(path.dirname(f.startup.file))).toEqual([path.basename(f.startup.file)]);
});

it("preserves concurrent waits and daemon readiness without storing credential contents", async () => {
	const f = await fixture();
	f.startup.phase("daemon-handshake");
	f.startup.linkDaemon(123, "daemon-launch");
	const cloud = f.startup.beginCredential("cloud-read");
	const multica = f.startup.beginCredential("multica-decrypt");
	f.startup.phase("ready");
	f.advance(2000);
	cloud("unavailable");
	expect(await f.read()).toMatchObject({ phase: "ready", daemon: { pid: 123, launchId: "daemon-launch" }, waitReason: "keychain-access", waitOperation: "multica-decrypt", lastCredentialResult: { result: "unavailable", durationMs: 2000 } });
	multica("completed");
	expect(await f.read()).toMatchObject({ phase: "ready", waitReason: null, operations: {} });
	f.startup.linkDaemon(123);
	expect((await f.read()).daemon?.launchId).toBe("daemon-launch");
});

it("writes a wait before entering storage and records denial without its secret error", async () => {
	const f = await fixture();
	await expect(credentialAccess("cloud-read", async () => {
		expect((await f.read()).waitReason).toBe("keychain-access");
		throw new Error("private-token-in-native-error");
	})).rejects.toThrow();
	const raw = await readFile(f.startup.file, "utf8");
	expect(raw).not.toContain("private-token");
	expect(await f.read()).toMatchObject({ waitReason: null, lastCredentialResult: { result: "unavailable" } });
});

it("does not fabricate heartbeats during blocked work and marks sleep and clock discontinuities", async () => {
	const f = await fixture();
	const before = (await f.read()).heartbeatAt;
	f.advance(600000);
	expect((await f.read()).heartbeatAt).toBe(before);
	f.startup.power("suspended");
	expect(await f.read()).toMatchObject({ powerState: "suspended", clockDiscontinuity: true, heartbeatAt: before + 600 });
	f.advance(-900000);
	f.startup.power("awake");
	expect((await f.read()).clockDiscontinuity).toBe(true);
});
