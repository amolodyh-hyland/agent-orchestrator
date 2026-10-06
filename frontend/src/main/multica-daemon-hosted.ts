import { daemonStatusKey, probeFromStatus, type DaemonStatus, type LocalRuntimeProbe } from "../shared/multica-daemon";
import { DAEMON_BUSY_MESSAGE, type DaemonResult, type MulticaDaemonService } from "./multica-daemon-cli";

const STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_TIMEOUT_MS = 75_000;
const DEFAULT_POLL_MS = 5_000;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// One hosted lifecycle action at a time, across every service instance (like the CLI service).
let hostedLifecycleBusy = false;

export type HostedMulticaDaemonStatus = {
	state: string;
	pid?: unknown;
	profile?: unknown;
	startedAt?: unknown;
	health?: unknown;
};

type HostedResponse = Pick<Response, "ok" | "status" | "json">;
type HostedFetchJson = (url: string, init: RequestInit, timeoutMs: number) => Promise<HostedResponse>;

export type HostedMulticaDaemonControl = {
	getStatus: () => Promise<HostedMulticaDaemonStatus>;
	start: () => Promise<DaemonResult>;
	stop: () => Promise<DaemonResult>;
	restart: () => Promise<DaemonResult>;
};

export function isMulticaHostingEnabled(env: NodeJS.ProcessEnv): boolean {
	return ["1", "true", "on"].includes(env.AO_MULTICA_DAEMON?.trim().toLowerCase() ?? "");
}

export function hostedMulticaCliEnv(env: NodeJS.ProcessEnv, findBinary: () => string | null): NodeJS.ProcessEnv {
	if (!isMulticaHostingEnabled(env) || env.AO_MULTICA_CLI !== undefined) return {};
	const binary = findBinary()?.trim();
	return binary ? { AO_MULTICA_CLI: binary } : {};
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const safeText = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 256 ? value : undefined);

export function mapHostedStatus(daemon: HostedMulticaDaemonStatus, now = Date.now()): DaemonStatus {
	const state = daemon.state;
	const status: DaemonStatus = {
		state: state === "running" || state === "external" ? "running" : state === "starting" || state === "backoff" ? "starting" : "stopped",
	};
	if (state === "external") status.externallyManaged = true;
	if (typeof daemon.pid === "number" && Number.isSafeInteger(daemon.pid)) status.pid = daemon.pid;
	const profile = safeText(daemon.profile);
	if (profile !== undefined) status.profile = profile;

	const health = record(daemon.health);
	if (health) {
		const fields: Array<[keyof DaemonStatus, unknown]> = [
			["daemonId", health.daemonId],
			["deviceName", health.deviceName],
			["serverUrl", health.serverUrl],
		];
		for (const [key, value] of fields) {
			const text = safeText(value);
			if (text !== undefined) (status as Record<string, unknown>)[key] = text;
		}
		if (Array.isArray(health.agents)) {
			const agents = health.agents
				.filter((agent): agent is string => typeof agent === "string" && PROVIDER.test(agent.toLowerCase()))
				.slice(0, 64);
			status.agents = agents;
		}
		if (typeof health.workspaceCount === "number" && Number.isSafeInteger(health.workspaceCount) && health.workspaceCount >= 0) {
			status.workspaceCount = health.workspaceCount;
		}
	}

	if (status.state === "running" && typeof daemon.startedAt === "string") {
		const startedAt = Date.parse(daemon.startedAt);
		if (Number.isFinite(startedAt)) status.uptime = formatDuration(Math.max(0, Math.floor((now - startedAt) / 1000)));
	}
	return status;
}

function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	const parts = [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder ? `${remainder}s` : ""].filter(Boolean);
	return parts.join("") || "0s";
}

