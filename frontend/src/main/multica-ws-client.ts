// One WebSocket per watched workspace. Connects to Multica's `/ws`, sends the
// token as the first frame (never in the URL), waits for `auth_ack`, then hands
// text frames to the caller. Reconnects with jittered back-off; a 401 or an
// `invalid token` frame stops for good until the credential changes. The server
// offers no resume position, so the caller reconciles by GET each time the
// socket goes live again.

import { WebSocket, type RawData } from "ws";
import { systemScheduler, type Scheduler } from "./multica-read-client";

export type WorkspaceSocketState = "connecting" | "authenticating" | "live" | "backoff" | "stopped";
/** Why a socket stopped for good: its token is refused, the user may not read it, or it no longer exists. */
export type WorkspaceSocketStop = "unauthorized" | "no_access" | "gone";

export const SOCKET_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const SOCKET_DEAD_AFTER_MS = 120_000;
export const SOCKET_RESET_AFTER_LIVE_MS = 120_000;
export const SOCKET_BACKOFF_BASE_MS = 1_000;
export const SOCKET_BACKOFF_MAX_MS = 60_000;
export const SOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;

export type WorkspaceSocketOptions = {
	/** The server's `/ws` URL (`ws:` or `wss:`). The workspace id is added as a query parameter; the token never is. */
	wsUrl: string;
	workspaceId: string;
	getToken: () => string | null;
	/** A text frame that is not one of the noisy types. */
	onFrame: (raw: string) => void;
	/** Fires each time the socket becomes live (after `auth_ack`), the first time and after every reconnect. */
	onLive: () => void;
	onState: (state: WorkspaceSocketState, attempt: number) => void;
	onStop: (reason: WorkspaceSocketStop) => void;
	scheduler?: Scheduler;
	random?: () => number;
};

export type WorkspaceSocket = {
	start: () => void;
	stop: () => void;
	state: () => WorkspaceSocketState;
};

const NOISY_SUFFIXES = /"type":"(?:task:message|task:progress|daemon:[A-Za-z0-9_.:-]*)"\}$/;

/**
 * Cheap pre-parse filter. Go marshals a map with sorted keys, so `type` is the
 * last key of a frame and a suffix test finds the high-volume frame types
 * (`task:message`, `task:progress`, `daemon:*`) without parsing them. A frame
 * that does not end that way is passed on and judged after parsing.
 */
export function isNoisyFrame(raw: string): boolean {
	return NOISY_SUFFIXES.test(raw);
}

/** Delay before reconnect attempt `attempt` (1-based): 1 s doubling to 60 s, with 50 to 150 percent jitter. */
export function reconnectDelayMs(attempt: number, random: number): number {
	const base = Math.min(SOCKET_BACKOFF_MAX_MS, SOCKET_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (0.5 + random));
}

function stopReasonForError(message: string): WorkspaceSocketStop | null {
	const text = message.toLowerCase();
	if (text.includes("invalid token")) return "unauthorized";
	if (text.includes("account disabled") || text.includes("not a member")) return "no_access";
	if (text.includes("workspace not found")) return "gone";
	return null;
}

function toText(data: RawData, isBinary: boolean): string | null {
	if (isBinary) return null;
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return Buffer.from(data).toString("utf8");
}

