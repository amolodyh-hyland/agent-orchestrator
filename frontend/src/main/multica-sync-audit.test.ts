// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../shared/multica-issue-links";
import type { SyncSessionFacts } from "../shared/multica-status-writer";
import { getMulticaActionLog, MULTICA_ACTION_LOG_FILE } from "./multica-action-log";
import { createMulticaIssueApi } from "./multica-issue-api";
import { createMulticaStatusSync, type MulticaStatusSync, type MulticaSyncRecord } from "./multica-status-sync";
import { createFakeHost, startFakeMulticaServer, type FakeMulticaServer } from "./multica-fake-server.test-support";
import { emptyMulticaSyncStateFile, type MulticaSyncStateStore } from "./multica-sync-state";
import { createSyncAuditSink, syncRecordToAction } from "./multica-sync-audit";

const SERVER = "http://localhost:3000";
const facts = (overrides: Partial<SyncSessionFacts> = {}): SyncSessionFacts => ({ sessionId: "s-1", provisioning: "ready", column: "building", activity: "active", terminated: false, prs: [], ...overrides });
const link = (): MulticaIssueLink => ({ sessionId: "s-1", projectId: "p-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", createdAt: "2026-10-10T09:00:00.000Z", serverKey: SERVER });
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000, interval: 10 });

const memoryStore = (): MulticaSyncStateStore => {
	let current = emptyMulticaSyncStateFile();
	return { load: async () => JSON.parse(JSON.stringify(current)), save: async (file) => void (current = JSON.parse(JSON.stringify(file))) };
};

describe("status-sync audit goes to the shared action log", () => {
	let dir: string;
	let fake: FakeMulticaServer;
	let engine: MulticaStatusSync | null;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-sync-audit-"));
		fake = await startFakeMulticaServer();
		engine = null;
	});
	afterEach(async () => {
		engine?.dispose();
		await fake.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
	});

	it("records a status write, a pause and a resume with redaction, in the log awareness uses", async () => {
		const log = getMulticaActionLog(dir);
		const issue = fake.addIssue({ identifier: "MUL-1", status: "todo", title: "PRIVATE TITLE", description: "PRIVATE DESCRIPTION" });
		engine = createMulticaStatusSync({
			api: createMulticaIssueApi({ getHost: () => createFakeHost(fake, SERVER) }),
			store: memoryStore(),
			record: createSyncAuditSink(getMulticaActionLog(dir)),
			env: {},
			debounceMs: 20,
			minRetryMs: 15,
			maxRetryMs: 60,
			reconcileMs: 60 * 60 * 1000,
		});
		await engine.ready;
		engine.setLinks(SERVER, [link()]);
		engine.setFacts({ stale: false, sessions: [facts()] });
		await engine.setSettings({ enabled: true });
		await engine.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
		await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));

		// A person moves the card: AO pauses; Resume (a user action) lets it write again.
		const found = fake.issues.get(issue.id)!;
		found.status = "todo";
		found.status_category = "todo";
		found.revision += 1;
		engine.setFacts({ stale: false, sessions: [facts({ column: "needs_review", prs: ["open"] })] });
		await until(async () => expect((await log.read({ kind: "pause" })).length).toBe(1));
		await engine.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		await until(async () => expect((await log.read({ kind: "status_write" })).length).toBe(2));

		const records = (await log.read({})).reverse();
		expect(records.map((entry) => entry.kind)).toEqual(["status_write", "pause", "resume", "status_write"]);
		const [write, pause, resume] = records;
		expect(write).toMatchObject({
			direction: "ao_to_multica",
			actor: "policy",
			serverKey: SERVER,
			identifier: "MUL-1",
			sessionId: "s-1",
			issueId: issue.id,
			request: { method: "PUT", fields: { status: "in_progress", suppress_run: true } },
			result: { ok: true, httpStatus: 200 },
		});
		expect(typeof write.revBefore).toBe("number");
		expect(typeof write.revAfter).toBe("number");
		expect(write.request?.path).toMatch(/^\/api\/issues\/\{/);
		expect(pause).toMatchObject({ direction: "local", actor: "policy", result: { ok: true } });
		expect(resume).toMatchObject({ direction: "local", actor: "user_confirmed", result: { ok: true, code: "resumed_by_user" } });

		// Nothing of the issue's text and no token reaches the file.
		const raw = await readFile(path.join(dir, MULTICA_ACTION_LOG_FILE), "utf8");
		expect(raw).not.toContain("PRIVATE");
		expect(raw).not.toContain(fake.token);
		expect(raw).not.toMatch(/Bearer|authorization/i);
	});

	it("records a failed write attempt with its failure code", async () => {
		const log = getMulticaActionLog(dir);
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		fake.failNext({ method: "PUT" }, { status: 500 });
		engine = createMulticaStatusSync({
			api: createMulticaIssueApi({ getHost: () => createFakeHost(fake, SERVER) }),
			store: memoryStore(),
			record: createSyncAuditSink(log),
			env: {},
			debounceMs: 20,
			minRetryMs: 5_000,
			maxRetryMs: 5_000,
			reconcileMs: 60 * 60 * 1000,
		});
		await engine.ready;
		engine.setLinks(SERVER, [link()]);
		engine.setFacts({ stale: false, sessions: [facts()] });
		await engine.setSettings({ enabled: true });
		await engine.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
		await until(async () => expect((await log.read({ kind: "status_write" })).length).toBeGreaterThanOrEqual(1));
		const [attempt] = await log.read({ kind: "status_write" });
		expect(attempt.result?.ok).toBe(false);
		expect(attempt.result?.code).toBeTruthy();
	});
});

