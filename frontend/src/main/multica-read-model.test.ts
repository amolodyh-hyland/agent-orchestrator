import { describe, expect, it } from "vitest";
import {
	MULTICA_MAX_ISSUES_PER_SERVER,
	MULTICA_MAX_RUNS_PER_SERVER,
	type AwarenessIssue,
	type AwarenessRun,
} from "../shared/multica-awareness";
import {
	applyFrame,
	createServerModel,
	enforceCaps,
	isIgnoredFrameType,
	listItems,
	parseFrame,
	projectAgent,
	projectIssue,
	projectRun,
	projectRuntime,
	isOfInterest,
	reconcileRuns,
	upsertIssue,
	replaceAgents,
	resolveUnknownOutcome,
	type FrameContext,
	type ServerModel,
} from "./multica-read-model";

const NOW = "2026-10-10T12:00:00.000Z";
const WS = "ws-1";
const ME = "user-me";

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
	id: "iss-1",
	workspace_id: WS,
	number: 12,
	identifier: "MUL-12",
	title: "Fix the board",
	description: "PRIVATE DESCRIPTION",
	status: "todo",
	status_category: "todo",
	assignee_type: "agent",
	assignee_id: "agent-1",
	parent_issue_id: null,
	project_id: null,
	revision: 3,
	updated_at: "2026-10-10T11:00:00Z",
	metadata: { secret: "PRIVATE METADATA" },
	...overrides,
});

const context = (overrides: Partial<FrameContext> = {}): FrameContext => ({
	workspaceId: WS,
	nowIso: NOW,
	meId: ME,
	isLinked: () => false,
	...overrides,
});

const frame = (type: string, payload: unknown) => ({ type, payload, actorId: null, actorType: null });
const taskFrame = (type: string, extra: Record<string, unknown> = {}) =>
	frame(type, { task_id: "t1", agent_id: "agent-1", issue_id: "iss-1", ...extra });

function model(): ServerModel {
	const m = createServerModel();
	m.issues.set("iss-1", projectIssue(rawIssue())!);
	return m;
}

