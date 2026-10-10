// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MULTICA_WRITABLE_STATUSES } from "../shared/multica-status-writer";
import {
	buildMulticaRequestScript,
	createMulticaIssueApi,
	MULTICA_ISSUE_API_ALLOW_LIST,
	parseMulticaIssueResponse,
	prepareMulticaRequest,
	type MulticaApiRequest,
} from "./multica-issue-api";
import { createFakeHost, startFakeMulticaServer, type FakeHost, type FakeMulticaServer } from "./multica-fake-server.test-support";

const SERVER_KEY = "http://localhost:3000";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

describe("prepareMulticaRequest allow-list", () => {
	it("builds the status write with exactly status, expected_revision and suppress_run: true", () => {
		const prepared = prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status: "in_progress", expectedRevision: 7 });

		expect(prepared).toMatchObject({ method: "PUT", pathTemplate: "/api/issues/{id}", path: `/api/issues/${ISSUE_ID}`, workspaceSlug: "acme" });
		expect(prepared.body).toEqual({ status: "in_progress", expected_revision: 7, suppress_run: true });
		expect(Object.keys(prepared.body ?? {}).sort()).toEqual([...MULTICA_ISSUE_API_ALLOW_LIST.put_status.bodyFields].sort());
	});

	it("always carries suppress_run: true, whatever the status", () => {
		for (const status of MULTICA_WRITABLE_STATUSES) {
			const prepared = prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status, expectedRevision: 1 });
			expect(prepared.body?.suppress_run).toBe(true);
		}
	});

	it("builds the parent read as a plain GET by UUID, and refuses a bad id", () => {
		expect(prepareMulticaRequest({ kind: "get_parent", workspaceSlug: "acme", issueId: ISSUE_ID })).toMatchObject({
			method: "GET",
			pathTemplate: "/api/issues/{id}",
			path: `/api/issues/${ISSUE_ID}`,
			body: null,
		});
		expect(() => prepareMulticaRequest({ kind: "get_parent", workspaceSlug: "acme", issueId: "MUL-1" })).toThrow("invalid issue id");
		expect(() => prepareMulticaRequest({ kind: "get_parent", workspaceSlug: "acme", issueId: "../me" })).toThrow();
	});

	it("builds the issue read and the trigger preview", () => {
		expect(prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "acme", identifier: "MUL-12" })).toMatchObject({
			method: "GET",
			path: "/api/issues/MUL-12",
			body: null,
		});
		expect(prepareMulticaRequest({ kind: "preview_trigger", workspaceSlug: "acme", issueId: ISSUE_ID, status: "in_progress" })).toMatchObject({
			method: "POST",
			path: "/api/issues/preview-trigger",
			body: { issue_ids: [ISSUE_ID], status: "in_progress" },
		});
	});

	it("refuses every status AO must never write, and every field outside the list", () => {
		for (const status of ["backlog", "todo", "blocked", "cancelled", "triage", "", "IN_PROGRESS", "in_progress ", "custom"]) {
			expect(() =>
				prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status: status as never, expectedRevision: 1 }),
			).toThrow("status not allowed");
			expect(() =>
				prepareMulticaRequest({ kind: "preview_trigger", workspaceSlug: "acme", issueId: ISSUE_ID, status: status as never }),
			).toThrow("status not allowed");
		}
	});

	it("never builds a request whose method, path or body field is off the list", () => {
		const requests: MulticaApiRequest[] = [];
		for (const status of MULTICA_WRITABLE_STATUSES) {
			requests.push({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status, expectedRevision: 3 });
			requests.push({ kind: "preview_trigger", workspaceSlug: "acme", issueId: ISSUE_ID, status });
		}
		requests.push({ kind: "get_issue", workspaceSlug: "acme", identifier: "MUL-1" });
		requests.push({ kind: "get_parent", workspaceSlug: "acme", issueId: ISSUE_ID });
		const allowed = Object.values(MULTICA_ISSUE_API_ALLOW_LIST);
		for (const request of requests) {
			const prepared = prepareMulticaRequest(request);
			const entry = allowed.find((candidate) => candidate.method === prepared.method && candidate.pathTemplate === prepared.pathTemplate);
			expect(entry, `${prepared.method} ${prepared.pathTemplate}`).toBeDefined();
			for (const field of Object.keys(prepared.body ?? {})) expect(entry?.bodyFields).toContain(field);
			expect(prepared.body === null ? "" : JSON.stringify(prepared.body)).not.toMatch(/assignee|backlog|cancelled|blocked|"todo"/);
		}
	});

	it("rejects an unknown request kind, a bad workspace, a bad identifier, a bad id and a bad revision", () => {
		expect(() => prepareMulticaRequest({ kind: "delete_issue", workspaceSlug: "acme" } as never)).toThrow();
		expect(() => prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "../x", identifier: "MUL-1" })).toThrow("invalid workspace");
		expect(() => prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "acme", identifier: "mul-1" })).toThrow("invalid issue identifier");
		expect(() => prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "acme", identifier: "MUL-1/../../me" })).toThrow();
		expect(() => prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: "not-a-uuid", status: "done", expectedRevision: 1 })).toThrow("invalid issue id");
		expect(() => prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status: "done", expectedRevision: 0 })).toThrow("invalid revision");
		expect(() => prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: ISSUE_ID, status: "done", expectedRevision: 1.5 })).toThrow("invalid revision");
	});

	it("builds a valid async script that embeds no token", () => {
		const script = buildMulticaRequestScript({
			apiUrl: "https://api.example.com/",
			request: prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "acme", identifier: "MUL-1" }),
		});
		expect(script.startsWith("(async () => {")).toBe(true);
		expect(script).toContain('credentials: "omit"');
		expect(script).toContain('redirect: "error"');
		expect(script).not.toMatch(/tok-/);
	});
});

