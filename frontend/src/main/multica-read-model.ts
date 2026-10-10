// In-memory read model of one Multica server: issues, agent task runs, agents
// and runtimes, plus the pure reducers that keep it current from WebSocket
// frames and REST snapshots. Nothing here does I/O.
//
// Projection happens at the parse boundary. A response or frame carries far
// more than AO keeps (descriptions, comments, task results and errors, the
// working directory, trigger comment text), and none of that is read: only the
// listed fields are copied out and the raw value is dropped.

import {
	MULTICA_MAX_ISSUES_PER_SERVER,
	MULTICA_MAX_RUNS_PER_SERVER,
	MULTICA_TASK_STATUS_RANK,
	MULTICA_TITLE_MAX,
	isActiveMulticaTaskStatus,
	isMulticaTaskStatus,
	type AwarenessAgent,
	type AwarenessIssue,
	type AwarenessRun,
	type AwarenessRuntime,
	type MulticaAssigneeType,
	type MulticaTaskStatus,
} from "../shared/multica-awareness";

export type ServerModel = {
	issues: Map<string, AwarenessIssue>;
	runs: Map<string, AwarenessRun>;
	agents: Map<string, AwarenessAgent>;
	runtimes: Map<string, AwarenessRuntime>;
	/** Issues that were deleted while watched, newest last: a link to one of them is orphaned. */
	deleted: Map<string, { workspaceId: string; identifier: string }>;
};

export const MULTICA_MAX_DELETED_ISSUES = 200;

export function createServerModel(): ServerModel {
	return { issues: new Map(), runs: new Map(), agents: new Map(), runtimes: new Map(), deleted: new Map() };
}

// Projection

const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]", "g");

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	return Array.from(value.replace(CONTROL_CHARACTERS, " ")).slice(0, max).join("");
}

function id(value: unknown): string | null {
	const result = text(value, 80);
	return result !== null && result.length > 0 && result === value ? result : null;
}

function optionalId(value: unknown): string | null {
	return id(value);
}

function assigneeType(value: unknown): MulticaAssigneeType | null {
	return value === "member" || value === "agent" || value === "squad" ? value : null;
}

/** Copies the kept fields of an issue; null when it is not a usable issue. */
export function projectIssue(raw: unknown, fallbackWorkspaceId?: string): AwarenessIssue | null {
	if (!isRecord(raw)) return null;
	const issueId = id(raw.id);
	const workspaceId = id(raw.workspace_id) ?? fallbackWorkspaceId ?? null;
	const identifier = text(raw.identifier, 40);
	const title = text(raw.title, MULTICA_TITLE_MAX);
	const status = text(raw.status, 80);
	if (!issueId || !workspaceId || !identifier || title === null || !status) return null;
	const type = assigneeType(raw.assignee_type);
	return {
		id: issueId,
		workspaceId,
		identifier,
		title,
		status,
		statusCategory: text(raw.status_category, 40) ?? "",
		assigneeType: type,
		assigneeId: type === null ? null : optionalId(raw.assignee_id),
		parentIssueId: optionalId(raw.parent_issue_id),
		projectId: optionalId(raw.project_id),
		revision: typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
		updatedAt: text(raw.updated_at, 40) ?? "",
	};
}

function timestamp(value: unknown): string | null {
	const result = text(value, 40);
	return result !== null && result.length > 0 ? result : null;
}

/** Copies the kept fields of a REST task object. Chat tasks (no issue) are not runs and return null. */
export function projectRun(raw: unknown, fallbackWorkspaceId: string | undefined, nowIso: string): AwarenessRun | null {
	if (!isRecord(raw)) return null;
	const runId = id(raw.id);
	const issueId = id(raw.issue_id);
	const agentId = id(raw.agent_id);
	const workspaceId = id(raw.workspace_id) ?? fallbackWorkspaceId ?? null;
	if (!runId || !issueId || !agentId || !workspaceId || !isMulticaTaskStatus(raw.status)) return null;
	const status = raw.status;
	const terminal = !isActiveMulticaTaskStatus(status) && status !== "deferred";
	return {
		id: runId,
		workspaceId,
		issueId,
		agentId,
		status,
		failureReason: text(raw.failure_reason, 60) || null,
		retryPending: raw.retry_pending === true,
		outcomeUnknown: false,
		startedAt: timestamp(raw.started_at),
		endedAt: timestamp(raw.completed_at) ?? (terminal ? nowIso : null),
		isLeaderTask: raw.is_leader_task === true,
		autopilotRunId: optionalId(raw.autopilot_run_id),
		parentTaskId: optionalId(raw.parent_task_id),
		runtimeId: optionalId(raw.runtime_id),
	};
}