describe("projection", () => {
	it("keeps only the listed issue fields and truncates the title", () => {
		const issue = projectIssue(rawIssue({ title: `${"x".repeat(300)}\n`, comment: "PRIVATE COMMENT" }))!;
		expect(Object.keys(issue).sort()).toEqual(
			["assigneeId", "assigneeType", "id", "identifier", "parentIssueId", "projectId", "revision", "statusCategory", "status", "title", "updatedAt", "workspaceId"].sort(),
		);
		expect(Array.from(issue.title)).toHaveLength(200);
		expect(JSON.stringify(issue)).not.toContain("PRIVATE");
	});

	it("rejects an issue without the required fields and nulls an unknown assignee type", () => {
		expect(projectIssue({ id: "a" })).toBeNull();
		expect(projectIssue(null)).toBeNull();
		expect(projectIssue(rawIssue({ assignee_type: "robot" }))!.assigneeType).toBeNull();
		expect(projectIssue(rawIssue({ assignee_type: null, assignee_id: null }))!.assigneeId).toBeNull();
	});

	it("drops results, errors, work_dir, trigger text and the other claim-only fields from a run", () => {
		const run = projectRun(
			{
				id: "t1",
				agent_id: "agent-1",
				runtime_id: "rt-1",
				issue_id: "iss-1",
				workspace_id: WS,
				status: "running",
				result: { secret: "PRIVATE RESULT" },
				error: "PRIVATE ERROR",
				work_dir: "/Users/someone/work",
				trigger_comment_content: "PRIVATE TRIGGER",
				chat_message: "PRIVATE CHAT",
				started_at: "2026-10-10T11:59:00Z",
				is_leader_task: true,
				autopilot_run_id: "ap-1",
				parent_task_id: "t0",
			},
			WS,
			NOW,
		)!;
		expect(run).toEqual({
			id: "t1",
			workspaceId: WS,
			issueId: "iss-1",
			agentId: "agent-1",
			status: "running",
			failureReason: null,
			retryPending: false,
			outcomeUnknown: false,
			startedAt: "2026-10-10T11:59:00Z",
			endedAt: null,
			isLeaderTask: true,
			autopilotRunId: "ap-1",
			parentTaskId: "t0",
			runtimeId: "rt-1",
		});
		expect(JSON.stringify(run)).not.toMatch(/PRIVATE|work_dir|Users/);
	});

	it("ignores chat tasks and unknown statuses", () => {
		expect(projectRun({ id: "t", agent_id: "a", issue_id: "", status: "running", chat_session_id: "c" }, WS, NOW)).toBeNull();
		expect(projectRun({ id: "t", agent_id: "a", issue_id: "i", status: "exploded" }, WS, NOW)).toBeNull();
	});

	it("stamps the end time of a terminal run that has no completion time", () => {
		expect(projectRun({ id: "t", agent_id: "a", issue_id: "i", status: "failed", failure_reason: "agent_error" }, WS, NOW)).toMatchObject({
			endedAt: NOW,
			failureReason: "agent_error",
		});
	});

	it("projects agents and runtimes without their instructions or device info", () => {
		expect(projectAgent({ id: "a", workspace_id: WS, name: "Builder", instructions: "PRIVATE", runtime_id: "rt" })).toEqual({
			id: "a",
			workspaceId: WS,
			name: "Builder",
			runtimeId: "rt",
		});
		expect(projectRuntime({ id: "rt", workspace_id: WS, provider: "claude", daemon_id: "d1", status: "online", device_info: "PRIVATE", metadata: { a: 1 } })).toEqual({
			id: "rt",
			workspaceId: WS,
			provider: "claude",
			daemonId: "d1",
			status: "online",
		});
	});

	it("reads bare arrays and wrapped lists", () => {
		expect(listItems([1], "issues")).toEqual([1]);
		expect(listItems({ issues: [2] }, "issues")).toEqual([2]);
		expect(listItems({ other: [3] }, "issues")).toEqual([]);
	});

	it("parses frames and refuses malformed ones", () => {
		expect(parseFrame('{"actor_id":"u","actor_type":"member","payload":{"a":1},"type":"issue:updated"}')).toEqual({
			type: "issue:updated",
			payload: { a: 1 },
			actorId: "u",
			actorType: "member",
		});
		expect(parseFrame("not json")).toBeNull();
		expect(parseFrame('{"payload":{}}')).toBeNull();
		expect(parseFrame("[]")).toBeNull();
	});

	it("names the noisy frame types", () => {
		expect(isIgnoredFrameType("task:message")).toBe(true);
		expect(isIgnoredFrameType("task:progress")).toBe(true);
		expect(isIgnoredFrameType("daemon:heartbeat")).toBe(true);
		expect(isIgnoredFrameType("task:running")).toBe(false);
	});
});

