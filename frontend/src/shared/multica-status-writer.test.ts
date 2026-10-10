import { describe, expect, it } from "vitest";
import {
	aggregateTargets,
	decideStatusWrite,
	isMulticaWritableStatus,
	isOwnEcho,
	mapSessionToTarget,
	MULTICA_STATUS_CATEGORIES,
	MULTICA_WRITABLE_STATUSES,
	SYNC_ACTIVITIES,
	SYNC_KANBAN_COLUMNS,
	SYNC_PROVISIONING,
	type LastKnownStatus,
	type MulticaIssueObservation,
	type SyncPrState,
	type SyncSessionFacts,
} from "./multica-status-writer";

function facts(overrides: Partial<SyncSessionFacts> = {}): SyncSessionFacts {
	return {
		sessionId: "s-1",
		provisioning: "ready",
		column: "building",
		activity: "active",
		terminated: false,
		prs: [],
		...overrides,
	};
}

function issue(overrides: Partial<MulticaIssueObservation> = {}): MulticaIssueObservation {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		workspaceId: "22222222-2222-4222-8222-222222222222",
		identifier: "MUL-1",
		status: "todo",
		category: "todo",
		revision: 4,
		assigneeType: "member",
		inTriage: false,
		...overrides,
	};
}

function known(status: string, overrides: Partial<LastKnownStatus> = {}): LastKnownStatus {
	return { status, category: status, revision: 5, source: "write", at: "2026-10-10T10:00:00.000Z", ...overrides };
}

const decide = (overrides: Partial<Parameters<typeof decideStatusWrite>[0]> = {}) =>
	decideStatusWrite({ target: "in_progress", current: issue(), lastKnown: null, moveOutOfBacklog: true, reopenConfirmed: false, ...overrides });

describe("mapping table rows 1 to 13 (one session)", () => {
	it("row 2: provisioning or failed provisioning writes nothing", () => {
		expect(mapSessionToTarget(facts({ provisioning: "provisioning" }))).toEqual({ target: null, row: 2 });
		expect(mapSessionToTarget(facts({ provisioning: "failed" }))).toEqual({ target: null, row: 2 });
	});

	it("row 3: an active worker with no PR is in progress", () => {
		expect(mapSessionToTarget(facts({ activity: "active" }))).toEqual({ target: "in_progress", row: 3 });
	});

	it("row 4: an idle worker with no PR writes nothing", () => {
		expect(mapSessionToTarget(facts({ activity: "idle" }))).toEqual({ target: null, row: 4 });
	});

	it("row 5: needs input or blocked never writes blocked, or anything", () => {
		expect(mapSessionToTarget(facts({ activity: "waiting_input" }))).toEqual({ target: null, row: 5 });
		expect(mapSessionToTarget(facts({ activity: "blocked" }))).toEqual({ target: null, row: 5 });
	});

	it("row 6: exited or no signal is a technical state, not a delivery fact", () => {
		expect(mapSessionToTarget(facts({ activity: "exited" }))).toEqual({ target: null, row: 6 });
		expect(mapSessionToTarget(facts({ activity: "unknown" }))).toEqual({ target: null, row: 6 });
	});

	it("row 7: an open PR in the validating column (AO still turns the loop) is in progress", () => {
		expect(mapSessionToTarget(facts({ column: "validating", prs: ["open"] }))).toEqual({ target: "in_progress", row: 7 });
		expect(mapSessionToTarget(facts({ column: "validating", prs: ["draft"] }))).toEqual({ target: "in_progress", row: 7 });
	});

	it("row 8: an open PR waiting on a person is in review", () => {
		expect(mapSessionToTarget(facts({ column: "needs_review", prs: ["open"] }))).toEqual({ target: "in_review", row: 8 });
	});

	it("row 9: an approved or mergeable PR stays in review until it is merged", () => {
		expect(mapSessionToTarget(facts({ column: "ready", prs: ["open"] }))).toEqual({ target: "in_review", row: 9 });
	});

	it("row 10: every PR merged finishes the issue, even while the session is alive", () => {
		expect(mapSessionToTarget(facts({ column: "ready", prs: ["merged"] }))).toEqual({ target: "done", row: 10 });
		expect(mapSessionToTarget(facts({ column: "ready", prs: ["merged", "merged"] }))).toEqual({ target: "done", row: 10 });
	});

	it("row 10: one merged PR beside an open one is not done", () => {
		expect(mapSessionToTarget(facts({ column: "validating", prs: ["merged", "open"] })).target).toBe("in_progress");
	});

	it("row 11: a PR closed without merging, with the session alive, writes nothing", () => {
		expect(mapSessionToTarget(facts({ column: "ready", prs: ["closed"] }))).toEqual({ target: null, row: 11 });
		expect(mapSessionToTarget(facts({ column: "ready", prs: ["merged", "closed"] }))).toEqual({ target: null, row: 11 });
	});

	it("row 12: a terminated session with no PR writes nothing", () => {
		expect(mapSessionToTarget(facts({ terminated: true, column: "archive" }))).toEqual({ target: null, row: 12 });
		expect(mapSessionToTarget(facts({ terminated: true, column: "archive", prs: ["closed"] }))).toEqual({ target: null, row: 12 });
	});

	it("row 13: a terminated session whose PR merged is done", () => {
		expect(mapSessionToTarget(facts({ terminated: true, column: "archive", prs: ["merged"] }))).toEqual({ target: "done", row: 13 });
	});

	it("never maps to anything outside the writable statuses, over every combination of facts", () => {
		const prSets: SyncPrState[][] = [[], ["open"], ["draft"], ["merged"], ["closed"], ["merged", "open"], ["merged", "closed"], ["open", "closed"]];
		for (const provisioning of SYNC_PROVISIONING) {
			for (const column of SYNC_KANBAN_COLUMNS) {
				for (const activity of SYNC_ACTIVITIES) {
					for (const terminated of [false, true]) {
						for (const prs of prSets) {
							const { target } = mapSessionToTarget(facts({ provisioning, column, activity, terminated, prs }));
							expect(target === null || (MULTICA_WRITABLE_STATUSES as readonly string[]).includes(target)).toBe(true);
							expect(target).not.toBe("backlog");
							expect(target).not.toBe("todo");
							expect(target).not.toBe("blocked");
							expect(target).not.toBe("cancelled");
						}
					}
				}
			}
		}
	});
});

