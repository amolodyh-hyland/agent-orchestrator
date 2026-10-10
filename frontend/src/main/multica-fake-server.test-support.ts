// A fake Multica server for tests: just enough of the issue API to exercise
// status sync end to end (read an issue, compare-and-set a status, preview the
// run trigger). It also models the one hazard the sync design guards against: a
// write that would start a Multica agent run, counted in `runsStarted`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import type { MulticaServer } from "../shared/multica";

export type FakeIssue = {
	id: string;
	workspace_id: string;
	number: number;
	identifier: string;
	title: string;
	description: string;
	status: string;
	status_category?: string;
	assignee_type: "member" | "agent" | "squad" | null;
	assignee_id: string | null;
	revision: number;
	triage_state?: string | null;
	/** An entry that is in Triage in Multica but whose JSON does not say so (today's real behaviour). Never serialized. */
	hiddenTriage?: boolean;
	parent_issue_id: string | null;
};

export type FakeRequest = {
	method: string;
	path: string;
	workspaceSlug: string | null;
	hasAuthorization: boolean;
	body: Record<string, unknown> | null;
};

export type ForcedFailure = { status: number; body?: unknown; headers?: Record<string, string> };

export type FakeMulticaServer = {
	url: string;
	token: string;
	requests: FakeRequest[];
	/** Requests that were neither an issue read, a status write nor a trigger preview. Must stay empty. */
	unexpected: FakeRequest[];
	issues: Map<string, FakeIssue>;
	/** Writes that would have started a Multica agent run for the written issue itself. */
	runsStarted: number;
	/** Status writes on a sub-issue whose parent is owned by an agent or squad: Multica's child rules wake that parent whatever `suppress_run` says. */
	parentWakes: number;
	/** Status writes on a sub-issue whose parent belongs to a member (an inbox notification, as for a human). */
	parentNotifications: number;
	addIssue: (issue: Partial<FakeIssue> & { identifier: string }) => FakeIssue;
	/** Runs once, just before the next status write is processed (to stage a concurrent change by a person). */
	beforeNextPut: (action: (issue: FakeIssue) => void) => void;
	failNext: (match: { method?: string; pathPrefix?: string }, failure: ForcedFailure, times?: number) => void;
	forbid: (identifier: string) => void;
	close: () => Promise<void>;
};

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
let issueCounter = 0;

function uuid(counter: number): string {
	return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		request.on("data", (chunk) => {
			data += String(chunk);
		});
		request.on("end", () => resolve(data));
	});
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "Content-Type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

