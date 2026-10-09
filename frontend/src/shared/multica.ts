// Types, constants and pure helpers for the embedded Multica desktop UI. Shared
// by the main process (view host, settings, desktop bridge), the preload bridge
// and the renderer. Kept free of Electron and DOM types so it is trivially
// unit-testable.

/** Local default from Multica's self-hosting docs: the web app on port 3000. */
export const MULTICA_DEFAULT_URL = "http://localhost:3000";

/**
 * Dedicated persistent session partition: Multica's cookies and storage never
 * mix with the AO shell or the per-worker browser profiles.
 */
export const MULTICA_PARTITION = "persist:ao-multica";

/**
 * Multica's own desktop app runs its renderer with webSecurity off because the
 * built renderer is a file:// page that calls the Multica API cross-origin.
 * Kept on here until a live run proves it is needed; if it is turned off it
 * applies only to the Multica view (own partition, navigation pinned to the
 * built bundle, every permission denied).
 */
export const MULTICA_WEB_SECURITY = true;

// Sent by the main process when the "toggle-multica" shortcut fires, so the
// renderer can run the same toggle path as the sidebar button.
export const TOGGLE_MULTICA_SHORTCUT_CHANNEL = "app:toggle-multica";
export const MULTICA_GET_STATE_CHANNEL = "multica:getState";
export const MULTICA_SET_ACTIVE_CHANNEL = "multica:setActive";
export const MULTICA_RELOAD_CHANNEL = "multica:reload";
export const MULTICA_STATE_CHANNEL = "multica:state";
export const MULTICA_GET_SETTINGS_CHANNEL = "multica:getSettings";
export const MULTICA_SET_SETTINGS_CHANNEL = "multica:setSettings";
export const MULTICA_CHECK_SERVER_CHANNEL = "multica:checkServer";

/** Multica Cloud, from Multica Desktop's built-in default runtime config. */
export const MULTICA_CLOUD_APP_URL = "https://multica.ai";
export const MULTICA_CLOUD_API_URL = "https://api.multica.ai";
export const MULTICA_CLOUD_PARTITION = "persist:ao-multica-cloud";

export type MulticaServerMode = "cloud" | "local";

export type MulticaSettings = {
	mode: MulticaServerMode;
	/** Web origin of the local / self-hosted server. Empty string means "not set". Kept while the mode is cloud. */
	customUrl: string;
	/** Explicit API origin for a self-hosted server whose API is not at the derived address. Empty means derive it. */
	apiUrl: string;
};

export const DEFAULT_MULTICA_SETTINGS: MulticaSettings = { mode: "local", customUrl: MULTICA_DEFAULT_URL, apiUrl: "" };

export type MulticaStatus = "unconfigured" | "idle" | "loading" | "ready" | "error";

export type MulticaErrorKind = "bundle-missing";

export type MulticaViewState = {
	/** True while the Multica view (not AO) is the one on screen. */
	active: boolean;
	status: MulticaStatus;
	/** The configured URL; empty when unset. */
	url: string;
	error?: string;
	errorKind?: MulticaErrorKind;
};

export type MulticaUrl = { ok: true; url: string; origin: string } | { ok: false };

/**
 * Accepts http(s) URLs only, with no embedded credentials. A bare `host:port`
 * gets `http://` prepended (`new URL("localhost:3000")` would otherwise parse
 * `localhost:` as a scheme).
 */
export function parseMulticaUrl(raw: unknown): MulticaUrl {
	if (typeof raw !== "string") return { ok: false };
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false };
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
	if (url.username || url.password) return { ok: false };
	url.hash = "";
	return { ok: true, url: url.href, origin: url.origin };
}

function originOrEmpty(raw: unknown): string {
	const parsed = parseMulticaUrl(raw);
	return parsed.ok ? parsed.origin : "";
}

/**
 * Missing or non-object input yields the defaults. A persisted URL that is not
 * valid is treated as unset rather than silently replaced. A version 1 file
 * (`{ url }`) becomes cloud when it named Multica Cloud's web app, local
 * otherwise; paths are reduced to the origin.
 */
export function coerceMulticaSettings(raw: unknown): MulticaSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_MULTICA_SETTINGS };
	const record = raw as Record<string, unknown>;
	if (record.mode === "cloud" || record.mode === "local") {
		return {
			mode: record.mode,
			customUrl: typeof record.customUrl === "string" ? originOrEmpty(record.customUrl) : DEFAULT_MULTICA_SETTINGS.customUrl,
			apiUrl: typeof record.apiUrl === "string" ? originOrEmpty(record.apiUrl) : "",
		};
	}
	if (typeof record.url !== "string") return { ...DEFAULT_MULTICA_SETTINGS };
	const origin = originOrEmpty(record.url);
	if (origin === MULTICA_CLOUD_APP_URL) return { mode: "cloud", customUrl: DEFAULT_MULTICA_SETTINGS.customUrl, apiUrl: "" };
	return { mode: "local", customUrl: origin, apiUrl: "" };
}

export type MulticaServerUrlError = "invalid_url" | "insecure_http" | "path_not_allowed";

