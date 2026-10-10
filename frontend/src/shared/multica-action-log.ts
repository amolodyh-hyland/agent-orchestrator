// Shape of the Multica action log and the pure helpers that keep it free of
// secrets. Shared by the main-process writer, the IPC bridge and the Activity
// viewer. Kept free of Electron and Node types.

export const MULTICA_ACTION_LOG_READ_CHANNEL = "multicaActionLog:read";

export const MULTICA_ACTION_KINDS = [
	"status_write",
	"assignee_write",
	"note_comment",
	"task_cancel",
	"metadata_write",
	"proposal_created",
	"proposal_confirmed",
	"proposal_dismissed",
	"spawn",
	"restore",
	"send",
	"terminate",
	"handoff_to_ao",
	"handoff_to_multica",
	"pause",
	"resume",
	"contested",
	"connect",
	"disconnect",
	"signed_out",
	"setting_changed",
	"limit_hit",
	"error",
] as const;
export type MulticaActionKind = (typeof MULTICA_ACTION_KINDS)[number];

export const MULTICA_ACTION_DIRECTIONS = ["ao_to_multica", "multica_to_ao", "local"] as const;
export type MulticaActionDirection = (typeof MULTICA_ACTION_DIRECTIONS)[number];

export const MULTICA_ACTION_ACTORS = ["user_confirmed", "user_setting", "policy", "system"] as const;
export type MulticaActionActor = (typeof MULTICA_ACTION_ACTORS)[number];

/** Request fields whose scalar value may be logged. Every other field name is logged without its value. */
export const MULTICA_ACTION_VALUE_FIELDS = ["status", "assignee_type", "assignee_id", "expected_revision", "suppress_run"] as const;

export type MulticaActionScalar = string | number | boolean | null;

export type MulticaActionRequest = {
	method: string;
	/** A path template such as `/api/issues/{id}`, never a concrete URL with ids or query strings. */
	path: string;
	/** Names of the changed fields; values are kept only for {@link MULTICA_ACTION_VALUE_FIELDS}. No text bodies. */
	fields?: Record<string, MulticaActionScalar | undefined>;
};

export type MulticaActionResult = { ok: boolean; code?: string; httpStatus?: number };

/** What a caller passes to `record()`. Anything else on the object is dropped, never logged. */
export type MulticaActionInput = {
	kind: MulticaActionKind;
	direction: MulticaActionDirection;
	actor: MulticaActionActor;
	serverKey?: string;
	workspaceId?: string;
	issueId?: string;
	identifier?: string;
	/** Cut to 80 characters and logged as plain text. */
	title?: string;
	/** The frame type and revision, or the user action that caused the record. */
	trigger?: string;
	request?: MulticaActionRequest;
	result?: MulticaActionResult;
	revBefore?: number;
	revAfter?: number;
	sessionId?: string;
	clientRequestId?: string;
	proposalId?: string;
	handoffId?: string;
};

export type MulticaActionRecord = Omit<MulticaActionInput, "title"> & {
	v: 1;
	id: string;
	ts: string;
	title80?: string;
};

export type MulticaActionLogQuery = { issueId?: string; kind?: MulticaActionKind; limit?: number };

export type MulticaActionLogBridge = {
	read: (query?: MulticaActionLogQuery) => Promise<MulticaActionRecord[]>;
};

export const MULTICA_ACTION_TITLE_MAX = 80;
export const MULTICA_ACTION_TEXT_MAX = 200;
export const MULTICA_ACTION_READ_MAX = 500;

const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]", "g");

/**
 * Multica token shapes (`mul_` personal, `mcn_`, `mdt_`, `mat_`), a JWT, and an
 * Authorization header value. Used as a second line of defence: fields are
 * already restricted to an allow-list, this catches a secret that ends up in a
 * permitted field.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
	/\b(?:mul|mcn|mdt|mat)_[A-Za-z0-9_-]{8,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

export const REDACTED = "[redacted]";

/** Replaces anything shaped like a Multica credential, and strips control characters. */
export function redactSecrets(value: string): string {
	let result = value.replace(CONTROL_CHARACTERS, " ");
	for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
	return result;
}

/** Redacts, trims and bounds one logged string. */
export function sanitizeActionText(value: unknown, max = MULTICA_ACTION_TEXT_MAX): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = redactSecrets(value).trim();
	if (cleaned === "") return undefined;
	return Array.from(cleaned).slice(0, max).join("");
}