describe("parseMulticaIssueResponse", () => {
	it("is unavailable for a missing result and unreadable for garbage", () => {
		expect(parseMulticaIssueResponse(undefined)).toEqual({ ok: false, kind: "unavailable" });
		expect(parseMulticaIssueResponse("{")).toEqual({ ok: false, kind: "unreadable" });
		expect(parseMulticaIssueResponse("[]")).toEqual({ ok: false, kind: "unreadable" });
		expect(parseMulticaIssueResponse(JSON.stringify({ ok: true, status: 200, body: { id: "x" } }))).toMatchObject({ ok: false, kind: "unreadable" });
	});

	it("derives the category from the status key when the server sends none, and from status_category otherwise", () => {
		const body = { id: ISSUE_ID, workspace_id: ISSUE_ID, identifier: "MUL-1", status: "in_review", revision: 3, status_category: null, assignee_type: null, triage_state: null };
		const plain = parseMulticaIssueResponse(JSON.stringify({ ok: true, status: 200, body }));
		expect(plain).toMatchObject({ ok: true, issue: { category: "in_review", inTriage: false, assigneeType: null } });
		const custom = parseMulticaIssueResponse(JSON.stringify({ ok: true, status: 200, body: { ...body, status: "qa", status_category: "in_review" } }));
		expect(custom).toMatchObject({ ok: true, issue: { status: "qa", category: "in_review" } });
		const customWithoutCategory = parseMulticaIssueResponse(JSON.stringify({ ok: true, status: 200, body: { ...body, status: "qa", status_category: null } }));
		expect(customWithoutCategory).toMatchObject({ ok: true, issue: { status: "qa", category: "" } });
	});

	it("reads a triage field when the server sends one", () => {
		const body = { id: ISSUE_ID, workspace_id: ISSUE_ID, identifier: "MUL-1", status: "todo", revision: 3, triage_state: true };
		expect(parseMulticaIssueResponse(JSON.stringify({ ok: true, status: 200, body }))).toMatchObject({ ok: true, issue: { inTriage: true } });
	});
});

