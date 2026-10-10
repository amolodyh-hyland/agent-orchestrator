import { describe, expect, it } from "vitest";
import {
	MULTICA_ASSIGNED_NOT_RUNNING_GRACE_MS,
	deriveMulticaExecutor,
	multicaWhoFlags,
	type ExecutorInput,
	type ExecutorIssueFacts,
} from "./multica-executor";

const ME = "user-me";
const issue = (overrides: Partial<ExecutorIssueFacts> = {}): ExecutorIssueFacts => ({
	status: "todo",
	statusCategory: "todo",
	assigneeType: null,
	assigneeId: null,
	...overrides,
});
const input = (overrides: Partial<ExecutorInput> = {}): ExecutorInput => ({
	issue: issue(),
	activeRunCount: 0,
	hasLiveAoSession: false,
	meId: ME,
	...overrides,
});

describe("deriveMulticaExecutor truth table", () => {
	const rows: Array<{
		name: string;
		given: ExecutorInput;
		executor: string;
		detail: string;
		contested: boolean;
		display: string;
	}> = [
		{ name: "1 deleted or unreachable issue", given: input({ issue: null }), executor: "none", detail: "orphaned", contested: false, display: "none" },
		{ name: "1 deleted issue wins over a live session", given: input({ issue: null, hasLiveAoSession: true }), executor: "none", detail: "orphaned", contested: false, display: "none" },
		{ name: "2 active run, agent assignee", given: input({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), activeRunCount: 1 }), executor: "multica-agent", detail: "running", contested: false, display: "multica-agent" },
		{ name: "2 active run, squad leader run", given: input({ issue: issue({ assigneeType: "squad", assigneeId: "sq" }), activeRunCount: 2 }), executor: "multica-agent", detail: "running", contested: false, display: "multica-agent" },
		{ name: "2 active run on an unassigned issue (autopilot)", given: input({ activeRunCount: 1 }), executor: "multica-agent", detail: "running", contested: false, display: "multica-agent" },
		{ name: "2 active run on a member's issue", given: input({ issue: issue({ assigneeType: "member", assigneeId: ME }), activeRunCount: 1 }), executor: "multica-agent", detail: "running", contested: false, display: "multica-agent" },
		{ name: "3 agent assigned, todo, no run", given: input({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }) }), executor: "multica-agent", detail: "assigned_not_running", contested: false, display: "multica-agent" },
		{ name: "3 squad assigned, in progress, no run", given: input({ issue: issue({ status: "in_progress", statusCategory: "in_progress", assigneeType: "squad", assigneeId: "sq" }) }), executor: "multica-agent", detail: "assigned_not_running", contested: false, display: "multica-agent" },
		{ name: "4 agent assigned, backlog", given: input({ issue: issue({ status: "backlog", statusCategory: "backlog", assigneeType: "agent", assigneeId: "a1" }) }), executor: "multica-agent", detail: "parked", contested: false, display: "multica-agent" },
		{ name: "4 squad assigned, triage key", given: input({ issue: issue({ status: "triage", statusCategory: "backlog", assigneeType: "squad", assigneeId: "sq" }) }), executor: "multica-agent", detail: "parked", contested: false, display: "multica-agent" },
		{ name: "4 custom status in the backlog category", given: input({ issue: issue({ status: "icebox", statusCategory: "backlog", assigneeType: "agent", assigneeId: "a1" }) }), executor: "multica-agent", detail: "parked", contested: false, display: "multica-agent" },
		{ name: "5 live AO session on an unassigned issue", given: input({ hasLiveAoSession: true }), executor: "ao", detail: "live_session", contested: false, display: "ao" },
		{ name: "5 live AO session on my issue", given: input({ issue: issue({ assigneeType: "member", assigneeId: ME }), hasLiveAoSession: true }), executor: "ao", detail: "live_session", contested: false, display: "ao" },
		{ name: "5 live AO session, issue assigned to another member", given: input({ issue: issue({ assigneeType: "member", assigneeId: "other" }), hasLiveAoSession: true }), executor: "ao", detail: "live_session", contested: false, display: "ao" },
		{ name: "6 assigned to me", given: input({ issue: issue({ assigneeType: "member", assigneeId: ME }) }), executor: "human", detail: "you", contested: false, display: "human" },
		{ name: "7 assigned to another member", given: input({ issue: issue({ assigneeType: "member", assigneeId: "other" }) }), executor: "human", detail: "other", contested: false, display: "human" },
		{ name: "7 signed-in user unknown", given: input({ issue: issue({ assigneeType: "member", assigneeId: ME }), meId: null }), executor: "human", detail: "other", contested: false, display: "human" },
		{ name: "8 unassigned", given: input(), executor: "none", detail: "unassigned", contested: false, display: "none" },
		{ name: "contested: run plus live session", given: input({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), activeRunCount: 1, hasLiveAoSession: true }), executor: "multica-agent", detail: "running", contested: true, display: "contested" },
		{ name: "contested: assigned agent, no run, live session", given: input({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), hasLiveAoSession: true }), executor: "multica-agent", detail: "assigned_not_running", contested: true, display: "contested" },
		{ name: "contested: parked agent issue, live session", given: input({ issue: issue({ status: "backlog", statusCategory: "backlog", assigneeType: "agent", assigneeId: "a1" }), hasLiveAoSession: true }), executor: "multica-agent", detail: "parked", contested: true, display: "contested" },
		{ name: "closed issue: finished agent issue is not held by the agent", given: input({ issue: issue({ status: "done", statusCategory: "done", assigneeType: "agent", assigneeId: "a1" }), hasLiveAoSession: true }), executor: "ao", detail: "live_session", contested: false, display: "ao" },
		{ name: "closed issue: cancelled agent issue, no session", given: input({ issue: issue({ status: "cancelled", statusCategory: "cancelled", assigneeType: "agent", assigneeId: "a1" }) }), executor: "none", detail: "unassigned", contested: false, display: "none" },
		{ name: "closed issue with an active run is still held by the agent", given: input({ issue: issue({ status: "done", statusCategory: "done", assigneeType: "agent", assigneeId: "a1" }), activeRunCount: 1 }), executor: "multica-agent", detail: "running", contested: false, display: "multica-agent" },
	];

	for (const row of rows) {
		it(row.name, () => {
			expect(deriveMulticaExecutor(row.given)).toEqual({
				executor: row.executor,
				detail: row.detail,
				contested: row.contested,
				display: row.display,
			});
		});
	}

	it("never reports an executor of ao while an agent holds the issue", () => {
		for (const assigneeType of ["agent", "squad"] as const) {
			for (const status of ["backlog", "todo", "in_progress", "in_review"]) {
				const result = deriveMulticaExecutor(
					input({ issue: issue({ status, statusCategory: status, assigneeType, assigneeId: "x" }), hasLiveAoSession: true }),
				);
				expect(result.executor).toBe("multica-agent");
				expect(result.contested).toBe(true);
			}
		}
	});
});

