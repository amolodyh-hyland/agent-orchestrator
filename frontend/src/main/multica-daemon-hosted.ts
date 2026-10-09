import path from "node:path";
import { daemonStatusKey, probeFromStatus, type DaemonStatus, type LocalRuntimeProbe } from "../shared/multica-daemon";
import { DAEMON_BUSY_MESSAGE, type DaemonResult, type MulticaDaemonService } from "./multica-daemon-cli";

const STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_TIMEOUT_MS = 65_000;
const DEFAULT_POLL_MS = 5_000;
const MODE_CACHE_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROTOCOL_ERROR = "The AO daemon sent an unexpected response.";

// One hosted lifecycle action at a time, across every service instance (like the CLI service).
let hostedLifecycleBusy = false;

export type HostedMulticaDaemonStatus = {
	state: string;
	enabled?: boolean;
	pid?: unknown;
	profile?: unknown;
	startedAt?: unknown;
	health?: unknown;
};

export type HostedResponse = Pick<Response, "ok" | "status" | "json">;
export type HostedFetchJson = (url: string, init: RequestInit, timeoutMs: number) => Promise<HostedResponse>;

export function createHostedFetchJson(fetchImpl: typeof fetch): HostedFetchJson {
	return async (url, init, timeoutMs) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(url, { ...init, signal: controller.signal });
			const reader = response.body?.getReader();
			let parsed: unknown;
			if (reader) {
				const chunks: Uint8Array[] = [];
				let length = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						length += chunk.value.byteLength;
						if (length > MAX_RESPONSE_BYTES) {
							await reader.cancel();
							throw new Error("The AO daemon response is too large.");
						}
						chunks.push(chunk.value);
					}
				} finally {
					reader.releaseLock();
				}
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				try {
					parsed = JSON.parse(new TextDecoder().decode(bytes));
				} catch {
					parsed = undefined;
				}
			}
			return { ok: response.ok, status: response.status, json: async () => parsed };
		} finally {
			clearTimeout(timer);
		}
	};
}

export type HostedStatusRead = { baseUrl: string | null; available: boolean; status?: HostedMulticaDaemonStatus };

export type HostedMulticaDaemonControl = {
	getStatus: () => Promise<HostedMulticaDaemonStatus>;
	getStatusResult: () => Promise<HostedStatusRead>;
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

export function hostedMulticaLogPath(homeDirectory: string, profileValue: string | undefined): string {
	const root = path.join(homeDirectory, ".multica");
	const profile = profileValue?.trim() ?? "";
	if (!profile || profile === "default" || profile === "." || profile === ".." || /[\\/\0]/.test(profile)) {
		return path.join(root, "daemon.log");
	}
	return path.join(root, "profiles", profile, "daemon.log");
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
	if (state === "external") {
		const externalPid = record(daemon.health)?.pid;
		if (typeof externalPid === "number" && Number.isSafeInteger(externalPid) && externalPid > 0) status.pid = externalPid;
	} else if (typeof daemon.pid === "number" && Number.isSafeInteger(daemon.pid)) status.pid = daemon.pid;
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

	if (state !== "external" && status.state === "running" && typeof daemon.startedAt === "string") {
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
	const parseStatus = (body: unknown): HostedMulticaDaemonStatus | undefined => {
		const daemon = record(record(body)?.daemon);
		return daemon && typeof daemon.state === "string" ? (daemon as HostedMulticaDaemonStatus) : undefined;
	};
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
			return { ready: true as const, baseUrl, response, body, status: parseStatus(body) };
		} catch (error) {
			return { ready: true as const, baseUrl, error };
		}
	};

	const getStatusResult = async (): Promise<HostedStatusRead> => {
		const result = await request("status", "GET", STATUS_TIMEOUT_MS);
		if (!result.ready || !result.baseUrl || !result.response?.ok || !result.status) {
			return { baseUrl: result.ready ? result.baseUrl ?? null : null, available: false };
		}
		return { baseUrl: result.baseUrl, available: true, status: result.status };
	};
	const getStatus = async (): Promise<HostedMulticaDaemonStatus> => (await getStatusResult()).status ?? { state: "stopped" };

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
			if (!result.status) return { success: false, error: PROTOCOL_ERROR };
			return { success: true };
		} catch {
			return { success: false, error: "Unable to reach the AO daemon." };
		} finally {
			hostedLifecycleBusy = false;
		}
	};

	return {
		getStatus,
		getStatusResult,
		start: () => lifecycle("start"),
		stop: () => lifecycle("stop"),
		restart: () => lifecycle("restart"),
	};
}

