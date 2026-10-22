import { randomUUID } from "node:crypto";
import type { DelegationCancellation, DelegationStatus, DelegationStatusResult } from "../shared/multica-delegation-confirmation";
import type { DelegationJournal, DelegationRecord, MainProcessDelegationActions, MulticaDelegationCoordinator } from "./multica-delegation-coordinator";
import { createDelegationConfirmationTokens } from "./multica-delegation-confirmation-tokens";
import type { PublicApiBinding } from "./multica-public-api";

type Entry = { record: DelegationRecord; connection: DelegationStatus["connection"]; failures: number; timer?: ReturnType<typeof setTimeout>; pending?: Promise<void> };
const AUTH = new Set(["no_token", "credential_unavailable", "credential_required", "invalid_token", "unauthorized", "unsupported_credential", "scoped_token_required", "insufficient_scope", "forbidden"]);
const BASE_MS = 2000;
const MAX_MS = 60_000;

function project(entry: Entry): DelegationStatus {
	const r = entry.record;
	return { requestId: r.requestId, projectId: r.projectId, taskId: r.taskId,
		workspaceId: r.intent.binding.workspaceId, serverOrigin: r.intent.binding.origin, serverKey: r.intent.binding.serverKey,
		state: r.state, remoteId: r.remote?.delegation_id ?? null, remoteTaskId: r.remote?.task_id ?? null,
		remoteStatus: r.remote?.status ?? null, terminal: r.state === "terminal" || r.state === "rejected",
		failureCode: r.remote?.failure_reason ?? r.failureCode, connection: entry.connection };
}

export function createDelegationStatusFlow(options: {
	journal: Pick<DelegationJournal, "get" | "find">; coordinator: Pick<MulticaDelegationCoordinator, "reconcile">;
	human: Pick<MainProcessDelegationActions, "cancelFromUserAction">;
	prepare: (binding: PublicApiBinding) => Promise<void>;
	confirmCancellation: (status: DelegationStatus) => Promise<boolean>;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry>();
	const cancelling = new Set<string>();
	const tokens = createDelegationConfirmationTokens(now);
	let generation = 0;
	let cancellationGeneration = 0;
	let disposed = false;
	function invalidate() {
		generation++; tokens.clear();
		for (const entry of entries.values()) clearTimeout(entry.timer);
		entries.clear();
	}
	function poll(entry: Entry): Promise<void> {
		if (entry.pending) return entry.pending;
		const version = generation;
		const current = () => !disposed && generation === version && entries.get(entry.record.requestId) === entry;
		entry.pending = (async () => {
			let retryAfter = 0;
			try {
				await options.prepare(entry.record.intent.binding);
				if (!current()) return;
				const result = await options.coordinator.reconcile(entry.record.requestId);
				if (!current()) return;
				if (result.record.version >= entry.record.version) entry.record = result.record;
				if (result.failure) {
					entry.connection = AUTH.has(result.failure.code) ? "reauthentication_required" : result.failure.code === "connection_changed" ? "connection_changed" : "retrying";
					retryAfter = result.failure.retryAfterMs ?? 0;
					entry.failures++;
				} else {
					entry.connection = "current";
					entry.failures = result.found || !result.record.attempted ? 0 : entry.failures + 1;
				}
			} catch (error) {
				if (!current()) return;
				entry.connection = error instanceof Error && error.message === "connection_changed" ? "connection_changed" : "retrying";
				entry.failures++;
			} finally {
				entry.pending = undefined;
				if (current() && !project(entry).terminal && entry.connection !== "reauthentication_required" && entry.connection !== "connection_changed") {
					const delay = Math.max(BASE_MS, Math.min(MAX_MS, retryAfter), Math.min(MAX_MS, BASE_MS * 2 ** Math.min(entry.failures, 5)));
					entry.timer = setTimeout(() => { void poll(entry); }, delay);
				}
			}
		})();
		return entry.pending;
	}
	return {
		async status(projectId: string, taskId: string): Promise<DelegationStatusResult> {
			const version = generation;
			try {
				const record = await options.journal.find(projectId, taskId);
				if (disposed || generation !== version) return { ok: false, code: "connection_changed" };
				if (!record) return { ok: true, status: null };
				let entry = entries.get(record.requestId);
				if (!entry) {
					entry = { record, connection: "current", failures: 0 };
					entries.set(record.requestId, entry);
					await poll(entry);
				} else if (record.version > entry.record.version) {
					entry.record = record;
					if (project(entry).terminal) clearTimeout(entry.timer);
				}
				if (generation !== version) return { ok: false, code: "connection_changed" };
				return { ok: true, status: project(entry) };
			} catch { return { ok: false, code: "journal_unavailable" }; }
		},
		async cancelFromRendererAction(input: DelegationCancellation): Promise<{ ok: boolean; code?: string }> {
			if (disposed || cancelling.has(input.requestId)) return { ok: false, code: "confirmation_required" };
			cancelling.add(input.requestId);
			const version = generation, cancellationVersion = cancellationGeneration;
			const current = () => !disposed && generation === version && cancellationGeneration === cancellationVersion;
			try {
				const record = await options.journal.get(input.requestId);
				if (!current() || !record?.remote || record.remote.delegation_id !== input.remoteId || record.remote.terminal) return { ok: false, code: "confirmation_required" };
				await options.prepare(record.intent.binding);
				const status = project({ record, connection: "current", failures: 0 });
				if (!current() || !await options.confirmCancellation(status) || !current()) return { ok: false, code: "cancelled" };
				const hash = JSON.stringify(["cancel", record.requestId, record.intent.binding, input.remoteId, record.remote.task_id]);
				const expiresAt = now() + 10_000;
				const token = tokens.mint(hash, expiresAt);
				if (!tokens.consume(token, hash)) return { ok: false, code: "confirmation_required" };
				const result = await options.human.cancelFromUserAction(record.requestId, { id: randomUUID(), userId: "desktop-user", at: new Date(now()).toISOString() }, () => current() && now() < expiresAt, input.remoteId);
				const entry = entries.get(record.requestId);
				if (entry && current() && result.version >= entry.record.version) entry.record = result;
				return { ok: true };
			} catch { return { ok: false, code: "confirmation_required" }; }
			finally { cancelling.delete(input.requestId); }
		},
		revokeConfirmation() { cancellationGeneration++; tokens.clear(); },
		resume(workspaceId: string) {
			for (const entry of entries.values()) {
				if (entry.record.intent.binding.workspaceId !== workspaceId) continue;
				clearTimeout(entry.timer); entry.failures = 0;
				void (entry.pending ?? Promise.resolve()).then(() => {
					if (!disposed && entries.get(entry.record.requestId) === entry) { clearTimeout(entry.timer); void poll(entry); }
				});
			}
		},
		invalidate,
		dispose() { disposed = true; invalidate(); },
	};
}
