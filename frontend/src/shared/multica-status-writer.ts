// Pure rules for writing AO session progress to a Multica issue's status. No
// Electron, DOM, file or network access: the main process feeds it facts and
// acts on the answer, so every rule here is unit-testable.
//
// Two steps. `mapSessionToTarget` / `aggregateTargets` turn AO's delivery facts
// into the status AO would like the issue to show (the mapping table in docs/multica-desktop-embed.md).
// `decideStatusWrite` compares that with what Multica currently shows and says
// whether to write, stay quiet, pause for this issue, or refuse.

/** The only statuses AO ever writes. Never `backlog`, `todo`, `blocked` or `cancelled`. */
export const MULTICA_WRITABLE_STATUSES = ["in_progress", "in_review", "done"] as const;
export type MulticaWritableStatus = (typeof MULTICA_WRITABLE_STATUSES)[number];

export function isMulticaWritableStatus(value: unknown): value is MulticaWritableStatus {
	return typeof value === "string" && (MULTICA_WRITABLE_STATUSES as readonly string[]).includes(value);
}

export const SYNC_KANBAN_COLUMNS = ["building", "validating", "needs_review", "ready", "archive"] as const;
export type SyncKanbanColumn = (typeof SYNC_KANBAN_COLUMNS)[number];
export const SYNC_PR_STATES = ["draft", "open", "merged", "closed"] as const;
export type SyncPrState = (typeof SYNC_PR_STATES)[number];
export const SYNC_ACTIVITIES = ["active", "idle", "waiting_input", "blocked", "exited", "unknown"] as const;
export type SyncActivity = (typeof SYNC_ACTIVITIES)[number];
export const SYNC_PROVISIONING = ["provisioning", "ready", "failed"] as const;
export type SyncProvisioning = (typeof SYNC_PROVISIONING)[number];

/** What the mapper needs to know about one AO session; derived by the daemon, never persisted. */
export type SyncSessionFacts = {
	sessionId: string;
	provisioning: SyncProvisioning;
	column: SyncKanbanColumn;
	activity: SyncActivity;
	terminated: boolean;
	prs: SyncPrState[];
};

export type SessionTarget = {
	target: MulticaWritableStatus | null;
	/** Row of the mapping table in docs/multica-desktop-embed.md that decided it. */
	row: number;
};

function openPrCount(prs: readonly SyncPrState[]): number {
	return prs.filter((state) => state === "open" || state === "draft").length;
}

function allMerged(prs: readonly SyncPrState[]): boolean {
	return prs.length > 0 && prs.every((state) => state === "merged");
}

function activityTarget(facts: SyncSessionFacts): SessionTarget {
	switch (facts.activity) {
		case "active":
			return { target: "in_progress", row: 3 };
		case "idle":
			return { target: null, row: 4 };
		case "waiting_input":
		case "blocked":
			// Multica's `blocked` means an external dependency; AO never writes it.
			return { target: null, row: 5 };
		default:
			return { target: null, row: 6 };
	}
}

/** The status one session alone would put on its issue. Rows 2 to 13 of the mapping table. */
export function mapSessionToTarget(facts: SyncSessionFacts): SessionTarget {
	if (facts.provisioning !== "ready") return { target: null, row: 2 };
	// Every PR merged finishes the issue, whether or not the session was already torn down (rows 10 and 13).
	if (allMerged(facts.prs)) return { target: "done", row: facts.terminated ? 13 : 10 };
	if (facts.terminated) return { target: null, row: 12 };
	if (facts.prs.length > 0 && openPrCount(facts.prs) === 0) return { target: null, row: 11 };
	if (openPrCount(facts.prs) > 0) {
		switch (facts.column) {
			case "validating":
				return { target: "in_progress", row: 7 };
			case "needs_review":
				return { target: "in_review", row: 8 };
			case "ready":
				return { target: "in_review", row: 9 };
			default:
				return activityTarget(facts);
		}
	}
	return activityTarget(facts);
}

// AO's own ranking of boards (backend/pkg/contract/kanban.go kanbanPriority): the session whose
// next step is closest to a person wins.
const COLUMN_PRIORITY: Record<SyncKanbanColumn, number> = { ready: 0, needs_review: 1, validating: 2, building: 3, archive: 4 };

export type AggregateTarget = SessionTarget & {
	/** The session that decided, or null when there is none (row 1). */
	sessionId: string | null;
};

/**
 * Several sessions can be linked to one issue (row 15). The most actionable live
 * session decides; ended sessions count only when nothing is live, and then
 * only to carry a merge to `done`.
 */
export function aggregateTargets(sessions: readonly SyncSessionFacts[]): AggregateTarget {
	if (sessions.length === 0) return { target: null, row: 1, sessionId: null };
	const live = sessions.filter((session) => !session.terminated);
	if (live.length > 0) {
		const ranked = live
			.map((session) => ({ session, mapped: mapSessionToTarget(session) }))
			.sort((left, right) => {
				// A live session with something to say outranks one with nothing to say (a closed PR in `ready`, say),
				// so it cannot hide an active worker; then AO's own board ranking decides.
				if ((left.mapped.target === null) !== (right.mapped.target === null)) return left.mapped.target === null ? 1 : -1;
				const priority = COLUMN_PRIORITY[left.session.column] - COLUMN_PRIORITY[right.session.column];
				if (priority !== 0) return priority;
				return left.session.sessionId < right.session.sessionId ? -1 : left.session.sessionId > right.session.sessionId ? 1 : 0;
			});
		const winner = ranked[0];
		return { ...winner.mapped, sessionId: winner.session.sessionId };
	}
	const finished = sessions
		.map((session) => ({ session, mapped: mapSessionToTarget(session) }))
		.filter((entry) => entry.mapped.target === "done")
		.sort((left, right) => (left.session.sessionId < right.session.sessionId ? -1 : 1));
	if (finished.length > 0) return { ...finished[0].mapped, sessionId: finished[0].session.sessionId };
	return { target: null, row: 12, sessionId: sessions[0].sessionId };
}

