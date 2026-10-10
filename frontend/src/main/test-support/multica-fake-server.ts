// A fake Multica server for tests: the REST routes AO reads and the `/ws`
// protocol (first-frame auth, `auth_ack`, error frames, ping), on loopback with
// fixed fixtures. It never talks to a real Multica. Every request is recorded so
// a test can assert what AO sent, and every request that is not a GET is
// recorded as a write and refused, so "AO wrote nothing" is a one-line check.
//
// Shapes follow Multica's wire format as the awareness client reads it; fixtures
// carry the fields AO must drop (descriptions, results, work directories) so the
// tests can prove they never reach the read model.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type FakeRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	authorization: string | undefined;
	workspaceId: string | undefined;
	workspaceSlug: string | undefined;
	origin: string | undefined;
};

export type FakeUser = { id: string; name: string; workspaceIds: string[] };
export type FakeWorkspace = { id: string; slug: string; name: string };

export type FakeFailure = { status: number; headers?: Record<string, string>; count?: number };

export type FakeMulticaServer = {
	origin: string;
	wsUrl: string;
	/** Registers a token (a fake string) for a user. */
	addUser: (token: string, user: FakeUser) => void;
	addWorkspace: (workspace: FakeWorkspace) => void;
	setIssues: (workspaceId: string, issues: Array<Record<string, unknown>>) => void;
	setTasks: (workspaceId: string, tasks: Array<Record<string, unknown>>) => void;
	setAgents: (workspaceId: string, agents: Array<Record<string, unknown>>) => void;
	setRuntimes: (workspaceId: string, runtimes: Array<Record<string, unknown>>) => void;
	/** Answers the next requests whose path starts with `pathPrefix` with `failure` instead of the fixture. */
	failNext: (pathPrefix: string, failure: FakeFailure) => void;
	/** Makes the token invalid: HTTP 401, a WebSocket `invalid token` frame, and a close for open sockets. */
	revokeToken: (token: string) => void;
	/** Sends one frame to every authenticated socket of the workspace; keys sorted as Go marshals a map. */
	broadcast: (workspaceId: string, frame: { type: string; payload?: unknown; actorId?: string; actorType?: string }) => void;
	/** Sends a raw text frame to every socket of the workspace. */
	broadcastRaw: (workspaceId: string, raw: string) => void;
	/** Closes the sockets of the workspace (or every socket) without a goodbye, as a network drop. */
	dropSockets: (workspaceId?: string) => void;
	/** Stops answering auth on new sockets (they stay unauthenticated) to test the liveness timer. */
	holdAuth: (hold: boolean) => void;
	requests: FakeRequest[];
	requestsTo: (pathPrefix: string) => FakeRequest[];
	/** Requests that were not GETs. Always refused with 405. */
	writes: () => FakeRequest[];
	/** WebSocket upgrades seen, including those that failed to authenticate. */
	connectionAttempts: () => number;
	/** Currently authenticated sockets. */
	liveSockets: (workspaceId?: string) => number;
	/** Auth frames received, with the token text, so a test can check which token went to which server. */
	authTokens: () => string[];
	close: () => Promise<void>;
};

type Socket = { ws: WebSocket; workspaceId: string; token: string; authenticated: boolean };

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
	response.end(text);
}

