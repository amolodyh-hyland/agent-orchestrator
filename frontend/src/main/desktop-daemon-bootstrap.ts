import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DaemonStatus } from "../shared/daemon-status";

export async function readDaemonStartupLink(directory: string, identity: {
	pid: number; processStart: string; executable: string; spawnedAt: number;
}): Promise<{ pid: number; launchId: string } | null> {
	if (!identity.processStart) return null;
	const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
	try {
		const executable = await realpath(identity.executable);
		for (const name of await readdir(directory)) {
			if (!/^[A-Za-z0-9-]+\.json$/.test(name)) continue;
			try {
				const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
				if (record.pid !== identity.pid || typeof record.processStart !== "string" || normalize(record.processStart) !== normalize(identity.processStart)) continue;
				if (!Number.isInteger(record.startedAt) || record.startedAt < Math.floor(identity.spawnedAt / 1000) - 2 || record.startedAt > Date.now() / 1000 + 2) continue;
				if (typeof record.launchId !== "string" || name !== `${record.launchId}.json`) continue;
				if (await realpath(record.executable) !== executable) continue;
				return { pid: identity.pid, launchId: record.launchId };
			} catch { /* An atomic replacement or incomplete record is retried. */ }
		}
	} catch { /* The daemon creates its startup directory after spawn. */ }
	return null;
}

export type DesktopDaemonBootstrapResult = { state: "verified" | "cancelled" | "failed" | "unverified" };

export async function bootstrapDaemonBeforeFeatures(options: {
	start: () => Promise<unknown>;
	status: () => DaemonStatus;
	attachment: () => object | string | number | null;
	handshake: () => Promise<boolean>;
	cancelled: () => boolean;
	initializeFeatures: () => Promise<void>;
	wait?: () => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
}): Promise<DesktopDaemonBootstrapResult> {
	if (options.cancelled()) return { state: "cancelled" };
	try { await options.start(); }
	catch { return { state: options.cancelled() ? "cancelled" : "failed" }; }
	const now = options.now ?? (() => performance.now());
	const deadline = now() + (options.timeoutMs ?? 30_000);
	for (;;) {
		if (options.cancelled()) return { state: "cancelled" };
		const status = options.status();
		if (status.state === "error" || status.state === "stopped") return { state: "failed" };
		if (now() >= deadline) return { state: "unverified" };
		const attachment = options.attachment();
		const verified = attachment !== null && await options.handshake();
		if (options.cancelled()) return { state: "cancelled" };
		const current = options.status();
		if (current.state === "error" || current.state === "stopped") return { state: "failed" };
		if (verified && attachment === options.attachment()) {
			await options.initializeFeatures();
			return { state: "verified" };
		}
		await (options.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 100)));
	}
}