describe("multicaWhoFlags", () => {
	const nowMs = Date.parse("2026-10-10T12:00:00Z");
	const old = new Date(nowMs - MULTICA_ASSIGNED_NOT_RUNNING_GRACE_MS - 1000).toISOString();
	const fresh = new Date(nowMs - 60 * 1000).toISOString();
	const flags = (given: Partial<ExecutorInput>, updatedAt: string | null = old) => multicaWhoFlags({ ...input(given), updatedAt, nowMs });

	it("flags an orphaned issue and nothing else", () => {
		expect(flags({ issue: null, hasLiveAoSession: true })).toEqual(["orphaned"]);
	});

	it("flags contested", () => {
		expect(flags({ issue: issue({ assigneeType: "agent", assigneeId: "a" }), activeRunCount: 1, hasLiveAoSession: true })).toContain("contested");
	});

	it("flags assigned-not-running only after five minutes and only for todo or in progress", () => {
		const agent = issue({ assigneeType: "agent", assigneeId: "a" });
		expect(flags({ issue: agent })).toEqual(["assigned_not_running"]);
		expect(flags({ issue: agent }, fresh)).toEqual([]);
		expect(flags({ issue: issue({ status: "in_progress", statusCategory: "in_progress", assigneeType: "squad", assigneeId: "s" }) })).toEqual(["assigned_not_running"]);
		expect(flags({ issue: issue({ status: "in_review", statusCategory: "in_review", assigneeType: "agent", assigneeId: "a" }) })).toEqual([]);
		expect(flags({ issue: agent, activeRunCount: 1 })).toEqual([]);
	});

	it("flags parked", () => {
		expect(flags({ issue: issue({ status: "backlog", statusCategory: "backlog", assigneeType: "agent", assigneeId: "a" }) })).toEqual(["parked"]);
		expect(flags({ issue: issue({ status: "backlog", statusCategory: "backlog" }) })).toEqual([]);
	});

	it("flags no-longer-yours when the issue moved to another member while a session is live", () => {
		expect(flags({ issue: issue({ assigneeType: "member", assigneeId: "other" }), hasLiveAoSession: true })).toEqual(["no_longer_yours"]);
		expect(flags({ issue: issue({ assigneeType: "member", assigneeId: ME }), hasLiveAoSession: true })).toEqual([]);
		expect(flags({ issue: issue({ assigneeType: "member", assigneeId: "other" }) })).toEqual([]);
	});
});