/** Cloud metadata service names, which the single-label and `.internal` rules would otherwise let through over http. */
const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "metadata.azure.internal"]);

/**
 * Hosts where plain http is acceptable: loopback, RFC 1918, CGNAT (VPN
 * overlays), unique-local IPv6, single-label names and the usual private
 * suffixes. Link-local addresses (169.254/16, fe80::/10) are not: that range
 * holds cloud metadata services. Judged by name only (no DNS), so this is a
 * usability guard, not a security boundary.
 */
export function isPrivateMulticaHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (METADATA_HOSTS.has(host)) return false;
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 127 ||
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (host.includes(":")) return /^f[cd][0-9a-f]{2}:/.test(host);
	if (!host.includes(".")) return true;
	return [".local", ".lan", ".internal", ".home.arpa"].some((suffix) => host.endsWith(suffix));
}

export type MulticaServerUrl = { ok: true; origin: string } | { ok: false; error: MulticaServerUrlError };

/**
 * Strict form used when the user saves a server: http(s) without credentials,
 * an origin only (no path or query), and https unless the host is local or on a
 * private network.
 */
export function validateMulticaServerUrl(raw: unknown): MulticaServerUrl {
	const parsed = parseMulticaUrl(raw);
	if (!parsed.ok) return { ok: false, error: "invalid_url" };
	const url = new URL(parsed.url);
	if ((url.pathname !== "/" && url.pathname !== "") || url.search) return { ok: false, error: "path_not_allowed" };
	if (url.protocol === "http:" && !isPrivateMulticaHost(url.hostname)) return { ok: false, error: "insecure_http" };
	return { ok: true, origin: parsed.origin };
}

export type MulticaRuntimeConfig = {
	schemaVersion: 1;
	apiUrl: string;
	wsUrl: string;
	appUrl: string;
};

export type MulticaRuntimeConfigResult =
	| { ok: true; config: MulticaRuntimeConfig }
	| { ok: false; error: { message: string } };

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/**
 * Builds the runtime config Multica's desktop renderer reads at boot from the
 * configured Multica web URL. A local or LAN web app (Multica's self-hosting
 * default: web on :3000) talks to its API on :8080 of the same host, and so does
 * a plain-http name on a private network (`http://mybox:3000`, `http://box.lan`).
 * Any other host follows Multica's cloud convention of `api.<web host>`.
 */
export function multicaRuntimeConfig(rawAppUrl: string): MulticaRuntimeConfigResult {
	const parsed = parseMulticaUrl(rawAppUrl);
	if (!parsed.ok) return { ok: false, error: { message: "Multica URL is not set" } };
	const app = new URL(parsed.origin);
	const api = new URL(app.origin);
	if (app.hostname === "localhost" || IP_LITERAL.test(app.hostname) || (app.protocol === "http:" && isPrivateMulticaHost(app.hostname))) {
		api.port = "8080";
	} else if (!app.hostname.startsWith("api.")) {
		api.hostname = `api.${app.hostname}`;
	}
	const ws = new URL(api.origin);
	ws.protocol = api.protocol === "https:" ? "wss:" : "ws:";
	ws.pathname = "/ws";
	return {
		ok: true,
		config: { schemaVersion: 1, apiUrl: api.origin, wsUrl: ws.href, appUrl: app.origin },
	};
}

export type MulticaServer = {
	/** Stable identity of the server: "cloud", the web origin, or `<web origin>|<api origin>` when the API is not the derived one. Tags issue links. */
	key: string;
	mode: MulticaServerMode;
	appUrl: string;
	config: MulticaRuntimeConfig;
	/** Session partition holding this server's sign-in. */
	partition: string;
	/** CLI profile AO passes to `multica`; null for the default profile (the default local server). */
	cliProfile: string | null;
};

/** 64 bits from two FNV-1a passes; only needs to keep origins apart, not to be secret. */
function hashOrigin(value: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0xdeadbeef;
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193) >>> 0;
		b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * One partition per server so a sign-in for one server is never offered to
 * another (the file:// renderer keeps its token in localStorage, which belongs
 * to the partition). The original partition stays with the default local server
 * so existing sign-ins survive.
 */
export function multicaPartitionFor(mode: MulticaServerMode, identity: string): string {
	if (mode === "cloud") return MULTICA_CLOUD_PARTITION;
	if (identity === new URL(MULTICA_DEFAULT_URL).origin) return MULTICA_PARTITION;
	return `${MULTICA_PARTITION}-${hashOrigin(identity)}`;
}

/**
 * `ao-<readable host>-<64-bit hash of the identity>`: the hash keeps hosts that
 * sanitize alike (`a.b:1`, `a.b-1`) and the same host over http and https on
 * separate CLI profiles, so one profile never holds two servers' sign-in.
 */
function cliProfileFor(mode: MulticaServerMode, identity: string, appOrigin: string): string | null {
	if (mode === "local" && identity === new URL(MULTICA_DEFAULT_URL).origin) return null;
	if (mode === "cloud") return "ao-multica.ai";
	const host = new URL(appOrigin).host.replace(/[^a-z0-9.]/gi, "-").toLowerCase().slice(0, 40);
	return `ao-${host}-${hashOrigin(identity)}`;
}