describe("syncRecordToAction", () => {
	const base: MulticaSyncRecord = {
		kind: "status_write",
		at: "2026-10-10T10:00:00.000Z",
		serverKey: SERVER,
		workspaceId: "w1",
		issueId: "i1",
		issueIdentifier: "MUL-1",
		sessionId: "s-1",
		request: { method: "PUT", pathTemplate: "/api/issues/{id}", fields: { status: "done", expected_revision: 4, suppress_run: true } },
		revBefore: 4,
		revAfter: 5,
		result: { ok: true, httpStatus: 200 },
	};

	it("maps a write, a pause and a user resume", () => {
		expect(syncRecordToAction(base)).toEqual({
			kind: "status_write",
			direction: "ao_to_multica",
			actor: "policy",
			serverKey: SERVER,
			workspaceId: "w1",
			issueId: "i1",
			identifier: "MUL-1",
			sessionId: "s-1",
			trigger: "status_write",
			request: { method: "PUT", path: "/api/issues/{id}", fields: { status: "done", expected_revision: 4, suppress_run: true } },
			revBefore: 4,
			revAfter: 5,
			result: { ok: true, httpStatus: 200 },
		});
		expect(syncRecordToAction({ ...base, kind: "pause", request: null, revAfter: null, result: { ok: true, reason: "changed_in_multica" } })).toMatchObject({
			kind: "pause",
			direction: "local",
			actor: "policy",
			trigger: "changed_in_multica",
			result: { ok: true, code: "changed_in_multica" },
		});
		expect(syncRecordToAction({ ...base, kind: "resume", request: null, revBefore: null, revAfter: null, result: { ok: true, reason: "reopen_confirmed_by_user" } })).toMatchObject({
			kind: "resume",
			actor: "user_confirmed",
		});
	});

	it("leaves out absent ids and revisions", () => {
		const action = syncRecordToAction({ ...base, workspaceId: null, issueId: null, sessionId: null, request: null, revBefore: null, revAfter: null });
		expect(action).not.toHaveProperty("workspaceId");
		expect(action).not.toHaveProperty("issueId");
		expect(action).not.toHaveProperty("sessionId");
		expect(action).not.toHaveProperty("request");
		expect(action).not.toHaveProperty("revBefore");
	});

	it("never lets a credential-shaped value through to the file, even in a free reason", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "ao-sync-audit-redact-"));
		try {
			const log = getMulticaActionLog(dir);
			createSyncAuditSink(log)({ ...base, result: { ok: false, reason: "failed with mul_FIXTUREsecretTOKEN0001 and Bearer abcdefghijklmnop" } });
			await until(async () => expect((await log.read({})).length).toBe(1));
			const raw = await readFile(path.join(dir, MULTICA_ACTION_LOG_FILE), "utf8");
			expect(raw).not.toContain("FIXTUREsecret");
			expect(raw).not.toContain("abcdefghijklmnop");
			expect(raw).toContain("[redacted]");
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
		}
	});
});