describe("mapping table rows 1 and 15 (several sessions)", () => {
	it("row 1: no linked session writes nothing", () => {
		expect(aggregateTargets([])).toEqual({ target: null, row: 1, sessionId: null });
	});

	it("row 15: the most actionable live session decides, by AO's board ranking", () => {
		const result = aggregateTargets([
			facts({ sessionId: "a", column: "building", activity: "active" }),
			facts({ sessionId: "b", column: "needs_review", prs: ["open"] }),
			facts({ sessionId: "c", column: "validating", prs: ["open"] }),
		]);
		expect(result).toEqual({ target: "in_review", row: 8, sessionId: "b" });
	});

	it("row 15: ended sessions are ignored while another one is live", () => {
		const result = aggregateTargets([
			facts({ sessionId: "old", terminated: true, column: "archive", prs: ["merged"] }),
			facts({ sessionId: "new", column: "building", activity: "active" }),
		]);
		expect(result).toEqual({ target: "in_progress", row: 3, sessionId: "new" });
	});

	it("row 15: when every session has ended, a merge still produces done", () => {
		const result = aggregateTargets([
			facts({ sessionId: "a", terminated: true, column: "archive" }),
			facts({ sessionId: "b", terminated: true, column: "archive", prs: ["merged"] }),
		]);
		expect(result).toEqual({ target: "done", row: 13, sessionId: "b" });
	});

	it("row 15: when every session has ended without a merge nothing is written", () => {
		const result = aggregateTargets([facts({ sessionId: "a", terminated: true, column: "archive" })]);
		expect(result.target).toBeNull();
	});

	it("row 15: equal rank prefers a session that has something to say, then the lower id", () => {
		const result = aggregateTargets([
			facts({ sessionId: "a", column: "building", activity: "idle" }),
			facts({ sessionId: "b", column: "building", activity: "active" }),
		]);
		expect(result.sessionId).toBe("b");
	});
});