function sanitizeScalar(value: MulticaActionScalar | undefined): MulticaActionScalar | undefined {
	if (typeof value === "string") return sanitizeActionText(value, 80) ?? "";
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	return undefined;
}

function sanitizeRequest(request: MulticaActionRequest | undefined): MulticaActionRequest | undefined {
	if (!request) return undefined;
	const method = sanitizeActionText(request.method, 10)?.toUpperCase();
	const path = sanitizeActionText(request.path, 120);
	if (!method || !path) return undefined;
	const allowed: readonly string[] = MULTICA_ACTION_VALUE_FIELDS;
	const fields: Record<string, MulticaActionScalar> = {};
	for (const [name, value] of Object.entries(request.fields ?? {})) {
		const safeName = sanitizeActionText(name, 40);
		if (!safeName) continue;
		const scalar = allowed.includes(safeName) ? sanitizeScalar(value) : null;
		fields[safeName] = scalar === undefined ? null : scalar;
	}
	return { method, path, ...(Object.keys(fields).length > 0 ? { fields } : {}) };
}

function sanitizeResult(result: MulticaActionResult | undefined): MulticaActionResult | undefined {
	if (!result || typeof result.ok !== "boolean") return undefined;
	const code = sanitizeActionText(result.code, 60);
	return {
		ok: result.ok,
		...(code ? { code } : {}),
		...(typeof result.httpStatus === "number" && Number.isInteger(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
	};
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Builds the record from an explicit allow-list of fields, so a secret, a
 * description, a comment, a prompt, a frame body or a `work_dir` passed by
 * mistake is dropped by construction rather than filtered afterwards.
 */
export function buildActionRecord(input: MulticaActionInput, id: string, now: Date): MulticaActionRecord {
	const text = (value: unknown, max = MULTICA_ACTION_TEXT_MAX) => sanitizeActionText(value, max);
	const record: MulticaActionRecord = {
		v: 1,
		id,
		ts: now.toISOString(),
		kind: input.kind,
		direction: input.direction,
		actor: input.actor,
	};
	const optional: Array<[keyof MulticaActionRecord, unknown]> = [
		["serverKey", text(input.serverKey, 300)],
		["workspaceId", text(input.workspaceId, 80)],
		["issueId", text(input.issueId, 80)],
		["identifier", text(input.identifier, 40)],
		["title80", text(input.title, MULTICA_ACTION_TITLE_MAX)],
		["trigger", text(input.trigger, 120)],
		["request", sanitizeRequest(input.request)],
		["result", sanitizeResult(input.result)],
		["revBefore", safeInteger(input.revBefore)],
		["revAfter", safeInteger(input.revAfter)],
		["sessionId", text(input.sessionId, 200)],
		["clientRequestId", text(input.clientRequestId, 128)],
		["proposalId", text(input.proposalId, 80)],
		["handoffId", text(input.handoffId, 80)],
	];
	for (const [key, value] of optional) {
		if (value !== undefined) (record as Record<string, unknown>)[key] = value;
	}
	return record;
}

/** Parses one JSONL line; anything that is not a well-formed record is ignored. */
export function parseActionRecord(line: string): MulticaActionRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || typeof record.id !== "string" || typeof record.ts !== "string") return null;
	if (!(MULTICA_ACTION_KINDS as readonly unknown[]).includes(record.kind)) return null;
	if (!(MULTICA_ACTION_DIRECTIONS as readonly unknown[]).includes(record.direction)) return null;
	if (!(MULTICA_ACTION_ACTORS as readonly unknown[]).includes(record.actor)) return null;
	return value as MulticaActionRecord;
}

export function isMulticaActionLogQuery(value: unknown): value is MulticaActionLogQuery {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const query = value as Record<string, unknown>;
	if (Object.keys(query).some((key) => key !== "issueId" && key !== "kind" && key !== "limit")) return false;
	if (query.issueId !== undefined && (typeof query.issueId !== "string" || query.issueId.length > 80)) return false;
	if (query.kind !== undefined && !(MULTICA_ACTION_KINDS as readonly unknown[]).includes(query.kind)) return false;
	return query.limit === undefined || (typeof query.limit === "number" && Number.isSafeInteger(query.limit) && query.limit > 0);
}
