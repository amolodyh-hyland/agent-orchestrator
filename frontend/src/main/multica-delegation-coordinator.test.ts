import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMulticaDelegationCoordinator, delegationPayloadHash, type DelegationRecord, type DelegationJournal, type DelegationIntent } from "./multica-delegation-coordinator";
import type { DelegationSendGuard } from "./multica-delegation-policy";
import type { PublicDelegation } from "./multica-public-api-model";

const binding = { serverKey: "local", origin: "http://127.0.0.1:4444", workspaceId: "10000000-0000-4000-8000-000000000001" };
const intent: DelegationIntent = { binding, payload: {
	agent_id: "20000000-0000-4000-8000-000000000002", expected_runtime_id: "30000000-0000-4000-8000-000000000003",
	source: { system: "ao", project_id: "project-1", task_id: "task-1" }, task: { title: "Review", instructions: "Review A & B, 日本語\u2028" },
} };
const approved = { id: "confirmation-1", userId: "user-1", at: "2026-10-21T12:00:00Z" };
const remote: PublicDelegation = {
	delegation_id: "40000000-0000-4000-8000-000000000004", task_id: "50000000-0000-4000-8000-000000000005",
	workspace_id: binding.workspaceId, agent_id: intent.payload.agent_id, runtime_id: intent.payload.expected_runtime_id,
	status: "queued", terminal: false, revision: "revision-1", created_at: approved.at,
};
const confirmations = createMainProcessDelegationAuthority(Buffer.alloc(32, 7));
let dir: string;
let file: string;
let rows: Map<string, DelegationRecord>;
let journal: DelegationJournal;
let calls: string[];
let accepted: PublicDelegation | null;
let client: ReturnType<typeof fakeClient>;
function fakeClient() {
	return {
		binding,
		delegate: vi.fn(async (_payload: unknown, key: string, _confirmed: boolean, guard: DelegationSendGuard) => { const blocked = await guard(); if (blocked) return { ok: false as const, code: blocked }; calls.push(`submit:${key}`); accepted = structuredClone(remote); return { ok: true as const, data: accepted }; }),
		listDelegations: vi.fn(async ({ idempotencyKey }: { idempotencyKey?: string } = {}) => { calls.push(`lookup:${idempotencyKey}`); return { ok: true as const, data: { delegations: accepted ? [accepted] : [] } }; }),
		getDelegation: vi.fn(async (id: string) => { calls.push(`status:${id}`); return { ok: true as const, data: accepted! }; }),
		cancelDelegation: vi.fn(async (id: string) => { calls.push(`cancel:${id}`); return { ok: true as const, data: accepted! }; }),
	};
}
function coordinator(enabled = true, extras: Partial<Pick<Parameters<typeof createMulticaDelegationCoordinator>[0], "policy" | "resolveRuntimeClass">> = {}) {
 const result = createMulticaDelegationCoordinator({ journal, client: () => client, enabled, confirmations, ...extras });
 const combined = { ...result.taskOrchestrator, confirm: result.human.confirmFromUserAction, cancel: result.human.cancelFromUserAction };
 return { taskOrchestrator: combined, projectOrchestrator: combined };
}
async function flush() { await writeFile(file, JSON.stringify([...rows])); }
async function restart() { rows = new Map(JSON.parse(await readFile(file, "utf8"))); return coordinator(); }
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-delegation-")); file = path.join(dir, "journal.json");
	rows = new Map(); calls = []; accepted = null; client = fakeClient();
	journal = {
		evaluatePolicy: async () => ({ code: "policy_absent" }),
		get: async (id) => structuredClone(rows.get(id) ?? null),
		find: async (project, task) => structuredClone([...rows.values()].reverse().find((r) => r.projectId === project && r.taskId === task) ?? null),
		reserve: async (r) => {
			const same = [...rows.values()].find((v) => v.confirmationId === r.confirmationId);
			if (same) return structuredClone(same);
			const existing = await journal.find(r.projectId, r.taskId);
			if (existing && !r.rerunOf) {
				if (existing.payloadHash !== r.payloadHash || JSON.stringify(existing.intent) !== JSON.stringify(r.intent)) throw new Error("journal_conflict");
				return existing;
			}
			if ((existing?.requestId ?? "") !== r.rerunOf || (existing && existing.state !== "terminal" && existing.state !== "rejected")) throw new Error("journal_conflict");
			rows.set(r.requestId, structuredClone(r)); await flush(); return structuredClone(r);
		},
		save: async (r) => {
			if (rows.get(r.requestId)?.version !== r.version) throw new Error("journal_conflict");
			const next = { ...r, version: r.version + 1 }; rows.set(r.requestId, structuredClone(next)); await flush(); return structuredClone(next);
		},
	};
	await flush();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("shared confirmed delegation coordinator", () => {
	it("shares both orchestrator paths and requires persisted confirmation", async () => {
		const service = coordinator();
		expect(service.taskOrchestrator).toBe(service.projectOrchestrator);
		await expect(service.taskOrchestrator.processTask("project-1", "task-1")).rejects.toThrow("confirmation_required");
		await expect(service.taskOrchestrator.confirm(intent, { ...approved, userId: "" })).rejects.toThrow("confirmation_required");
		expect(calls).toEqual([]);
	});
	it("writes the exact approval and target before any call; survives a crash before submission", async () => {
		const r = await coordinator().taskOrchestrator.confirm(intent, approved);
		expect(calls).toEqual([]);
		expect(r).toMatchObject({ confirmedBy: approved.userId, confirmedAt: approved.at, confirmationId: approved.id, intent, payloadHash: delegationPayloadHash(intent.payload), state: "submitting" });
		const service = await restart();
		await service.projectOrchestrator.processTask("project-1", "task-1");
		expect(calls).toEqual([]);
		await service.projectOrchestrator.process(r.requestId, () => true);
		expect(calls).toEqual([`submit:${r.requestId}`]);
		expect((await journal.get(r.requestId))?.state).toBe("accepted");
	});
	it("reconciles after a crash between attempted write and submission, then replays the same key", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockRejectedValueOnce(new Error("crash before socket write"));
		await expect(service.process(r.requestId, () => true)).rejects.toThrow("crash");
		expect((await journal.get(r.requestId))?.state).toBe("submission_unknown");
		await (await restart()).projectOrchestrator.process(r.requestId, () => true);
		expect(calls).toEqual([`lookup:${r.requestId}`, `submit:${r.requestId}`]);
	});
	it.each(["remote accepted", "local acceptance recording"])("recovers a crash at %s without a duplicate admission", async (window) => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		if (window === "remote accepted") client.delegate.mockImplementationOnce(async () => { accepted = remote; throw new Error("lost response"); });
		else {
			const save = journal.save;
			journal.save = async (record) => { if (record.remote) throw new Error("disk unavailable"); return save(record); };
		}
		await expect(service.process(r.requestId, () => true)).rejects.toThrow();
		const realSave = async (record: DelegationRecord) => { const next = { ...record, version: record.version + 1 }; rows.set(record.requestId, next); await flush(); return next; };
		journal.save = realSave;
		const recovered = await (await restart()).taskOrchestrator.process(r.requestId, () => true);
		expect(recovered).toMatchObject({ state: "accepted", remote });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		expect(client.listDelegations).toHaveBeenCalledWith({ idempotencyKey: r.requestId });
	});
	it("never retries while reconciliation is unavailable", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId, () => true);
		client.listDelegations.mockResolvedValueOnce({ ok: false, code: "unreachable" } as never);
		await (await restart()).taskOrchestrator.process(r.requestId, () => true);
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});
	it("deduplicates task processing and requires a new confirmation for a new rerun key", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		const repeated = await service.confirm(intent, { ...approved, id: "another-confirmation" });
		expect(repeated.requestId).toBe(r.requestId);
		await Promise.all([service.process(r.requestId, () => true), service.process(r.requestId, () => true)]);
		expect(client.delegate).toHaveBeenCalledTimes(1);
		await expect(service.confirm(intent, { ...approved, id: "running-rerun" }, r.requestId)).rejects.toThrow("journal_conflict");
 accepted = { ...remote, status: "completed", terminal: true };
 await service.process(r.requestId, () => true);
 const rerun = await service.confirm(intent, { ...approved, id: "rerun-confirmation" }, r.requestId);
		expect(rerun.requestId).not.toBe(r.requestId);
		expect(await journal.get(r.requestId)).not.toBeNull();
		expect((await service.confirm(intent, { ...approved, id: "rerun-confirmation" }, r.requestId)).requestId).toBe(rerun.requestId);
		await expect(service.confirm(intent, { ...approved, id: "stale-confirmation" }, r.requestId)).rejects.toThrow("journal_conflict");
	});
	it("blocks payload mutation and target mismatch without network submission", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		rows.get(r.requestId)!.intent.payload.task.instructions = "unapproved contents";
		await expect(service.process(r.requestId, () => true)).rejects.toThrow("payload_hash_mismatch");
		expect(calls).toEqual([]);
		await expect(service.confirm({ ...intent, payload: { ...intent.payload, task: { ...intent.payload.task, title: "Changed" } } }, { ...approved, id: "changed" })).rejects.toThrow("journal_conflict");
	});
	it("refuses to use a client bound to a different origin", async () => {
		const r = await coordinator().taskOrchestrator.confirm(intent, approved);
		client.binding = { ...binding, origin: "https://other.example" };
		await expect(coordinator().taskOrchestrator.process(r.requestId, () => true)).rejects.toThrow("connection_changed");
		expect(calls).toEqual([]);
	});
	it("keeps rollout off by default but still reconciles and cancels accepted work", async () => {
		const disabled = coordinator(false).taskOrchestrator;
		await expect(disabled.confirm(intent, approved)).rejects.toThrow("delegations_disabled");
		const r = await coordinator().taskOrchestrator.confirm(intent, approved);
		await disabled.process(r.requestId, () => true); expect(calls).toEqual([]);
		await coordinator().taskOrchestrator.process(r.requestId, () => true);
		const pending = await disabled.cancel(r.requestId, { ...approved, id: "cancel-1" });
		expect(pending.state).toBe("cancellation_requested");
		expect(pending.cancellation).toMatchObject({ id: "cancel-1", userId: "user-1" });
		accepted = { ...remote, status: "cancelled", terminal: true, revision: "cancelled" };
		expect((await (await restart()).taskOrchestrator.process(r.requestId, () => true)).state).toBe("terminal");
	});
	it("reconciles unknown submissions before cancelling by exact remote ID", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockImplementationOnce(async () => { accepted = remote; return { ok: false, code: "timeout" } as never; });
		await service.process(r.requestId, () => true);
		await service.cancel(r.requestId, { ...approved, id: "cancel-1" });
		expect(calls).toEqual([`lookup:${r.requestId}`, `cancel:${remote.delegation_id}`]);
	});
	it("never submits an intent cancelled before admission or an ambiguous cancelled intent missing remotely", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		expect((await service.cancel(r.requestId, { ...approved, id: "cancel-1" })).state).toBe("rejected");
		expect(calls).toEqual([]);
		const next = await service.confirm(intent, { ...approved, id: "rerun" }, r.requestId);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(next.requestId, () => true);
		await service.cancel(next.requestId, { ...approved, id: "cancel-2" });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		expect((await journal.get(next.requestId))?.state).toBe("cancellation_requested");
	});
	it("retains terminal outcomes and prevents a replay rejection from ending an unknown admission", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId, () => true);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "runtime_binding_changed" } as never);
		expect((await service.process(r.requestId, () => true)).state).toBe("submission_unknown");
		accepted = { ...remote, status: "completed", terminal: true };
		expect((await service.process(r.requestId, () => true)).state).toBe("terminal");
		accepted = remote;
		expect((await service.process(r.requestId, () => true)).remote?.status).toBe("completed");
	});
	it("does not submit when durable intent or attempt writes fail", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		journal.save = async () => { throw new Error("disk failure"); };
		await expect(service.process(r.requestId, () => true)).rejects.toThrow("disk failure");
		expect(client.delegate).not.toHaveBeenCalled();
		journal.reserve = async () => { throw new Error("disk failure"); };
		await expect(service.confirm(intent, approved)).rejects.toThrow("disk failure");
		expect(calls).toEqual([]);
	});
	it("reconciles an ambiguous cancellation after restart and preserves the cancellation audit", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		await service.process(r.requestId, () => true);
		client.cancelDelegation.mockImplementationOnce(async () => {
			accepted = { ...remote, terminal: true, status: "cancelled" }; throw new Error("lost cancellation response");
		});
		await expect(service.cancel(r.requestId, { ...approved, id: "cancel-1" })).rejects.toThrow("lost cancellation");
		const recovered = await (await restart()).projectOrchestrator.process(r.requestId, () => true);
		expect(recovered.state).toBe("terminal");
		expect(recovered.cancellation?.id).toBe("cancel-1");
		expect(client.cancelDelegation).toHaveBeenCalledTimes(1);
	});
	it("does not accept a reconciliation record for another profile or runtime", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId, () => true);
		accepted = { ...remote, runtime_id: "90000000-0000-4000-8000-000000000009" };
		await expect(service.process(r.requestId, () => true)).rejects.toThrow("remote_identity_mismatch");
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});

	it("retains a definite first rejection and requires a fresh approval for a rerun", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "runtime_binding_changed" } as never);
		expect(await service.process(r.requestId, () => true)).toMatchObject({ state: "rejected", failureCode: "runtime_binding_changed" });
		await service.process(r.requestId, () => true);
		expect(client.delegate).toHaveBeenCalledTimes(1);
		const rerun = await service.confirm(intent, { ...approved, id: "fresh-preview" }, r.requestId);
		expect(rerun.requestId).not.toBe(r.requestId);
	});
	it("does not retry admission from a paginated or non-unique reconciliation result", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId, () => true);
		client.listDelegations.mockResolvedValueOnce({ ok: true, data: { delegations: [], next_cursor: "more" } } as never);
		await service.process(r.requestId, () => true);
		client.listDelegations.mockResolvedValueOnce({ ok: true, data: { delegations: [remote, remote] } });
		await service.process(r.requestId, () => true);
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});
	it("reconciles cancellation conflicts and uses the latest opaque revision", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		await service.process(r.requestId, () => true);
		client.cancelDelegation.mockResolvedValueOnce({ ok: false, code: "revision_conflict" } as never);
		expect((await service.cancel(r.requestId, { ...approved, id: "cancel-1" })).state).toBe("cancellation_requested");
		accepted = { ...remote, status: "running", revision: "new-opaque-revision" };
		await service.process(r.requestId, () => true);
		expect(client.cancelDelegation).toHaveBeenCalledTimes(1);
		await service.cancel(r.requestId, { ...approved, id: "retry-cancel" });
		expect(client.cancelDelegation).toHaveBeenLastCalledWith(remote.delegation_id, true, "new-opaque-revision", expect.any(Function));
	});

	it("polling never submits or cancels, including empty and paginated unknown lookups", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		await service.reconcile(record.requestId);
		expect(calls).toEqual([]);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(record.requestId, () => true);
		for (const data of [{ delegations: [] }, { delegations: [], next_cursor: "more" }, { delegations: [remote, remote] }]) {
			client.listDelegations.mockResolvedValueOnce({ ok: true, data });
			expect(await service.reconcile(record.requestId)).toMatchObject({ found: false, record: { state: "submission_unknown", remote: null } });
		}
		accepted = remote;
		expect(await service.reconcile(record.requestId)).toMatchObject({ found: true, record: { state: "accepted", remote } });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		expect(client.cancelDelegation).not.toHaveBeenCalled();
	});
	it("retains terminal observations across late cancellation and stale status races", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		await service.process(record.requestId, () => true);
		accepted = { ...remote, status: "completed", terminal: true };
		const results = await Promise.all([service.reconcile(record.requestId), service.cancel(record.requestId, { ...approved, id: "late-cancel" })]);
		expect(results[0]).toMatchObject({ record: { state: "terminal", remote: { status: "completed" } } });
		expect(results[1]).toMatchObject({ state: "terminal", remote: { status: "completed" } });
		accepted = remote;
		expect(await service.reconcile(record.requestId)).toMatchObject({ record: { state: "terminal", remote: { status: "completed" } } });
		expect(client.cancelDelegation).not.toHaveBeenCalled();
	});
	it("does not import execution fields into the journal during reconciliation", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		await service.process(record.requestId, () => true);
		accepted = { ...remote, status: "running", result: "secret-result", error: "secret-error", work_directory: "/secret/work", credentials: "mul_secret" } as PublicDelegation;
		await service.reconcile(record.requestId);
		const contents = await readFile(file, "utf8");
		for (const privateValue of ["secret-result", "secret-error", "/secret/work", "mul_secret"]) expect(contents).not.toContain(privateValue);
	});

});