export function createWorkspaceSocket(options: WorkspaceSocketOptions): WorkspaceSocket {
	const scheduler = options.scheduler ?? systemScheduler;
	const random = options.random ?? Math.random;
	let current: WorkspaceSocketState = "stopped";
	let socket: WebSocket | null = null;
	let attempt = 0;
	let liveSince: number | null = null;
	let reconnectTimer: unknown = null;
	let deadTimer: unknown = null;
	let stopped = true;
	// Each connection gets an id so a late event from a closed socket is ignored.
	let generation = 0;

	const setState = (next: WorkspaceSocketState): void => {
		current = next;
		options.onState(next, attempt);
	};

	const clearDead = (): void => {
		if (deadTimer !== null) scheduler.clearTimeout(deadTimer);
		deadTimer = null;
	};

	const armDead = (id: number): void => {
		clearDead();
		deadTimer = scheduler.setTimeout(() => {
			if (id !== generation || stopped) return;
			// No frame and no ping for two minutes: the connection is dead.
			socket?.terminate();
			ended(id);
		}, SOCKET_DEAD_AFTER_MS);
	};

	const closeSocket = (): void => {
		const closing = socket;
		socket = null;
		generation += 1;
		clearDead();
		if (!closing) return;
		closing.removeAllListeners();
		closing.on("error", () => undefined);
		try {
			closing.terminate();
		} catch {
			// Already gone.
		}
	};

	const permanentStop = (reason: WorkspaceSocketStop): void => {
		if (stopped) return;
		stopped = true;
		closeSocket();
		if (reconnectTimer !== null) scheduler.clearTimeout(reconnectTimer);
		reconnectTimer = null;
		setState("stopped");
		options.onStop(reason);
	};

	function ended(id: number): void {
		if (id !== generation || stopped) return;
		if (liveSince !== null && scheduler.now() - liveSince >= SOCKET_RESET_AFTER_LIVE_MS) attempt = 0;
		liveSince = null;
		closeSocket();
		attempt += 1;
		setState("backoff");
		reconnectTimer = scheduler.setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, reconnectDelayMs(attempt, random()));
	}

	function connect(): void {
		if (stopped) return;
		const token = options.getToken();
		if (token === null) {
			permanentStop("unauthorized");
			return;
		}
		const url = new URL(options.wsUrl);
		url.searchParams.set("workspace_id", options.workspaceId);
		const id = (generation += 1);
		setState("connecting");
		let ws: WebSocket;
		try {
			// No Origin header: a main-process client is not subject to the page allow-list. Redirects are not followed.
			ws = new WebSocket(url, { maxPayload: SOCKET_MAX_PAYLOAD_BYTES, followRedirects: false, handshakeTimeout: SOCKET_HANDSHAKE_TIMEOUT_MS });
		} catch {
			ended(id);
			return;
		}
		socket = ws;
		armDead(id);

		ws.on("open", () => {
			if (id !== generation) return;
			setState("authenticating");
			ws.send(JSON.stringify({ type: "auth", payload: { token } }));
		});
		ws.on("ping", () => {
			if (id === generation) armDead(id);
		});
		ws.on("unexpected-response", (_request, response) => {
			if (id !== generation) return;
			const status = response.statusCode ?? 0;
			response.resume();
			if (status === 401) permanentStop("unauthorized");
			else if (status === 403) permanentStop("no_access");
			else if (status === 404) permanentStop("gone");
			else ended(id);
		});
		ws.on("message", (data, isBinary) => {
			if (id !== generation) return;
			const text = toText(data, isBinary);
			if (text === null) return;
			armDead(id);
			if (text.startsWith('{"error":')) {
				// The server answers a bad token, a disabled account or a missing membership with an error frame, then closes.
				let message = "";
				try {
					const parsed = JSON.parse(text) as { error?: unknown };
					message = typeof parsed.error === "string" ? parsed.error : "";
				} catch {
					// An unparseable error frame is treated as a failed attempt by the close that follows.
				}
				const reason = stopReasonForError(message);
				if (reason) permanentStop(reason);
				return;
			}
			if (current !== "live") {
				if (text === '{"type":"auth_ack"}') {
					liveSince = scheduler.now();
					setState("live");
					options.onLive();
				}
				return;
			}
			if (isNoisyFrame(text)) return;
			options.onFrame(text);
		});
		ws.on("error", () => {
			// The close event that follows drives the reconnect.
		});
		ws.on("close", () => ended(id));
	}

	return {
		start: () => {
			if (!stopped) return;
			stopped = false;
			attempt = 0;
			liveSince = null;
			connect();
		},
		stop: () => {
			if (stopped && current === "stopped") return;
			stopped = true;
			closeSocket();
			if (reconnectTimer !== null) scheduler.clearTimeout(reconnectTimer);
			reconnectTimer = null;
			current = "stopped";
		},
		state: () => current,
	};
}
