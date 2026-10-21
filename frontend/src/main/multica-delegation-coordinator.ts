import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import type { createMulticaPublicApi, PublicApiBinding, PublicApiFailureCode } from "./multica-public-api";
import { createDelegation, delegation, type CreatePublicDelegation, type PublicDelegation } from "./multica-public-api-model";

export type DelegationIntent = { binding: PublicApiBinding; payload: CreatePublicDelegation };
export type UserConfirmation = { id: string; userId: string; at: string };
export type DelegationRecord = {
	requestId: string; projectId: string; taskId: string;
	confirmationId: string; confirmedBy: string; confirmedAt: string; rerunOf: string;
	intent: DelegationIntent; payloadHash: string; version: number;
	state: "submitting" | "submission_unknown" | "accepted" | "cancellation_requested" | "terminal" | "rejected";
	failureCode: PublicApiFailureCode | null; attempted: boolean; remote: PublicDelegation | null; cancellation: UserConfirmation | null;
};
export interface DelegationJournal {
	get(requestId: string): Promise<DelegationRecord | null>;
	find(projectId: string, taskId: string): Promise<DelegationRecord | null>;
	reserve(record: DelegationRecord, confirmationProof: string): Promise<DelegationRecord>;
	save(record: DelegationRecord): Promise<DelegationRecord>;
}
export interface MulticaDelegationCoordinator {
	process(requestId: string): Promise<DelegationRecord>;
	processTask(projectId: string, taskId: string): Promise<DelegationRecord>;
}
export interface MainProcessDelegationActions {
	confirmFromUserAction(intent: DelegationIntent, approved: UserConfirmation, rerunOf?: string): Promise<DelegationRecord>;
	cancelFromUserAction(requestId: string, approved: UserConfirmation): Promise<DelegationRecord>;
}
type Client = Pick<ReturnType<typeof createMulticaPublicApi>, "binding" | "delegate" | "getDelegation" | "listDelegations" | "cancelDelegation">;
type Options = { journal: DelegationJournal; client: (binding: PublicApiBinding) => Client; enabled?: boolean; confirmations: MainProcessDelegationAuthority };

export const delegationPayloadHash = (p: CreatePublicDelegation) => createHash("sha256").update(
	[p.agent_id, p.expected_runtime_id, p.source.system, p.source.project_id, p.source.task_id, p.task.title, p.task.instructions]
		.map((v) => `${Buffer.byteLength(v)}:${v}`).join(""),
).digest("hex");
const hash = delegationPayloadHash;
const equal = isDeepStrictEqual;
function confirmation(value: UserConfirmation): UserConfirmation {
	if (!value?.id?.trim() || !value.userId?.trim() || !Number.isFinite(Date.parse(value.at))) throw new Error("confirmation_required");
	const normalized = { id: value.id, userId: value.userId, at: value.at };
	if (!equal(normalized, value)) throw new Error("confirmation_required");
	return normalized;
}
function verify(record: DelegationRecord): void {
	confirmation({ id: record.confirmationId, userId: record.confirmedBy, at: record.confirmedAt });
	const payload = createDelegation(record.intent.payload);
	if (!equal(payload, record.intent.payload) || payload.source.system !== "ao" || payload.source.project_id !== record.projectId || payload.source.task_id !== record.taskId || hash(payload) !== record.payloadHash) throw new Error("payload_hash_mismatch");
}
const rejected: readonly PublicApiFailureCode[] = ["invalid_request", "runtime_binding_changed", "idempotency_conflict", "target_unavailable", "runtime_unsupported", "invocation_not_allowed", "forbidden", "unauthorized", "insufficient_scope", "policy_denied", "feature_disabled"];