export function projectAgent(raw: unknown, fallbackWorkspaceId?: string): AwarenessAgent | null {
	if (!isRecord(raw)) return null;
	const agentId = id(raw.id);
	const workspaceId = id(raw.workspace_id) ?? fallbackWorkspaceId ?? null;
	const name = text(raw.name, 100);
	if (!agentId || !workspaceId || !name) return null;
	return { id: agentId, workspaceId, name, runtimeId: optionalId(raw.runtime_id) };
}

export function projectRuntime(raw: unknown, fallbackWorkspaceId?: string): AwarenessRuntime | null {
	if (!isRecord(raw)) return null;
	const runtimeId = id(raw.id);
	const workspaceId = id(raw.workspace_id) ?? fallbackWorkspaceId ?? null;
	if (!runtimeId || !workspaceId) return null;
	return {
		id: runtimeId,
		workspaceId,
		provider: text(raw.provider, 40) ?? "",
		daemonId: optionalId(raw.daemon_id),
		status: text(raw.status, 40) ?? "",
	};
}

/** The list endpoints answer either a bare array or `{ issues: [...] }`. */
export function listItems(raw: unknown, key: string): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isRecord(raw) && Array.isArray(raw[key])) return raw[key] as unknown[];
	return [];
}

export type ParsedFrame = { type: string; payload: unknown; actorId: string | null; actorType: string | null };

/** Parses one WebSocket text frame into `{ type, payload, actor }`. Anything else is dropped. */
export function parseFrame(raw: string): ParsedFrame | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0 || value.type.length > 80) return null;
	return {
		type: value.type,
		payload: value.payload,
		actorId: id(value.actor_id),
		actorType: text(value.actor_type, 20),
	};
}

// Interest

export type InterestContext = {
	meId: string | null;
	/** True for an issue an AO session is linked to. */
	isLinked: (issue: AwarenessIssue) => boolean;
};

function isClosed(issue: AwarenessIssue): boolean {
	return issue.statusCategory === "done" || issue.statusCategory === "cancelled" || issue.status === "done" || issue.status === "cancelled";
}

function hasActiveRun(model: ServerModel, issueId: string): boolean {
	for (const run of model.runs.values()) {
		if (run.issueId === issueId && isActiveMulticaTaskStatus(run.status) && !run.outcomeUnknown) return true;
	}
	return false;
}

/**
 * The bounded set the model keeps: linked issues, issues with an active run,
 * open issues assigned to the signed-in user, and open issues assigned to an
 * agent or squad.
 */
export function isOfInterest(model: ServerModel, issue: AwarenessIssue, context: InterestContext): boolean {
	if (context.isLinked(issue) || hasActiveRun(model, issue.id)) return true;
	if (isClosed(issue)) return false;
	if (issue.assigneeType === "agent" || issue.assigneeType === "squad") return true;
	return issue.assigneeType === "member" && context.meId !== null && issue.assigneeId === context.meId;
}

// Mutation helpers

/** Inserts or replaces an issue unless the held one is at least as new. Returns true when the model changed. */
export function upsertIssue(model: ServerModel, issue: AwarenessIssue): boolean {
	const held = model.issues.get(issue.id);
	if (held && held.revision >= issue.revision) return false;
	model.issues.set(issue.id, issue);
	model.deleted.delete(issue.id);
	return true;
}

