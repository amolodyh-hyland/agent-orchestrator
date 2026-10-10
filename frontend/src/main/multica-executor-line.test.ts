import { describe, expect, it } from "vitest";
import type { AwarenessIssue, AwarenessRun } from "../shared/multica-awareness";
import type { AwarenessIssueLookup } from "./multica-awareness";
import { buildExecutorLine } from "./multica-executor-line";

const issue = (overrides: Partial<AwarenessIssue> = {}): AwarenessIssue => ({
	id: "i1",
	workspaceId: "w1",
	identifier: "MUL-1",
	title: "t",
	status: "todo",
	statusCategory: "todo",
	assigneeType: null,
	assigneeId: null,
	parentIssueId: null,
	projectId: null,
	revision: 1,
	updatedAt: "2026-10-10T10:00:00Z",
	...overrides,
});
const run = (): AwarenessRun => ({
	id: "t1",
	workspaceId: "w1",
	issueId: "i1",
	agentId: "a1",
	status: "running",
	failureReason: null,
	retryPending: false,
	outcomeUnknown: false,
	startedAt: null,
	endedAt: null,
	isLeaderTask: false,
	autopilotRunId: null,
	parentTaskId: null,
	runtimeId: null,
});
const lookup = (overrides: Partial<AwarenessIssueLookup> = {}): AwarenessIssueLookup => ({ issue: issue(), activeRuns: [], agentNames: [], meId: "me", ...overrides });
const session = { label: "Fix the board", stateLabel: "Working" };

describe("buildExecutorLine", () => {
	it("says nothing when awareness does not know the issue", () => {
		expect(buildExecutorLine({ lookup: null, liveSessions: [session] })).toBeNull();
	});

	it("says nothing when nobody holds the issue", () => {
		expect(buildExecutorLine({ lookup: lookup(), liveSessions: [] })).toBeNull();
	});

	it("names the Multica agent that is running", () => {
		expect(
			buildExecutorLine({ lookup: lookup({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), activeRuns: [run()], agentNames: ["Builder"] }), liveSessions: [] }),
		).toEqual({ display: "multica-agent", text: "Run by: Multica agent Builder, running" });
	});

	it("describes an assigned agent without a run and a parked one", () => {
		expect(buildExecutorLine({ lookup: lookup({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), agentNames: ["Builder"] }), liveSessions: [] })?.text).toBe(
			"Run by: Multica agent Builder, assigned, not running",
		);
		expect(
			buildExecutorLine({ lookup: lookup({ issue: issue({ status: "backlog", statusCategory: "backlog", assigneeType: "squad", assigneeId: "s1" }) }), liveSessions: [] })?.text,
		).toBe("Run by: a Multica squad, parked in the backlog");
	});

	it("names the AO session", () => {
		expect(buildExecutorLine({ lookup: lookup(), liveSessions: [session, { label: "Second", stateLabel: "Idle" }] })).toEqual({
			display: "ao",
			text: "Run by: AO session Fix the board, Working +1 more",
		});
	});

	it("says you or another member", () => {
		expect(buildExecutorLine({ lookup: lookup({ issue: issue({ assigneeType: "member", assigneeId: "me" }) }), liveSessions: [] })).toEqual({ display: "human", text: "Run by: you" });
		expect(buildExecutorLine({ lookup: lookup({ issue: issue({ assigneeType: "member", assigneeId: "other" }) }), liveSessions: [] })).toEqual({
			display: "human",
			text: "Run by: another member",
		});
	});

	it("reports contested when a Multica agent and a live AO session both hold the issue", () => {
		expect(
			buildExecutorLine({ lookup: lookup({ issue: issue({ assigneeType: "agent", assigneeId: "a1" }), activeRuns: [run()], agentNames: ["Builder"] }), liveSessions: [session] }),
		).toEqual({ display: "contested", text: "Contested: a Multica agent and an AO session both hold this issue" });
	});

	it("keeps control characters and long names out of the line", () => {
		const long = "x".repeat(300);
		const line = buildExecutorLine({ lookup: lookup(), liveSessions: [{ label: `a\nb\u0007${long}`, stateLabel: "Working" }] });
		expect(line?.text).not.toMatch(/[\u0000-\u001F]/);
		expect(Array.from(line?.text ?? "").length).toBeLessThanOrEqual(160);
	});
});