describe("task frame reducer", () => {
	const events: Array<[string, string]> = [
		["task:queued", "queued"],
		["task:dispatch", "dispatched"],
		["task:running", "running"],
		["task:waiting_local_directory", "waiting_local_directory"],
		["task:completed", "completed"],
		["task:failed", "failed"],
		["task:cancelled", "cancelled"],
	];

	for (const [type, status] of events) {
		it(`${type} creates a ${status} run for an unknown task and asks for a snapshot refresh`, () => {
			const m = model();
			const result = applyFrame(m, taskFrame(type), context());
			expect(result.changed).toBe(true);
			expect(result.effects).toEqual([{ type: "refresh_snapshot" }]);
			expect(m.runs.get("t1")).toMatchObject({ status, issueId: "iss-1", agentId: "agent-1", workspaceId: WS });
		});
	}

	it("follows the payload status over the event name", () => {
		const m = model();
		applyFrame(m, taskFrame("task:dispatch", { status: "dispatched" }), context());
		expect(m.runs.get("t1")!.status).toBe("dispatched");
	});

	it("walks a run through its whole life without a second refresh", () => {
		const m = model();
		applyFrame(m, taskFrame("task:queued"), context());
		for (const type of ["task:dispatch", "task:running", "task:completed"]) {
			expect(applyFrame(m, taskFrame(type), context()).effects).toEqual([]);
		}
		expect(m.runs.get("t1")).toMatchObject({ status: "completed", endedAt: NOW });
	});

	it("records the failure reason and the retry flag", () => {
		const m = model();
		applyFrame(m, taskFrame("task:failed", { failure_reason: "agent_error", retry_pending: true, error: "PRIVATE ERROR" }), context());
		expect(m.runs.get("t1")).toMatchObject({ status: "failed", failureReason: "agent_error", retryPending: true });
		expect(JSON.stringify([...m.runs.values()])).not.toContain("PRIVATE");
	});

	it("does not move a task backwards and treats a duplicate as no change", () => {
		const m = model();
		applyFrame(m, taskFrame("task:running"), context());
		expect(applyFrame(m, taskFrame("task:queued"), context()).changed).toBe(false);
		expect(applyFrame(m, taskFrame("task:dispatch"), context()).changed).toBe(false);
		expect(applyFrame(m, taskFrame("task:running"), context()).changed).toBe(false);
		expect(m.runs.get("t1")!.status).toBe("running");
	});

	it("keeps a terminal state sticky", () => {
		const m = model();
		applyFrame(m, taskFrame("task:completed"), context());
		expect(applyFrame(m, taskFrame("task:running"), context()).changed).toBe(false);
		expect(applyFrame(m, taskFrame("task:cancelled"), context()).changed).toBe(false);
		expect(m.runs.get("t1")!.status).toBe("completed");
	});

	it("ignores chat tasks that carry no issue", () => {
		const m = model();
		const result = applyFrame(m, frame("task:queued", { task_id: "c1", agent_id: "agent-1", issue_id: "", chat_session_id: "chat" }), context());
		expect(result).toEqual({ changed: false, effects: [] });
		expect(m.runs.size).toBe(0);
	});

	it("supersedes a retry-pending failure when the agent's next run starts", () => {
		const m = model();
		applyFrame(m, taskFrame("task:failed", { retry_pending: true }), context());
		applyFrame(m, frame("task:queued", { task_id: "t2", agent_id: "agent-1", issue_id: "iss-1" }), context());
		expect(m.runs.get("t1")!.retryPending).toBe(false);
		expect(m.runs.get("t2")!.status).toBe("queued");
	});
});

