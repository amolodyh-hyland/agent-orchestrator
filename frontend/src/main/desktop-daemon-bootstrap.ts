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

export async function bootstrapDaemonBeforeFeatures(options: {
	start: () => Promise<unknown>;
	status: () => DaemonStatus;
	handshake: () => Promise<boolean>;
	cancelled: () => boolean;
	initializeFeatures: () => Promise<void>;
	wait?: () => Promise<void>;
}): Promise<void> {
	await options.start();
	if (!options.cancelled() && options.status().state === "ready") await options.handshake();
	while (!options.cancelled() && options.status().state === "starting") {
		if (await options.handshake()) break;
		await (options.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 100)));
	}
	if (!options.cancelled()) await options.initializeFeatures();
}
