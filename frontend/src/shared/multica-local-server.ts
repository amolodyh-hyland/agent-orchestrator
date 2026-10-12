import { coerceMulticaSettings, multicaRuntimeConfig, parseMulticaUrl, type MulticaSettings } from "./multica";

// Controls for the self-hosted Multica SERVER (backend, web app and Postgres run by Docker
// Compose on this computer). Not the Multica agent daemon, which is a separate program.

export const MULTICA_LOCAL_SERVER_GET_STATE_CHANNEL = "multica:localServer:getState";
export const MULTICA_LOCAL_SERVER_WATCH_CHANNEL = "multica:localServer:watch";
export const MULTICA_LOCAL_SERVER_STATUS_CHANNEL = "multica:localServer:status";
export const MULTICA_LOCAL_SERVER_START_CHANNEL = "multica:localServer:start";
export const MULTICA_LOCAL_SERVER_STOP_CHANNEL = "multica:localServer:stop";
export const MULTICA_LOCAL_SERVER_RESTART_CHANNEL = "multica:localServer:restart";
export const MULTICA_LOCAL_SERVER_CANCEL_CHANNEL = "multica:localServer:cancel";
export const MULTICA_LOCAL_SERVER_SETUP_CHANNEL = "multica:localServer:setup";
export const MULTICA_LOCAL_SERVER_CHOOSE_FOLDER_CHANNEL = "multica:localServer:chooseFolder";
export const MULTICA_LOCAL_SERVER_USE_DETECTED_CHANNEL = "multica:localServer:useDetected";
export const MULTICA_LOCAL_SERVER_GET_LOGS_CHANNEL = "multica:localServer:getLogs";

/** The Compose services of Multica's self-hosting stack; the only names a log request may carry. */
export const LOCAL_SERVER_SERVICES = ["backend", "frontend", "postgres"] as const;
export type LocalServerService = (typeof LOCAL_SERVER_SERVICES)[number];

export const LOCAL_SERVER_LOG_TAIL_DEFAULT = 200;
export const LOCAL_SERVER_LOG_TAIL_MAX = 500;

export type LocalServerUnavailableReason = "cloud" | "no_url" | "remote_url" | "remote_api";

export type LocalServerState =
	| "unavailable"
	| "no_folder"
	| "invalid_folder"
	| "needs_setup"
	| "docker_not_installed"
	| "compose_missing"
	| "docker_not_running"
	| "docker_starting"
	| "stopped"
	| "starting"
	| "healthy"
	| "unhealthy"
	| "port_conflict"
	| "running_elsewhere"
	| "setting_up"
	| "starting_server"
	| "stopping"
	| "restarting";

/** Failure codes; the renderer maps each to a localized message. */
export type LocalServerErrorCode =
	| "busy"
	| "unavailable"
	| "no_folder"
	| "invalid_folder"
	| "needs_setup"
	| "already_set_up"
	| "setup_failed"
	| "docker_not_installed"
	| "compose_missing"
	| "docker_not_running"
	| "docker_start_timeout"
	| "port_conflict"
	| "timeout"
	| "cancelled"
	| "command_failed"
	| "no_detected_folder"
	| "bad_request";

export type LocalServerStatus = {
	state: LocalServerState;
	/** Canonical stack folder in use, or null. */
	folder: string | null;
	/** A Multica stack found through Docker that the user may adopt; never used without a click. */
	detectedFolder: string | null;
	unavailableReason: LocalServerUnavailableReason | null;
	/** The server's web port when it differs from the configured URL's port. */
	portMismatch: { published: number; configured: number } | null;
	/** Last failed operation, cleared by the next successful one. `detail` is redacted command output. */
	error: { code: LocalServerErrorCode; detail?: string } | null;
	/** True on macOS, where AO can start Docker Desktop. */
	canLaunchDocker: boolean;
};

export const EMPTY_LOCAL_SERVER_STATUS: LocalServerStatus = {
	state: "unavailable",
	folder: null,
	detectedFolder: null,
	unavailableReason: null,
	portMismatch: null,
	error: null,
	canLaunchDocker: false,
};

export type LocalServerResult = { ok: true } | { ok: false; code: LocalServerErrorCode; detail?: string };
export type LocalServerLogsResult = { ok: true; lines: string[] } | { ok: false; code: LocalServerErrorCode; detail?: string };

export type LocalServerAvailability =
	| { available: true; webUrl: string; webPort: number; /** The explicit API origin, or "" to derive it from the web address. Always loopback. */ apiUrl: string }
	| { available: false; reason: LocalServerUnavailableReason };

/** The only addresses this computer's own stack can answer on (it binds 127.0.0.1). */
export function isLoopbackMulticaHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return v4 !== null && Number(v4[1]) === 127;
}

/**
 * Whether the saved server settings point at a server this computer can run: Cloud
 * never, an empty or non-loopback address never (a LAN or remote address is another
 * machine, and the stack AO manages listens on this one only). The API address the
 * view uses must be on this computer too: a local web address with a remote API is a
 * remote server, and the status probe must never be answered by it.
 */
export function localServerAvailability(settings: MulticaSettings): LocalServerAvailability {
	const coerced = coerceMulticaSettings(settings);
	if (coerced.mode === "cloud") return { available: false, reason: "cloud" };
	const parsed = parseMulticaUrl(coerced.customUrl);
	if (!parsed.ok) return { available: false, reason: "no_url" };
	const url = new URL(parsed.origin);
	if (!isLoopbackMulticaHost(url.hostname)) return { available: false, reason: "remote_url" };
	let apiUrl = "";
	if (coerced.apiUrl !== "") {
		const api = parseMulticaUrl(coerced.apiUrl);
		if (!api.ok) return { available: false, reason: "remote_api" };
		apiUrl = api.origin;
	}
	// The API the view will really use: the explicit one, else the one derived from the web address.
	const derived = multicaRuntimeConfig(parsed.origin);
	const effectiveApi = apiUrl !== "" ? apiUrl : derived.ok ? derived.config.apiUrl : "";
	if (effectiveApi === "" || !isLoopbackMulticaHost(new URL(effectiveApi).hostname)) return { available: false, reason: "remote_api" };
	const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	return { available: true, webUrl: parsed.origin, webPort: port, apiUrl };
}

export function parseLocalServerService(value: unknown): LocalServerService | null {
	return typeof value === "string" && (LOCAL_SERVER_SERVICES as readonly string[]).includes(value) ? (value as LocalServerService) : null;
}

/** An integer line count within bounds; anything else is rejected rather than coerced. */
export function parseLocalServerTail(value: unknown): number | null {
	if (value === undefined) return LOCAL_SERVER_LOG_TAIL_DEFAULT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
	return Math.min(value, LOCAL_SERVER_LOG_TAIL_MAX);
}

export function localServerStatusKey(status: LocalServerStatus): string {
	return JSON.stringify(status);
}
