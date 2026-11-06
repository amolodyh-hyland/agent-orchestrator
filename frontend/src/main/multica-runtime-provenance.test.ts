// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
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
	const config = { server_url: "http://localhost:8380", token: "must-not-be-used-or-sent" };
	const write = (name: string, value: string) => writeFile(path.join(directory, name), value, { mode: 0o600 });
	await write("config.json", JSON.stringify(config));
	await write("daemon.port", JSON.stringify({ port: 20481, pid: 123 }));
	await write("daemon.pid", "123");
	await write("bundle-daemon.id", daemon);
	const health = { status: "running", profile: "runner", pid: 123, daemon_id: daemon, server_url: config.server_url, workspaces: [{ id: workspace, runtimes: [runtime] }] };
	const listener = { pid: 123, uid: process.getuid!(), start: "Fri Nov 6 12:00:00 2026", executable: "/opt/multica" };
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

it("verifies the listener PID, OS uid, start and executable without process signals or command arguments", async () => {
	const run = vi.fn(async (file: string) => ({ stdout: file.endsWith("lsof") ? "p123\nu501\nf7\n" : "501 Fri Nov  6 12:00:00 2026 /opt/multica\n", stderr: "" }));
	expect(await inspectMulticaListener(20481, "darwin", run)).toEqual({ pid: 123, uid: 501, start: "Fri Nov  6 12:00:00 2026", executable: "/opt/multica" });
	expect(run.mock.calls[0][0]).toBe("/usr/sbin/lsof");
	for (const output of ["502 Fri Nov  6 12:00:00 2026 /opt/multica", "501 Fri Nov  6 12:00:00 2026 /usr/bin/node", "invalid"]) {
		run.mockImplementation(async (file) => ({ stdout: file.endsWith("lsof") ? "p123\nu501\n" : output, stderr: "" }));
		expect(await inspectMulticaListener(20481, "darwin", run)).toBeNull();
	}
});
