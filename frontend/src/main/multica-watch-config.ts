import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	MULTICA_CREDENTIAL_SOURCES,
	MULTICA_MAX_SOCKETS,
	type MulticaCredentialSource,
} from "../shared/multica-awareness";
import { resolveMulticaServer, validateMulticaServerUrl, type MulticaServerMode } from "../shared/multica";

export const MULTICA_WATCH_FILE = "multica-watch.json";
export const MAX_WATCHED_SERVERS = 8;
export const MAX_WATCH_WORKSPACES_PER_SERVER = 100;

export type WatchWorkspace = { workspaceId: string; slug: string; name: string; watch: boolean };

/** One server the user may watch. No secret is ever stored here. */
export type WatchServer = {
	serverKey: string;
	mode: MulticaServerMode;
	customUrl: string;
	apiUrl: string;
	enabled: boolean;
	credentialSource: MulticaCredentialSource;
	/** The user agreed to AO reading this server's Multica CLI profile token. */
	consentGranted: boolean;
	workspaces: WatchWorkspace[];
};

export type WatchConfig = {
	masterEnabled: boolean;
	maxSockets: number;
	servers: WatchServer[];
};

/** Everything is off by default: master switch, each server, each workspace. */
export const DEFAULT_WATCH_CONFIG: WatchConfig = { masterEnabled: false, maxSockets: MULTICA_MAX_SOCKETS, servers: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001F\u007F]/.test(value) ? value : null;
}

function coerceWorkspace(raw: unknown): WatchWorkspace | null {
	if (!isRecord(raw)) return null;
	const workspaceId = boundedString(raw.workspaceId, 80);
	const slug = boundedString(raw.slug, 80);
	if (!workspaceId || !slug) return null;
	return { workspaceId, slug, name: typeof raw.name === "string" ? raw.name.slice(0, 100) : slug, watch: raw.watch === true };
}

function coerceServer(raw: unknown): WatchServer | null {
	if (!isRecord(raw)) return null;
	const mode = raw.mode;
	if (mode !== "cloud" && mode !== "local") return null;
	const customUrl = typeof raw.customUrl === "string" ? raw.customUrl : "";
	const apiUrl = typeof raw.apiUrl === "string" ? raw.apiUrl : "";
	// The same rule as when a server is added (an origin, https unless local or private): a hand-edited file
	// must not be able to point a token at a public host over plain http.
	if (mode === "local") {
		for (const url of [customUrl, apiUrl]) if (url !== "" && !validateMulticaServerUrl(url).ok) return null;
	}
	// The key is recomputed, never trusted: a hand-edited file cannot point one server's credential at another's key.
	const resolved = resolveMulticaServer({ mode, customUrl, apiUrl });
	if (!resolved) return null;
	const source = (MULTICA_CREDENTIAL_SOURCES as readonly unknown[]).includes(raw.credentialSource)
		? (raw.credentialSource as MulticaCredentialSource)
		: "profile";
	const workspaces: WatchWorkspace[] = [];
	const seen = new Set<string>();
	for (const value of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
		const workspace = coerceWorkspace(value);
		if (!workspace || seen.has(workspace.workspaceId)) continue;
		seen.add(workspace.workspaceId);
		workspaces.push(workspace);
		if (workspaces.length >= MAX_WATCH_WORKSPACES_PER_SERVER) break;
	}
	return {
		serverKey: resolved.key,
		mode,
		customUrl,
		apiUrl,
		enabled: raw.enabled === true,
		credentialSource: source,
		consentGranted: raw.consentGranted === true,
		workspaces,
	};
}

/** Missing, malformed or unknown input yields the all-off defaults. */
export function coerceWatchConfig(raw: unknown): WatchConfig {
	if (!isRecord(raw) || raw.version !== 1) return { ...DEFAULT_WATCH_CONFIG, servers: [] };
	const servers: WatchServer[] = [];
	const seen = new Set<string>();
	for (const value of Array.isArray(raw.servers) ? raw.servers : []) {
		const server = coerceServer(value);
		if (!server || seen.has(server.serverKey)) continue;
		seen.add(server.serverKey);
		servers.push(server);
		if (servers.length >= MAX_WATCHED_SERVERS) break;
	}
	const maxSockets =
		typeof raw.maxSockets === "number" && Number.isInteger(raw.maxSockets) ? Math.min(MULTICA_MAX_SOCKETS, Math.max(1, raw.maxSockets)) : MULTICA_MAX_SOCKETS;
	return { masterEnabled: raw.masterEnabled === true, maxSockets, servers };
}

export type MulticaWatchConfigStore = {
	read: () => Promise<WatchConfig>;
	/** Applies `change` to the current config under the write lock and persists the result. */
	update: (change: (current: WatchConfig) => WatchConfig) => Promise<WatchConfig>;
};

/** Persisted like `multica-settings.json`: mode 0600, atomic replace, serialised writes. */
export function createMulticaWatchConfigStore(stateDir: string): MulticaWatchConfigStore {
	let queue: Promise<void> = Promise.resolve();
	const run = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = queue.then(operation, operation);
		queue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};
	const file = path.join(stateDir, MULTICA_WATCH_FILE);
	const readUnlocked = async (): Promise<WatchConfig> => {
		try {
			return coerceWatchConfig(JSON.parse(await readFile(file, "utf8")));
		} catch {
			return { ...DEFAULT_WATCH_CONFIG, servers: [] };
		}
	};
	return {
		read: () => run(readUnlocked),
		update: (change) =>
			run(async () => {
				const next = coerceWatchConfig({ version: 1, ...change(await readUnlocked()) });
				await mkdir(stateDir, { recursive: true, mode: 0o750 });
				const temporary = path.join(stateDir, `.multica-watch-${process.pid}-${randomUUID()}.json`);
				try {
					await writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 });
					await rename(temporary, file);
				} finally {
					await unlink(temporary).catch(() => undefined);
				}
				return next;
			}),
	};
}
