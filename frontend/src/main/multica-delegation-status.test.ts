import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegationStatusFlow } from "./multica-delegation-status";
import type { DelegationRecord, DelegationReconciliation } from "./multica-delegation-coordinator";

function fixture() {
	let record: DelegationRecord = {
		requestId: "request", projectId: "project", taskId: "task", confirmationId: "approval", confirmedBy: "desktop-user", confirmedAt: "2026-10-22T00:00:00Z", rerunOf: "",
		payloadHash: "hash", version: 1, attempted: true, state: "submission_unknown", remote: null, cancellation: null, failureCode: null,
		intent: { binding: { serverKey: "configured", origin: "https://multica.example", workspaceId: "workspace" },
			payload: { agent_id: "profile", expected_runtime_id: "runtime", source: { system: "ao", project_id: "project", task_id: "task" }, task: { title: "Title", instructions: "private brief" } } },
	};
	const remote = { delegation_id: "remote", task_id: "remote-task", workspace_id: "workspace", agent_id: "profile", runtime_id: "runtime", status: "running" as const, terminal: false, revision: "opaque", created_at: "2026-10-22T00:00:00Z" };
	const journal = { find: vi.fn(async () => structuredClone(record)), get: vi.fn(async () => structuredClone(record)) };
	const reconcile = vi.fn(async (): Promise<DelegationReconciliation> => ({ record: structuredClone(record), found: !!record.remote }));
	const human = { cancelFromUserAction: vi.fn(async () => { record = { ...record, state: "cancellation_requested", cancellation: { id: "cancel", userId: "desktop-user", at: record.confirmedAt } }; return record; }) };
	const prepare = vi.fn(async () => undefined);
	const confirmCancellation = vi.fn(async () => true);
	const flow = createDelegationStatusFlow({ journal, coordinator: { reconcile }, human, prepare, confirmCancellation });
	return { flow, reconcile, human, prepare, confirmCancellation, journal,
		accept() { record = { ...record, version: 2, state: "accepted", remote }; },
		finish() { record = { ...record, version: record.version + 1, state: "terminal", remote: { ...remote, status: "completed", terminal: true } }; },
		get record() { return record; } };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => { vi.useFakeTimers(); f = fixture(); });
afterEach(() => { f.flow.dispose(); vi.useRealTimers(); });