describe("issue frame reducer", () => {
	const issueFrame = (type: string, overrides: Record<string, unknown> = {}) => frame(type, { issue: rawIssue(overrides), status_changed: true });

	it("upserts only when the revision is newer", () => {
		const m = model();
		expect(applyFrame(m, issueFrame("issue:updated", { revision: 3, title: "same revision" }), context()).changed).toBe(false);
		expect(applyFrame(m, issueFrame("issue:updated", { revision: 2, title: "older" }), context()).changed).toBe(false);
		expect(applyFrame(m, issueFrame("issue:updated", { revision: 4, title: "newer", status: "in_progress", status_category: "in_progress" }), context()).changed).toBe(true);
		expect(m.issues.get("iss-1")).toMatchObject({ title: "newer", status: "in_progress", revision: 4 });
	});

	it("never keeps the description of an updated issue", () => {
		const m = model();
		applyFrame(m, issueFrame("issue:updated", { revision: 9, description: "PRIVATE DESCRIPTION 2" }), context());
		expect(JSON.stringify([...m.issues.values()])).not.toContain("PRIVATE");
	});

	it("ignores an unknown issue outside the interest set and keeps one inside it", () => {
		const m = createServerModel();
		const outside = issueFrame("issue:created", { id: "iss-9", assignee_type: "member", assignee_id: "someone-else" });
		expect(applyFrame(m, outside, context()).changed).toBe(false);
		const mine = issueFrame("issue:created", { id: "iss-9", assignee_type: "member", assignee_id: ME });
		expect(applyFrame(m, mine, context()).changed).toBe(true);
		expect(m.issues.has("iss-9")).toBe(true);
		const linked = issueFrame("issue:created", { id: "iss-8", assignee_type: null, assignee_id: null });
		expect(applyFrame(m, linked, context({ isLinked: (issue) => issue.id === "iss-8" })).changed).toBe(true);
	});

	it("drops an issue that left the interest set", () => {
		const m = createServerModel();
		applyFrame(m, issueFrame("issue:created", { assignee_type: "member", assignee_id: ME }), context());
		expect(m.issues.size).toBe(1);
		applyFrame(m, issueFrame("issue:updated", { revision: 5, assignee_type: "member", assignee_id: "someone-else" }), context());
		expect(m.issues.size).toBe(0);
	});

	it("keeps an issue that has an active run whoever it is assigned to", () => {
		const m = model();
		applyFrame(m, taskFrame("task:running"), context());
		applyFrame(m, issueFrame("issue:updated", { revision: 5, assignee_type: "member", assignee_id: "someone-else" }), context());
		expect(m.issues.has("iss-1")).toBe(true);
	});

	it("ignores a frame for another workspace", () => {
		const m = createServerModel();
		const result = applyFrame(m, issueFrame("issue:created", { workspace_id: "ws-2" }), context());
		expect(result.changed).toBe(false);
	});

	it("deletes the issue and its runs and remembers the identifier", () => {
		const m = model();
		applyFrame(m, taskFrame("task:running"), context());
		const result = applyFrame(m, frame("issue:deleted", { issue_id: "iss-1" }), context());
		expect(result.changed).toBe(true);
		expect(m.issues.size).toBe(0);
		expect(m.runs.size).toBe(0);
		expect(m.deleted.get("iss-1")).toEqual({ workspaceId: WS, identifier: "MUL-12" });
	});

	it("forgets the deleted mark when the issue comes back with a newer revision", () => {
		const m = model();
		applyFrame(m, frame("issue:deleted", { issue_id: "iss-1" }), context());
		applyFrame(m, issueFrame("issue:created", { revision: 1 }), context());
		expect(m.deleted.size).toBe(0);
	});
});

describe("other frames", () => {
	it("asks for an agent refresh on agent and squad events", () => {
		for (const type of ["agent:status", "agent:created", "squad:updated"]) {
			expect(applyFrame(createServerModel(), frame(type, {}), context()).effects).toEqual([{ type: "refresh_agents" }]);
		}
	});

	it("refetches a held issue after a labels or metadata change, and only a held one", () => {
		const m = model();
		expect(applyFrame(m, frame("issue_labels:changed", { issue_id: "iss-1" }), context()).effects).toEqual([{ type: "refetch_issue", issueId: "iss-1" }]);
		expect(applyFrame(m, frame("issue_metadata:changed", { issue_id: "iss-1" }), context()).effects).toEqual([{ type: "refetch_issue", issueId: "iss-1" }]);
		expect(applyFrame(m, frame("issue_labels:changed", { issue_id: "other" }), context()).effects).toEqual([]);
	});

	it("stops the workspace when it is deleted or the user is removed", () => {
		const m = model();
		expect(applyFrame(m, frame("workspace:deleted", { workspace_id: WS }), context()).effects).toEqual([{ type: "stop", reason: "gone" }]);
		expect(applyFrame(m, frame("workspace:deleted", { workspace_id: "other" }), context()).effects).toEqual([]);
		expect(applyFrame(m, frame("member:removed", { user_id: ME, workspace_id: WS }), context()).effects).toEqual([{ type: "stop", reason: "no_access" }]);
		expect(applyFrame(m, frame("member:removed", { user_id: "someone", workspace_id: WS }), context()).effects).toEqual([]);
	});

	it("ignores every other frame", () => {
		expect(applyFrame(model(), frame("comment:created", { comment: { content: "PRIVATE" } }), context())).toEqual({ changed: false, effects: [] });
	});
});

