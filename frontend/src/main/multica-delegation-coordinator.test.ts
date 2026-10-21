import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMulticaDelegationCoordinator, delegationPayloadHash, type DelegationRecord, type DelegationJournal, type DelegationIntent } from "./multica-delegation-coordinator";
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
		delegate: vi.fn(async (_payload: unknown, key: string) => { calls.push(`submit:${key}`); accepted = structuredClone(remote); return { ok: true as const, data: accepted }; }),
		listDelegations: vi.fn(async ({ idempotencyKey }: { idempotencyKey?: string } = {}) => { calls.push(`lookup:${idempotencyKey}`); return { ok: true as const, data: { delegations: accepted ? [accepted] : [] } }; }),
		getDelegation: vi.fn(async (id: string) => { calls.push(`status:${id}`); return { ok: true as const, data: accepted! }; }),
		cancelDelegation: vi.fn(async (id: string) => { calls.push(`cancel:${id}`); return { ok: true as const, data: accepted! }; }),
	};
}
function coordinator(enabled = true) { return createMulticaDelegationCoordinator({ journal, client: () => client, enabled }); }
async function flush() { await writeFile(file, JSON.stringify([...rows])); }
async function restart() { rows = new Map(JSON.parse(await readFile(file, "utf8"))); return coordinator(); }
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-delegation-")); file = path.join(dir, "journal.json");
	rows = new Map(); calls = []; accepted = null; client = fakeClient();
	journal = {
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
			if ((existing?.requestId ?? "") !== r.rerunOf) throw new Error("journal_conflict");
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
		expect(calls).toEqual([`submit:${r.requestId}`]);
		expect((await journal.get(r.requestId))?.state).toBe("accepted");
	});
	it("reconciles after a crash between attempted write and submission, then replays the same key", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockRejectedValueOnce(new Error("crash before socket write"));
		await expect(service.process(r.requestId)).rejects.toThrow("crash");
		expect((await journal.get(r.requestId))?.state).toBe("submission_unknown");
		await (await restart()).projectOrchestrator.process(r.requestId);
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
		await expect(service.process(r.requestId)).rejects.toThrow();
		const realSave = async (record: DelegationRecord) => { const next = { ...record, version: record.version + 1 }; rows.set(record.requestId, next); await flush(); return next; };
		journal.save = realSave;
		const recovered = await (await restart()).taskOrchestrator.process(r.requestId);
		expect(recovered).toMatchObject({ state: "accepted", remote });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		expect(client.listDelegations).toHaveBeenCalledWith({ idempotencyKey: r.requestId });
	});
	it("never retries while reconciliation is unavailable", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId);
		client.listDelegations.mockResolvedValueOnce({ ok: false, code: "unreachable" } as never);
		await (await restart()).taskOrchestrator.process(r.requestId);
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});
	it("deduplicates task processing and requires a new confirmation for a new rerun key", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		const repeated = await service.confirm(intent, { ...approved, id: "another-confirmation" });
		expect(repeated.requestId).toBe(r.requestId);
		await Promise.all([service.process(r.requestId), service.process(r.requestId)]);
		expect(client.delegate).toHaveBeenCalledTimes(1);
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
		await expect(service.process(r.requestId)).rejects.toThrow("payload_hash_mismatch");
		expect(calls).toEqual([]);
		await expect(service.confirm({ ...intent, payload: { ...intent.payload, task: { ...intent.payload.task, title: "Changed" } } }, { ...approved, id: "changed" })).rejects.toThrow("journal_conflict");
	});
	it("refuses to use a client bound to a different origin", async () => {
		const r = await coordinator().taskOrchestrator.confirm(intent, approved);
		client.binding = { ...binding, origin: "https://other.example" };
		await expect(coordinator().taskOrchestrator.process(r.requestId)).rejects.toThrow("connection_changed");
		expect(calls).toEqual([]);
	});
	it("keeps rollout off by default but still reconciles and cancels accepted work", async () => {
		const disabled = createMulticaDelegationCoordinator({ journal, client: () => client }).taskOrchestrator;
		const r = await disabled.confirm(intent, approved);
		await disabled.process(r.requestId); expect(calls).toEqual([]);
		await coordinator().taskOrchestrator.process(r.requestId);
		const pending = await disabled.cancel(r.requestId, { ...approved, id: "cancel-1" });
		expect(pending.state).toBe("cancellation_requested");
		expect(pending.cancellation).toMatchObject({ id: "cancel-1", userId: "user-1" });
		accepted = { ...remote, status: "cancelled", terminal: true, revision: "cancelled" };
		expect((await (await restart()).taskOrchestrator.process(r.requestId)).state).toBe("terminal");
	});
	it("reconciles unknown submissions before cancelling by exact remote ID", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockImplementationOnce(async () => { accepted = remote; return { ok: false, code: "timeout" } as never; });
		await service.process(r.requestId);
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
		await service.process(next.requestId);
		await service.cancel(next.requestId, { ...approved, id: "cancel-2" });
		expect(client.delegate).toHaveBeenCalledTimes(1);
		expect((await journal.get(next.requestId))?.state).toBe("cancellation_requested");
	});
	it("retains terminal outcomes and prevents a replay rejection from ending an unknown admission", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "runtime_binding_changed" } as never);
		expect((await service.process(r.requestId)).state).toBe("submission_unknown");
		accepted = { ...remote, status: "completed", terminal: true };
		expect((await service.process(r.requestId)).state).toBe("terminal");
		accepted = remote;
		expect((await service.process(r.requestId)).remote?.status).toBe("completed");
	});
	it("does not submit when durable intent or attempt writes fail", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		journal.save = async () => { throw new Error("disk failure"); };
		await expect(service.process(r.requestId)).rejects.toThrow("disk failure");
		expect(client.delegate).not.toHaveBeenCalled();
		journal.reserve = async () => { throw new Error("disk failure"); };
		await expect(service.confirm(intent, approved)).rejects.toThrow("disk failure");
		expect(calls).toEqual([]);
	});
	it("reconciles an ambiguous cancellation after restart and preserves the cancellation audit", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		await service.process(r.requestId);
		client.cancelDelegation.mockImplementationOnce(async () => {
			accepted = { ...remote, terminal: true, status: "cancelled" }; throw new Error("lost cancellation response");
		});
		await expect(service.cancel(r.requestId, { ...approved, id: "cancel-1" })).rejects.toThrow("lost cancellation");
		const recovered = await (await restart()).projectOrchestrator.process(r.requestId);
		expect(recovered.state).toBe("terminal");
		expect(recovered.cancellation?.id).toBe("cancel-1");
		expect(client.cancelDelegation).toHaveBeenCalledTimes(1);
	});
	it("does not accept a reconciliation record for another profile or runtime", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId);
		accepted = { ...remote, runtime_id: "90000000-0000-4000-8000-000000000009" };
		await expect(service.process(r.requestId)).rejects.toThrow("remote_identity_mismatch");
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});

	it("retains a definite first rejection and requires a fresh approval for a rerun", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "runtime_binding_changed" } as never);
		expect(await service.process(r.requestId)).toMatchObject({ state: "rejected", failureCode: "runtime_binding_changed" });
		await service.process(r.requestId);
		expect(client.delegate).toHaveBeenCalledTimes(1);
		const rerun = await service.confirm(intent, { ...approved, id: "fresh-preview" }, r.requestId);
		expect(rerun.requestId).not.toBe(r.requestId);
	});
	it("does not retry admission from a paginated or non-unique reconciliation result", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		client.delegate.mockResolvedValueOnce({ ok: false, code: "timeout" } as never);
		await service.process(r.requestId);
		client.listDelegations.mockResolvedValueOnce({ ok: true, data: { delegations: [], next_cursor: "more" } } as never);
		await service.process(r.requestId);
		client.listDelegations.mockResolvedValueOnce({ ok: true, data: { delegations: [remote, remote] } });
		await service.process(r.requestId);
		expect(client.delegate).toHaveBeenCalledTimes(1);
	});
	it("reconciles cancellation conflicts and uses the latest opaque revision", async () => {
		const service = coordinator().taskOrchestrator;
		const r = await service.confirm(intent, approved);
		await service.process(r.requestId);
		client.cancelDelegation.mockResolvedValueOnce({ ok: false, code: "revision_conflict" } as never);
		expect((await service.cancel(r.requestId, { ...approved, id: "cancel-1" })).state).toBe("cancellation_requested");
		accepted = { ...remote, status: "running", revision: "new-opaque-revision" };
		await service.process(r.requestId);
		expect(client.cancelDelegation).toHaveBeenLastCalledWith(remote.delegation_id, true, "new-opaque-revision");
	});

});
