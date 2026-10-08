import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { daemonStatusKey, mapDaemonStatus, probeFromStatus, type DaemonStatus, type LocalRuntimeProbe } from "../shared/multica-daemon";
import type { MulticaDaemonScanResult, RunningMulticaDaemon } from "./multica-daemon-guard";

// A minimal daemon control surface for the embedded Multica UI. It shells out to
// the installed `multica` CLI (fixed argument arrays through execFile, never a
// shell string) and never touches the CLI's login or server config.

const STATUS_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const RESTART_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 256 * 1024;
const DEFAULT_POLL_MS = 5_000;
const LOG_POLL_MS = 500;
const LOG_INITIAL_BYTES = 32 * 1024;
const LOG_INITIAL_LINES = 200;
const LOG_MAX_CHUNK_BYTES = 256 * 1024;
const LOG_MAX_LINE = 4096;

// One daemon per machine: lifecycle commands are serialized across every service
// instance, so replacing the Multica view cannot overlap a command still running.
let lifecycleBusy = false;

export const DAEMON_BUSY_MESSAGE = "Another daemon operation is in progress";

export type DaemonResult = { success: boolean; error?: string };

export type ExecFileLike = (
	file: string,
	args: string[],
	options: { timeout: number; maxBuffer: number; windowsHide: boolean; env?: NodeJS.ProcessEnv },
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export type MulticaDaemonService = {
	getStatus: () => Promise<DaemonStatus>;
	start: () => Promise<DaemonResult>;
	stop: () => Promise<DaemonResult>;
	restart: () => Promise<DaemonResult>;
	isInstalled: () => Promise<boolean>;
	/** Forget the located binary so the next call looks again (after an install). */
	refreshBinary: () => void;
	probeRuntimes: () => Promise<LocalRuntimeProbe>;
	startLogStream: () => void;
	stopLogStream: () => void;
	/** Polls the CLI and pushes `daemon:status` when the daemon's state changes. */
	startPolling: () => void;
	stopPolling: () => void;
	dispose: () => void;
};

export type FindBinaryOptions = {
	/** Explicit path (AO_MULTICA_CLI). When set it is the only candidate. */
	override?: string;
	/** Packaged executable, checked after the override and before PATH. */
	bundledPath?: string;
	pathEnv?: string;
	home: string;
	platform: NodeJS.Platform;
	isExecutable?: (file: string) => boolean;
};

function isExecutableFile(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Locates the multica CLI: the override when set, otherwise the bundled binary
 * and then PATH plus usual user-install directories (a GUI-launched app
 * inherits a minimal PATH). Relative PATH entries are ignored.
 */
export function findMulticaBinary(options: FindBinaryOptions): string | null {
	const isExecutable = options.isExecutable ?? isExecutableFile;
	if (options.override) {
		return path.isAbsolute(options.override) && isExecutable(options.override) ? options.override : null;
	}
	if (options.bundledPath && path.isAbsolute(options.bundledPath) && isExecutable(options.bundledPath)) return options.bundledPath;
	const name = options.platform === "win32" ? "multica.exe" : "multica";
	const fallbacks =
		options.platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", path.join(options.home, ".local", "bin")];
	const dirs = [...(options.pathEnv ?? "").split(path.delimiter), ...fallbacks].filter((dir) => dir && path.isAbsolute(dir));
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

export type MulticaDaemonServiceOptions = {
	/** Pushes a main-to-renderer message to the Multica view. */
	emit: (channel: string, payload: unknown) => void;
	findBinary: () => string | null;
	cliNotFoundMessage?: string;
	logPath: string | (() => string);
	isOwnedDaemon?: (status: DaemonStatus) => boolean | Promise<boolean>;
	listRunningDaemons?: () => Promise<MulticaDaemonScanResult>;
	writeOwnerMarker?: (status: DaemonStatus) => Promise<void>;
	removeOwnerMarker?: () => Promise<void>;
	isPidAlive?: (pid: number) => boolean;
	isBundledBinary?: (binaryPath: string) => boolean;
	execFile?: ExecFileLike;
	pollMs?: number;
	/** Multica CLI profile of the selected server; null or absent targets the default profile. */
	profile?: string | null;
};

export function createMulticaDaemonService(options: MulticaDaemonServiceOptions): MulticaDaemonService {
	const exec: ExecFileLike = options.execFile ?? ((file, args, opts, callback) => nodeExecFile(file, args, opts, (error, stdout, stderr) => callback(error, String(stdout), String(stderr))));
	let binary: string | null | undefined;
	const profileArgs = options.profile ? ["--profile", options.profile] : [];
	let disposed = false;
	let pollTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let pollGeneration = 0;
	let lastKey = "";

	const locate = (): string | null => {
		if (binary) return binary;
		binary = options.findBinary();
		return binary;
	};

	const run = (bin: string, args: string[], timeout: number, launchedByDesktop = false): Promise<{ error: Error | null; stdout: string; stderr: string }> =>
		new Promise((resolve) => {
			const execOptions = {
				timeout,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
				...(launchedByDesktop ? { env: { ...process.env, MULTICA_LAUNCHED_BY: "desktop" } } : {}),
			};
			exec(bin, args, execOptions, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
		});

	// Concurrent callers (the page may ask repeatedly) share one CLI process.
	type StatusSnapshot = { status: DaemonStatus; statusName?: string; known: boolean };
	let statusInFlight: Promise<StatusSnapshot> | undefined;
	const readStatusSnapshot = (): Promise<StatusSnapshot> => {
		if (statusInFlight) return statusInFlight;
		let pending: Promise<StatusSnapshot>;
		pending = (async (): Promise<StatusSnapshot> => {
			const bin = locate();
			if (!bin) return { status: { state: "cli_not_found" }, known: false };
			// A stopped daemon may exit non-zero; the JSON (when any) still says so.
			const result = await run(bin, [...profileArgs, "daemon", "status", "--output", "json"], STATUS_TIMEOUT_MS);
			const status = mapDaemonStatus(result.stdout);
			let statusName: string | undefined;
			try {
				const parsed: unknown = JSON.parse(result.stdout);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					const raw = (parsed as Record<string, unknown>).status;
					if (typeof raw === "string") statusName = raw;
				}
			} catch {
				// Malformed output is not a confirmed daemon state.
			}
			const known = result.error === null && (statusName === "running" || statusName === "starting" || statusName === "stopped");
			if (options.isOwnedDaemon && (status.state === "running" || status.state === "starting")) {
				status.externallyManaged = !(await options.isOwnedDaemon(status));
			}
			return { status, ...(statusName !== undefined ? { statusName } : {}), known };
		})().finally(() => {
			if (statusInFlight === pending) statusInFlight = undefined;
		});
		statusInFlight = pending;
		return pending;
	};
	const readStatus = async (): Promise<DaemonStatus> => (await readStatusSnapshot()).status;
	const readFreshStatusSnapshot = (): Promise<StatusSnapshot> => {
		statusInFlight = undefined;
		return readStatusSnapshot();
	};

	const push = (status: DaemonStatus): void => {
		if (disposed) return;
		lastKey = daemonStatusKey(status);
		options.emit("daemon:status", status);
	};

	const lifecycle = async (
		args: string[],
		timeout: number,
		transient: "starting" | "stopping",
		action: "start" | "stop" | "restart",
	): Promise<DaemonResult> => {
		const bin = locate();
		if (!bin) return { success: false, error: options.cliNotFoundMessage ?? "multica CLI is not installed" };
		if (lifecycleBusy) return { success: false, error: DAEMON_BUSY_MESSAGE };
		lifecycleBusy = true;
		statusInFlight = undefined;
		try {
			let ownedStopStatus: DaemonStatus | undefined;
			if (action === "stop") {
				const snapshot = await readFreshStatusSnapshot();
				const status = snapshot.status;
				if (
					!snapshot.known ||
					(status.state !== "running" && status.state !== "starting") ||
					!Number.isSafeInteger(status.pid) ||
					(status.pid ?? 0) <= 0 ||
					!options.isOwnedDaemon ||
					!(await options.isOwnedDaemon(status))
				)
					return { success: false, error: "No Multica daemon started by AO is running; stop it where it was started" };
				ownedStopStatus = status;
			}
			if ((action === "start" || action === "restart") && options.listRunningDaemons) {
				let scan: MulticaDaemonScanResult;
				try {
					scan = await options.listRunningDaemons();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { success: false, error: `Unable to check for running Multica daemons: ${message}` };
				}
				if (scan.state === "unknown") {
					return { success: false, error: "Could not verify whether another Multica daemon is running; not starting a second one" };
				}
				let other: RunningMulticaDaemon | undefined;
				for (const daemon of scan.daemons) {
					const daemonStatus: DaemonStatus = {
						state: "running",
						pid: daemon.pid,
						profile: daemon.profile ?? daemon.profiles[0] ?? "",
						daemonId: daemon.daemonId,
					};
					if (!(await options.isOwnedDaemon?.(daemonStatus))) {
						other = daemon;
						break;
					}
				}
				if (other) {
					const profile = (other.profile !== undefined ? [other.profile] : other.profiles).map((name) => name || "default").join(", ");
					return {
						success: false,
						error: `A Multica daemon is already running (profile ${profile}, port ${other.port}); AO will not start a second one`,
					};
				}
			}
			push({ state: transient });
			const result = await run(bin, args, timeout, (action === "start" || action === "restart") && (options.isBundledBinary?.(bin) ?? false));
			const failure = result.error ? (result.stderr.trim() || result.error.message).slice(0, 300) : undefined;
			let status: DaemonStatus | undefined;
			let markerFailure: string | undefined;
			let stopPidStillAlive = false;
			const snapshot = await readFreshStatusSnapshot();
			status = snapshot.status;
			if (!failure && action === "stop" && ownedStopStatus?.pid !== undefined) {
				let processAlive = true;
				try {
					processAlive = options.isPidAlive?.(ownedStopStatus.pid) ?? true;
				} catch {
					processAlive = true;
				}
				if (!processAlive) {
					try {
						await options.removeOwnerMarker?.();
					} catch (error) {
						markerFailure = error instanceof Error ? error.message : String(error);
					}
				} else {
					stopPidStillAlive = true;
					status = { ...ownedStopStatus, externallyManaged: false };
				}
			}
			if (!failure && (action === "start" || action === "restart")) {
				if (snapshot.known && (status.state === "running" || status.state === "starting") && status.pid !== undefined) {
					try {
						await options.writeOwnerMarker?.(status);
						if (options.isOwnedDaemon) status.externallyManaged = !(await options.isOwnedDaemon(status));
					} catch (error) {
						markerFailure = error instanceof Error ? error.message : String(error);
					}
				} else {
					markerFailure = "could not read the Multica daemon's status after the operation";
				}
			}
			if (!failure && !stopPidStillAlive && action === "stop" && (status.state === "running" || status.state === "starting") && options.isOwnedDaemon) {
				status.externallyManaged = !(await options.isOwnedDaemon(status));
			}
			if (!disposed) push(status);
			if (failure) return { success: false, error: failure };
			if (markerFailure) return { success: false, error: `Multica daemon operation succeeded but AO could not update its ownership marker: ${markerFailure}` };
			return { success: true };
		} finally {
			lifecycleBusy = false;
		}
	};

	const poll = async (generation: number): Promise<void> => {
		if (disposed || generation !== pollGeneration || lifecycleBusy || polling) return;
		polling = true;
		try {
			const status = await readStatus();
			if (!disposed && generation === pollGeneration && !lifecycleBusy && daemonStatusKey(status) !== lastKey) push(status);
		} finally {
			if (generation === pollGeneration) polling = false;
		}
	};

	const stopPolling = (): void => {
		pollGeneration += 1;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		polling = false;
	};

	// Log tail: reads the end of the file once, then forwards appended bytes.
	let logTimer: NodeJS.Timeout | undefined;
	let logPosition: number | null = null;
	let logPartial = "";
	let logBusy = false;
	let logGeneration = 0;
	let activeLogPath = typeof options.logPath === "string" ? options.logPath : "";

	const sendLines = (text: string): void => {
		const lines = (logPartial + text).split("\n");
		// An unterminated line is held back, but never beyond the per-line cap.
		logPartial = (lines.pop() ?? "").slice(0, LOG_MAX_LINE);
		for (const line of lines) if (line.length > 0) options.emit("daemon:log-line", line.slice(0, LOG_MAX_LINE));
	};

	const readRange = async (from: number, length: number): Promise<string> => {
		const handle = await open(activeLogPath, "r");
		try {
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, from);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	};

	const logTick = async (): Promise<void> => {
		if (disposed || logBusy) return;
		logBusy = true;
		const generation = logGeneration;
		try {
			const { size } = await stat(activeLogPath);
			if (logPosition === null) {
				const length = Math.min(size, LOG_INITIAL_BYTES);
				const text = length > 0 ? await readRange(size - length, length) : "";
				if (generation !== logGeneration) return;
				const lines = text.split("\n");
				if (size > length) lines.shift(); // starts mid-line
				logPartial = (lines.pop() ?? "").slice(0, LOG_MAX_LINE);
				for (const line of lines.filter((l) => l.length > 0).slice(-LOG_INITIAL_LINES)) options.emit("daemon:log-line", line.slice(0, LOG_MAX_LINE));
				logPosition = size;
				return;
			}
			if (size < logPosition) {
				logPosition = 0;
				logPartial = "";
			}
			if (size === logPosition) return;
			const from = Math.max(logPosition, size - LOG_MAX_CHUNK_BYTES);
			const text = await readRange(from, size - from);
			if (generation !== logGeneration) return;
			logPosition = size;
			sendLines(text);
		} catch {
			// The log may not exist yet; try again on the next tick.
		} finally {
			logBusy = false;
		}
	};

	const stopLogStream = (): void => {
		logGeneration += 1;
		if (logTimer) clearInterval(logTimer);
		logTimer = undefined;
		logPosition = null;
		logPartial = "";
	};

	return {
		getStatus: readStatus,
		start: () => lifecycle([...profileArgs, "daemon", "start"], START_TIMEOUT_MS, "starting", "start"),
		stop: () => lifecycle([...profileArgs, "daemon", "stop"], STOP_TIMEOUT_MS, "stopping", "stop"),
		restart: () => lifecycle([...profileArgs, "daemon", "restart"], RESTART_TIMEOUT_MS, "starting", "restart"),
		isInstalled: async () => locate() !== null,
		refreshBinary: () => {
			binary = undefined;
		},
		probeRuntimes: async () => probeFromStatus(await readStatus()),
		startLogStream: () => {
			stopLogStream();
			activeLogPath = typeof options.logPath === "string" ? options.logPath : options.logPath();
			void logTick();
			logTimer = setInterval(() => void logTick(), LOG_POLL_MS);
			logTimer.unref?.();
		},
		stopLogStream,
		startPolling: () => {
			if (pollTimer || disposed) return;
			const generation = pollGeneration;
			void poll(generation);
			pollTimer = setInterval(() => void poll(generation), options.pollMs ?? DEFAULT_POLL_MS);
			pollTimer.unref?.();
		},
		stopPolling,
		dispose: () => {
			disposed = true;
			stopPolling();
			stopLogStream();
		},
	};
}
