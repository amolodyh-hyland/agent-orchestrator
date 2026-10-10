import type { MulticaActionInput } from "../shared/multica-action-log";
import type { MulticaActionLog } from "./multica-action-log";
import type { MulticaSyncRecord } from "./multica-status-sync";

const USER_REASONS = new Set(["resumed_by_user", "reopen_confirmed_by_user"]);

/**
 * Maps one status-sync audit entry (a write attempt, a pause or a resume) to an
 * action-log record. The log keeps only allow-listed fields and redacts
 * credential-shaped strings, so even an unexpected value cannot leak.
 */
export function syncRecordToAction(entry: MulticaSyncRecord): MulticaActionInput {
	const resumedByUser = entry.kind === "resume" && USER_REASONS.has(entry.result.reason ?? "");
	return {
		kind: entry.kind,
		direction: entry.kind === "status_write" ? "ao_to_multica" : "local",
		actor: resumedByUser ? "user_confirmed" : "policy",
		serverKey: entry.serverKey,
		...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
		...(entry.issueId ? { issueId: entry.issueId } : {}),
		identifier: entry.issueIdentifier,
		...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
		trigger: entry.result.reason ?? entry.kind,
		...(entry.request ? { request: { method: entry.request.method, path: entry.request.pathTemplate, fields: entry.request.fields } } : {}),
		...(entry.revBefore !== null ? { revBefore: entry.revBefore } : {}),
		...(entry.revAfter !== null ? { revAfter: entry.revAfter } : {}),
		result: {
			ok: entry.result.ok,
			...((entry.result.code ?? entry.result.reason) ? { code: entry.result.code ?? entry.result.reason } : {}),
			...(entry.result.httpStatus !== undefined ? { httpStatus: entry.result.httpStatus } : {}),
		},
	};
}

/** The `record` sink for the status-sync engine: every attempt, pause and resume goes to the shared action log. */
export function createSyncAuditSink(log: Pick<MulticaActionLog, "record">): (entry: MulticaSyncRecord) => void {
	return (entry) => {
		void log.record(syncRecordToAction(entry));
	};
}