/** The server the settings select, or null when the view is off. */
export function resolveMulticaServer(settings: MulticaSettings): MulticaServer | null {
	if (settings.mode === "cloud") {
		return {
			key: "cloud",
			mode: "cloud",
			appUrl: MULTICA_CLOUD_APP_URL,
			config: {
				schemaVersion: 1,
				apiUrl: MULTICA_CLOUD_API_URL,
				wsUrl: "wss://api.multica.ai/ws",
				appUrl: MULTICA_CLOUD_APP_URL,
			},
			partition: MULTICA_CLOUD_PARTITION,
			cliProfile: cliProfileFor("cloud", "cloud", MULTICA_CLOUD_APP_URL),
		};
	}
	const derived = multicaRuntimeConfig(settings.customUrl);
	if (!derived.ok) return null;
	const config = { ...derived.config };
	const api = settings.apiUrl ? parseMulticaUrl(settings.apiUrl) : null;
	if (api?.ok) {
		config.apiUrl = api.origin;
		const ws = new URL(api.origin);
		ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
		ws.pathname = "/ws";
		config.wsUrl = ws.href;
	}
	// The sign-in token lives in the partition and is sent to the API, so a
	// different API address is a different server even for the same web address.
	const apiOverride = config.apiUrl !== derived.config.apiUrl;
	const identity = apiOverride ? `${config.appUrl}|${config.apiUrl}` : config.appUrl;
	return {
		key: identity,
		mode: "local",
		appUrl: config.appUrl,
		config,
		partition: multicaPartitionFor("local", identity),
		cliProfile: cliProfileFor("local", identity, config.appUrl),
	};
}

/** The command that signs the CLI profile of a non-default server in; AO never logs in or syncs a token itself. */
export function multicaCliSignInCommand(server: MulticaServer): string | null {
	if (!server.cliProfile) return null;
	if (server.mode === "cloud") return `multica login --profile ${server.cliProfile}`;
	return `multica setup self-host --profile ${server.cliProfile} --server-url ${server.config.apiUrl} --app-url ${server.appUrl}`;
}

export type MulticaServerCheckError =
	| MulticaServerUrlError
	| "unreachable"
	| "timeout"
	| "tls"
	| "not_multica"
	| "not_ready";

export type MulticaSetSettingsRequest = {
	mode: MulticaServerMode;
	customUrl: string;
	apiUrl?: string;
	/** Save although the connection check failed (not for invalid or insecure URLs). */
	force?: boolean;
};

export type MulticaCheckResult = { ok: true; apiUrl: string } | { ok: false; error: MulticaServerCheckError };

export type MulticaSetSettingsResult =
	| { ok: true; settings: MulticaSettings }
	| { ok: false; error: MulticaServerCheckError; forceable: boolean };

export const MULTICA_DEEP_LINK_PROTOCOL = "multica:";

export type MulticaDeepLink = { channel: "auth:token" | "invite:open"; payload: string };

const MAX_DEEP_LINK_TOKEN_LENGTH = 8192;
const INVITE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Parses the two deep links Multica's desktop handles: the sign-in callback
 * `multica://auth/callback?token=<jwt>` and `multica://invite/<id>`. Anything
 * else, including malformed input, is ignored.
 */
export function parseMulticaDeepLink(raw: string): MulticaDeepLink | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== MULTICA_DEEP_LINK_PROTOCOL) return null;
	if (url.hostname === "auth" && url.pathname === "/callback") {
		const token = url.searchParams.get("token");
		return token && token.length <= MAX_DEEP_LINK_TOKEN_LENGTH ? { channel: "auth:token", payload: token } : null;
	}
	if (url.hostname === "invite") {
		let id: string;
		try {
			id = decodeURIComponent(url.pathname.replace(/^\//, ""));
		} catch {
			return null;
		}
		return INVITE_ID.test(id) ? { channel: "invite:open", payload: id } : null;
	}
	return null;
}

/**
 * The built renderer is a file:// page, so its WebSocket handshake carries
 * `Origin: file://` (or `null`), which a Multica server only accepts if its
 * allowlist says so.
 * For a handshake to the configured API origin, presents the Multica app origin
 * (which the server already trusts) instead. Everything else is left alone.
 */
export function multicaWebSocketHeaders(
	requestUrl: string,
	headers: Record<string, string>,
	config: MulticaRuntimeConfig | null,
): Record<string, string> {
	const originKey = Object.keys(headers).find((key) => key.toLowerCase() === "origin");
	if (!originKey || (headers[originKey] !== "null" && headers[originKey] !== "file://")) return headers;
	if (!config) return headers;
	try {
		const target = new URL(requestUrl);
		if (target.protocol !== "ws:" && target.protocol !== "wss:") return headers;
		target.protocol = target.protocol === "wss:" ? "https:" : "http:";
		if (target.origin !== new URL(config.apiUrl).origin) return headers;
	} catch {
		return headers;
	}
	return { ...headers, [originKey]: config.appUrl };
}
