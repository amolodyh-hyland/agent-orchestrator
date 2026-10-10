// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../shared/multica-issue-links";
import type { MulticaSyncLinkView, MulticaSyncSettingsPatch } from "../shared/multica-status-sync";
import { MULTICA_WRITABLE_STATUSES, type SyncSessionFacts } from "../shared/multica-status-writer";
import { createMulticaIssueApi, type MulticaIssueApi } from "./multica-issue-api";
import { createMulticaStatusSync, type MulticaStatusSync, type MulticaSyncRecord } from "./multica-status-sync";
import { createFakeHost, startFakeMulticaServer, type FakeHost, type FakeMulticaServer } from "./multica-fake-server.test-support";
import { emptyMulticaSyncStateFile, type MulticaSyncStateFile, type MulticaSyncStateStore } from "./multica-sync-state";

const SERVER = "http://localhost:3000";
const OTHER_SERVER = "cloud";
const DEBOUNCE_MS = 20;

function memoryStore(initial: MulticaSyncStateFile = emptyMulticaSyncStateFile()): MulticaSyncStateStore & { saved: () => MulticaSyncStateFile; saves: number } {
	let current: MulticaSyncStateFile = JSON.parse(JSON.stringify(initial));
	const store = {
		saves: 0,
		load: async () => JSON.parse(JSON.stringify(current)) as MulticaSyncStateFile,
		save: async (file: MulticaSyncStateFile) => {
			store.saves += 1;
			current = JSON.parse(JSON.stringify(file));
		},
		saved: () => current,
	};
	return store;
}

function sessionFacts(overrides: Partial<SyncSessionFacts> = {}): SyncSessionFacts {
	return { sessionId: "s-1", provisioning: "ready", column: "building", activity: "active", terminated: false, prs: [], ...overrides };
}

const working = (sessionId = "s-1") => sessionFacts({ sessionId });
const inReview = (sessionId = "s-1") => sessionFacts({ sessionId, column: "needs_review", prs: ["open"] });
const fixing = (sessionId = "s-1") => sessionFacts({ sessionId, column: "validating", prs: ["open"] });
const merged = (sessionId = "s-1") => sessionFacts({ sessionId, column: "ready", prs: ["merged"] });

