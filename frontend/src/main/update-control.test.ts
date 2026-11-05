// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { authorizeUpdateShutdown, startUpdateControl } from "./update-control";

vi.mock("node:child_process", () => ({ execFileSync: () => "Mon Oct 12 00:00:00 2026" }));

const identity = { token: "a".repeat(64), launchId: "this-launch" };
const request = { ...identity, command: "shutdown" };

describe("update supervisor shutdown", () => {
	it("works without a tray and preserves the startup/migration interlock", () => {
		expect(authorizeUpdateShutdown(request, identity, () => true)).toBe("accepted");
		expect(authorizeUpdateShutdown(request, identity, () => false)).toBe("migration-or-startup-active");
	});
	it("rejects tokens and identities from a previous launch before consulting readiness", () => {
		const canShutdown = vi.fn(() => true);
		for (const changed of [{ token: "b".repeat(64) }, { launchId: "previous-launch" }, { command: "kill" }, { token: null }]) {
			expect(authorizeUpdateShutdown({ ...request, ...changed }, identity, canShutdown)).toBe("unauthorized");
		}
		expect(canShutdown).not.toHaveBeenCalled();
	});
});

it("serves authenticated shutdown before readiness without a tray", async () => {
	const directory = await mkdtemp("/tmp/ao-control-");
	let canShutdown = false;
	const quit = vi.fn();
	const dispose = await startUpdateControl({ directory, canShutdown: () => canShutdown, quit });
	try {
		const record = JSON.parse(await readFile(path.join(directory, "update-control.json"), "utf8"));
		const send = (token: string): Promise<string> => new Promise((resolve, reject) => {
			const socket = net.connect(record.socketPath);
			let response = "";
			socket.on("error", reject);
			socket.on("connect", () => socket.write(`${JSON.stringify({ token, launchId: record.launchId, command: "shutdown" })}\n`));
			socket.on("data", (data) => { response += data.toString(); });
			socket.on("end", () => resolve(JSON.parse(response).result));
		});
		expect(await send("invalid")).toBe("unauthorized");
		expect(await send(record.token)).toBe("migration-or-startup-active");
		expect(quit).not.toHaveBeenCalled();
		canShutdown = true;
		expect(await send(record.token)).toBe("accepted");
		expect(quit).toHaveBeenCalledOnce();
	} finally {
		dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
