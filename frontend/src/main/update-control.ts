import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export function authorizeUpdateShutdown(
	request: { token?: unknown; launchId?: unknown; command?: unknown },
	identity: { token: string; launchId: string },
	canShutdown: () => boolean,
): string {
	if (typeof request.token !== "string" || Buffer.byteLength(request.token) !== Buffer.byteLength(identity.token)
		|| !timingSafeEqual(Buffer.from(request.token), Buffer.from(identity.token))
		|| request.launchId !== identity.launchId || request.command !== "shutdown") return "unauthorized";
	return canShutdown() ? "accepted" : "migration-or-startup-active";
}

export async function startUpdateControl(options: {
	directory: string;
	canShutdown(): boolean;
	quit(): void;
}): Promise<() => void> {
	const identity = { launchId: randomUUID(), token: randomBytes(32).toString("hex") };
	const socketPath = path.join(options.directory, `quit-${identity.launchId.slice(0, 12)}.sock`);
	const recordPath = path.join(options.directory, "update-control.json");
	const temporary = `${recordPath}.${identity.launchId}.tmp`;
	await mkdir(options.directory, { recursive: true, mode: 0o700 });
	const server = net.createServer((socket) => {
		socket.setTimeout(5_000, () => socket.destroy());
		let input = "";
		let handled = false;
		socket.on("error", () => undefined);
		socket.on("data", (data) => {
			if (handled) return;
   input += data.toString();
			if (input.length > 4096) { socket.destroy(); return; }
			if (!input.includes("\n")) return;
			handled = true;
   let result = "unauthorized";
			try { result = authorizeUpdateShutdown(JSON.parse(input.split("\n")[0]), identity, options.canShutdown); } catch { result = "unauthorized"; }
			socket.end(`${JSON.stringify({ result })}\n`, () => { if (result === "accepted") options.quit(); });
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
	try {
  await chmod(socketPath, 0o600);
		const processStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().replace(/\s+/g, " ");
		await writeFile(temporary, JSON.stringify({ ...identity, pid: process.pid, processStart, executable: process.execPath, socketPath }), { mode: 0o600 });
		await rename(temporary, recordPath);
	} catch (error) {
		server.close();
		await rm(socketPath, { force: true });
		throw error;
	}
	return () => {
		server.close();
		rmSync(socketPath, { force: true });
		try {
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			if (record.launchId === identity.launchId && record.token === identity.token) rmSync(recordPath);
		} catch {}
	};
}