function link(overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink {
	return {
		sessionId: "s-1",
		projectId: "p-1",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-10-10T09:00:00.000Z",
		serverKey: SERVER,
		...overrides,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000, interval: 10 });

describe("multica status sync", () => {
	let fake: FakeMulticaServer;
	let host: FakeHost;
	let api: MulticaIssueApi;
	let store: ReturnType<typeof memoryStore>;
	let engine: MulticaStatusSync;
	let records: MulticaSyncRecord[];
	let clock: number;
	let engines: MulticaStatusSync[];

	function start(
		options: { links?: MulticaIssueLink[]; settings?: MulticaSyncSettingsPatch; env?: Record<string, string>; engine?: Partial<Parameters<typeof createMulticaStatusSync>[0]> } = {},
	): MulticaStatusSync {
		const created = createMulticaStatusSync({
			api,
			store,
			record: (entry) => records.push(entry),
			env: options.env ?? {},
			now: () => clock,
			debounceMs: DEBOUNCE_MS,
			minRetryMs: 15,
			maxRetryMs: 60,
			reconcileMs: 60 * 60 * 1000,
			...options.engine,
		});
		engines.push(created);
		engine = created;
		return created;
	}

	async function turnOn(sync: MulticaStatusSync, links: MulticaIssueLink[] = [link()], settings: MulticaSyncSettingsPatch = { enabled: true }): Promise<void> {
		await sync.ready;
		sync.setLinks(SERVER, links);
		await sync.setSettings(settings);
		for (const entry of links) {
			await sync.setLink({ sessionId: entry.sessionId, workspaceSlug: entry.workspaceSlug, issueIdentifier: entry.issueIdentifier, enabled: true });
		}
	}

	const view = (sync = engine, sessionId = "s-1", issueIdentifier = "MUL-1"): MulticaSyncLinkView => {
		const found = sync.getSnapshot().links.find((entry) => entry.sessionId === sessionId && entry.issueIdentifier === issueIdentifier);
		if (!found) throw new Error("no such link view");
		return found;
	};
	const settled = (sync = engine, sessionId = "s-1", issueIdentifier = "MUL-1") =>
		until(() => expect(view(sync, sessionId, issueIdentifier).state).not.toBe("pending"));
	const put = () => fake.requests.filter((request) => request.method === "PUT");
	const get = () => fake.requests.filter((request) => request.method === "GET");

	beforeEach(async () => {
		fake = await startFakeMulticaServer();
		host = createFakeHost(fake, SERVER);
		api = createMulticaIssueApi({ getHost: () => host });
		store = memoryStore();
		records = [];
		engines = [];
		clock = Date.parse("2026-10-10T10:00:00.000Z");
	});

	afterEach(async () => {
		for (const created of engines) created.dispose();
		await fake.close();
	});

	describe("default off", () => {
		it("writes nothing, reads nothing and sends no token until the master switch and the link are both on", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			await sync.ready;
			sync.setLinks(SERVER, [link()]);
			sync.setFacts({ stale: false, sessions: [working()] });
			await sleep(120);

			expect(sync.getSnapshot().settings).toEqual({ enabled: false, moveOutOfBacklog: false });
			expect(view().state).toBe("off");
			expect(fake.requests).toHaveLength(0);
			expect(host.scripts).toHaveLength(0);

			// Link on, master off.
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await sleep(120);
			expect(view()).toMatchObject({ enabled: true, state: "off", reason: "master_off" });
			expect(fake.requests).toHaveLength(0);

			// Master on, link off.
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
			await sync.setSettings({ enabled: true });
			await sleep(120);
			expect(view()).toMatchObject({ enabled: false, state: "off", reason: null });
			expect(fake.requests).toHaveLength(0);
		});

		it("writes once both are on", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();

			expect(put()).toHaveLength(1);
			expect([...fake.issues.values()][0].status).toBe("in_progress");
			expect(view().state).toBe("synced");
		});

		it("the AO_MULTICA_SYNC=0 kill switch forces everything off whatever the settings say", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start({ env: { AO_MULTICA_SYNC: "0" } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await sleep(120);

			expect(sync.getSnapshot().killSwitch).toBe(true);
			expect(view()).toMatchObject({ enabled: true, state: "off", reason: "kill_switch" });
			expect(fake.requests).toHaveLength(0);
		});

		it("writes nothing when AO goes offline between scheduling a write and making it", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start({ engine: { debounceMs: 100 } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			sync.setFacts({ stale: true, sessions: [working()] });
			await sleep(250);

			expect(fake.requests).toHaveLength(0);
			expect(view()).toMatchObject({ state: "error", reason: "ao_offline" });
		});

		it("does not touch the network when the facts are not there yet or are stale (AO offline)", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			await turnOn(sync);
			await sleep(100);
			expect(view().state).toBe("pending");
			expect(fake.requests).toHaveLength(0);

			sync.setFacts({ stale: true, sessions: [working()] });
			await sleep(100);
			expect(view()).toMatchObject({ state: "error", reason: "ao_offline" });
			expect(fake.requests).toHaveLength(0);

			sync.setFacts({ stale: false, sessions: [working()] });
			await settled();
			expect(put()).toHaveLength(1);
		});
	});

	describe("mapping rows through the engine", () => {
		const writes: Array<[string, SyncSessionFacts, string]> = [
			["row 3: working, no PR", working(), "in_progress"],
			["row 7: PR open, AO still turning the loop", fixing(), "in_progress"],
			["row 8: PR waiting on a person", inReview(), "in_review"],
			["row 9: PR approved or mergeable", sessionFacts({ column: "ready", prs: ["open"] }), "in_review"],
			["row 10: every PR merged, session alive", merged(), "done"],
			["row 13: terminated, PR merged", sessionFacts({ terminated: true, column: "archive", prs: ["merged"] }), "done"],
		];
		it.each(writes)("%s writes %s", async (_name, facts, expected) => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [facts] });
			await turnOn(sync);
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe(expected);
			expect(put()).toHaveLength(1);
		});

		const silent: Array<[string, SyncSessionFacts]> = [
			["row 2: provisioning", sessionFacts({ provisioning: "provisioning" })],
			["row 2: provisioning failed", sessionFacts({ provisioning: "failed" })],
			["row 4: idle worker", sessionFacts({ activity: "idle" })],
			["row 5: needs input", sessionFacts({ activity: "waiting_input" })],
			["row 5: blocked", sessionFacts({ activity: "blocked" })],
			["row 6: exited", sessionFacts({ activity: "exited" })],
			["row 11: PR closed unmerged", sessionFacts({ column: "ready", prs: ["closed"] })],
			["row 12: terminated, no PR", sessionFacts({ terminated: true, column: "archive" })],
		];
		it.each(silent)("%s writes nothing", async (_name, facts) => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [facts] });
			await turnOn(sync);
			await settled();
			await sleep(60);

			expect(fake.issues.get(issue.id)?.status).toBe("todo");
			expect(put()).toHaveLength(0);
		});

		it("row 1: a link whose session AO does not know writes nothing", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("other")] });
			await turnOn(sync);
			await settled();
			expect(fake.issues.get(issue.id)?.status).toBe("todo");
			expect(fake.requests).toHaveLength(0);
		});

		it("Q1: starting a session on a Backlog issue moves it forward, after previewing the run trigger", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link()], { enabled: true, moveOutOfBacklog: true });
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");
			expect(fake.requests.map((request) => `${request.method} ${request.path.replace(issue.id, "{id}")}`)).toEqual([
				"GET /api/issues/MUL-1",
				"POST /api/issues/preview-trigger",
				"PUT /api/issues/{id}",
			]);
		});

		it("pinned: with the default settings a Backlog card is never moved, and nothing else is asked of Multica for it", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			await sleep(60);

			expect(sync.getSnapshot().settings.moveOutOfBacklog).toBe(false);
			expect(fake.issues.get(issue.id)?.status).toBe("backlog");
			expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
			expect(view().state).toBe("synced");
		});

		it("moves a Backlog card only after the user turns the option on, and turning it off again stops it", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(fake.issues.get(issue.id)?.status).toBe("backlog");

			await sync.setSettings({ moveOutOfBacklog: true });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
		});

		it("leaves a Backlog issue alone when the user turned the move off", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link()], { enabled: true, moveOutOfBacklog: false });
			await settled();
			expect(fake.issues.get(issue.id)?.status).toBe("backlog");
			expect(put()).toHaveLength(0);
		});

		it("refuses to move out of Backlog when the preview says a Multica run would start (and fails closed when it cannot ask)", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			fake.failNext({ method: "POST" }, { status: 200, body: { triggers: [{ issue_id: issue.id, agent_id: "a", source: "status" }], total_count: 1 } });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link()], { enabled: true, moveOutOfBacklog: true });
			await settled();
			expect(view()).toMatchObject({ state: "refused", reason: "would_start_run" });
			expect(put()).toHaveLength(0);

			fake.failNext({ method: "POST" }, { status: 500 }, 5);
			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "unreachable" }));
			expect(put()).toHaveLength(0);
		});

		it("row 15: several sessions on one issue, the most actionable live session decides", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), inReview("s-2"), fixing("s-3")] });
			await turnOn(sync, [link({ sessionId: "s-1" }), link({ sessionId: "s-2" }), link({ sessionId: "s-3" })]);
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("in_review");
			expect(put()).toHaveLength(1);
		});

		it("only enabled links decide: a session whose link is off contributes nothing", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), inReview("s-2")] });
			await sync.ready;
			const links = [link({ sessionId: "s-1" }), link({ sessionId: "s-2" })];
			sync.setLinks(SERVER, links);
			await sync.setSettings({ enabled: true });
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");
			expect(view(engine, "s-2")).toMatchObject({ enabled: false, state: "off" });
		});

		it("Q14: a session linked to two issues writes only to the first one it was linked to", async () => {
			const first = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const second = fake.addIssue({ identifier: "MUL-2", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			const links = [link({ issueIdentifier: "MUL-2", createdAt: "2026-10-10T09:30:00.000Z" }), link({ issueIdentifier: "MUL-1" })];
			await turnOn(sync, links);
			await settled(engine, "s-1", "MUL-1");
			await sleep(60);

			expect(fake.issues.get(first.id)?.status).toBe("in_progress");
			expect(fake.issues.get(second.id)?.status).toBe("todo");
			expect(view(engine, "s-1", "MUL-2")).toMatchObject({ state: "refused", reason: "secondary_link" });
		});
	});

	describe("forward only, done is sticky, reopen", () => {
		it("never writes a status behind the one Multica shows", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "in_review" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [fixing()] });
			await turnOn(sync);
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("in_review");
			expect(put()).toHaveLength(0);
			expect(view().state).toBe("synced");
		});

		it("moves in progress, then in review, then done as the facts advance, each time with the revision it just read", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_review"));
			await settled();
			sync.setFacts({ stale: false, sessions: [merged()] });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("done"));
			await settled();

			expect(put().map((request) => request.body)).toEqual([
				{ status: "in_progress", expected_revision: 4, suppress_run: true },
				{ status: "in_review", expected_revision: 5, suppress_run: true },
				{ status: "done", expected_revision: 6, suppress_run: true },
			]);
		});

		it("done is sticky: a closed issue pauses AO, and only a confirmed reopen writes (row 14 / D12)", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "done" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();

			expect(view()).toMatchObject({ state: "paused", reason: "closed_in_multica", canReopen: true, canResume: false });
			expect(put()).toHaveLength(0);

			// Resuming is not reopening.
			await sync.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await sleep(60);
			expect(put()).toHaveLength(0);

			await sync.reopen({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			expect(put()).toHaveLength(1);
			expect(records.map((entry) => `${entry.kind}:${entry.result.reason ?? entry.result.ok}`)).toEqual([
				"pause:closed_in_multica",
				"resume:reopen_confirmed_by_user",
				"status_write:true",
			]);
		});

		it("a reopen or resume while sync is off does nothing, and does not wait around for the day it is turned on", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "done" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(view().canReopen).toBe(true);

			await sync.setSettings({ enabled: false });
			await sync.reopen({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await sync.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await sync.setSettings({ enabled: true });
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("done");
			expect(put()).toHaveLength(0);
			expect(view()).toMatchObject({ state: "paused", reason: "closed_in_multica" });
		});

		it("a reopen on a link that is not paused for a closed issue does nothing", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [sessionFacts({ activity: "idle" })] });
			await turnOn(sync);
			await settled();
			await sync.reopen({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			sync.setFacts({ stale: false, sessions: [working()] });
			await settled();
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			// The write was the normal forward write, not a reopen.
			expect(records.filter((entry) => entry.kind === "resume")).toHaveLength(0);
		});

		it("after AO wrote done, a new session on the issue does not silently reopen it", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "in_review" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [merged()] });
			await turnOn(sync);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("done"));
			await settled();

			sync.setFacts({ stale: false, sessions: [sessionFacts({ terminated: true, column: "archive", prs: ["merged"] }), working("s-2")] });
			sync.setLinks(SERVER, [link(), link({ sessionId: "s-2" })]);
			await sync.setLink({ sessionId: "s-2", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await settled(engine, "s-2");

			expect(fake.issues.get(issue.id)?.status).toBe("done");
			expect(put()).toHaveLength(1);
			expect(view(engine, "s-2")).toMatchObject({ state: "paused", reason: "closed_in_multica" });
		});

		it("never writes over blocked or cancelled", async () => {
			for (const status of ["blocked", "cancelled"]) {
				fake.issues.clear();
				records.length = 0;
				const issue = fake.addIssue({ identifier: "MUL-1", status });
				const sync = start();
				sync.setFacts({ stale: false, sessions: [working()] });
				await turnOn(sync);
				await settled();
				expect(fake.issues.get(issue.id)?.status).toBe(status);
				expect(view().state).toBe("paused");
				sync.dispose();
				store = memoryStore();
			}
			expect(put()).toHaveLength(0);
		});
	});

	describe("sub-issues: Multica runs the parent's rules after any status change", () => {
		// suppress_run only skips the run for the written issue; the parent's sub-issue rules (child done, conditions)
		// run regardless and can wake the parent's agent or squad leader, or notify a member parent.
		it.each(["agent", "squad"] as const)("refuses to write a sub-issue whose parent is owned by a Multica %s", async (assigneeType) => {
			const parent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: assigneeType });
			const child = fake.addIssue({ identifier: "MUL-6", status: "todo", parent_issue_id: parent.id });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link({ issueIdentifier: "MUL-6" })]);
			await settled(engine, "s-1", "MUL-6");

			expect(view(engine, "s-1", "MUL-6")).toMatchObject({ state: "refused", reason: "sub_issue_parent" });
			expect(put()).toHaveLength(0);
			expect(fake.issues.get(child.id)?.status).toBe("todo");
			expect(fake.parentWakes).toBe(0);
			expect(fake.requests.map((request) => `${request.method} ${request.path.replace(/[0-9a-f-]{36}/, "{id}")}`)).toEqual([
				"GET /api/issues/MUL-6",
				"GET /api/issues/{id}",
			]);
		});

		it("writes a sub-issue whose parent belongs to a member or to nobody (a notification, as for a human), never waking an agent", async () => {
			const memberParent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: "member" });
			const freeParent = fake.addIssue({ identifier: "MUL-7", status: "in_progress", assignee_type: null });
			const first = fake.addIssue({ identifier: "MUL-6", status: "todo", parent_issue_id: memberParent.id });
			const second = fake.addIssue({ identifier: "MUL-8", status: "todo", parent_issue_id: freeParent.id });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await turnOn(sync, [link({ sessionId: "s-1", issueIdentifier: "MUL-6" }), link({ sessionId: "s-2", issueIdentifier: "MUL-8" })]);
			await settled(engine, "s-1", "MUL-6");
			await settled(engine, "s-2", "MUL-8");

			expect(fake.issues.get(first.id)?.status).toBe("in_progress");
			expect(fake.issues.get(second.id)?.status).toBe("in_progress");
			expect(fake.parentWakes).toBe(0);
			expect(fake.parentNotifications).toBe(2);
		});

		it("does not write when the parent cannot be read, and does not mistake that for the child being gone", async () => {
			const parent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: "member" });
			const child = fake.addIssue({ identifier: "MUL-6", status: "todo", parent_issue_id: parent.id });
			fake.forbid("MUL-5");
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link({ issueIdentifier: "MUL-6" })]);
			await settled(engine, "s-1", "MUL-6");

			expect(view(engine, "s-1", "MUL-6")).toMatchObject({ state: "refused", reason: "sub_issue_parent" });
			expect(put()).toHaveLength(0);
			expect(fake.issues.get(child.id)?.status).toBe("todo");
			expect(store.saved().issues[0].orphaned).toBe(false);
		});

		it("retries a parent read that failed for a transient reason, then writes", async () => {
			const parent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: "member" });
			const child = fake.addIssue({ identifier: "MUL-6", status: "todo", parent_issue_id: parent.id });
			fake.failNext({ method: "GET", pathPrefix: `/api/issues/${parent.id}` }, { status: 503 });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link({ issueIdentifier: "MUL-6" })]);
			await until(() => expect(view(engine, "s-1", "MUL-6")).toMatchObject({ state: "error", reason: "unreachable" }));
			await until(() => expect(fake.issues.get(child.id)?.status).toBe("in_progress"));
		});

		it("does not read the parent when there is nothing to write", async () => {
			const parent = fake.addIssue({ identifier: "MUL-5", status: "in_progress", assignee_type: "agent" });
			fake.addIssue({ identifier: "MUL-6", status: "in_review", parent_issue_id: parent.id });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link({ issueIdentifier: "MUL-6" })]);
			await settled(engine, "s-1", "MUL-6");

			expect(view(engine, "s-1", "MUL-6").state).toBe("synced");
			expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
		});

		it("an issue with no parent is written without reading anything else", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(fake.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
		});
	});

	describe("review gaps: signed-out guard, tokens in the environment, conflict timing", () => {
		it("a sibling's 401 stops an issue whose write was already scheduled: it never sends the dead token (d)", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.addIssue({ identifier: "MUL-2", status: "todo" });
			host.setToken("expired");
			const sync = start({ engine: { debounceMs: 80 } });
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await sync.ready;
			sync.setLinks(SERVER, [link({ sessionId: "s-1" }), link({ sessionId: "s-2", issueIdentifier: "MUL-2" })]);
			await sync.setSettings({ enabled: true });
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await sleep(40);
			// Its timer fires after the first one's 401 has stopped the server.
			await sync.setLink({ sessionId: "s-2", workspaceSlug: "acme", issueIdentifier: "MUL-2", enabled: true });
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "signed_out" }));
			await sleep(200);

			expect(fake.requests).toHaveLength(1);
			expect(host.scripts).toHaveLength(1);
			expect(view(engine, "s-2", "MUL-2")).toMatchObject({ state: "error", reason: "signed_out" });
		});

		it("nothing leaks a token that is in the process environment: records, snapshot, state file, scripts, requests, console (e)", async () => {
			vi.stubEnv("MULTICA_TOKEN", "env-token-leak-check-0001");
			vi.stubEnv("AO_MULTICA_TOKEN", "env-token-leak-check-0002");
			vi.stubEnv("MULTICA_PAT", "mul_env-token-leak-check-0003");
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
			try {
				const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
				fake.beforeNextPut((found) => {
					found.revision += 1;
				});
				const sync = start({ engine: { env: undefined } });
				sync.setFacts({ stale: false, sessions: [working()] });
				await turnOn(sync);
				await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
				await settled();
				const found = fake.issues.get(issue.id)!;
				found.status = "todo";
				found.status_category = "todo";
				found.revision += 1;
				sync.setFacts({ stale: false, sessions: [inReview()] });
				await until(() => expect(view().state).toBe("paused"));
				await sync.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
				await settled();

				const everything = JSON.stringify({
					records,
					snapshot: sync.getSnapshot(),
					state: store.saved(),
					scripts: host.scripts,
					requests: fake.requests,
					fetchCalls: host.fetchCalls.map((call) => ({ url: call.url, body: call.init.body })),
					console: spies.map((spy) => spy.mock.calls),
					consoleInPage: host.consoleCalls,
				});
				expect(everything).not.toMatch(/env-token-leak-check/);
				expect(everything).not.toContain(fake.token);
			} finally {
				spies.forEach((spy) => spy.mockRestore());
				vi.unstubAllEnvs();
			}
		});

		it("retries a conflict at once with the fresh revision, in the same pass, not on the next scheduled one (c)", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.beforeNextPut((found) => {
				found.revision += 1;
			});
			const sync = start({ engine: { debounceMs: 250 } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.requests.length).toBeGreaterThanOrEqual(1));
			const startedAt = Date.now();
			await until(() => expect(fake.requests).toHaveLength(4));
			// The next scheduled pass would come a whole debounce window later.
			expect(Date.now() - startedAt).toBeLessThan(200);
			expect(put().map((request) => request.body?.expected_revision)).toEqual([4, 5]);
			await settled();
			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");
		});
	});

	describe("compare and set", () => {
		it("on a revision conflict reads once more and writes again with the new revision", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.beforeNextPut((found) => {
				found.revision += 1; // someone edited the title between the read and the write
			});
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();

			expect(fake.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
			expect(put().map((request) => request.body?.expected_revision)).toEqual([4, 5]);
			expect(fake.issues.get(issue.id)).toMatchObject({ status: "in_progress", revision: 6 });
			expect(records.map((entry) => [entry.kind, entry.result.ok, entry.revBefore, entry.revAfter])).toEqual([
				["status_write", false, 4, null],
				["status_write", true, 5, 6],
			]);
			expect(records[0].result).toMatchObject({ httpStatus: 409, code: "revision_conflict", reason: "conflict" });
		});

		it("gives up after the second conflict and tries again only on the next pass", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.beforeNextPut((found) => {
				found.revision += 1;
			});
			fake.beforeNextPut((found) => {
				found.revision += 1;
			});
			const sync = start({ engine: { debounceMs: 200 } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.requests).toHaveLength(4));
			// One read-again only: nothing more is sent until the next scheduled pass.
			await sleep(80);
			expect(fake.requests).toHaveLength(4);
			expect(put().map((request) => request.body?.expected_revision)).toEqual([4, 5]);

			await settled();
			// The next pass succeeds with the revision then current.
			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");
			expect(put().map((request) => request.body?.expected_revision)).toEqual([4, 5, 6]);
		});

		it("a person's status change between the read and the write wins", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.beforeNextPut((found) => {
				found.status = "in_review";
				found.status_category = "in_review";
				found.revision += 1;
			});
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();

			expect(fake.issues.get(issue.id)?.status).toBe("in_review");
			expect(put()).toHaveLength(1);
			expect(view().state).toBe("synced");
		});
	});

	describe("pause fence", () => {
		async function writtenInProgress(): Promise<ReturnType<FakeMulticaServer["addIssue"]>> {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			start();
			engine.setFacts({ stale: false, sessions: [working()] });
			await turnOn(engine);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			return issue;
		}

		function personMoves(issue: ReturnType<FakeMulticaServer["addIssue"]>, status: string): void {
			const found = fake.issues.get(issue.id)!;
			found.status = status;
			found.status_category = status;
			found.revision += 1;
		}

		it("row 17: pauses when a person moved the card away from what AO wrote, and writes nothing more", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");

			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			expect(view()).toMatchObject({ state: "paused", reason: "changed_in_multica", multicaStatus: "todo", aoStatus: "in_review", canResume: true });
			expect(fake.issues.get(issue.id)?.status).toBe("todo");
			expect(put()).toHaveLength(1);
			expect(records.map((entry) => entry.kind)).toEqual(["status_write", "pause"]);
		});

		it("a paused link writes nothing, however often the facts change while AO's status stays the same", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));
			const requestsWhenPaused = fake.requests.length;

			for (const column of ["needs_review", "ready", "needs_review"] as const) {
				engine.setFacts({ stale: false, sessions: [sessionFacts({ column, prs: ["open"] })] });
				await sleep(DEBOUNCE_MS * 3);
			}
			// The reconcile pass and a fact that maps to the same status touch nothing either.
			expect(fake.requests).toHaveLength(requestsWhenPaused);
			expect(view().state).toBe("paused");
		});

		it("looks again when AO's own mapped status changes to a new one", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			engine.setFacts({ stale: false, sessions: [merged()] });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("done"));
			await settled();
			expect(view().state).toBe("synced");
		});

		it("Resume lets AO take over again, going forward only", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			await engine.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_review"));
			await settled();
			expect(view().state).toBe("synced");
			expect(records.map((entry) => entry.kind)).toEqual(["status_write", "pause", "resume", "status_write"]);
		});

		it("Sync now on a paused link reads again but never writes", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			await engine.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await settled();
			await sleep(60);
			expect(put()).toHaveLength(1);
			expect(view().state).toBe("paused");
			expect(records.filter((entry) => entry.kind === "pause")).toHaveLength(1);
		});

		it("the person moving the card to the status AO wants ends the pause (agreement)", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			personMoves(issue, "in_review");
			await engine.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(view().state).toBe("synced"));
			expect(put()).toHaveLength(1);
		});

		it("a custom status in the same category is not a conflict", async () => {
			const issue = await writtenInProgress();
			const found = fake.issues.get(issue.id)!;
			found.status = "doing";
			found.status_category = "in_progress";
			found.revision += 1;

			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_review"));
			expect(records.filter((entry) => entry.kind === "pause")).toHaveLength(0);
		});

		it("survives a restart: still paused, still writes nothing", async () => {
			const issue = await writtenInProgress();
			personMoves(issue, "todo");
			engine.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));
			await sleep(20);
			const requests = fake.requests.length;
			engine.dispose();

			const restarted = start();
			await restarted.ready;
			restarted.setLinks(SERVER, [link()]);
			restarted.setFacts({ stale: false, sessions: [inReview()] });
			await sleep(120);

			expect(view(restarted)).toMatchObject({ enabled: true, state: "paused", reason: "changed_in_multica" });
			expect(fake.requests).toHaveLength(requests);
		});
	});

	describe("echo suppression", () => {
		it("AO's own write coming back is not a change by someone else", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			const writtenRevision = fake.issues.get(issue.id)!.revision;
			const before = JSON.stringify(store.saved().issues[0].lastKnown);

			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(get().length).toBe(2));
			await settled();

			expect(put()).toHaveLength(1);
			expect(view().state).toBe("synced");
			expect(records.map((entry) => entry.kind)).toEqual(["status_write"]);
			expect(store.saved().issues[0].lastKnown).toMatchObject({ source: "write", revision: writtenRevision });
			expect(JSON.stringify(store.saved().issues[0].lastKnown)).toBe(before);
		});
	});

	describe("refusals", () => {
		it.each(["agent", "squad"] as const)("row 16: refuses an issue assigned to a Multica %s, whatever the status", async (assigneeType) => {
			for (const status of ["backlog", "todo", "in_progress", "in_review"]) {
				fake.issues.clear();
				fake.requests.length = 0;
				const issue = fake.addIssue({ identifier: "MUL-1", status, assignee_type: assigneeType });
				const sync = start();
				sync.setFacts({ stale: false, sessions: [inReview()] });
				await turnOn(sync);
				await settled();

				expect(view()).toMatchObject({ state: "refused", reason: "driven_by_multica" });
				expect(put()).toHaveLength(0);
				expect(fake.requests.some((request) => request.path === "/api/issues/preview-trigger")).toBe(false);
				expect(fake.issues.get(issue.id)?.status).toBe(status);
				sync.dispose();
				store = memoryStore();
			}
			expect(fake.runsStarted).toBe(0);
		});

		it("row 16: refuses an issue in Triage when the issue JSON says so", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo", triage_state: "triage" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(view()).toMatchObject({ state: "refused", reason: "triage" });
			expect(put()).toHaveLength(0);
		});

		it("row 16: refuses when the write itself answers issue_in_triage (the issue JSON has no triage field today)", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.failNext({ method: "PUT" }, { status: 400, body: { error: "the issue is in Triage", code: "issue_in_triage" } });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(view()).toMatchObject({ state: "refused", reason: "triage" });
			expect(put()).toHaveLength(1);
		});

		it("KNOWN GAP, pinned: an entry in Triage that the issue JSON does not mark is NOT protected, and AO writes over the triager's proposal", async () => {
			// Multica's issue JSON has no triage field and its PUT guard only locks parent_issue_id, so today a
			// Triage entry looks like any other backlog/todo issue. This test documents that; it is not coverage of row 16 for Triage.
			const backlog = fake.addIssue({ identifier: "MUL-1", status: "backlog", hiddenTriage: true });
			const todo = fake.addIssue({ identifier: "MUL-2", status: "todo", hiddenTriage: true });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await turnOn(sync, [link({ sessionId: "s-1" }), link({ sessionId: "s-2", issueIdentifier: "MUL-2" })]);
			await settled();
			await settled(engine, "s-2", "MUL-2");

			// The Backlog-looking one is left alone by the default settings (the user has to opt in to moving Backlog);
			// the one shown as todo is overwritten whatever the setting says.
			expect(fake.issues.get(backlog.id)?.status).toBe("backlog");
			expect(fake.issues.get(todo.id)?.status).toBe("in_progress");
			expect(view().state).toBe("synced");
		});

		it("the issue leaving Multica's agent: the refusal lifts when AO reads again", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo", assignee_type: "agent" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(view().state).toBe("refused");

			issue.assignee_type = "member";
			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
		});

		it("refuses an identifier that now names another issue, and records the ids the first time", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const recordIssueIds = vi.fn(async () => undefined);
			const sync = start({ engine: { recordIssueIds } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(recordIssueIds).toHaveBeenCalledExactlyOnceWith(
				{ serverKey: SERVER, workspaceSlug: "acme", issueIdentifier: "MUL-1" },
				{ workspaceId: issue.workspace_id, issueId: issue.id },
			);

			sync.dispose();
			fake.requests.length = 0;
			store = memoryStore();
			const other = start();
			other.setFacts({ stale: false, sessions: [working()] });
			const known = link({ workspaceId: issue.workspace_id, issueId: "99999999-9999-4999-8999-999999999999" });
			await turnOn(other, [known]);
			await settled(other);
			expect(view(other)).toMatchObject({ state: "refused", reason: "identity_changed" });
			expect(put()).toHaveLength(0);
		});
	});

	describe("debounce", () => {
		it("ten changes in one window produce one read and one write of the latest state", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start({ engine: { debounceMs: 120 } });
			await turnOn(sync);
			const sequence = [working(), fixing(), inReview(), fixing(), working(), inReview(), fixing(), inReview(), working(), inReview()];
			for (const facts of sequence) {
				sync.setFacts({ stale: false, sessions: [facts] });
				await sleep(3);
			}
			await settled();

			expect(get()).toHaveLength(1);
			expect(put()).toHaveLength(1);
			expect(put()[0].body?.status).toBe("in_review");
			expect(fake.issues.get(issue.id)?.status).toBe("in_review");
		});

		it("does not read or write again when the facts change but AO's status stays the same", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			const requests = fake.requests.length;

			sync.setFacts({ stale: false, sessions: [fixing()] });
			sync.setFacts({ stale: false, sessions: [working()] });
			await sleep(DEBOUNCE_MS * 4);
			expect(fake.requests).toHaveLength(requests);
		});
	});

	describe("serverKey isolation", () => {
		it("only acts on links of the selected server and never sends the token for another server's link", async () => {
			const here = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const there = fake.addIssue({ identifier: "MUL-2", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await sync.ready;
			const links = [link({ sessionId: "s-1", issueIdentifier: "MUL-1" }), link({ sessionId: "s-2", issueIdentifier: "MUL-2", serverKey: OTHER_SERVER })];
			sync.setLinks(SERVER, links);
			await sync.setSettings({ enabled: true });
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await settled();
			await sleep(60);

			expect(fake.issues.get(here.id)?.status).toBe("in_progress");
			expect(fake.issues.get(there.id)?.status).toBe("todo");
			expect(fake.requests.every((request) => request.path.includes("MUL-1") || request.path.includes(here.id))).toBe(true);
			expect(sync.getSnapshot().links.map((entry) => entry.issueIdentifier)).toEqual(["MUL-1"]);
		});

		it("a state saved for the same issue on one server does not leak to the other", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();

			sync.handleServerChange(OTHER_SERVER);
			host.switchServer(OTHER_SERVER);
			const cloudLink = link({ serverKey: OTHER_SERVER });
			sync.setLinks(OTHER_SERVER, [cloudLink]);
			expect(view(sync)).toMatchObject({ enabled: false, state: "off" });

			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await until(() => expect(view(sync).state).not.toBe("pending"));
			expect(store.saved().issues.map((entry) => entry.serverKey).sort()).toEqual([OTHER_SERVER, SERVER].sort());
			expect(store.saved().links.map((entry) => entry.serverKey).sort()).toEqual([OTHER_SERVER, SERVER].sort());
		});

		it("switching the server while a read is in flight cancels the work: no write, no token to the other server", async () => {
			let finishRead: (value: unknown) => void = () => undefined;
			const stub: MulticaIssueApi = {
				getIssue: vi.fn(
					() =>
						new Promise((resolve) => {
							finishRead = resolve;
						}),
				) as MulticaIssueApi["getIssue"],
				putStatus: vi.fn(),
				previewTrigger: vi.fn(),
				getParent: vi.fn(),
			};
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(stub.getIssue).toHaveBeenCalledTimes(1));

			sync.handleServerChange(OTHER_SERVER);
			finishRead({
				ok: true,
				issue: {
					id: "11111111-1111-4111-8111-111111111111",
					workspaceId: "22222222-2222-4222-8222-222222222222",
					identifier: "MUL-1",
					status: "todo",
					category: "todo",
					revision: 4,
					assigneeType: "member",
					inTriage: false,
				},
			});
			await sleep(80);

			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(stub.previewTrigger).not.toHaveBeenCalled();
			expect(sync.getSnapshot().links).toEqual([]);
		});

		it("the in-page script is bound to the server: a view of another server never runs it", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			host.switchServer(OTHER_SERVER);
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "unavailable" }));

			expect(host.scripts).toHaveLength(0);
			expect(fake.requests).toHaveLength(0);
		});
	});

	describe("turning sync off while a request is in flight", () => {
		const observation = (status = "todo") => ({
			ok: true as const,
			issue: {
				id: "11111111-1111-4111-8111-111111111111",
				workspaceId: "22222222-2222-4222-8222-222222222222",
				identifier: "MUL-1",
				status,
				category: status,
				revision: 4,
				assigneeType: "member",
				inTriage: false,
			},
		});

		function heldApi() {
			const held: { resolveRead: (value: unknown) => void; resolvePreview: (value: unknown) => void } = {
				resolveRead: () => undefined,
				resolvePreview: () => undefined,
			};
			const stub = {
				getIssue: vi.fn(() => new Promise((resolve) => (held.resolveRead = resolve))),
				previewTrigger: vi.fn(() => new Promise((resolve) => (held.resolvePreview = resolve))),
				putStatus: vi.fn(async () => observation("in_progress")),
			} as unknown as MulticaIssueApi;
			return { held, stub };
		}

		async function startHeld(status = "todo", moveOutOfBacklog = false) {
			const { held, stub } = heldApi();
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link()], { enabled: true, moveOutOfBacklog });
			await until(() => expect(stub.getIssue).toHaveBeenCalledTimes(1));
			return { held, stub, sync, status };
		}

		it("does not write when the master switch is turned off before the read comes back", async () => {
			const { held, stub, sync } = await startHeld();
			await sync.setSettings({ enabled: false });
			held.resolveRead(observation());
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(view()).toMatchObject({ state: "off", reason: "master_off" });
		});

		it("does not write when the link is turned off before the read comes back", async () => {
			const { held, stub, sync } = await startHeld();
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
			held.resolveRead(observation());
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(view().state).toBe("off");
		});

		it("does not write when the link is removed before the read comes back", async () => {
			const { held, stub, sync } = await startHeld();
			sync.setLinks(SERVER, []);
			held.resolveRead(observation());
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(store.saved().links).toEqual([]);
		});

		it("does not write when the master switch is turned off while the Backlog preview is pending", async () => {
			const { held, stub, sync } = await startHeld("todo", true);
			held.resolveRead(observation("backlog"));
			await until(() => expect(stub.previewTrigger).toHaveBeenCalledTimes(1));
			await sync.setSettings({ enabled: false });
			held.resolvePreview({ ok: true, triggers: 0 });
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalled();
		});

		it("does not write when the only enabled link is turned off while the Backlog preview is pending", async () => {
			const { held, stub, sync } = await startHeld("todo", true);
			held.resolveRead(observation("backlog"));
			await until(() => expect(stub.previewTrigger).toHaveBeenCalledTimes(1));
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
			held.resolvePreview({ ok: true, triggers: 0 });
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalled();
		});

		it("still writes when nothing was turned off (the guard does not block the normal path)", async () => {
			const { held, stub } = await startHeld();
			held.resolveRead(observation());
			await until(() => expect(stub.putStatus).toHaveBeenCalledTimes(1));
		});

		it("looks again, and does not write the old target, when a writer link is removed mid-flight", async () => {
			const { held, stub, sync } = await startHeld();
			sync.setFacts({ stale: false, sessions: [working("s-1"), inReview("s-2")] });
			sync.setLinks(SERVER, [link(), link({ sessionId: "s-2" })]);
			await sync.setLink({ sessionId: "s-2", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
			held.resolveRead(observation());
			await sleep(60);
			expect(stub.putStatus).not.toHaveBeenCalledWith(SERVER, expect.objectContaining({ status: "in_progress" }));
		});
	});

	describe("a write whose answer is lost, and a server switched back mid-flight", () => {
		const issueAt = (status: string, revision: number) => ({
			ok: true as const,
			issue: {
				id: "11111111-1111-4111-8111-111111111111",
				workspaceId: "22222222-2222-4222-8222-222222222222",
				identifier: "MUL-1",
				status,
				category: status,
				revision,
				assigneeType: "member",
				inTriage: false,
			},
		});

		it("recognises its own write when the answer was lost and the facts moved on, instead of pausing (F3.1)", async () => {
			const current = { status: "todo", revision: 4 };
			let loseNext = false;
			const stub = {
				getIssue: vi.fn(async () => issueAt(current.status, current.revision)),
				previewTrigger: vi.fn(),
				putStatus: vi.fn(async (_key: string, input: { status: string }) => {
					current.status = input.status;
					current.revision += 1;
					return loseNext ? { ok: false as const, kind: "timeout" as const } : issueAt(current.status, current.revision);
				}),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(current.status).toBe("in_progress");

			loseNext = true;
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(current.status).toBe("in_review"));
			await until(() => expect(view().state).toBe("error"));
			expect(store.saved().issues[0].intent).toMatchObject({ status: "in_review", revBefore: 5 });

			loseNext = false;
			sync.setFacts({ stale: false, sessions: [merged()] });
			await until(() => expect(current.status).toBe("done"));
			await settled();

			expect(view().state).toBe("synced");
			expect(records.some((entry) => entry.kind === "pause")).toBe(false);
			expect(store.saved().issues[0].intent ?? null).toBeNull();
		});

		it("turning sync off while the intent is being saved stops the write, and forgets the intent", async () => {
			let releaseSave: () => void = () => undefined;
			const originalSave = store.save;
			let gated = false;
			store.save = async (file) => {
				if (!gated && file.issues.some((issue) => issue.intent)) {
					gated = true;
					await new Promise<void>((resolve) => {
						releaseSave = resolve;
					});
				}
				return originalSave(file);
			};
			const stub = {
				getIssue: vi.fn(async () => issueAt("todo", 4)),
				previewTrigger: vi.fn(),
				putStatus: vi.fn(async () => issueAt("in_progress", 5)),
				getParent: vi.fn(),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(gated).toBe(true));

			await sync.setSettings({ enabled: false });
			releaseSave();
			await sleep(80);

			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(store.saved().issues.every((issue) => !issue.intent)).toBe(true);
			expect(records.filter((entry) => entry.kind === "status_write")).toEqual([]);
		});

		it("a status that matches the intent at a revision that is not newer is not taken for AO's own write", async () => {
			const current = { status: "todo", revision: 4 };
			let mode: "normal" | "lost-and-stale" = "normal";
			const stub = {
				getIssue: vi.fn(async () => issueAt(current.status, current.revision)),
				previewTrigger: vi.fn(),
				getParent: vi.fn(),
				putStatus: vi.fn(async (_key: string, input: { status: string }) => {
					if (mode === "lost-and-stale") {
						// The write is lost, and the next read shows the intended status at the revision before it.
						current.status = input.status;
						return { ok: false as const, kind: "timeout" as const };
					}
					current.status = input.status;
					current.revision += 1;
					return issueAt(current.status, current.revision);
				}),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(current).toEqual({ status: "in_progress", revision: 5 });

			mode = "lost-and-stale";
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("error"));
			sync.setFacts({ stale: false, sessions: [merged()] });
			// Same category as the intent, revision 5 is not newer than the 5 AO read before writing: a person's change, not an echo.
			await until(() => expect(view().state).toBe("paused"));
			expect(view()).toMatchObject({ reason: "changed_in_multica" });
		});

		it("records the intent before the write goes out, and forgets it once the write is answered", async () => {
			let release: (value: unknown) => void = () => undefined;
			const stub = {
				getIssue: vi.fn(async () => issueAt("todo", 4)),
				previewTrigger: vi.fn(),
				putStatus: vi.fn(() => new Promise((resolve) => (release = resolve))),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(stub.putStatus).toHaveBeenCalledTimes(1));
			expect(store.saved().issues[0].intent).toMatchObject({ status: "in_progress", category: "in_progress", revBefore: 4 });

			release(issueAt("in_progress", 5));
			await settled();
			expect(store.saved().issues[0].intent ?? null).toBeNull();
		});

		it("a lost write that never landed leaves no false agreement", async () => {
			const stub = {
				getIssue: vi.fn(async () => issueAt("todo", 4)),
				previewTrigger: vi.fn(),
				putStatus: vi.fn(async () => ({ ok: false as const, kind: "timeout" as const })),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start({ engine: { minRetryMs: 15, maxRetryMs: 15 } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(vi.mocked(stub.putStatus).mock.calls.length).toBeGreaterThanOrEqual(2));
			// The write was retried (nothing landed), and nothing was paused or mistaken for AO's own write.
			expect(records.some((entry) => entry.kind === "pause")).toBe(false);
		});

		it("a pass superseded by a server switch back to the same server does not clear the newer pass's running state (F3.2)", async () => {
			const resolvers: Array<(value: unknown) => void> = [];
			const stub = {
				getIssue: vi.fn(() => new Promise((resolve) => resolvers.push(resolve))),
				previewTrigger: vi.fn(),
				putStatus: vi.fn(async () => issueAt("in_progress", 5)),
			} as unknown as MulticaIssueApi;
			api = stub;
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(stub.getIssue).toHaveBeenCalledTimes(1));

			sync.handleServerChange(OTHER_SERVER);
			sync.setLinks(SERVER, [link()]);
			await until(() => expect(stub.getIssue).toHaveBeenCalledTimes(2));

			// The first, superseded read comes back.
			resolvers[0](issueAt("todo", 4));
			await sleep(80);

			// No third concurrent pass was started, and the newer one is still pending.
			expect(stub.getIssue).toHaveBeenCalledTimes(2);
			expect(stub.putStatus).not.toHaveBeenCalled();
			expect(view().state).toBe("pending");

			resolvers[1](issueAt("todo", 4));
			await until(() => expect(stub.putStatus).toHaveBeenCalledTimes(1));
		});
	});

	describe("failures", () => {
		it("signed out: stops for the whole server without a retry storm, and resumes when the user signs in", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.addIssue({ identifier: "MUL-2", status: "todo" });
			host.setToken(null);
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await turnOn(sync, [link({ sessionId: "s-1" }), link({ sessionId: "s-2", issueIdentifier: "MUL-2" })]);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "signed_out" }));
			const scripts = host.scripts.length;
			await sleep(250);

			expect(view(engine, "s-2", "MUL-2")).toMatchObject({ state: "error", reason: "signed_out" });
			expect(host.scripts).toHaveLength(scripts);
			expect(scripts).toBeLessThanOrEqual(2);
			expect(fake.requests).toHaveLength(0);

			host.setToken(fake.token);
			sync.notifySignedIn();
			await settled();
			await settled(engine, "s-2", "MUL-2");
			expect(put()).toHaveLength(2);
		});

		it("an expired token (401) is treated the same way", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			host.setToken("expired");
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "signed_out" }));
			await sleep(150);
			expect(fake.requests).toHaveLength(1);
		});

		it("a server error backs off and retries, then writes", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.failNext({ method: "GET" }, { status: 503 }, 2);
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "unreachable" }));
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			expect(get()).toHaveLength(3);
		});

		it("429 waits as long as Retry-After says, and Sync now tries at once", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.failNext({ method: "GET" }, { status: 429, headers: { "Retry-After": "30" } });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "rate_limited" }));
			await sleep(150);
			expect(fake.requests).toHaveLength(1);

			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
		});

		it("404 marks the issue orphaned and stops; 403 reports no access; neither retries", async () => {
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "orphaned" }));
			await sleep(150);
			expect(fake.requests).toHaveLength(1);
			expect(store.saved().issues[0].orphaned).toBe(true);

			sync.dispose();
			fake.requests.length = 0;
			store = memoryStore();
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.forbid("MUL-1");
			const other = start();
			other.setFacts({ stale: false, sessions: [working()] });
			await turnOn(other);
			await until(() => expect(view(other)).toMatchObject({ state: "error", reason: "no_access" }));
			await sleep(150);
			expect(fake.requests).toHaveLength(1);
		});

		it("no live Multica view: waits and retries, writing as soon as it is there", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			host.setAvailable(false);
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "unavailable" }));
			expect(fake.requests).toHaveLength(0);

			host.setAvailable(true);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
		});
	});

	describe("write budget", () => {
		it("at most N writes per issue per hour, then waits", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start({ engine: { maxWritesPerIssuePerHour: 2 } });
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_review"));
			await settled();
			sync.setFacts({ stale: false, sessions: [merged()] });
			await until(() => expect(view()).toMatchObject({ state: "error", reason: "rate_limited" }));
			expect(fake.issues.get(issue.id)?.status).toBe("in_review");

			clock += 61 * 60 * 1000;
			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("done"));
		});

		it("at most N writes per server per minute across issues", async () => {
			const first = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const second = fake.addIssue({ identifier: "MUL-2", status: "todo" });
			const sync = start({ engine: { maxWritesPerServerPerMinute: 1 } });
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2")] });
			await turnOn(sync, [link({ sessionId: "s-1" }), link({ sessionId: "s-2", issueIdentifier: "MUL-2" })]);
			await until(() => expect(put()).toHaveLength(1));
			await sleep(120);
			expect(put()).toHaveLength(1);
			const statuses = [fake.issues.get(first.id)?.status, fake.issues.get(second.id)?.status];
			expect(statuses.filter((status) => status === "in_progress")).toHaveLength(1);

			clock += 61 * 1000;
			await sync.syncNow({ sessionId: "s-2", workspaceSlug: "acme", issueIdentifier: "MUL-2" });
			await sync.syncNow({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await until(() => expect(put()).toHaveLength(2));
		});
	});

	describe("audit hook", () => {
		it("is called after every write attempt, pause and resume, with request fields, revisions and result", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();

			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				kind: "status_write",
				serverKey: SERVER,
				workspaceId: issue.workspace_id,
				issueId: issue.id,
				issueIdentifier: "MUL-1",
				sessionId: "s-1",
				request: {
					method: "PUT",
					pathTemplate: "/api/issues/{id}",
					fields: { status: "in_progress", expected_revision: 4, suppress_run: true },
				},
				revBefore: 4,
				revAfter: 5,
				result: { ok: true, httpStatus: 200 },
			});
			expect(Date.parse(records[0].at)).toBe(clock);
		});

		it("carries no secrets: not the token, the title, the description or the issue text", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo", title: "Leaky title", description: "Leaky description" });
			fake.beforeNextPut((found) => {
				found.revision += 1;
			});
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			const found = fake.issues.get(issue.id)!;
			found.status = "todo";
			found.status_category = "todo";
			found.revision += 1;
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));
			await sync.resume({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
			await settled();

			const serialized = JSON.stringify(records);
			expect(records.map((entry) => entry.kind)).toContain("pause");
			expect(records.map((entry) => entry.kind)).toContain("resume");
			expect(serialized).not.toContain(fake.token);
			expect(serialized).not.toMatch(/Bearer|Authorization|Leaky|secret/i);
			expect(JSON.stringify(store.saved())).not.toMatch(/Leaky|secret/i);
			for (const entry of records) {
				if (entry.request) expect(Object.keys(entry.request.fields).sort()).toEqual(["expected_revision", "status", "suppress_run"]);
			}
		});

		it("logs nothing at all: no console output in a scenario with a write, a conflict, a pause and a failure", async () => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			fake.beforeNextPut((found) => {
				found.revision += 1;
			});
			fake.failNext({ method: "GET" }, { status: 503 });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			const found = fake.issues.get(issue.id)!;
			found.status = "todo";
			found.status_category = "todo";
			found.revision += 1;
			sync.setFacts({ stale: false, sessions: [inReview()] });
			await until(() => expect(view().state).toBe("paused"));

			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			spies.forEach((spy) => spy.mockRestore());
		});

		it("a failing sink does not stop sync, and the default sink is a no-op", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start({
				engine: {
					record: () => {
						throw new Error("sink is down");
					},
				},
			});
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");

			sync.dispose();
			const quiet = createMulticaStatusSync({ api, store: memoryStore(), env: {}, debounceMs: DEBOUNCE_MS });
			engines.push(quiet);
			fake.issues.get(issue.id)!.status = "todo";
			fake.issues.get(issue.id)!.status_category = "todo";
			quiet.setFacts({ stale: false, sessions: [working()] });
			await turnOn(quiet);
			await settled(quiet);
			expect(fake.issues.get(issue.id)?.status).toBe("in_progress");
		});
	});

	describe("request allow-list, end to end", () => {
		it("over a long scenario every request is an allowed one and no Multica run is ever started", async () => {
			const backlog = fake.addIssue({ identifier: "MUL-1", status: "backlog" });
			const agent = fake.addIssue({ identifier: "MUL-2", status: "backlog", assignee_type: "agent" });
			const done = fake.addIssue({ identifier: "MUL-3", status: "done" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working("s-1"), working("s-2"), working("s-3")] });
			await turnOn(sync, [
				link({ sessionId: "s-1", issueIdentifier: "MUL-1" }),
				link({ sessionId: "s-2", issueIdentifier: "MUL-2" }),
				link({ sessionId: "s-3", issueIdentifier: "MUL-3" }),
			], { enabled: true, moveOutOfBacklog: true });
			for (const [session, identifier] of [["s-1", "MUL-1"], ["s-2", "MUL-2"], ["s-3", "MUL-3"]]) await settled(engine, session, identifier);
			sync.setFacts({ stale: false, sessions: [inReview("s-1"), inReview("s-2"), inReview("s-3")] });
			await sleep(DEBOUNCE_MS * 4);
			await settled(engine, "s-1", "MUL-1");
			sync.setFacts({ stale: false, sessions: [merged("s-1"), merged("s-2"), merged("s-3")] });
			await sleep(DEBOUNCE_MS * 4);
			await settled(engine, "s-1", "MUL-1");

			expect(fake.unexpected).toEqual([]);
			expect(fake.runsStarted).toBe(0);
			expect(fake.parentWakes).toBe(0);
			expect(fake.issues.get(agent.id)?.status).toBe("backlog");
			expect(fake.issues.get(done.id)?.status).toBe("done");
			expect(fake.issues.get(backlog.id)?.status).toBe("done");
			for (const request of fake.requests) {
				const template = request.path.replace(/\/api\/issues\/[0-9a-f-]{36}$/, "/api/issues/{id}").replace(/\/api\/issues\/MUL-\d+$/, "/api/issues/{identifier}");
				expect([
					"GET /api/issues/{identifier}",
					"PUT /api/issues/{id}",
					"POST /api/issues/preview-trigger",
				]).toContain(`${request.method} ${template}`);
				if (request.method === "PUT") {
					expect(Object.keys(request.body ?? {}).sort()).toEqual(["expected_revision", "status", "suppress_run"]);
					expect(request.body?.suppress_run).toBe(true);
					expect(MULTICA_WRITABLE_STATUSES as readonly unknown[]).toContain(request.body?.status);
				}
				expect(JSON.stringify(request.body ?? {})).not.toMatch(/assignee/);
			}
		});
	});

	describe("persistence", () => {
		it("remembers the settings, the enabled links and the last status across a restart, without writing again", async () => {
			const issue = fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync, [link()], { enabled: true, moveOutOfBacklog: false });
			await until(() => expect(fake.issues.get(issue.id)?.status).toBe("in_progress"));
			await settled();
			sync.dispose();

			const restarted = start();
			await restarted.ready;
			restarted.setLinks(SERVER, [link()]);
			expect(restarted.getSnapshot().settings).toEqual({ enabled: true, moveOutOfBacklog: false });
			expect(view(restarted).enabled).toBe(true);
			restarted.setFacts({ stale: false, sessions: [working()] });
			await settled(restarted);
			expect(put()).toHaveLength(1);
		});

		it("turning a link off forgets its issue state; removing the link prunes both", async () => {
			fake.addIssue({ identifier: "MUL-1", status: "todo" });
			const sync = start();
			sync.setFacts({ stale: false, sessions: [working()] });
			await turnOn(sync);
			await settled();
			expect(store.saved().issues).toHaveLength(1);

			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
			await sleep(20);
			expect(store.saved().links).toEqual([]);
			expect(store.saved().issues).toEqual([]);

			await sync.setLink({ sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			await settled();
			sync.setLinks(SERVER, []);
			await sleep(20);
			expect(store.saved().links).toEqual([]);
			expect(store.saved().issues).toEqual([]);
		});

		it("does not forget the enabled links when the server is announced before the links are known (startup race)", async () => {
			const saved: MulticaSyncStateFile = {
				settings: { enabled: true, moveOutOfBacklog: true },
				links: [{ serverKey: SERVER, sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" }],
				issues: [],
			};
			store = memoryStore(saved);
			const slowLoad = store.load;
			let release: () => void = () => undefined;
			store.load = async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return slowLoad();
			};
			const sync = start();
			// The view host announces the server while the saved state is still being read.
			sync.handleServerChange(SERVER);
			release();
			await sync.ready;
			await sleep(20);
			expect(store.saved().links).toEqual(saved.links);

			sync.setLinks(SERVER, [link()]);
			expect(view(sync).enabled).toBe(true);
			expect(store.saved().links).toEqual(saved.links);

			// Once the links are known, a link that is really gone is pruned.
			sync.setLinks(SERVER, []);
			await sleep(20);
			expect(store.saved().links).toEqual([]);
		});

		it("does not prune the links of a server whose list has not arrived after a switch", async () => {
			const sync = start();
			await turnOn(sync);
			sync.handleServerChange(OTHER_SERVER);
			sync.handleServerChange(SERVER);
			await sleep(20);
			expect(store.saved().links).toEqual([{ serverKey: SERVER, sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" }]);
		});

		it("ignores an action for a link it does not have", async () => {
			const sync = start();
			await sync.ready;
			sync.setLinks(SERVER, [link()]);
			await sync.setLink({ sessionId: "nope", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
			expect(store.saved().links).toEqual([]);
		});
	});

	it("notifies listeners of every change of the snapshot, once per change", async () => {
		fake.addIssue({ identifier: "MUL-1", status: "todo" });
		const sync = start();
		const seen: string[] = [];
		sync.onChanged((snapshot) => seen.push(snapshot.links.map((entry) => entry.state).join(",")));
		sync.setFacts({ stale: false, sessions: [working()] });
		await turnOn(sync);
		await settled();

		expect(seen.at(-1)).toBe("synced");
		expect(seen.length).toBeGreaterThan(1);
		expect(new Set(seen.map((entry, index) => `${index > 0 ? seen[index - 1] : ""}>${entry}`)).size).toBe(seen.length);
	});
});
