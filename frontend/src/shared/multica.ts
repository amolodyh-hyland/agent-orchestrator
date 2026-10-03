// Types, constants and pure helpers for the embedded Multica web UI. Shared by
// the main process (view host, settings), the preload bridge and the renderer.
// Kept free of Electron and DOM types so it is trivially unit-testable.

/** Local default from Multica's self-hosting docs: the web app on port 3000. */
export const MULTICA_DEFAULT_URL = "http://localhost:3000";

/**
 * Dedicated persistent session partition: Multica's cookies and storage never
 * mix with the AO shell or the per-worker browser profiles.
 */
export const MULTICA_PARTITION = "persist:ao-multica";

// Sent by the main process when the "toggle-multica" shortcut fires, so the
// renderer can run the same toggle path as the sidebar button.
export const TOGGLE_MULTICA_SHORTCUT_CHANNEL = "app:toggle-multica";
export const MULTICA_GET_STATE_CHANNEL = "multica:getState";
export const MULTICA_SET_ACTIVE_CHANNEL = "multica:setActive";
export const MULTICA_SET_BOUNDS_CHANNEL = "multica:setBounds";
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

export type MulticaRect = { x: number; y: number; width: number; height: number };

export type MulticaBoundsInput = {
	/** Monotonic per renderer; stale reports are dropped. */
	revision: number;
	/** Null hides the native view (the pane is not mounted). */
	rect: MulticaRect | null;
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

export function isMulticaOrigin(rawUrl: string, origin: string): boolean {
	try {
		return new URL(rawUrl).origin === origin;
	} catch {
		return false;
	}
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