export function createModeAwareMulticaDaemonService(options: {
	cli: MulticaDaemonService;
	hosted: HostedMulticaDaemonControl;
	hostingEnabled: () => boolean;
	baseUrl?: () => string | null;
	emit: (channel: string, payload: unknown) => void;
	onModeChange?: (mode: "cli" | "hosted") => void;
	pollMs?: number;
	now?: () => number;
}): MulticaDaemonService & { getMode: () => "cli" | "hosted" | undefined } {
	let disposed = false;
	let pollTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let pollGeneration = 0;
	let lastKey = "";
	let currentMode: "cli" | "hosted" | undefined;
	let cliPollingDelegated = false;
	let pollingStarted = false;
	let cliDisposed = false;
	let modeCache: { mode: "cli" | "hosted"; baseUrl: string | null; available: boolean; expiresAt: number; status?: HostedMulticaDaemonStatus } | undefined;
	let decisionInFlight: { baseUrl: string; promise: Promise<{ mode: "cli" | "hosted"; status?: HostedMulticaDaemonStatus }> } | undefined;
	const now = options.now ?? Date.now;
	const disposeCli = (): void => {
		if (cliDisposed) return;
		cliDisposed = true;
		options.cli.dispose();
	};

	const currentBaseUrl = (): string | null => {
		try {
			return options.baseUrl ? options.baseUrl() : modeCache?.baseUrl ?? (options.hostingEnabled() ? "hosted" : null);
		} catch {
			return null;
		}
	};
	const switchMode = (mode: "cli" | "hosted"): void => {
		if (disposed) return;
		if (currentMode !== mode) {
			currentMode = mode;
			options.onModeChange?.(mode);
		}
		if (mode === "hosted" && cliPollingDelegated) {
			options.cli.stopPolling();
			cliPollingDelegated = false;
		}
		if (mode === "cli" && pollingStarted && !cliPollingDelegated) {
			options.cli.startPolling();
			cliPollingDelegated = true;
		}
	};
	const readDecision = async (baseUrl: string | null): Promise<{ mode: "cli" | "hosted"; status?: HostedMulticaDaemonStatus }> => {
		if (!baseUrl) {
			const mode = options.hostingEnabled() ? "hosted" : "cli";
			modeCache = { mode, baseUrl, available: false, expiresAt: now() + MODE_CACHE_MS };
			switchMode(mode);
			return { mode };
		}
		let result: HostedStatusRead;
		try {
			result = await options.hosted.getStatusResult();
		} catch {
			result = { baseUrl, available: false };
		}
		const available = result.available && !!result.status;
		const mode = available ? (result.status?.state === "disabled" ? "cli" : "hosted") : options.hostingEnabled() ? "hosted" : "cli";
		modeCache = {
			mode,
			baseUrl: result.baseUrl ?? baseUrl,
			available,
			expiresAt: now() + MODE_CACHE_MS,
			...(result.status ? { status: result.status } : {}),
		};
		switchMode(mode);
		return { mode, ...(result.status ? { status: result.status } : {}) };
	};
	const decide = (): Promise<{ mode: "cli" | "hosted"; status?: HostedMulticaDaemonStatus }> => {
		const baseUrl = currentBaseUrl();
		if (modeCache && modeCache.baseUrl === baseUrl && modeCache.expiresAt > now()) {
			switchMode(modeCache.mode);
			return Promise.resolve({ mode: modeCache.mode, ...(modeCache.status ? { status: modeCache.status } : {}) });
		}
		if (baseUrl && decisionInFlight?.baseUrl === baseUrl) return decisionInFlight.promise;
		const promise = readDecision(baseUrl).finally(() => {
			if (decisionInFlight?.promise === promise) decisionInFlight = undefined;
		});
		if (baseUrl) decisionInFlight = { baseUrl, promise };
		return promise;
	};
	const getHostedStatus = async (status?: HostedMulticaDaemonStatus): Promise<DaemonStatus> =>
		mapHostedStatus(status ?? { state: "stopped" }, now());
	const poll = async (generation: number): Promise<void> => {
		if (disposed || generation !== pollGeneration || polling) return;
		polling = true;
		try {
			const decision = await decide();
			if (decision.mode === "cli") return;
			const status = await getHostedStatus(decision.status);
			const key = daemonStatusKey(status);
			if (!disposed && generation === pollGeneration && key !== lastKey) {
				lastKey = key;
				options.emit("daemon:status", status);
			}
		} catch {
			// Status failures leave the current mode available for the next poll.
		} finally {
			if (generation === pollGeneration) polling = false;
		}
	};
	const stopPolling = (): void => {
		pollGeneration += 1;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		pollingStarted = false;
		polling = false;
		if (cliPollingDelegated) {
			options.cli.stopPolling();
			cliPollingDelegated = false;
		}
	};

	const hostedLifecycle = async (action: "start" | "stop" | "restart"): Promise<DaemonResult> => {
		const decision = await decide();
		if (decision.mode === "cli") return options.cli[action]();
		const result = await options.hosted[action]();
		modeCache = undefined;
		return result;
	};

	return {
		getStatus: async () => {
			const decision = await decide();
			return decision.mode === "hosted" ? getHostedStatus(decision.status) : options.cli.getStatus();
		},
		start: () => hostedLifecycle("start"),
		stop: () => hostedLifecycle("stop"),
		restart: () => hostedLifecycle("restart"),
		isInstalled: async () => (await decide()).mode === "hosted" ? true : options.cli.isInstalled(),
		refreshBinary: () => options.cli.refreshBinary(),
		probeRuntimes: async (): Promise<LocalRuntimeProbe> => {
			const decision = await decide();
			return decision.mode === "hosted" ? probeFromStatus(await getHostedStatus(decision.status)) : options.cli.probeRuntimes();
		},
		startLogStream: () => {
			options.cli.startLogStream();
		},
		stopLogStream: () => {
			options.cli.stopLogStream();
		},
		startPolling: () => {
			if (disposed) return;
			pollingStarted = true;
			if (pollTimer) return;
			const generation = pollGeneration;
			void poll(generation);
			pollTimer = setInterval(() => void poll(generation), options.pollMs ?? DEFAULT_POLL_MS);
			pollTimer.unref?.();
		},
		stopPolling,
		dispose: () => {
			disposed = true;
			stopPolling();
			disposeCli();
		},
		getMode: () => currentMode,
	};
}

/**
 * The hosted daemon (AO's supervised child) serves the default local server. For
 * any other server the panel drives the CLI with that server's profile, so it
 * never starts, stops or shows a daemon that belongs to a different server.
 */
export function chooseMulticaDaemonService<T extends MulticaDaemonService>(options: {
	cliProfile: string | null;
	cli: MulticaDaemonService;
	modeAware: () => T;
}): MulticaDaemonService | T {
	return options.cliProfile ? options.cli : options.modeAware();
}