function rememberDeleted(model: ServerModel, issue: AwarenessIssue): void {
	model.deleted.delete(issue.id);
	model.deleted.set(issue.id, { workspaceId: issue.workspaceId, identifier: issue.identifier });
	while (model.deleted.size > MULTICA_MAX_DELETED_ISSUES) {
		const oldest = model.deleted.keys().next().value;
		if (oldest === undefined) break;
		model.deleted.delete(oldest);
	}
}

/** Runs of one issue that Multica may retry are superseded when a newer run for the same agent starts. */
function supersedeRetries(model: ServerModel, run: AwarenessRun): void {
	for (const held of model.runs.values()) {
		if (held.id !== run.id && held.issueId === run.issueId && held.agentId === run.agentId && held.status === "failed" && held.retryPending) {
			held.retryPending = false;
		}
	}
}

/**
 * Applies a task observation (a frame or a REST object) without moving the task
 * backwards: a terminal state is sticky and a lower-ranked status is ignored.
 * Returns true when the model changed.
 */
export function upsertRun(model: ServerModel, incoming: AwarenessRun): boolean {
	const held = model.runs.get(incoming.id);
	if (!held) {
		model.runs.set(incoming.id, incoming);
		if (isActiveMulticaTaskStatus(incoming.status)) supersedeRetries(model, incoming);
		return true;
	}
	const heldTerminal = MULTICA_TASK_STATUS_RANK[held.status] >= 4 && !held.outcomeUnknown;
	if (heldTerminal) {
		// Sticky: only the same terminal status may refine the detail.
		if (incoming.status !== held.status) return false;
		const next = { ...held, failureReason: incoming.failureReason ?? held.failureReason, retryPending: incoming.retryPending };
		const changed = next.failureReason !== held.failureReason || next.retryPending !== held.retryPending;
		if (changed) model.runs.set(incoming.id, next);
		return changed;
	}
	if (!held.outcomeUnknown && MULTICA_TASK_STATUS_RANK[incoming.status] < MULTICA_TASK_STATUS_RANK[held.status]) return false;
	const next: AwarenessRun = {
		...held,
		...incoming,
		startedAt: incoming.startedAt ?? held.startedAt,
		autopilotRunId: incoming.autopilotRunId ?? held.autopilotRunId,
		parentTaskId: incoming.parentTaskId ?? held.parentTaskId,
		runtimeId: incoming.runtimeId ?? held.runtimeId,
		isLeaderTask: incoming.isLeaderTask || held.isLeaderTask,
	};
	if (JSON.stringify(next) === JSON.stringify(held)) return false;
	model.runs.set(incoming.id, next);
	if (isActiveMulticaTaskStatus(next.status)) supersedeRetries(model, next);
	return true;
}

/** Keeps the model inside its bounds: finished runs go first, then the oldest; issues outside the interest set go first. */
export function enforceCaps(model: ServerModel, context: InterestContext): void {
	if (model.runs.size > MULTICA_MAX_RUNS_PER_SERVER) {
		const ranked = [...model.runs.values()].sort((left, right) => {
			const leftActive = isActiveMulticaTaskStatus(left.status) && !left.outcomeUnknown ? 1 : 0;
			const rightActive = isActiveMulticaTaskStatus(right.status) && !right.outcomeUnknown ? 1 : 0;
			if (leftActive !== rightActive) return leftActive - rightActive;
			return (left.endedAt ?? left.startedAt ?? "").localeCompare(right.endedAt ?? right.startedAt ?? "");
		});
		for (const run of ranked.slice(0, model.runs.size - MULTICA_MAX_RUNS_PER_SERVER)) model.runs.delete(run.id);
	}
	if (model.issues.size > MULTICA_MAX_ISSUES_PER_SERVER) {
		const ranked = [...model.issues.values()].sort((left, right) => {
			const leftKeep = isOfInterest(model, left, context) ? 1 : 0;
			const rightKeep = isOfInterest(model, right, context) ? 1 : 0;
			if (leftKeep !== rightKeep) return leftKeep - rightKeep;
			return left.updatedAt.localeCompare(right.updatedAt);
		});
		for (const issue of ranked.slice(0, model.issues.size - MULTICA_MAX_ISSUES_PER_SERVER)) model.issues.delete(issue.id);
	}
}