export function createMulticaDelegationCoordinator(options: Options): { human: MainProcessDelegationActions; taskOrchestrator: MulticaDelegationCoordinator; projectOrchestrator: MulticaDelegationCoordinator } {
	const { journal } = options;
	const queues = new Map<string, Promise<unknown>>();
	function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
		queues.set(id, next);
		void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => undefined);
		return next;
	}
	async function load(id: string): Promise<DelegationRecord> {
		const record = await journal.get(id);
		if (!record) throw new Error("delegation_not_found");
		verify(record);
		return record;
	}
	function clientFor(record: DelegationRecord): Client {
		const client = options.client(record.intent.binding);
		if (!equal(client.binding, record.intent.binding)) throw new Error("connection_changed");
		return client;
	}
	async function observe(record: DelegationRecord, value: PublicDelegation): Promise<DelegationRecord> {
		const remote = delegation(value, record.intent.binding.workspaceId);
		if (remote.agent_id !== record.intent.payload.agent_id || remote.runtime_id !== record.intent.payload.expected_runtime_id || (record.remote && (record.remote.delegation_id !== remote.delegation_id || record.remote.task_id !== remote.task_id))) throw new Error("remote_identity_mismatch");
		if (record.remote?.terminal || equal(record.remote, remote)) return record;
		return journal.save({ ...record, remote, state: remote.terminal ? "terminal" : record.cancellation ? "cancellation_requested" : "accepted" });
	}
	async function process(id: string): Promise<DelegationRecord> {
		let record = await load(id);
		if (record.state === "terminal" || record.state === "rejected") return record;
		const client = clientFor(record);
		if (record.attempted) {
			if (record.remote) {
				const result = await client.getDelegation(record.remote.delegation_id);
				if (!result.ok) return record;
				record = await observe(record, result.data);
			} else {
				const result = await client.listDelegations({ idempotencyKey: record.requestId });
				if (!result.ok || result.data.next_cursor || result.data.delegations.length > 1) return record;
				if (result.data.delegations.length === 1) record = await observe(record, result.data.delegations[0]);
			}
		}
		if (record.remote?.terminal) return record;
		if (record.cancellation) {
			if (!record.remote) {
				// A missing reconciliation result cannot prove a prior submission never arrived.
				if (record.attempted) return record;
				return journal.save({ ...record, state: "rejected" });
			}
			const result = await client.cancelDelegation(record.remote.delegation_id, true, record.remote.revision);
			return result.ok ? observe(record, result.data) : record;
		}
		if (record.remote || options.enabled !== true) return record;
		const firstAttempt = !record.attempted;
		record = await journal.save({ ...record, attempted: true, state: "submission_unknown" });
		const result = await client.delegate(record.intent.payload, record.requestId, true);
		if (result.ok) return observe(record, result.data);
		// A failed replay never proves that an earlier ambiguous submission was rejected.
		if (firstAttempt) {
			if (rejected.includes(result.code)) return journal.save({ ...record, state: "rejected", failureCode: result.code });
		}
		return record;
	}
	const human: MainProcessDelegationActions = {
		async confirmFromUserAction(intent: DelegationIntent, approved: UserConfirmation, rerunOf = ""): Promise<DelegationRecord> {
			const by = confirmation(approved);
			const payload = createDelegation(intent.payload);
			if (payload.source.system !== "ao") throw new Error("invalid_source");
			const binding = { serverKey: intent.binding.serverKey, origin: intent.binding.origin, workspaceId: intent.binding.workspaceId };
			if (!equal({ binding, payload }, intent)) throw new Error("invalid_request");
			const record: DelegationRecord = {
				requestId: randomUUID(), projectId: payload.source.project_id, taskId: payload.source.task_id,
				confirmationId: by.id, confirmedBy: by.userId, confirmedAt: by.at, rerunOf,
				intent: { binding, payload }, payloadHash: hash(payload), version: 0,
				state: "submitting", failureCode: null, attempted: false, remote: null, cancellation: null,
			};
			verify(record);
			clientFor(record);
			return journal.reserve(record, options.confirmations.confirmationProof(record));
		},
		cancelFromUserAction: (requestId: string, approved: UserConfirmation) => serial(requestId, async () => {
			const by = confirmation(approved);
			const record = await load(requestId);
			if (record.remote?.terminal || record.state === "rejected") return record;
			await journal.save({ ...record, cancellation: record.cancellation ?? by, state: "cancellation_requested" });
			return process(requestId);
		}),
	};
	const coordinator: MulticaDelegationCoordinator = {
		process: (requestId: string) => serial(requestId, () => process(requestId)),
		async processTask(projectId: string, taskId: string) {
			const record = await journal.find(projectId, taskId);
			if (!record) throw new Error("confirmation_required");
			return coordinator.process(record.requestId);
		},
	};
	return { human, taskOrchestrator: coordinator, projectOrchestrator: coordinator };
}