function errorDetails(value: unknown): { code?: string; message?: string } {
	const body = record(value);
	const envelopeError = record(body?.error);
	const code = typeof envelopeError?.code === "string" ? envelopeError.code : typeof body?.code === "string" ? body.code : undefined;
	const message =
		typeof body?.message === "string" && body.message !== ""
			? body.message
			: typeof envelopeError?.message === "string" && envelopeError.message !== ""
				? envelopeError.message
				: undefined;
	return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function failureMessage(status: number, details: { code?: string; message?: string }): string {
	if (details.code === "MULTICA_DISABLED") {
		return "The running AO daemon was started without Multica hosting. Restart AO with Multica hosting enabled.";
	}
	if (details.code === "MULTICA_EXTERNAL") {
		return "A Multica daemon outside AO is running; stop it from where you started it.";
	}
	if (details.message) return details.message;
	if (status === 503) return "The Multica daemon is temporarily unavailable.";
	return `The AO daemon request failed (HTTP ${status}).`;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createHostedMulticaDaemonControl(options: {
	baseUrl: () => string | null;
	fetchJson: HostedFetchJson;
	timeoutMs?: number;
}): HostedMulticaDaemonControl {
	const request = async (name: "status" | "start" | "stop" | "restart", method: "GET" | "POST", timeoutMs: number) => {
		let baseUrl: string | null;
		try {
			baseUrl = options.baseUrl();
		} catch (error) {
			return { ready: true as const, error };
		}
		if (!baseUrl) return { ready: false as const };
		try {
			const response = await options.fetchJson(`${baseUrl.replace(/\/+$/, "")}/api/v1/multica/${name}`, { method }, timeoutMs);
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			return { ready: true as const, response, body };
		} catch (error) {
			return { ready: true as const, error };
		}
	};

	const getStatus = async (): Promise<HostedMulticaDaemonStatus> => {
		const result = await request("status", "GET", STATUS_TIMEOUT_MS);
		if (!result.ready || !result.response?.ok) return { state: "stopped" };
		const daemon = record(record(result.body)?.daemon);
		return daemon && typeof daemon.state === "string" ? (daemon as HostedMulticaDaemonStatus) : { state: "stopped" };
	};

	const lifecycle = async (name: "start" | "stop" | "restart"): Promise<DaemonResult> => {
		if (hostedLifecycleBusy) return { success: false, error: DAEMON_BUSY_MESSAGE };
		hostedLifecycleBusy = true;
		try {
			const result = await request(name, "POST", options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
			if (!result.ready) return { success: false, error: "The AO daemon is not ready." };
			if (result.error) {
				return {
					success: false,
					error: isTimeoutError(result.error) ? "The AO daemon request timed out." : "Unable to reach the AO daemon.",
				};
			}
			if (!result.response) return { success: false, error: "Unable to reach the AO daemon." };
			if (!result.response.ok) return { success: false, error: failureMessage(result.response.status, errorDetails(result.body)) };
			return { success: true };
		} catch {
			return { success: false, error: "Unable to reach the AO daemon." };
		} finally {
			hostedLifecycleBusy = false;
		}
	};

	return {
		getStatus,
		start: () => lifecycle("start"),
		stop: () => lifecycle("stop"),
		restart: () => lifecycle("restart"),
	};
}

export function createModeAwareMulticaDaemonService(options: {
	cli: MulticaDaemonService;
	hosted: HostedMulticaDaemonControl;
	hostingEnabled: () => boolean;
	emit: (channel: string, payload: unknown) => void;
	pollMs?: number;
	now?: () => number;
}): MulticaDaemonService {
	let disposed = false;
	let pollTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let lastKey = "";
	const now = options.now ?? Date.now;

	const getHostedStatus = async (): Promise<DaemonStatus> => mapHostedStatus(await options.hosted.getStatus(), now());
	const poll = async (): Promise<void> => {
		if (disposed || polling) return;
		polling = true;
		try {
			const status = await getHostedStatus();
			const key = daemonStatusKey(status);
			if (!disposed && key !== lastKey) {
				lastKey = key;
				options.emit("daemon:status", status);
			}
		} catch {
			// A failed status read is represented by the hosted control as stopped.
		} finally {
			polling = false;
		}
	};

	const hostedLifecycle = async (action: "start" | "stop" | "restart"): Promise<DaemonResult> => options.hosted[action]();

	return {
		getStatus: () => (options.hostingEnabled() ? getHostedStatus() : options.cli.getStatus()),
		start: () => (options.hostingEnabled() ? hostedLifecycle("start") : options.cli.start()),
		stop: () => (options.hostingEnabled() ? hostedLifecycle("stop") : options.cli.stop()),
		restart: () => (options.hostingEnabled() ? hostedLifecycle("restart") : options.cli.restart()),
		isInstalled: () => (options.hostingEnabled() ? Promise.resolve(true) : options.cli.isInstalled()),
		refreshBinary: () => options.cli.refreshBinary(),
		probeRuntimes: async (): Promise<LocalRuntimeProbe> =>
			options.hostingEnabled() ? probeFromStatus(await getHostedStatus()) : options.cli.probeRuntimes(),
		startLogStream: () => options.cli.startLogStream(),
		stopLogStream: () => options.cli.stopLogStream(),
		startPolling: () => {
			if (!options.hostingEnabled()) {
				options.cli.startPolling();
				return;
			}
			if (pollTimer || disposed) return;
			void poll();
			pollTimer = setInterval(() => void poll(), options.pollMs ?? DEFAULT_POLL_MS);
			pollTimer.unref?.();
		},
		dispose: () => {
			disposed = true;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			options.cli.dispose();
		},
	};
}