// Frames

export type FrameEffect =
	| { type: "refetch_issue"; issueId: string }
	| { type: "refresh_agents" }
	| { type: "refresh_snapshot" }
	| { type: "stop"; reason: "gone" | "no_access" };

export type FrameContext = InterestContext & { workspaceId: string; nowIso: string };

const TASK_FRAME_STATUS: Record<string, MulticaTaskStatus> = {
	"task:queued": "queued",
	"task:dispatch": "dispatched",
	"task:running": "running",
	"task:waiting_local_directory": "waiting_local_directory",
	"task:completed": "completed",
	"task:failed": "failed",
	"task:cancelled": "cancelled",
};

/** Frame types that carry no state AO keeps. They are dropped before parsing where possible. */
export function isIgnoredFrameType(type: string): boolean {
	return type === "task:message" || type === "task:progress" || type.startsWith("daemon:");
}

/**
 * Applies one frame. Returns whether the model changed and the follow-up work
 * the caller should schedule (refetches, a stop). A frame never leaves the
 * model in a state that REST truth would not also produce.
 */
export function applyFrame(model: ServerModel, frame: ParsedFrame, context: FrameContext): { changed: boolean; effects: FrameEffect[] } {
	const effects: FrameEffect[] = [];
	let changed = false;
	const payload = isRecord(frame.payload) ? frame.payload : {};

	if (frame.type === "issue:created" || frame.type === "issue:updated") {
		const issue = projectIssue(payload.issue, context.workspaceId);
		if (!issue || issue.workspaceId !== context.workspaceId) return { changed, effects };
		const held = model.issues.get(issue.id);
		if (held && held.revision >= issue.revision) return { changed, effects };
		if (!held && !isOfInterest(model, issue, context)) return { changed, effects };
		changed = upsertIssue(model, issue);
		// An issue that left the interest set is dropped rather than carried.
		if (changed && !isOfInterest(model, issue, context)) {
			model.issues.delete(issue.id);
		}
		return { changed, effects };
	}

	if (frame.type === "issue:deleted") {
		const issueId = id(payload.issue_id);
		if (!issueId) return { changed, effects };
		const held = model.issues.get(issueId);
		if (held) {
			rememberDeleted(model, held);
			model.issues.delete(issueId);
			changed = true;
		}
		for (const run of [...model.runs.values()]) {
			if (run.issueId === issueId) {
				model.runs.delete(run.id);
				changed = true;
			}
		}
		return { changed, effects };
	}

	const taskStatus = TASK_FRAME_STATUS[frame.type];
	if (taskStatus !== undefined) {
		const taskId = id(payload.task_id);
		const issueId = id(payload.issue_id);
		const agentId = id(payload.agent_id);
		// Chat tasks have no issue and are not runs.
		if (!taskId || !issueId || !agentId) return { changed, effects };
		const status = isMulticaTaskStatus(payload.status) ? payload.status : taskStatus;
		const known = model.runs.has(taskId);
		const terminal = MULTICA_TASK_STATUS_RANK[status] >= 4;
		const run: AwarenessRun = {
			id: taskId,
			workspaceId: context.workspaceId,
			issueId,
			agentId,
			status,
			failureReason: text(payload.failure_reason, 60) || null,
			retryPending: payload.retry_pending === true,
			outcomeUnknown: false,
			startedAt: status === "running" ? context.nowIso : null,
			endedAt: terminal ? context.nowIso : null,
			isLeaderTask: false,
			autopilotRunId: null,
			parentTaskId: null,
			runtimeId: null,
		};
		changed = upsertRun(model, run);
		// A frame carries only ids and status: fetch the rest (leader flag, autopilot, parent) once.
		if (!known) effects.push({ type: "refresh_snapshot" });
		enforceCaps(model, context);
		return { changed, effects };
	}

	if (frame.type.startsWith("agent:") || frame.type.startsWith("squad:")) {
		effects.push({ type: "refresh_agents" });
		return { changed, effects };
	}

	if (frame.type === "issue_labels:changed" || frame.type === "issue_metadata:changed") {
		const issueId = id(payload.issue_id);
		if (issueId && model.issues.has(issueId)) effects.push({ type: "refetch_issue", issueId });
		return { changed, effects };
	}

	if (frame.type === "workspace:deleted") {
		if (id(payload.workspace_id) === context.workspaceId) effects.push({ type: "stop", reason: "gone" });
		return { changed, effects };
	}

	if (frame.type === "member:removed") {
		if (context.meId !== null && id(payload.user_id) === context.meId && id(payload.workspace_id) === context.workspaceId) {
			effects.push({ type: "stop", reason: "no_access" });
		}
		return { changed, effects };
	}

	return { changed, effects };
}

