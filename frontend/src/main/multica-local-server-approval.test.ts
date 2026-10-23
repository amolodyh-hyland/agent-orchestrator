import { describe, expect, it, vi } from "vitest";
import { approveLocalServerLogs, approveLocalServerMutation } from "./multica-local-server-approval";
import type { ProjectApprovalRequest } from "./multica-local-server-preflight";

const request: ProjectApprovalRequest = { action: "restart", stackDir: "/new/stack", digest: "digest", plan: { services: [], volumes: [], networks: [] }, snapshot: { endpoint: "unix:///engine.sock", engineId: "engine-1234", containers: [], volumes: ["multica_pgdata"], networks: [], resources: [] } };

function dialogs(responses: number[], verify = vi.fn(async () => undefined)) {
	return { show: vi.fn(async () => ({ response: responses.shift() ?? 0 })), chooseReceipt: vi.fn(async () => "/private/recovery.json"), verify };
}

describe("native project approval", () => {
	it("defaults to cancel and cannot approve by merely choosing a receipt", async () => {
		const cancelled = dialogs([0]);
		expect(await approveLocalServerMutation(request, cancelled)).toBeNull();
		expect(cancelled.chooseReceipt).not.toHaveBeenCalled();
		const selected = dialogs([1, 0]);
		expect(await approveLocalServerMutation(request, selected)).toBeNull();
		expect(selected.verify).toHaveBeenCalledWith("/private/recovery.json", "digest");
		expect(selected.show.mock.calls).toHaveLength(2);
	});

	it("binds explicit takeover/downtime approval to action and snapshot", async () => {
		const native = dialogs([1, 1]);
		expect(await approveLocalServerMutation(request, native)).toEqual({ action: "restart", digest: "digest", recoveryReceipt: "/private/recovery.json" });
		expect(native.show).toHaveBeenLastCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ["Cancel", "Approve takeover and downtime"], detail: expect.stringContaining("multica_pgdata") }));
	});

	it("never presents approval for invalid recovery evidence", async () => {
		const native = dialogs([1, 1], vi.fn(async () => { throw new Error("missing backup"); }));
		expect(await approveLocalServerMutation(request, native)).toBeNull();
		expect(native.show).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", buttons: ["OK"] }));
	});
});


describe("native log read approval", () => {
	it("defaults to cancel and warns about existing-project sign-in codes", async () => {
		const native = dialogs([0]);
		expect(await approveLocalServerLogs({ stackDir: "/new/stack", snapshot: request.snapshot, digest: "snapshot", service: "backend", tail: 20 }, native)).toBe(false);
		expect(native.show).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ["Cancel", "Read logs"], detail: expect.stringContaining("sign-in codes") }));
	});
});