export async function createFakeMulticaServer(): Promise<FakeMulticaServer> {
	const users = new Map<string, FakeUser>();
	const revoked = new Set<string>();
	const workspaces = new Map<string, FakeWorkspace>();
	const issues = new Map<string, Array<Record<string, unknown>>>();
	const tasks = new Map<string, Array<Record<string, unknown>>>();
	const agents = new Map<string, Array<Record<string, unknown>>>();
	const runtimes = new Map<string, Array<Record<string, unknown>>>();
	const failures: Array<{ prefix: string; failure: FakeFailure; remaining: number }> = [];
	const sockets = new Set<Socket>();
	const requests: FakeRequest[] = [];
	const received: string[] = [];
	let attempts = 0;
	let authHeld = false;

	const userFor = (token: string | undefined): FakeUser | null => {
		if (!token || revoked.has(token)) return null;
		return users.get(token) ?? null;
	};
	const bearer = (request: IncomingMessage): string | undefined => {
		const header = request.headers.authorization;
		return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
	};

	function workspaceOf(request: IncomingMessage, user: FakeUser): FakeWorkspace | null {
		const id = request.headers["x-workspace-id"];
		const slug = request.headers["x-workspace-slug"];
		for (const workspace of workspaces.values()) {
			if (!user.workspaceIds.includes(workspace.id)) continue;
			if ((typeof id === "string" && workspace.id === id) || (typeof slug === "string" && workspace.slug === slug)) return workspace;
		}
		return null;
	}

	const http: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fake.invalid");
		const record: FakeRequest = {
			method: request.method ?? "GET",
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
			workspaceId: typeof request.headers["x-workspace-id"] === "string" ? (request.headers["x-workspace-id"] as string) : undefined,
			workspaceSlug: typeof request.headers["x-workspace-slug"] === "string" ? (request.headers["x-workspace-slug"] as string) : undefined,
			origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
		};
		requests.push(record);
		if (record.method !== "GET") {
			json(response, 405, { error: "method not allowed" });
			return;
		}
		const scripted = failures.find((entry) => entry.remaining > 0 && url.pathname.startsWith(entry.prefix));
		if (scripted) {
			scripted.remaining -= 1;
			json(response, scripted.failure.status, { error: "scripted failure" }, scripted.failure.headers);
			return;
		}
		const user = userFor(bearer(request));
		if (!user) {
			json(response, 401, { error: "invalid token" });
			return;
		}
		if (url.pathname === "/api/me") {
			json(response, 200, { id: user.id, name: user.name, email: "fixture@example.invalid" });
			return;
		}
		if (url.pathname === "/api/workspaces") {
			json(response, 200, [...workspaces.values()].filter((workspace) => user.workspaceIds.includes(workspace.id)).map((workspace) => ({ ...workspace, description: "PRIVATE WORKSPACE DESCRIPTION" })));
			return;
		}
		const workspace = workspaceOf(request, user);
		if (!workspace) {
			json(response, 404, { error: "workspace not found" });
			return;
		}
		const list = (store: Map<string, Array<Record<string, unknown>>>) => store.get(workspace.id) ?? [];
		if (url.pathname === "/api/agent-task-snapshot") return json(response, 200, list(tasks));
		if (url.pathname === "/api/agents") return json(response, 200, list(agents));
		if (url.pathname === "/api/runtimes") return json(response, 200, list(runtimes));
		if (url.pathname === "/api/issues") {
			let rows = list(issues);
			const ids = url.searchParams.get("ids");
			if (ids) rows = rows.filter((issue) => ids.split(",").includes(issue.id as string));
			const assigneeIds = url.searchParams.get("assignee_ids");
			if (assigneeIds) rows = rows.filter((issue) => assigneeIds.split(",").includes(issue.assignee_id as string));
			const assigneeTypes = url.searchParams.get("assignee_types");
			if (assigneeTypes) rows = rows.filter((issue) => assigneeTypes.split(",").includes(issue.assignee_type as string));
			if (url.searchParams.get("open_only") === "true") rows = rows.filter((issue) => issue.status_category !== "done" && issue.status_category !== "cancelled");
			rows = [...rows].sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
			const limit = Number(url.searchParams.get("limit") ?? 100);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			return json(response, 200, { issues: rows.slice(offset, offset + limit), total: rows.length });
		}
		const issueMatch = /^\/api\/issues\/([A-Za-z0-9-]+)(?:\/(task-runs|active-task))?$/.exec(url.pathname);
		if (issueMatch) {
			const issue = list(issues).find((candidate) => candidate.id === issueMatch[1] || candidate.identifier === issueMatch[1]);
			if (!issue) return json(response, 404, { error: "issue not found" });
			if (!issueMatch[2]) return json(response, 200, issue);
			const runs = list(tasks).filter((task) => task.issue_id === issue.id);
			if (issueMatch[2] === "active-task") return json(response, 200, runs.filter((task) => ["queued", "dispatched", "running", "waiting_local_directory"].includes(task.status as string)));
			const active = url.searchParams.get("active") === "true";
			return json(response, 200, active ? runs.filter((task) => ["queued", "dispatched", "running", "waiting_local_directory"].includes(task.status as string)) : runs);
		}
		json(response, 404, { error: "not found" });
	});

	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	http.on("upgrade", (request, socket, head) => {
		attempts += 1;
		const url = new URL(request.url ?? "/", "http://fake.invalid");
		requests.push({
			method: "GET",
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
			workspaceId: undefined,
			workspaceSlug: undefined,
			origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
		});
		const workspaceId = url.searchParams.get("workspace_id") ?? "";
		if (url.pathname !== "/ws" || !workspaceId) {
			socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const entry: Socket = { ws, workspaceId, token: "", authenticated: false };
			sockets.add(entry);
			ws.on("close", () => sockets.delete(entry));
			ws.on("error", () => undefined);
			ws.once("message", (data) => {
				if (authHeld) return;
				let token = "";
				try {
					const message = JSON.parse(data.toString()) as { type?: string; payload?: { token?: string } };
					if (message.type === "auth" && typeof message.payload?.token === "string") token = message.payload.token;
				} catch {
					// An unparseable first frame is an auth failure.
				}
				received.push(token);
				const user = userFor(token);
				if (!user) {
					ws.send(JSON.stringify({ error: "invalid token" }));
					ws.close();
					return;
				}
				if (!user.workspaceIds.includes(workspaceId)) {
					ws.send(JSON.stringify({ error: "not a member of this workspace" }));
					ws.close();
					return;
				}
				entry.token = token;
				entry.authenticated = true;
				ws.send(JSON.stringify({ type: "auth_ack" }));
			});
		});
	});

	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const port = (http.address() as AddressInfo).port;
	const origin = `http://127.0.0.1:${port}`;

	return {
		origin,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		addUser: (token, user) => {
			users.set(token, user);
			revoked.delete(token);
		},
		addWorkspace: (workspace) => workspaces.set(workspace.id, workspace),
		setIssues: (workspaceId, rows) => issues.set(workspaceId, rows),
		setTasks: (workspaceId, rows) => tasks.set(workspaceId, rows),
		setAgents: (workspaceId, rows) => agents.set(workspaceId, rows),
		setRuntimes: (workspaceId, rows) => runtimes.set(workspaceId, rows),
		failNext: (prefix, failure) => failures.push({ prefix, failure, remaining: failure.count ?? 1 }),
		revokeToken: (token) => {
			revoked.add(token);
			for (const entry of sockets) {
				if (entry.token !== token) continue;
				entry.ws.send(JSON.stringify({ error: "invalid token" }));
				entry.ws.close();
			}
		},
		broadcast: (workspaceId, frame) => {
			const text = JSON.stringify({
				actor_id: frame.actorId ?? "",
				actor_type: frame.actorType ?? "system",
				payload: frame.payload ?? {},
				type: frame.type,
			});
			for (const entry of sockets) if (entry.authenticated && entry.workspaceId === workspaceId) entry.ws.send(text);
		},
		broadcastRaw: (workspaceId, raw) => {
			for (const entry of sockets) if (entry.authenticated && entry.workspaceId === workspaceId) entry.ws.send(raw);
		},
		dropSockets: (workspaceId) => {
			for (const entry of sockets) if (workspaceId === undefined || entry.workspaceId === workspaceId) entry.ws.terminate();
		},
		holdAuth: (hold) => {
			authHeld = hold;
		},
		requests,
		requestsTo: (prefix) => requests.filter((request) => request.path.startsWith(prefix)),
		writes: () => requests.filter((request) => request.method !== "GET"),
		connectionAttempts: () => attempts,
		liveSockets: (workspaceId) => [...sockets].filter((entry) => entry.authenticated && (workspaceId === undefined || entry.workspaceId === workspaceId)).length,
		authTokens: () => [...received],
		close: async () => {
			for (const entry of sockets) entry.ws.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}

/** A raw issue as the server sends it, including fields AO must never keep. */
export function fakeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "iss-1",
		workspace_id: "ws-1",
		number: 1,
		identifier: "MUL-1",
		title: "Fixture issue",
		description: "PRIVATE ISSUE DESCRIPTION",
		status: "todo",
		status_category: "todo",
		priority: "none",
		assignee_type: null,
		assignee_id: null,
		parent_issue_id: null,
		project_id: null,
		revision: 1,
		updated_at: "2026-10-10T10:00:00Z",
		metadata: { note: "PRIVATE METADATA" },
		...overrides,
	};
}

/** A raw task as the REST snapshot sends it, including fields AO must never keep. */
export function fakeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "task-1",
		agent_id: "agent-1",
		runtime_id: "rt-1",
		issue_id: "iss-1",
		workspace_id: "ws-1",
		status: "running",
		result: { summary: "PRIVATE TASK RESULT" },
		error: null,
		work_dir: "/Users/someone/PRIVATE_WORK_DIR",
		trigger_comment_content: "PRIVATE TRIGGER COMMENT",
		started_at: "2026-10-10T10:05:00Z",
		completed_at: null,
		is_leader_task: false,
		created_at: "2026-10-10T10:04:00Z",
		...overrides,
	};
}
