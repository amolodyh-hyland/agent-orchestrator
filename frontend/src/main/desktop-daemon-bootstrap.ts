import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DaemonStatus } from "../shared/daemon-status";
import type { DaemonLaunchSpec } from "../shared/daemon-launch";
import { parseRunFile } from "../shared/daemon-discovery";
import { parseDaemonProbe, type DaemonProber, type DaemonProbe } from "../shared/daemon-attach";
import { readDaemonProcessIdentity, type DaemonProcessIdentity } from "./daemon-process-identity";

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

export async function verifyDesktopDaemonHandshake(options: {
	runFile: string;
	platform: NodeJS.Platform;
	launch: Pick<DaemonLaunchSpec, "command" | "shell">;
	spawned?: { appRunId: string; at: number; wrapperPid: number };
	attachedPid?: number;
	probe: DaemonProber;
	identityError: (probe: DaemonProbe) => string | null;
	processIdentity?: (pid: number, platform: NodeJS.Platform) => Promise<DaemonProcessIdentity | null>;
}): Promise<{ pid: number; launchId: string; executable: string; port: number } | null> {
	try {
		const info = parseRunFile(await readFile(options.runFile, "utf8"));
		if (!info || info.pid <= 1 || info.startedAtMs <= 0 || info.startedAtMs > Date.now() + 2000) return null;
		if (options.spawned) {
			if (info.appRunId !== options.spawned.appRunId || info.startedAtMs < options.spawned.at - 2000) return null;
			if (!options.launch.shell && info.pid !== options.spawned.wrapperPid) return null;
		} else if (info.pid !== options.attachedPid) return null;
		const health = parseDaemonProbe("healthz", await options.probe(info.port, "healthz"));
		if (!health || health.pid !== info.pid || !health.executablePath || options.identityError(health)) return null;
		const executable = await realpath(health.executablePath);
		const readIdentity = options.processIdentity ?? readDaemonProcessIdentity;
		const identity = await readIdentity(info.pid, options.platform);
		if (!identity?.processStart || (identity.executable && await realpath(identity.executable) !== executable)) return null;
		const link = await readDaemonStartupLink(path.join(path.dirname(options.runFile), "startup"), {
			pid: info.pid, executable, processStart: identity.processStart, spawnedAt: options.spawned?.at ?? 0,
		});
		if (!link) return null;
		const ready = parseDaemonProbe("readyz", await options.probe(info.port, "readyz"));
		if (!ready || ready.pid !== info.pid || !ready.executablePath || options.identityError(ready)) return null;
		if (await realpath(ready.executablePath) !== executable) return null;
		const confirmed = await readIdentity(info.pid, options.platform);
		if (!confirmed || confirmed.processStart !== identity.processStart || (confirmed.executable && await realpath(confirmed.executable) !== executable)) return null;
		const current = parseRunFile(await readFile(options.runFile, "utf8"));
		if (!current || current.pid !== info.pid || current.port !== info.port || current.startedAtMs !== info.startedAtMs || current.appRunId !== info.appRunId) return null;
		return { ...link, executable, port: info.port };
	} catch { return null; }
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

export async function bootstrapDaemonWithRecovery(options: Parameters<typeof bootstrapDaemonBeforeFeatures>[0] & {
	recover: (state: "failed" | "unverified") => Promise<"retry" | "leave-running">;
}): Promise<DesktopDaemonBootstrapResult> {
	for (;;) {
		const result = await bootstrapDaemonBeforeFeatures(options);
		if (result.state === "verified" || result.state === "cancelled") return result;
		if (options.cancelled()) return { state: "cancelled" };
		const action = await options.recover(result.state);
		if (options.cancelled()) return { state: "cancelled" };
		if (action !== "retry") return result;
	}
}