// --- Compare and decide -----------------------------------------------------

export const MULTICA_STATUS_CATEGORIES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
export type MulticaStatusCategory = (typeof MULTICA_STATUS_CATEGORIES)[number];

export function isMulticaStatusCategory(value: unknown): value is MulticaStatusCategory {
	return typeof value === "string" && (MULTICA_STATUS_CATEGORIES as readonly string[]).includes(value);
}

/** What the last read of the issue returned, projected to the fields the rules need. */
export type MulticaIssueObservation = {
	id: string;
	workspaceId: string;
	identifier: string;
	/** The status key (a custom status keeps its own key). */
	status: string;
	/** The built-in category the status belongs to; for a built-in it equals the key. */
	category: string;
	revision: number;
	assigneeType: string | null;
	/** True when the issue JSON carries a non-null `triage_state`. Multica's issue JSON has no such field today. */
	inTriage: boolean;
	/** The parent issue's UUID when this is a sub-issue. Completing a sub-issue runs the parent's sub-issue rules in Multica. */
	parentIssueId?: string | null;
};

/** The status AO last wrote, or last saw and agreed with. Anything else seen later is someone else's change. */
export type LastKnownStatus = {
	status: string;
	category: string;
	revision: number;
	source: "write" | "observed";
	at: string;
};

export type PauseReason = "changed_in_multica" | "closed_in_multica" | "blocked_in_multica";
export type RefusalReason = "driven_by_multica" | "triage";

export type StatusDecision =
	| { action: "none"; reason: "no_target" | "agrees" | "forward_only" | "backlog_not_moved" }
	| { action: "write"; status: MulticaWritableStatus; fromBacklog: boolean }
	| { action: "pause"; reason: PauseReason }
	| { action: "refuse"; reason: RefusalReason };

const DELIVERY_RANK: Partial<Record<MulticaStatusCategory, number>> = { backlog: 0, todo: 1, in_progress: 2, in_review: 3, done: 4 };

function rankOf(status: MulticaWritableStatus): number {
	return DELIVERY_RANK[status] ?? 0;
}

function pauseReasonFor(category: string): PauseReason {
	if (category === "done" || category === "cancelled") return "closed_in_multica";
	if (category === "blocked") return "blocked_in_multica";
	return "changed_in_multica";
}

export type DecideStatusWriteInput = {
	target: MulticaWritableStatus | null;
	current: MulticaIssueObservation;
	lastKnown: LastKnownStatus | null;
	/** Starting a session on a Backlog issue moves it forward (answer Q1 in the docs). */
	moveOutOfBacklog: boolean;
	/** The user confirmed reopening a closed or blocked issue; consumed by one write. */
	reopenConfirmed: boolean;
};

/**
 * Rules in order: refuse an issue that Multica drives (row 16); say nothing
 * without a target; agree when Multica already shows it; pause when someone
 * else moved the card away from what AO last knew (row 17); otherwise write
 * forward only. A closed issue (`done`, `cancelled`) and a `blocked` one are
 * never written without the user's confirmed reopen.
 */
export function decideStatusWrite(input: DecideStatusWriteInput): StatusDecision {
	const { target, current, lastKnown } = input;
	// An agent or squad owns the status of its issue, and Multica itself resets
	// `in_progress` to `todo` after a failed run. AO stays out (row 16).
	if (current.assigneeType === "agent" || current.assigneeType === "squad") return { action: "refuse", reason: "driven_by_multica" };
	// Triage is not a status in Multica (the key is reserved), but refuse if a status or category ever says so.
	if (current.inTriage || current.status === "triage" || current.category === "triage") return { action: "refuse", reason: "triage" };
	if (target === null) return { action: "none", reason: "no_target" };

	const category = current.category;
	if (!isMulticaStatusCategory(category)) return { action: "pause", reason: "changed_in_multica" };
	if (category === target) return { action: "none", reason: "agrees" };

	if (lastKnown !== null && category !== lastKnown.category) {
		if (input.reopenConfirmed && (category === "done" || category === "cancelled" || category === "blocked")) {
			return { action: "write", status: target, fromBacklog: false };
		}
		return { action: "pause", reason: pauseReasonFor(category) };
	}

	if (category === "done" || category === "cancelled" || category === "blocked") {
		if (input.reopenConfirmed) return { action: "write", status: target, fromBacklog: false };
		return { action: "pause", reason: pauseReasonFor(category) };
	}
	if (category === "backlog") {
		return input.moveOutOfBacklog ? { action: "write", status: target, fromBacklog: true } : { action: "none", reason: "backlog_not_moved" };
	}
	if (category === "todo") return { action: "write", status: target, fromBacklog: false };
	// in_progress or in_review: forward only.
	return rankOf(target) > (DELIVERY_RANK[category] ?? 0) ? { action: "write", status: target, fromBacklog: false } : { action: "none", reason: "forward_only" };
}

/**
 * True when an observation of the issue is AO's own write coming back: the same
 * status, and no revision newer than the one AO's write returned. A personal
 * token writes as the member, so the actor cannot tell AO's echo from the
 * user's clicks; the value and revision can.
 */
export function isOwnEcho(
	observation: Pick<MulticaIssueObservation, "category" | "revision">,
	lastKnown: LastKnownStatus | null,
): boolean {
	return lastKnown !== null && lastKnown.source === "write" && observation.category === lastKnown.category && observation.revision <= lastKnown.revision;
}