export async function startFakeMulticaServer(options: { token?: string } = {}): Promise<FakeMulticaServer> {
	const token = options.token ?? "tok-secret-1234567890";
	const issues = new Map<string, FakeIssue>();
	const requests: FakeRequest[] = [];
	const unexpected: FakeRequest[] = [];
	const forbidden = new Set<string>();
	const failures: Array<{ method?: string; pathPrefix?: string; failure: ForcedFailure; times: number }> = [];
	const beforePut: Array<(issue: FakeIssue) => void> = [];
	const state = { runsStarted: 0, parentWakes: 0, parentNotifications: 0 };

	const wouldStartRun = (issue: FakeIssue, nextStatus: string): boolean =>
		(issue.assignee_type === "agent" || issue.assignee_type === "squad") &&
		issue.status === "backlog" &&
		nextStatus !== "backlog" &&
		nextStatus !== "done" &&
		nextStatus !== "cancelled";

	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://fake.invalid");
		const raw = await readBody(request);
		let body: Record<string, unknown> | null = null;
		if (raw) {
			try {
				body = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				body = null;
			}
		}
		const recorded: FakeRequest = {
			method: request.method ?? "GET",
			path: url.pathname,
			workspaceSlug: typeof request.headers["x-workspace-slug"] === "string" ? request.headers["x-workspace-slug"] : null,
			hasAuthorization: typeof request.headers.authorization === "string",
			body,
		};
		requests.push(recorded);

		if (request.headers.authorization !== `Bearer ${token}`) {
			send(response, 401, { error: "unauthorized" });
			return;
		}
		const forced = failures.find(
			(entry) =>
				entry.times > 0 && (entry.method === undefined || entry.method === recorded.method) && (entry.pathPrefix === undefined || recorded.path.startsWith(entry.pathPrefix)),
		);
		if (forced) {
			forced.times -= 1;
			send(response, forced.failure.status, forced.failure.body ?? { error: "forced" }, forced.failure.headers);
			return;
		}

		const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
		if (recorded.method === "GET" && issueMatch && issueMatch[1] !== "preview-trigger") {
			const found = [...issues.values()].find((candidate) => candidate.identifier === issueMatch[1] || candidate.id === issueMatch[1]);
			if (!found) {
				send(response, 404, { error: "issue not found" });
				return;
			}
			if (forbidden.has(found.identifier)) {
				send(response, 403, { error: "forbidden" });
				return;
			}
			const { hiddenTriage: _hidden, ...visible } = found;
			send(response, 200, visible);
			return;
		}
		if (recorded.method === "PUT" && issueMatch) {
			const found = issues.get(issueMatch[1]);
			if (!found) {
				send(response, 404, { error: "issue not found" });
				return;
			}
			const hook = beforePut.shift();
			if (hook) hook(found);
			if (found.triage_state && body && "parent_issue_id" in body) {
				send(response, 400, { error: "the issue is in Triage", code: "issue_in_triage" });
				return;
			}
			if (body && typeof body.expected_revision === "number" && body.expected_revision !== found.revision) {
				send(response, 409, {
					error: "resource changed since it was loaded",
					code: "revision_conflict",
					resource_type: "issue",
					resource_id: found.id,
					expected_revision: body.expected_revision,
					actual_revision: found.revision,
				});
				return;
			}
			if (body && typeof body.status === "string") {
				if (body.suppress_run !== true && wouldStartRun(found, body.status)) state.runsStarted += 1;
				found.status = body.status;
				found.status_category = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(body.status)
					? body.status
					: found.status_category;
				found.revision += 1;
				// Multica runs the parent's sub-issue rules after any status change; suppress_run does not cover them.
				const parent = found.parent_issue_id ? issues.get(found.parent_issue_id) : undefined;
				if (parent?.assignee_type === "agent" || parent?.assignee_type === "squad") state.parentWakes += 1;
				else if (parent) state.parentNotifications += 1;
			}
			const { hiddenTriage: _hiddenAfter, ...written } = found;
			send(response, 200, written);
			return;
		}
		if (recorded.method === "POST" && url.pathname === "/api/issues/preview-trigger") {
			const ids = body && Array.isArray(body.issue_ids) ? (body.issue_ids as string[]) : [];
			const nextStatus = body && typeof body.status === "string" ? body.status : "";
			const triggers = ids.flatMap((id) => {
				const found = issues.get(id);
				return found && wouldStartRun(found, nextStatus) ? [{ issue_id: found.id, agent_id: found.assignee_id ?? "", source: "status" }] : [];
			});
			send(response, 200, { triggers, total_count: triggers.length });
			return;
		}
		unexpected.push(recorded);
		send(response, 404, { error: "not found" });
	};

	const server: Server = createServer((request, response) => {
		void handler(request, response).catch(() => {
			response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const fake: FakeMulticaServer = {
		url,
		token,
		requests,
		unexpected,
		issues,
		get runsStarted() {
			return state.runsStarted;
		},
		get parentWakes() {
			return state.parentWakes;
		},
		get parentNotifications() {
			return state.parentNotifications;
		},
		addIssue: (partial) => {
			issueCounter += 1;
			const issue: FakeIssue = {
				id: uuid(issueCounter),
				workspace_id: WORKSPACE_ID,
				number: Number(partial.identifier.split("-")[1]),
				title: "Fix the bug",
				description: "A long secret description that must never leave the page.",
				status: "todo",
				status_category: partial.status ?? "todo",
				assignee_type: "member",
				assignee_id: uuid(900000 + issueCounter),
				revision: 4,
				parent_issue_id: null,
				...partial,
			};
			if (partial.status !== undefined && partial.status_category === undefined) issue.status_category = partial.status;
			issues.set(issue.id, issue);
			return issue;
		},
		beforeNextPut: (action) => {
			beforePut.push(action);
		},
		failNext: (match, failure, times = 1) => {
			failures.push({ ...match, failure, times });
		},
		forbid: (identifier) => {
			forbidden.add(identifier);
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
	return fake;
}

export type FakeHost = {
	getServer: () => MulticaServer | null;
	evaluateInPage: (script: string, serverKey?: string) => Promise<unknown>;
	/** Pretend the live view belongs to a different server from now on. */
	switchServer: (serverKey: string) => void;
	/** Pretend there is no live view (hidden or not created). */
	setAvailable: (available: boolean) => void;
	/** Scripts that were evaluated, in order. */
	scripts: string[];
	setToken: (token: string | null) => void;
};

/** Runs the real in-page scripts against a fake server, with the sandbox a Multica page offers them. */
export function createFakeHost(fake: Pick<FakeMulticaServer, "url" | "token">, serverKey = "http://localhost:3000"): FakeHost {
	let currentKey = serverKey;
	let available = true;
	let token: string | null = fake.token;
	const scripts: string[] = [];
	const serverFor = (key: string): MulticaServer =>
		({
			key,
			mode: "local",
			appUrl: "http://localhost:3000",
			config: { schemaVersion: 1, apiUrl: fake.url, wsUrl: "ws://127.0.0.1/ws", appUrl: "http://localhost:3000" },
			partition: "persist:test",
			cliProfile: null,
		}) as MulticaServer;
	return {
		getServer: () => (available ? serverFor(currentKey) : null),
		evaluateInPage: async (script, key) => {
			if (!available) return undefined;
			if (key !== undefined && key !== currentKey) return undefined;
			scripts.push(script);
			return await (runInNewContext(script, {
				localStorage: { getItem: (name: string) => (name === "multica_token" ? token : null) },
				fetch: globalThis.fetch,
				AbortController,
				setTimeout,
				clearTimeout,
				JSON,
				encodeURIComponent,
				Promise,
				Error,
			}) as Promise<unknown>);
		},
		switchServer: (next) => {
			currentKey = next;
		},
		setAvailable: (next) => {
			available = next;
		},
		scripts,
		setToken: (next) => {
			token = next;
		},
	};
}
