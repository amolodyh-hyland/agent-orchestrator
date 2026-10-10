// Executor derivation for a Multica issue: who is working it right now.
// Pure and stateless: the executor is derived from facts on every change and
// never stored, so it cannot drift. Detection only; nothing here acts on it.

import type { MulticaAssigneeType } from "./multica-awareness";

export type MulticaExecutor = "ao" | "multica-agent" | "human" | "none";

/** What the executor is doing, for the line and the flags. */
export type MulticaExecutorDetail =
	| "orphaned"
	| "running"
	| "assigned_not_running"
	| "parked"
	| "live_session"
	| "you"
	| "other"
	| "unassigned";

/** The four values the UI shows, plus `none` when nobody holds the issue. */
export type MulticaExecutorDisplay = "ao" | "multica-agent" | "human" | "contested" | "none";

export type ExecutorIssueFacts = {
	status: string;
	statusCategory: string;
	assigneeType: MulticaAssigneeType | null;
	assigneeId: string | null;
};

export type ExecutorInput = {
	/** The issue, or null when it was deleted or is out of reach. */
	issue: ExecutorIssueFacts | null;
	/** Agent runs on the issue in an active status (queued, dispatched, running, waiting for a folder). */
	activeRunCount: number;
	/** A non-terminated AO session is linked to the issue. */
	hasLiveAoSession: boolean;
	/** The signed-in Multica user, when known. */
	meId: string | null;
};

export type MulticaExecutorDerivation = {
	executor: MulticaExecutor;
	detail: MulticaExecutorDetail;
	/** A Multica agent holds the issue and a live AO session is linked: a state, never resolved automatically. */
	contested: boolean;
	display: MulticaExecutorDisplay;
};

/** True for a backlog or triage issue: parked work that no agent starts. */
export function isParkedStatus(issue: Pick<ExecutorIssueFacts, "status" | "statusCategory">): boolean {
	return issue.status === "backlog" || issue.statusCategory === "backlog" || issue.status === "triage" || issue.statusCategory === "triage";
}

function isClosedStatus(issue: Pick<ExecutorIssueFacts, "statusCategory" | "status">): boolean {
	return issue.statusCategory === "done" || issue.statusCategory === "cancelled" || issue.status === "done" || issue.status === "cancelled";
}

/**
 * Precedence, first match wins:
 *
 * 1. issue deleted or unreachable: none (orphaned)
 * 2. an active run exists: multica-agent (running)
 * 3. agent or squad assignee, not backlog or triage, no run: multica-agent (assigned, not running)
 * 4. agent or squad assignee, backlog or triage: multica-agent (parked)
 * 5. a live AO session is linked: ao
 * 6. assignee is the signed-in user: human (you)
 * 7. assignee is another member: human (other)
 * 8. unassigned: none
 *
 * `contested` is rows 2, 3 or 4 together with row 5.
 *
 * One refinement of rows 3 and 4: a closed issue (done or cancelled) is not
 * being executed by its assignee, so it does not count as held by an agent.
 * Without it every finished agent issue that a person still inspects in AO
 * would read as contested.
 */
export function deriveMulticaExecutor(input: ExecutorInput): MulticaExecutorDerivation {
	const { issue } = input;
	if (issue === null) return { executor: "none", detail: "orphaned", contested: false, display: "none" };

	const agentAssignee = issue.assigneeType === "agent" || issue.assigneeType === "squad";
	let agentDetail: MulticaExecutorDetail | null = null;
	if (input.activeRunCount > 0) agentDetail = "running";
	else if (agentAssignee && !isClosedStatus(issue)) agentDetail = isParkedStatus(issue) ? "parked" : "assigned_not_running";

	if (agentDetail !== null) {
		const contested = input.hasLiveAoSession;
		return { executor: "multica-agent", detail: agentDetail, contested, display: contested ? "contested" : "multica-agent" };
	}
	if (input.hasLiveAoSession) return { executor: "ao", detail: "live_session", contested: false, display: "ao" };
	if (issue.assigneeType === "member") {
		const you = input.meId !== null && issue.assigneeId === input.meId;
		return { executor: "human", detail: you ? "you" : "other", contested: false, display: "human" };
	}
	return { executor: "none", detail: "unassigned", contested: false, display: "none" };
}

export type MulticaWhoFlag = "contested" | "assigned_not_running" | "parked" | "no_longer_yours" | "orphaned";

/** An agent or squad that has been assigned this long without a run is flagged. */
export const MULTICA_ASSIGNED_NOT_RUNNING_GRACE_MS = 5 * 60 * 1000;

export type WhoFlagInput = ExecutorInput & { updatedAt: string | null; nowMs: number };

/** Flags of the "who is working on what" view. */
export function multicaWhoFlags(input: WhoFlagInput): MulticaWhoFlag[] {
	const derivation = deriveMulticaExecutor(input);
	const flags: MulticaWhoFlag[] = [];
	if (derivation.detail === "orphaned") return ["orphaned"];
	if (derivation.contested) flags.push("contested");
	const { issue } = input;
	if (issue === null) return flags;
	const agentAssignee = issue.assigneeType === "agent" || issue.assigneeType === "squad";
	if (agentAssignee && input.activeRunCount === 0 && !isClosedStatus(issue)) {
		if (isParkedStatus(issue)) {
			flags.push("parked");
		} else if (issue.statusCategory === "todo" || issue.statusCategory === "in_progress" || issue.status === "todo" || issue.status === "in_progress") {
			const updated = input.updatedAt === null ? Number.NaN : Date.parse(input.updatedAt);
			if (Number.isNaN(updated) || input.nowMs - updated > MULTICA_ASSIGNED_NOT_RUNNING_GRACE_MS) flags.push("assigned_not_running");
		}
	}
	if (issue.assigneeType === "member" && input.meId !== null && issue.assigneeId !== input.meId && input.hasLiveAoSession) {
		flags.push("no_longer_yours");
	}
	return flags;
}