describe("read-only delegation status polling", () => {
	it("reconciles unknown submissions with backoff, then polls accepted work and stops at terminal", async () => {
		expect(await f.flow.status("project", "task")).toMatchObject({ ok: true, status: { state: "submission_unknown", remoteId: null } });
		await vi.advanceTimersByTimeAsync(3999); expect(f.reconcile).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); expect(f.reconcile).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(7999); expect(f.reconcile).toHaveBeenCalledTimes(2);
		f.accept(); await vi.advanceTimersByTimeAsync(1);
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { state: "accepted", remoteId: "remote", remoteStatus: "running" } });
		f.finish(); await vi.advanceTimersByTimeAsync(2000);
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { terminal: true, remoteStatus: "completed" } });
		const count = f.reconcile.mock.calls.length; await vi.advanceTimersByTimeAsync(300_000);
		expect(f.reconcile).toHaveBeenCalledTimes(count);
		expect(f.human.cancelFromUserAction).not.toHaveBeenCalled();
	});
	it("shows acceptance and terminal journal updates immediately without bypassing remote backoff", async () => {
		await f.flow.status("project", "task");
		f.accept();
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { state: "accepted", remoteId: "remote" } });
		f.finish();
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { state: "terminal", remoteStatus: "completed" } });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.reconcile).toHaveBeenCalledTimes(1);
	});

	it("honors Retry-After and caps exponential backoff without hot-looping on repeated UI reads", async () => {
		f.reconcile.mockImplementation(async () => ({ record: f.record, found: false, failure: { ok: false, code: "rate_limited", retryAfterMs: 30_000 } }));
		await f.flow.status("project", "task");
		for (let i = 0; i < 10; i++) await f.flow.status("project", "task");
		await vi.advanceTimersByTimeAsync(29_999); expect(f.reconcile).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); expect(f.reconcile).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(92_000);
		const count = f.reconcile.mock.calls.length;
		await vi.advanceTimersByTimeAsync(59_999); expect(f.reconcile).toHaveBeenCalledTimes(count);
		await vi.advanceTimersByTimeAsync(1); expect(f.reconcile).toHaveBeenCalledTimes(count + 1);
	});
	it.each(["invalid_token", "no_token", "unauthorized", "insufficient_scope"] as const)("pauses on %s and resumes only after workspace credential replacement", async (code) => {
		f.reconcile.mockResolvedValueOnce({ record: f.record, found: false, failure: { ok: false, code } });
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { connection: "reauthentication_required", state: "submission_unknown" } });
		await vi.advanceTimersByTimeAsync(300_000); await f.flow.status("project", "task");
		f.flow.resume("another-workspace"); await vi.advanceTimersByTimeAsync(0);
		expect(f.reconcile).toHaveBeenCalledTimes(1);
		f.accept(); f.flow.resume("workspace"); await vi.advanceTimersByTimeAsync(0);
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { connection: "current", state: "accepted" } });
	});
	it("stops before status I/O when the configured server binding changes", async () => {
		f.prepare.mockRejectedValueOnce(new Error("connection_changed"));
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { connection: "connection_changed", state: "submission_unknown" } });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(f.reconcile).not.toHaveBeenCalled();
	});

	it("drops execution contents and intent from the renderer projection", async () => {
		f.accept();
		Object.assign(f.record.remote!, { result: "private-result", error: "private-error", work_directory: "/private/work", branch: "private-branch", credentials: "mul_secret" });
		const result = await f.flow.status("project", "task");
		const data = JSON.stringify(result);
		for (const value of ["private-result", "private-error", "/private/work", "private-branch", "mul_secret", "private brief", "instructions", "confirmedBy"]) expect(data).not.toContain(value);
	});
	it("does not overlap polls or return stale responses after invalidation", async () => {
		let resolve!: (value: DelegationReconciliation) => void;
		f.reconcile.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
		const pending = f.flow.status("project", "task"); await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(60_000); expect(f.reconcile).toHaveBeenCalledTimes(1);
		f.flow.invalidate(); resolve({ record: f.record, found: false });
		expect(await pending).toEqual({ ok: false, code: "connection_changed" });
		await vi.advanceTimersByTimeAsync(60_000); expect(f.reconcile).toHaveBeenCalledTimes(1);
	});
});

describe("main-only cancellation confirmation", () => {
	it("binds approval to the remote ID, keeps cancellation pending and never cancels from polling", async () => {
		f.accept(); await f.flow.status("project", "task");
		expect(f.human.cancelFromUserAction).not.toHaveBeenCalled();
		expect(await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "wrong" })).toMatchObject({ ok: false });
		expect(f.confirmCancellation).not.toHaveBeenCalled();
		expect(await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" })).toEqual({ ok: true });
		expect(f.human.cancelFromUserAction).toHaveBeenCalledWith("request", expect.objectContaining({ userId: "desktop-user" }), expect.any(Function), "remote");
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { state: "cancellation_requested", remoteStatus: "running", terminal: false } });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.human.cancelFromUserAction).toHaveBeenCalledTimes(1);
		f.finish(); await vi.advanceTimersByTimeAsync(2000);
		expect(await f.flow.status("project", "task")).toMatchObject({ status: { state: "terminal", remoteStatus: "completed" } });
	});
	it("does nothing when native confirmation is declined or invalidated by navigation", async () => {
		f.accept(); f.confirmCancellation.mockResolvedValueOnce(false);
		await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" });
		expect(f.human.cancelFromUserAction).not.toHaveBeenCalled();
		f.confirmCancellation.mockImplementationOnce(async () => { f.flow.invalidate(); return true; });
		await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" });
		expect(f.human.cancelFromUserAction).not.toHaveBeenCalled();
	});
	it("rejects unknown and terminal records and suppresses double clicks", async () => {
		await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" });
		expect(f.confirmCancellation).not.toHaveBeenCalled();
		f.accept();
		const first = f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" });
		await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" }); await first;
		expect(f.confirmCancellation).toHaveBeenCalledTimes(1);
		f.finish(); await f.flow.cancelFromRendererAction({ requestId: "request", remoteId: "remote" });
		expect(f.confirmCancellation).toHaveBeenCalledTimes(1);
	});
});