describe("reconcile", () => {
	const run = (overrides: Partial<AwarenessRun> = {}): AwarenessRun => ({
		id: "t1",
		workspaceId: WS,
		issueId: "iss-1",
		agentId: "agent-1",
		status: "running",
		failureReason: null,
		retryPending: false,
		outcomeUnknown: false,
		startedAt: "2026-10-10T11:00:00Z",
		endedAt: null,
		isLeaderTask: false,
		autopilotRunId: null,
		parentTaskId: null,
		runtimeId: null,
		...overrides,
	});

	it("applies the snapshot and marks held active runs it no longer lists as ended, outcome unknown", () => {
		const m = model();
		m.runs.set("gone", run({ id: "gone" }));
		m.runs.set("other-ws", run({ id: "other-ws", workspaceId: "ws-2" }));
		const result = reconcileRuns(m, { workspaceId: WS, snapshotRuns: [run({ id: "t1", status: "queued" })], nowIso: NOW });
		expect(result.changed).toBe(true);
		expect(result.unknownOutcome.map((entry) => entry.id)).toEqual(["gone"]);
		expect(m.runs.get("gone")).toMatchObject({ outcomeUnknown: true, endedAt: NOW });
		expect(m.runs.get("other-ws")!.outcomeUnknown).toBe(false);
		expect(m.runs.get("t1")!.status).toBe("queued");
	});

	it("does not mark finished runs or mark twice", () => {
		const m = model();
		m.runs.set("done", run({ id: "done", status: "completed", endedAt: NOW }));
		m.runs.set("gone", run({ id: "gone" }));
		reconcileRuns(m, { workspaceId: WS, snapshotRuns: [], nowIso: NOW });
		expect(m.runs.get("done")!.outcomeUnknown).toBe(false);
		expect(reconcileRuns(m, { workspaceId: WS, snapshotRuns: [], nowIso: NOW }).unknownOutcome).toEqual([]);
	});

	it("replaces an unknown outcome with the enriched run", () => {
		const m = model();
		m.runs.set("gone", run({ id: "gone" }));
		reconcileRuns(m, { workspaceId: WS, snapshotRuns: [], nowIso: NOW });
		expect(resolveUnknownOutcome(m, run({ id: "gone", status: "completed", endedAt: "2026-10-10T11:30:00Z" }))).toBe(true);
		expect(m.runs.get("gone")).toMatchObject({ status: "completed", outcomeUnknown: false, endedAt: "2026-10-10T11:30:00Z" });
		expect(resolveUnknownOutcome(m, run({ id: "gone", status: "failed" }))).toBe(false);
	});

	it("does not let a stale snapshot move a run backwards", () => {
		const m = model();
		applyFrame(m, taskFrame("task:completed"), context());
		reconcileRuns(m, { workspaceId: WS, snapshotRuns: [run({ id: "t1", status: "running" })], nowIso: NOW });
		expect(m.runs.get("t1")!.status).toBe("completed");
	});

	it("replaces the agents of one workspace only", () => {
		const m = createServerModel();
		m.agents.set("a1", { id: "a1", workspaceId: WS, name: "A", runtimeId: null });
		m.agents.set("b1", { id: "b1", workspaceId: "ws-2", name: "B", runtimeId: null });
		expect(replaceAgents(m, WS, [{ id: "a2", workspaceId: WS, name: "A2", runtimeId: null }])).toBe(true);
		expect([...m.agents.keys()].sort()).toEqual(["a2", "b1"]);
	});
});