describe("issue API against a fake Multica server", () => {
	let fake: FakeMulticaServer;
	let host: FakeHost;
	let api: ReturnType<typeof createMulticaIssueApi>;

	beforeEach(async () => {
		fake = await startFakeMulticaServer();
		host = createFakeHost(fake, SERVER_KEY);
		api = createMulticaIssueApi({ getHost: () => host });
	});

	afterEach(async () => {
		await fake.close();
	});

	it("reads an issue with the page token and the link's workspace, and drops everything else", async () => {
		const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });

		const result = await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" });

		expect(result).toEqual({
			ok: true,
			issue: {
				id: issue.id,
				workspaceId: issue.workspace_id,
				identifier: "MUL-1",
				status: "todo",
				category: "todo",
				revision: 4,
				assigneeType: "member",
				inTriage: false,
				parentIssueId: null,
			},
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(JSON.stringify(result)).not.toContain(fake.token);
		expect(fake.requests).toEqual([
			{ method: "GET", path: "/api/issues/MUL-1", workspaceSlug: "acme", hasAuthorization: true, body: null },
		]);
	});

	it("what the page script hands back never contains the token, the description or an error sentence", async () => {
		const issue = fake.addIssue({ identifier: "MUL-1", status: "todo", description: "A long secret description" });
		const read = buildMulticaRequestScript({
			apiUrl: fake.url,
			request: prepareMulticaRequest({ kind: "get_issue", workspaceSlug: "acme", identifier: "MUL-1" }),
		});
		const rawRead = String(await host.evaluateInPage(read, SERVER_KEY));
		const write = buildMulticaRequestScript({
			apiUrl: fake.url,
			request: prepareMulticaRequest({ kind: "put_status", workspaceSlug: "acme", issueId: issue.id, status: "in_progress", expectedRevision: 1 }),
		});
		const rawConflict = String(await host.evaluateInPage(write, SERVER_KEY));

		for (const raw of [rawRead, rawConflict]) {
			expect(raw).not.toContain(fake.token);
			expect(raw).not.toMatch(/secret|Bearer|resource changed since it was loaded/);
		}
		expect(JSON.parse(rawRead).body).toEqual({
			id: issue.id,
			workspace_id: issue.workspace_id,
			identifier: "MUL-1",
			status: "todo",
			status_category: "todo",
			revision: 4,
			assignee_type: "member",
			parent_issue_id: null,
			triage_state: null,
		});
		expect(JSON.parse(rawConflict).body).toEqual({ code: "revision_conflict", actual_revision: 4 });
	});

	it("writes a status with expected_revision and suppress_run, and returns the new revision", async () => {
		const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });

		const result = await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: issue.id, status: "in_progress", expectedRevision: 4 });

		expect(result).toMatchObject({ ok: true, issue: { status: "in_progress", category: "in_progress", revision: 5 } });
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]).toMatchObject({
			method: "PUT",
			path: `/api/issues/${issue.id}`,
			workspaceSlug: "acme",
			body: { status: "in_progress", expected_revision: 4, suppress_run: true },
		});
		expect(Object.keys(fake.requests[0].body ?? {}).sort()).toEqual(["expected_revision", "status", "suppress_run"]);
	});

	it("starts no Multica run for the written issue itself, even when the write leaves backlog on an issue an agent owns (the parent's sub-issue rules are a separate matter, see the engine tests)", async () => {
		const issue = fake.addIssue({ identifier: "MUL-2", status: "backlog", assignee_type: "agent" });

		const result = await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: issue.id, status: "in_progress", expectedRevision: 4 });

		expect(result.ok).toBe(true);
		expect(fake.runsStarted).toBe(0);
	});

	it("reports a revision conflict with the actual revision", async () => {
		const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });

		const result = await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: issue.id, status: "in_progress", expectedRevision: 3 });

		expect(result).toEqual({ ok: false, kind: "conflict", httpStatus: 409, code: "revision_conflict", actualRevision: 4 });
		expect(fake.issues.get(issue.id)?.status).toBe("todo");
	});

	it("previews whether a write would start a run", async () => {
		const agentIssue = fake.addIssue({ identifier: "MUL-2", status: "backlog", assignee_type: "agent" });
		const memberIssue = fake.addIssue({ identifier: "MUL-3", status: "backlog" });

		expect(await api.previewTrigger(SERVER_KEY, { workspaceSlug: "acme", issueId: agentIssue.id, status: "in_progress" })).toEqual({ ok: true, triggers: 1 });
		expect(await api.previewTrigger(SERVER_KEY, { workspaceSlug: "acme", issueId: memberIssue.id, status: "in_progress" })).toEqual({ ok: true, triggers: 0 });
	});

	it("reads the parent of a sub-issue, and projects its parent id", async () => {
		const parent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: "agent" });
		fake.addIssue({ identifier: "MUL-6", status: "todo", parent_issue_id: parent.id });

		const child = await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-6" });
		expect(child).toMatchObject({ ok: true, issue: { parentIssueId: parent.id } });
		const read = await api.getParent(SERVER_KEY, { workspaceSlug: "acme", issueId: parent.id });
		expect(read).toMatchObject({ ok: true, issue: { identifier: "MUL-5", assigneeType: "agent", parentIssueId: null } });
		expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /api/issues/MUL-6", `GET /api/issues/${parent.id}`]);
	});

	it("maps 404, 403, 429, 5xx, triage and other rejections to distinct failures", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		fake.addIssue({ identifier: "MUL-9", status: "todo" });
		fake.forbid("MUL-9");

		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-404" })).toMatchObject({ ok: false, kind: "not_found" });
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-9" })).toMatchObject({ ok: false, kind: "forbidden" });

		fake.failNext({ method: "GET" }, { status: 429, headers: { "Retry-After": "12" } });
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 12000 });

		fake.failNext({ method: "GET" }, { status: 429 });
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 5000 });

		fake.failNext({ method: "GET" }, { status: 503 });
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toMatchObject({ ok: false, kind: "server_error" });

		fake.failNext({ method: "PUT" }, { status: 400, body: { error: "in triage", code: "issue_in_triage" } });
		expect(await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: ISSUE_ID, status: "done", expectedRevision: 1 })).toMatchObject({
			ok: false,
			kind: "in_triage",
		});

		fake.failNext({ method: "PUT" }, { status: 422, body: { error: "bad", code: "invalid_status" } });
		expect(await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: ISSUE_ID, status: "done", expectedRevision: 1 })).toMatchObject({
			ok: false,
			kind: "rejected",
			code: "invalid_status",
		});
	});

	it("caps Retry-After", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		fake.failNext({ method: "GET" }, { status: 429, headers: { "Retry-After": "99999" } });
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toMatchObject({ kind: "rate_limited", retryAfterMs: 300000 });
	});

	it("reports signed out without a token, and when the server answers 401", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		host.setToken(null);
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toEqual({ ok: false, kind: "signed_out" });
		expect(fake.requests).toHaveLength(0);

		host.setToken("expired-token");
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toEqual({ ok: false, kind: "signed_out" });
	});

	it("does not follow a redirect with the token", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		fake.failNext({ method: "GET" }, { status: 302, headers: { Location: "http://127.0.0.1:9/steal" } });

		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toMatchObject({ ok: false, kind: "unreadable" });
		expect(fake.requests).toHaveLength(1);
	});

	it("is unavailable without a live view, and for a view that belongs to another server; nothing is sent", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		host.setAvailable(false);
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toEqual({ ok: false, kind: "unavailable" });
		host.setAvailable(true);
		host.switchServer("cloud");
		expect(await api.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toEqual({ ok: false, kind: "unavailable" });
		expect(fake.requests).toHaveLength(0);
		expect(host.scripts).toHaveLength(0);
	});

	it("is unavailable when the page does not answer in time", async () => {
		const slow = createMulticaIssueApi({
			getHost: () => ({ getServer: host.getServer, evaluateInPage: () => new Promise(() => undefined) }),
			timeoutMs: 20,
		});
		expect(await slow.getIssue(SERVER_KEY, { workspaceSlug: "acme", identifier: "MUL-1" })).toEqual({ ok: false, kind: "unavailable" });
	});

	it("rejects an invalid request without evaluating anything", async () => {
		const result = await api.putStatus(SERVER_KEY, { workspaceSlug: "acme", issueId: ISSUE_ID, status: "backlog" as never, expectedRevision: 1 });
		expect(result).toMatchObject({ ok: false, kind: "unreadable" });
		expect(host.scripts).toHaveLength(0);
	});
});
