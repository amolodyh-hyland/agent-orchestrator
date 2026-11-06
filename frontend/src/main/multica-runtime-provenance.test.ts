// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalMulticaRuntimeResolver, inspectMulticaListener } from "./multica-runtime-provenance";

const workspace = "10000000-0000-4000-8000-000000000001", runtime = "20000000-0000-4000-8000-000000000002", daemon = "30000000-0000-4000-8000-000000000003";
let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "ao-runtime-provenance-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function fixture() {
	const directory = path.join(home, ".multica/profiles/runner");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const binary = path.join(home, "bin/multica");
	await mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
	await writeFile(binary, "trusted fixture binary", { mode: 0o700 });
	const config = { server_url: "http://localhost:8380", daemon_binary_path: binary,
		daemon_binary_sha256: createHash("sha256").update("trusted fixture binary").digest("hex"), token: "must-not-be-used-or-sent" };
	const write = (name: string, value: string) => writeFile(path.join(directory, name), value, { mode: 0o600 });
	await write("config.json", JSON.stringify(config));
	await write("daemon.port", JSON.stringify({ port: 20481, pid: 123 }));
	await write("daemon.pid", "123");
	await write("bundle-daemon.id", daemon);
	const health = { status: "running", profile: "runner", pid: 123, daemon_id: daemon, server_url: config.server_url, workspaces: [{ id: workspace, runtimes: [runtime] }] };
	const listener = { pid: 123, uid: process.getuid!(), start: "Fri Nov 6 12:00:00 2026", executable: await realpath(binary) };
	const inspectListener = vi.fn(async () => ({ ...listener }));
	const probeHealth = vi.fn(async () => health);
	const resolve = createLocalMulticaRuntimeResolver({ homeDirectory: home, inspectListener, probeHealth });
	return { directory, config, write, health, listener, inspectListener, probeHealth, resolve, binding: { serverKey: "configured", origin: config.server_url, workspaceId: workspace } };
}

describe("trusted local runtime provenance", () => {
	it("binds fresh same-user listener evidence to server, workspace, runtime and daemon identity", async () => {
		const f = await fixture();
		expect(await f.resolve(f.binding, runtime)).toBe("local");
		expect(f.inspectListener).toHaveBeenCalledTimes(2);
		expect(f.probeHealth).toHaveBeenCalledWith(20481, 1000);
		f.health.workspaces[0].runtimes = [];
		expect(await f.resolve(f.binding, runtime)).toBe("unknown");
	});
	it.each(["foreign uid", "wrong pid", "server", "health server", "workspace", "runtime", "daemon", "profile", "starting", "config writable", "config symlink", "invalid port", "no identity", "server-spoofed class", "process changed", "config changed", "probe failed"])("rejects %s", async (mode) => {
		const f = await fixture();
		if (mode === "foreign uid") f.listener.uid++;
		if (mode === "wrong pid") f.listener.pid++;
		if (mode === "server") f.binding.origin = "https://remote.example";
		if (mode === "health server") f.health.server_url = "https://remote.example";
		if (mode === "workspace") f.health.workspaces[0].id = daemon;
		if (mode === "runtime") f.health.workspaces[0].runtimes = [daemon];
		if (mode === "daemon") f.health.daemon_id = runtime;
		if (mode === "profile") f.health.profile = "other";
		if (mode === "starting") f.health.status = "starting";
		if (mode === "config writable") await chmod(path.join(f.directory, "config.json"), 0o666);
		if (mode === "config symlink") { await f.write("other.json", JSON.stringify(f.config)); await rm(path.join(f.directory, "config.json")); await symlink("other.json", path.join(f.directory, "config.json")); }
		if (mode === "invalid port") await f.write("daemon.port", JSON.stringify({ port: 65536, pid: 123 }));
		if (mode === "no identity") await rm(path.join(f.directory, "bundle-daemon.id"));
		if (mode === "server-spoofed class") { Object.assign(f.health, { runtime_class: "local", class: "local" }); f.health.workspaces = []; }
		if (mode === "process changed") f.inspectListener.mockResolvedValueOnce({ ...f.listener }).mockResolvedValue({ ...f.listener, start: "reused pid" });
		if (mode === "config changed") f.probeHealth.mockImplementation(async () => { await f.write("config.json", JSON.stringify({ server_url: "https://remote.example" })); return f.health; });
		if (mode === "probe failed") f.probeHealth.mockRejectedValue(new Error("unavailable"));
		expect(await f.resolve(f.binding, runtime)).toBe("unknown");
	});
});