describe("deferred runs", () => {
	it("do not hold an issue: only queued, dispatched, waiting and running count as active", () => {
		const m = createServerModel();
		const issue = projectIssue(rawIssue({ assignee_type: null, assignee_id: null }))!;
		const ctx = { meId: ME, isLinked: () => false };
		const run = (status: AwarenessRun["status"]): AwarenessRun => ({
			id: "t1", workspaceId: WS, issueId: "iss-1", agentId: "a", status, failureReason: null, retryPending: false, outcomeUnknown: false,
			startedAt: null, endedAt: null, isLeaderTask: false, autopilotRunId: null, parentTaskId: null, runtimeId: null,
		});
		m.runs.set("t1", run("deferred"));
		expect(isOfInterest(m, issue, ctx)).toBe(false);
		for (const status of ["queued", "dispatched", "waiting_local_directory", "running"] as const) {
			m.runs.set("t1", run(status));
			expect(isOfInterest(m, issue, ctx)).toBe(true);
		}
	});
});

describe("issue revisions", () => {
	it("upsertIssue keeps the held issue unless the new one is strictly newer", () => {
		const m = createServerModel();
		const base = projectIssue(rawIssue({ revision: 5 }))!;
		expect(upsertIssue(m, base)).toBe(true);
		expect(upsertIssue(m, { ...base, title: "same revision" })).toBe(false);
		expect(upsertIssue(m, { ...base, revision: 4, title: "older" })).toBe(false);
		expect(upsertIssue(m, { ...base, revision: 6, title: "newer" })).toBe(true);
		expect(m.issues.get("iss-1")!.title).toBe("newer");
	});
});

describe("caps", () => {
	it("evicts finished runs before active ones and the oldest first", () => {
		const m = createServerModel();
		for (let index = 0; index < MULTICA_MAX_RUNS_PER_SERVER + 5; index += 1) {
			const finished = index % 2 === 0;
			m.runs.set(`t${index}`, {
				id: `t${index}`,
				workspaceId: WS,
				issueId: "iss-1",
				agentId: "a",
				status: finished ? "completed" : "running",
				failureReason: null,
				retryPending: false,
				outcomeUnknown: false,
				startedAt: null,
				endedAt: finished ? `2026-10-10T10:${String(index % 60).padStart(2, "0")}:00Z` : null,
				isLeaderTask: false,
				autopilotRunId: null,
				parentTaskId: null,
				runtimeId: null,
			});
		}
		enforceCaps(m, { meId: ME, isLinked: () => false });
		expect(m.runs.size).toBe(MULTICA_MAX_RUNS_PER_SERVER);
		expect([...m.runs.values()].filter((run) => run.status === "running")).toHaveLength(Math.floor((MULTICA_MAX_RUNS_PER_SERVER + 5) / 2));
	});

	it("evicts issues outside the interest set first", () => {
		const m = createServerModel();
		const issue = (index: number, mine: boolean): AwarenessIssue => ({
			id: `${mine ? "i" : "x"}${index}`,
			workspaceId: WS,
			identifier: `MUL-${index}`,
			title: "t",
			status: "todo",
			statusCategory: "todo",
			assigneeType: mine ? "member" : null,
			assigneeId: mine ? ME : null,
			parentIssueId: null,
			projectId: null,
			revision: 1,
			updatedAt: `2026-10-10T10:00:${String(index % 60).padStart(2, "0")}Z`,
		});
		for (let index = 0; index < MULTICA_MAX_ISSUES_PER_SERVER; index += 1) m.issues.set(issue(index, true).id, issue(index, true));
		for (let index = 0; index < 3; index += 1) m.issues.set(issue(10_000 + index, false).id, issue(10_000 + index, false));
		enforceCaps(m, { meId: ME, isLinked: () => false });
		expect(m.issues.size).toBe(MULTICA_MAX_ISSUES_PER_SERVER);
		expect([...m.issues.keys()].some((key) => key.startsWith("x"))).toBe(false);
	});
});