describe("optional managed delegation policy", () => {
	it("does not mint a confirmation if managed policy is revoked during the local hook", async () => {
		let enter!: () => void, resume!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const resumed = new Promise<void>((resolve) => { resume = resolve; });
		journal.evaluatePolicy = async () => ({ code: "policy_allowed" });
		const proof = vi.fn(confirmations.confirmationProof);
		const services = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true,
			confirmations: { ...confirmations, confirmationProof: proof },
			policy: async () => { enter(); await resumed; return { code: "policy_allowed" }; },
		});
		const result = services.human.confirmFromUserAction(intent, approved);
		const assertion = expect(result).rejects.toThrow(/^policy_denied$/);
		await entered;
		journal.evaluatePolicy = async () => ({ code: "policy_denied" });
		resume();
		await assertion;
		expect(proof).not.toHaveBeenCalled();
		expect(rows.size).toBe(0);
	});
	it("allows personal use without policy and sends only minimum decision metadata", async () => {
		const policy = vi.fn(async () => ({ code: "policy_absent" }));
		journal.evaluatePolicy = policy;
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "accepted" });
		expect(policy).toHaveBeenCalledTimes(3);
		expect(policy.mock.calls[0]).toEqual([{
			serverOrigin: binding.origin, workspaceId: binding.workspaceId, profileId: intent.payload.agent_id,
			runtimeId: intent.payload.expected_runtime_id, runtimeClass: "unknown", dataScopes: ["task_brief"], action: "delegate",
		}]);
		expect(JSON.stringify(policy.mock.calls)).not.toContain(intent.payload.task.instructions);
	});
	it("accepts managed allow with an explicitly resolved runtime class", async () => {
		const resolveRuntimeClass = vi.fn(async () => "remote" as const);
		journal.evaluatePolicy = vi.fn(async (request) => ({ code: request.runtimeClass === "remote" ? "policy_allowed" : "policy_denied" }));
		const service = coordinator(true, { resolveRuntimeClass }).taskOrchestrator;
		const record = await service.confirm(intent, approved);
		expect((await service.process(record.requestId, () => true)).state).toBe("accepted");
		expect(resolveRuntimeClass).toHaveBeenCalledTimes(3);
	});
	it.each(["policy_denied", "policy_unavailable", "policy_runtime_unknown", "policy_location_unsafe"])("blocks proof minting and reservation on %s", async (code) => {
		journal.evaluatePolicy = async () => ({ code });
		const proof = vi.fn(confirmations.confirmationProof);
		const localAllow = vi.fn(async () => ({ code: "policy_allowed" }));
		const service = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true, confirmations: { ...confirmations, confirmationProof: proof }, policy: localAllow });
		await expect(service.human.confirmFromUserAction(intent, approved)).rejects.toThrow(code);
		expect(proof).not.toHaveBeenCalled();
		expect(localAllow).not.toHaveBeenCalled();
		expect(rows.size).toBe(0);
		expect(client.delegate).not.toHaveBeenCalled();
	});
	it("lets plug-ins narrow but never replace managed denials or widen local controls", async () => {
		journal.evaluatePolicy = async () => ({ code: "policy_allowed" });
		await expect(coordinator(true, { policy: async () => ({ code: "policy_denied" }) }).taskOrchestrator.confirm(intent, approved)).rejects.toThrow("policy_denied");
		const service = coordinator(false, { policy: async () => ({ code: "policy_allowed" }) }).taskOrchestrator;
		await expect(service.confirm(intent, approved)).rejects.toThrow("delegations_disabled");
		expect(client.delegate).not.toHaveBeenCalled();
	});
	it.each(["policy_denied", "policy_unavailable", "policy_location_unsafe"])("rechecks policy at dispatch after confirmation: %s", async (code) => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		journal.evaluatePolicy = async () => ({ code });
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "submitting", attempted: false, failureCode: code });
		expect(client.delegate).not.toHaveBeenCalled();
		journal.evaluatePolicy = async () => ({ code: "policy_allowed" });
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "accepted", failureCode: null });
	});
	it("rechecks after the durable attempt marker and does not lose ambiguous submissions", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		let checks = 0;
		journal.evaluatePolicy = async () => ({ code: ++checks === 1 ? "policy_allowed" : "policy_denied" });
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "submission_unknown", failureCode: "policy_denied" });
		expect(calls).toEqual([]);
		accepted = remote;
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "accepted", failureCode: null });
		expect(client.listDelegations).toHaveBeenCalled();
	});
	it("never retries an ambiguous admission when policy is revoked, while retaining cancellation", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(record.requestId, () => true);
		journal.evaluatePolicy = async () => ({ code: "policy_denied" });
		expect(await service.process(record.requestId, () => true)).toMatchObject({ state: "submission_unknown", failureCode: "policy_denied" });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		accepted = remote;
		await service.cancel(record.requestId, { ...approved, id: "cancel" });
		expect(client.cancelDelegation).toHaveBeenCalled();
	});
	it.each([undefined, true, { code: "unknown-private-policy" }, { code: "policy_allowed", raw: "private-policy" }])("fails closed on unknown or unprojected policy outcomes", async (outcome) => {
		journal.evaluatePolicy = async () => outcome;
		await expect(coordinator().taskOrchestrator.confirm(intent, approved)).rejects.toThrow("policy_unavailable");
		expect(rows.size).toBe(0);
	});
	it("does not leak policy exceptions into confirmation errors, journal state or logs", async () => {
		const service = coordinator().taskOrchestrator;
		const record = await service.confirm(intent, approved);
		const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
		journal.evaluatePolicy = async () => { throw new Error("private-policy /secret/path mul_token"); };
		await expect(service.confirm(intent, approved)).rejects.toThrow(/^policy_unavailable$/);
		expect(await service.process(record.requestId, () => true)).toMatchObject({ failureCode: "policy_unavailable" });
		expect(await readFile(file, "utf8")).not.toContain("private-policy");
		expect(logs).not.toHaveBeenCalled();
		logs.mockRestore();
	});
	it("keeps personal use working when runtime metadata is unavailable, but blocks a managed allow", async () => {
		const resolveRuntimeClass = async () => { throw new Error("private runtime lookup error"); };
		const service = coordinator(true, { resolveRuntimeClass }).taskOrchestrator;
		const record = await service.confirm(intent, approved);
		journal.evaluatePolicy = async (request) => ({ code: request.runtimeClass === "unknown" ? "policy_runtime_unknown" : "policy_allowed" });
		expect(await service.process(record.requestId, () => true)).toMatchObject({ failureCode: "policy_runtime_unknown", attempted: false });
		expect(client.delegate).not.toHaveBeenCalled();
	});
	it("bounds a hung plug-in and reports a safe unavailable reason", async () => {
		vi.useFakeTimers();
		try {
			journal.evaluatePolicy = () => new Promise(() => undefined);
			const result = coordinator().taskOrchestrator.confirm(intent, approved);
			const assertion = expect(result).rejects.toThrow(/^policy_unavailable$/);
			await vi.advanceTimersByTimeAsync(5000);
			await assertion;
			expect(rows.size).toBe(0);
		} finally { vi.useRealTimers(); }
	});
});

it.each(["offline", "unauthorized", "rate_limited", "restart"])("monitor reconciliation after %s keeps the original request and sends zero admission POSTs", async (failure) => {
	const record = await coordinator().taskOrchestrator.confirm(intent, approved);
	rows.set(record.requestId, { ...record, attempted: true, state: "submission_unknown" }); await flush();
	if (failure !== "restart") Object.assign(client, { listDelegations: vi.fn(async () => ({ ok: false, code: failure, retryAfterMs: failure === "rate_limited" ? 30_000 : undefined })) });
	let service = await restart();
	await service.taskOrchestrator.reconcile(record.requestId);
	accepted = structuredClone(remote);
	Object.assign(client, { listDelegations: vi.fn(async () => ({ ok: true, data: { delegations: [accepted] } })) });
	service = await restart();
	const recovered = await service.taskOrchestrator.reconcile(record.requestId);
	expect(recovered.record.requestId).toBe(record.requestId);
	expect(recovered.record.remote?.delegation_id).toBe(remote.delegation_id);
	expect(client.delegate).not.toHaveBeenCalled(); expect(client.cancelDelegation).not.toHaveBeenCalled();
	expect(rows.size).toBe(1);
});