it("verifies the full executable image from OS txt mappings, not a basename or another mapped file", async () => {
	const f = await fixture();
	const image = f.listener.executable;
	const run = vi.fn(async (file: string, args: string[]) => ({ stdout: file.endsWith("lsof")
		? args.includes("txt") ? `p123\nftxt\nn${image}\nftxt\nn/usr/lib/dyld\n` : "p123\nu501\nf7\n"
		: `501 Fri Nov  6 12:00:00 2026 ${image}\n`, stderr: "" }));
	expect(await inspectMulticaListener(20481, "darwin", run)).toEqual({ pid: 123, uid: 501, start: "Fri Nov  6 12:00:00 2026", executable: image });
	expect(run.mock.calls[2][1]).toContain("txt");
	const impostor = path.join(home, "other/multica");
	await mkdir(path.dirname(impostor)); await writeFile(impostor, "impostor");
	for (const output of [`502 Fri Nov  6 12:00:00 2026 ${image}`, `501 Fri Nov  6 12:00:00 2026 ${impostor}`, "invalid"]) {
		run.mockImplementation(async (file, args) => ({ stdout: file.endsWith("lsof")
			? args.includes("txt") ? `p123\nftxt\nn${image}\n` : "p123\nu501\n" : output, stderr: "" }));
		expect(await inspectMulticaListener(20481, "darwin", run)).toBeNull();
	}
});

it.each(["path differs", "hash differs", "missing record", "bad hash", "manifest differs", "broken manifest", "binary changed after health"])("rejects same-user executable provenance when %s despite matching health and files", async mode => {
	const f = await fixture();
	if (mode === "path differs") {
		const impostor = path.join(home, "other/multica");
		await mkdir(path.dirname(impostor)); await writeFile(impostor, "same-user impostor", { mode: 0o700 });
		f.listener.executable = await realpath(impostor);
	}
	if (mode === "hash differs") f.config.daemon_binary_sha256 = "0".repeat(64);
	if (mode === "missing record") Reflect.deleteProperty(f.config, "daemon_binary_path");
	if (mode === "bad hash") f.config.daemon_binary_sha256 = "invalid";
	if (mode === "manifest differs" || mode === "broken manifest") await writeFile(path.join(path.dirname(f.config.daemon_binary_path), "bundle-manifest.json"), mode === "broken manifest" ? "{" : JSON.stringify({ binaries: [{ file: "multica", sha256: "0".repeat(64) }] }), { mode: 0o600 });
	await f.write("config.json", JSON.stringify(f.config));
	if (mode === "binary changed after health") f.probeHealth.mockImplementation(async () => { await writeFile(f.listener.executable, "changed binary"); return f.health; });
	expect(await f.resolve(f.binding, runtime)).toBe("unknown");
});

it("accepts a canonical recorded path and enforces a hash from its bundle manifest", async () => {
	const f = await fixture();
	const alias = path.join(home, "linked-multica");
	await symlink(f.config.daemon_binary_path, alias);
	f.config.daemon_binary_path = alias;
	const hash = f.config.daemon_binary_sha256;
	Reflect.deleteProperty(f.config, "daemon_binary_sha256");
	await f.write("config.json", JSON.stringify(f.config));
	expect(await f.resolve(f.binding, runtime)).toBe("local");
	await writeFile(path.join(path.dirname(f.listener.executable), "bundle-manifest.json"), JSON.stringify({ binaries: [{ file: "multica", sha256: hash }] }), { mode: 0o600 });
	expect(await f.resolve(f.binding, runtime)).toBe("local");
	await writeFile(f.listener.executable, "wrong content at the recorded path");
	expect(await f.resolve(f.binding, runtime)).toBe("unknown");
});