describe("decideStatusWrite", () => {
	it("writes a status forward from todo", () => {
		expect(decide({ current: issue({ status: "todo", category: "todo" }) })).toEqual({ action: "write", status: "in_progress", fromBacklog: false });
	});

	it("decision Q1: moves an issue out of backlog, and says so", () => {
		expect(decide({ current: issue({ status: "backlog", category: "backlog" }) })).toEqual({ action: "write", status: "in_progress", fromBacklog: true });
	});

	it("leaves backlog alone when the user turned the move off", () => {
		expect(decide({ current: issue({ status: "backlog", category: "backlog" }), moveOutOfBacklog: false })).toEqual({
			action: "none",
			reason: "backlog_not_moved",
		});
	});

	it("is quiet when Multica already shows the target", () => {
		expect(decide({ current: issue({ status: "in_progress", category: "in_progress" }) })).toEqual({ action: "none", reason: "agrees" });
	});

	it("agrees by category: a custom status inside the target category is left alone", () => {
		expect(decide({ current: issue({ status: "doing", category: "in_progress" }) })).toEqual({ action: "none", reason: "agrees" });
	});

	it("is quiet when AO has nothing to say", () => {
		expect(decide({ target: null })).toEqual({ action: "none", reason: "no_target" });
	});

	it("is forward only: never writes a status behind the one shown", () => {
		expect(decide({ target: "in_progress", current: issue({ status: "in_review", category: "in_review" }) })).toEqual({
			action: "none",
			reason: "forward_only",
		});
		expect(decide({ target: "in_review", current: issue({ status: "in_review", category: "in_review" }), lastKnown: known("in_review") }).action).toBe("none");
	});

	it("moves forward from in progress to review and from review to done", () => {
		expect(decide({ target: "in_review", current: issue({ status: "in_progress", category: "in_progress" }), lastKnown: known("in_progress") })).toMatchObject({
			action: "write",
			status: "in_review",
		});
		expect(decide({ target: "done", current: issue({ status: "in_review", category: "in_review" }), lastKnown: known("in_review") })).toMatchObject({
			action: "write",
			status: "done",
		});
	});

	it("done is sticky: a closed issue is never written without a confirmed reopen", () => {
		for (const category of ["done", "cancelled"] as const) {
			expect(decide({ current: issue({ status: category, category }) })).toEqual({ action: "pause", reason: "closed_in_multica" });
			expect(decide({ current: issue({ status: category, category }), lastKnown: known("in_progress") })).toEqual({
				action: "pause",
				reason: "closed_in_multica",
			});
		}
	});

	it("a confirmed reopen writes once from a closed issue (row 14)", () => {
		expect(decide({ current: issue({ status: "done", category: "done" }), reopenConfirmed: true })).toEqual({
			action: "write",
			status: "in_progress",
			fromBacklog: false,
		});
		expect(decide({ current: issue({ status: "done", category: "done" }), lastKnown: known("done"), reopenConfirmed: true }).action).toBe("write");
	});

	it("never writes over blocked, which a person set, unless the reopen is confirmed", () => {
		expect(decide({ current: issue({ status: "blocked", category: "blocked" }) })).toEqual({ action: "pause", reason: "blocked_in_multica" });
		expect(decide({ current: issue({ status: "blocked", category: "blocked" }), reopenConfirmed: true }).action).toBe("write");
	});

	it("row 17: pauses when the status is not the one AO wrote or agreed with", () => {
		expect(decide({ target: "in_review", current: issue({ status: "todo", category: "todo" }), lastKnown: known("in_progress") })).toEqual({
			action: "pause",
			reason: "changed_in_multica",
		});
		expect(decide({ target: "in_review", current: issue({ status: "backlog", category: "backlog" }), lastKnown: known("in_progress") })).toEqual({
			action: "pause",
			reason: "changed_in_multica",
		});
	});

	it("does not pause when the person only moved to a custom status of the same category", () => {
		expect(
			decide({ target: "in_review", current: issue({ status: "doing", category: "in_progress" }), lastKnown: known("in_progress") }),
		).toMatchObject({ action: "write", status: "in_review" });
	});

	it("pauses on a status whose category AO does not know", () => {
		expect(decide({ current: issue({ status: "qa", category: "qa" }) })).toEqual({ action: "pause", reason: "changed_in_multica" });
		expect(decide({ current: issue({ status: "qa", category: "" }) }).action).toBe("pause");
	});

	it("row 16: refuses an issue assigned to a Multica agent or squad, whatever the status", () => {
		for (const assigneeType of ["agent", "squad"]) {
			for (const category of MULTICA_STATUS_CATEGORIES) {
				expect(decide({ current: issue({ assigneeType, status: category, category }) })).toEqual({ action: "refuse", reason: "driven_by_multica" });
			}
		}
		expect(decide({ target: null, current: issue({ assigneeType: "agent" }) }).action).toBe("refuse");
	});

	it("a member or unassigned issue is not refused", () => {
		expect(decide({ current: issue({ assigneeType: "member" }) }).action).toBe("write");
		expect(decide({ current: issue({ assigneeType: null }) }).action).toBe("write");
	});

	it("row 16: refuses an issue in triage", () => {
		expect(decide({ current: issue({ inTriage: true }) })).toEqual({ action: "refuse", reason: "triage" });
	});

	it("writes only statuses from the writable set", () => {
		for (const target of MULTICA_WRITABLE_STATUSES) {
			for (const category of MULTICA_STATUS_CATEGORIES) {
				for (const reopenConfirmed of [false, true]) {
					const decision = decide({ target, current: issue({ status: category, category }), reopenConfirmed });
					if (decision.action === "write") expect(isMulticaWritableStatus(decision.status)).toBe(true);
				}
			}
		}
		expect(isMulticaWritableStatus("todo")).toBe(false);
		expect(isMulticaWritableStatus("backlog")).toBe(false);
		expect(isMulticaWritableStatus("cancelled")).toBe(false);
		expect(isMulticaWritableStatus("blocked")).toBe(false);
	});
});

describe("isOwnEcho", () => {
	it("recognises the same status at a revision no newer than AO's write", () => {
		expect(isOwnEcho({ category: "in_progress", revision: 5 }, known("in_progress", { revision: 5 }))).toBe(true);
		expect(isOwnEcho({ category: "in_progress", revision: 4 }, known("in_progress", { revision: 5 }))).toBe(true);
	});

	it("does not treat a newer revision, a different status or a status AO only observed as its echo", () => {
		expect(isOwnEcho({ category: "in_progress", revision: 6 }, known("in_progress", { revision: 5 }))).toBe(false);
		expect(isOwnEcho({ category: "in_review", revision: 5 }, known("in_progress", { revision: 5 }))).toBe(false);
		expect(isOwnEcho({ category: "in_progress", revision: 5 }, known("in_progress", { source: "observed" }))).toBe(false);
		expect(isOwnEcho({ category: "in_progress", revision: 5 }, null)).toBe(false);
	});
});