// Reconcile

export type ReconcileInput = {
	workspaceId: string;
	/** Active tasks plus each agent's last outcome, from `GET /api/agent-task-snapshot`. */
	snapshotRuns: AwarenessRun[];
	nowIso: string;
};

/**
 * Replaces the workspace's active-task set with the snapshot. A run the model
 * held as active that the snapshot lacks is marked "ended, outcome unknown"
 * and returned so the caller can read its outcome once.
 */
export function reconcileRuns(model: ServerModel, input: ReconcileInput): { changed: boolean; unknownOutcome: AwarenessRun[] } {
	let changed = false;
	const listed = new Set(input.snapshotRuns.map((run) => run.id));
	for (const run of input.snapshotRuns) {
		if (upsertRun(model, run)) changed = true;
	}
	const unknownOutcome: AwarenessRun[] = [];
	for (const held of model.runs.values()) {
		if (held.workspaceId !== input.workspaceId || listed.has(held.id) || held.outcomeUnknown) continue;
		if (!isActiveMulticaTaskStatus(held.status)) continue;
		const ended: AwarenessRun = { ...held, outcomeUnknown: true, endedAt: input.nowIso };
		model.runs.set(held.id, ended);
		unknownOutcome.push(ended);
		changed = true;
	}
	return { changed, unknownOutcome };
}

/** Writes the real outcome of a run that ended while AO was not looking. */
export function resolveUnknownOutcome(model: ServerModel, run: AwarenessRun): boolean {
	const held = model.runs.get(run.id);
	if (!held || !held.outcomeUnknown) return false;
	model.runs.set(run.id, { ...run, outcomeUnknown: false, startedAt: run.startedAt ?? held.startedAt });
	return true;
}

/** Replaces the agents and runtimes of one workspace. */
export function replaceAgents(model: ServerModel, workspaceId: string, agents: AwarenessAgent[]): boolean {
	const before = JSON.stringify([...model.agents.values()].filter((agent) => agent.workspaceId === workspaceId));
	for (const agent of [...model.agents.values()]) if (agent.workspaceId === workspaceId) model.agents.delete(agent.id);
	for (const agent of agents) model.agents.set(agent.id, agent);
	return JSON.stringify(agents) !== before;
}

export function replaceRuntimes(model: ServerModel, workspaceId: string, runtimes: AwarenessRuntime[]): boolean {
	const before = JSON.stringify([...model.runtimes.values()].filter((runtime) => runtime.workspaceId === workspaceId));
	for (const runtime of [...model.runtimes.values()]) if (runtime.workspaceId === workspaceId) model.runtimes.delete(runtime.id);
	for (const runtime of runtimes) model.runtimes.set(runtime.id, runtime);
	return JSON.stringify(runtimes) !== before;
}

/** Forgets everything held for one workspace. */
export function clearWorkspace(model: ServerModel, workspaceId: string): void {
	for (const [key, issue] of [...model.issues]) if (issue.workspaceId === workspaceId) model.issues.delete(key);
	for (const [key, run] of [...model.runs]) if (run.workspaceId === workspaceId) model.runs.delete(key);
	for (const [key, agent] of [...model.agents]) if (agent.workspaceId === workspaceId) model.agents.delete(key);
	for (const [key, runtime] of [...model.runtimes]) if (runtime.workspaceId === workspaceId) model.runtimes.delete(key);
	for (const [key, entry] of [...model.deleted]) if (entry.workspaceId === workspaceId) model.deleted.delete(key);
}
