import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { daemonStatusKey, mapDaemonStatus, probeFromStatus, type DaemonStatus, type LocalRuntimeProbe } from "../shared/multica-daemon";

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
	options: { timeout: number; maxBuffer: number; windowsHide: boolean },
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
	dispose: () => void;
};

export type FindBinaryOptions = {
	/** Explicit path (AO_MULTICA_CLI). When set it is the only candidate. */
	override?: string;
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
 * Locates the multica CLI: the override when set, otherwise the first match on
 * PATH plus the usual user-install directories (a GUI-launched app inherits a
 * minimal PATH). Relative PATH entries are ignored.
 */
export function findMulticaBinary(options: FindBinaryOptions): string | null {
	const isExecutable = options.isExecutable ?? isExecutableFile;
	if (options.override) {
		return path.isAbsolute(options.override) && isExecutable(options.override) ? options.override : null;
	}
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
	logPath: string;
	execFile?: ExecFileLike;
	pollMs?: number;
};

export function createMulticaDaemonService(options: MulticaDaemonServiceOptions): MulticaDaemonService {
	const exec: ExecFileLike = options.execFile ?? ((file, args, opts, callback) => nodeExecFile(file, args, opts, (error, stdout, stderr) => callback(error, String(stdout), String(stderr))));
	let binary: string | null | undefined;
	let disposed = false;
	let pollTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let lastKey = "";

	const locate = (): string | null => {
		if (binary) return binary;
		binary = options.findBinary();
		return binary;
	};

	const run = (bin: string, args: string[], timeout: number): Promise<{ error: Error | null; stdout: string; stderr: string }> =>
		new Promise((resolve) => {
			exec(bin, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
		});

	// Concurrent callers (the page may ask repeatedly) share one CLI process.
	let statusInFlight: Promise<DaemonStatus> | undefined;
	const readStatus = (): Promise<DaemonStatus> => {
		statusInFlight ??= (async (): Promise<DaemonStatus> => {
			const bin = locate();
			if (!bin) return { state: "cli_not_found" };
			// A stopped daemon may exit non-zero; the JSON (when any) still says so.
			const result = await run(bin, ["daemon", "status", "--output", "json"], STATUS_TIMEOUT_MS);
			return mapDaemonStatus(result.stdout);
		})().finally(() => {
			statusInFlight = undefined;
		});
		return statusInFlight;
	};

	const push = (status: DaemonStatus): void => {
		if (disposed) return;
		lastKey = daemonStatusKey(status);
		options.emit("daemon:status", status);
	};

	const lifecycle = async (args: string[], timeout: number, transient: "starting" | "stopping"): Promise<DaemonResult> => {
		const bin = locate();
		if (!bin) return { success: false, error: "multica CLI is not installed" };
		if (lifecycleBusy) return { success: false, error: DAEMON_BUSY_MESSAGE };
		lifecycleBusy = true;
		try {
			push({ state: transient });
			const result = await run(bin, args, timeout);
			const failure = result.error ? (result.stderr.trim() || result.error.message).slice(0, 300) : undefined;
			if (!disposed) push(await readStatus());
			return failure ? { success: false, error: failure } : { success: true };
		} finally {
			lifecycleBusy = false;
		}
	};

	const poll = async (): Promise<void> => {
		if (disposed || lifecycleBusy || polling) return;
		polling = true;
		try {
			const status = await readStatus();
			if (!disposed && !lifecycleBusy && daemonStatusKey(status) !== lastKey) push(status);
		} finally {
			polling = false;
		}
	};

	// Log tail: reads the end of the file once, then forwards appended bytes.
	let logTimer: NodeJS.Timeout | undefined;
	let logPosition: number | null = null;
	let logPartial = "";
	let logBusy = false;
	let logGeneration = 0;

	const sendLines = (text: string): void => {
		const lines = (logPartial + text).split("\n");
		// An unterminated line is held back, but never beyond the per-line cap.
		logPartial = (lines.pop() ?? "").slice(0, LOG_MAX_LINE);
		for (const line of lines) if (line.length > 0) options.emit("daemon:log-line", line.slice(0, LOG_MAX_LINE));
	};

	const readRange = async (from: number, length: number): Promise<string> => {
		const handle = await open(options.logPath, "r");
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
			const { size } = await stat(options.logPath);
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
		start: () => lifecycle(["daemon", "start"], START_TIMEOUT_MS, "starting"),
		stop: () => lifecycle(["daemon", "stop"], STOP_TIMEOUT_MS, "stopping"),
		restart: () => lifecycle(["daemon", "restart"], RESTART_TIMEOUT_MS, "starting"),
		isInstalled: async () => locate() !== null,
		refreshBinary: () => {
			binary = undefined;
		},
		probeRuntimes: async () => probeFromStatus(await readStatus()),
		startLogStream: () => {
			stopLogStream();
			void logTick();
			logTimer = setInterval(() => void logTick(), LOG_POLL_MS);
			logTimer.unref?.();
		},
		stopLogStream,
		startPolling: () => {
			if (pollTimer || disposed) return;
			void poll();
			pollTimer = setInterval(() => void poll(), options.pollMs ?? DEFAULT_POLL_MS);
			pollTimer.unref?.();
		},
		dispose: () => {
			disposed = true;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			stopLogStream();
		},
	};
}
