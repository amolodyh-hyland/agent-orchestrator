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

export type MulticaSettings = {
	/** Empty string means "not set". */
	url: string;
};

export const DEFAULT_MULTICA_SETTINGS: MulticaSettings = { url: MULTICA_DEFAULT_URL };

export type MulticaStatus = "unconfigured" | "idle" | "loading" | "ready" | "error";

export type MulticaViewState = {
	/** True while the Multica view (not AO) is the one on screen. */
	active: boolean;
	status: MulticaStatus;
	/** The configured URL; empty when unset. */
	url: string;
	error?: string;
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

/**
 * Missing or non-object input yields the default URL. A persisted value that
 * is not a valid URL is treated as unset rather than silently replaced.
 */
export function coerceMulticaSettings(raw: unknown): MulticaSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_MULTICA_SETTINGS };
	const url = (raw as Record<string, unknown>).url;
	if (typeof url !== "string") return { ...DEFAULT_MULTICA_SETTINGS };
	const parsed = parseMulticaUrl(url);
	return { url: parsed.ok ? parsed.url : "" };
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
 * default: web on :3000) talks to its API on :8080 of the same host. Any other
 * host follows Multica's cloud convention of `api.<web host>`.
 */
export function multicaRuntimeConfig(rawAppUrl: string): MulticaRuntimeConfigResult {
	const parsed = parseMulticaUrl(rawAppUrl);
	if (!parsed.ok) return { ok: false, error: { message: "Multica URL is not set" } };
	const app = new URL(parsed.origin);
	const api = new URL(app.origin);
	if (app.hostname === "localhost" || IP_LITERAL.test(app.hostname)) {
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
	appUrl: string,
): Record<string, string> {
	const originKey = Object.keys(headers).find((key) => key.toLowerCase() === "origin");
	if (!originKey || (headers[originKey] !== "null" && headers[originKey] !== "file://")) return headers;
	const config = multicaRuntimeConfig(appUrl);
	if (!config.ok) return headers;
	try {
		const target = new URL(requestUrl);
		if (target.protocol !== "ws:" && target.protocol !== "wss:") return headers;
		target.protocol = target.protocol === "wss:" ? "https:" : "http:";
		if (target.origin !== new URL(config.config.apiUrl).origin) return headers;
	} catch {
		return headers;
	}
	return { ...headers, [originKey]: config.config.appUrl };
}
