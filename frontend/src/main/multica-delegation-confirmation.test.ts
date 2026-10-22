import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";
import { createDelegationConfirmationTokens } from "./multica-delegation-confirmation-tokens";
import type { DelegationRecord } from "./multica-delegation-coordinator";
import type { DelegationConfirmationGuard } from "./multica-delegation-policy";
import type { DelegationDraft, DelegationPreview } from "../shared/multica-delegation-confirmation";

const draft: DelegationDraft = { orchestrator: "task", projectId: "project", taskId: "task", title: "Review", brief: "Review only these instructions.",
	workspaceId: "10000000-0000-4000-8000-000000000001", profileId: "20000000-0000-4000-8000-000000000002", runtimeId: "30000000-0000-4000-8000-000000000003" };
const binding = { serverKey: "configured", origin: "https://multica.example", workspaceId: draft.workspaceId };
let time: number;
let profile: { agent_id: string; workspace_id: string; name: string; runtime_id: string; runtime_bound: boolean; permission_mode: string; can_invoke: boolean; invocation_targets: []; archived: boolean; availability: "online" };
let setup: ReturnType<typeof fixture>;
function fixture() {
	const record = { requestId: "request", state: "accepted", failureCode: null } as DelegationRecord;
	const client = { binding: { ...binding }, getAgent: vi.fn(async () => ({ ok: true as const, data: { ...profile } })),
		getRuntime: vi.fn(async () => ({ ok: true as const, data: { runtime_id: draft.runtimeId, workspace_id: draft.workspaceId, availability: "online" as const } })) };
	const options = { client: vi.fn(async () => client), policy: vi.fn(async (): Promise<unknown> => ({ code: "policy_absent" })),
		human: { confirmFromUserAction: vi.fn(async () => record), cancelFromUserAction: vi.fn(async () => record) },
		taskOrchestrator: { process: vi.fn(async (_id: string, _confirmationCurrent?: DelegationConfirmationGuard) => record), processTask: vi.fn(async () => record) },
		projectOrchestrator: { process: vi.fn(async (_id: string, _confirmationCurrent?: DelegationConfirmationGuard) => record), processTask: vi.fn(async () => record) },
		confirm: vi.fn(async () => true), now: () => time };
	return { options, client, flow: createDelegationConfirmationFlow(options) };
}
async function preview(input = draft): Promise<DelegationPreview> {
	const result = await setup.flow.preview(input);
	expect(result.ok).toBe(true);
	if (!result.ok || !("preview" in result)) throw new Error("missing preview");
	return result.preview;
}
beforeEach(() => {
	time = Date.now();
	profile = { agent_id: draft.profileId, workspace_id: draft.workspaceId, name: "Reviewer", runtime_id: draft.runtimeId,
		runtime_bound: true, permission_mode: "private", can_invoke: true, invocation_targets: [], archived: false, availability: "online" };
	setup = fixture();
});

describe("shared delegation confirmation", () => {
	it.each(["task", "project"] as const)("dispatches from the %s orchestrator only after explicit confirmation", async (orchestrator) => {
		const p = await preview({ ...draft, orchestrator });
		expect(p).toMatchObject({ serverOrigin: binding.origin, profileName: "Reviewer", scope: "task_brief", policy: "policy_absent" });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
		expect(setup.options.taskOrchestrator.process).not.toHaveBeenCalled();
		expect(setup.options.projectOrchestrator.process).not.toHaveBeenCalled();
		setup.options.confirm.mockImplementationOnce(async () => {
			expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled(); return true;
		});
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toMatchObject({ ok: true, state: "accepted" });
		expect(setup.options[orchestrator === "task" ? "taskOrchestrator" : "projectOrchestrator"].process).toHaveBeenCalledExactlyOnceWith("request", expect.any(Function));
		expect(setup.options.confirm.mock.calls[0]).toBeDefined();
		const approval = setup.options.human.confirmFromUserAction.mock.calls;
		expect(JSON.stringify(approval)).not.toContain("token");
	});
	it("requires a fresh confirmation after cancellation and consumes approvals once", async () => {
		let p = await preview(); setup.flow.cancel(p.id);
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		p = await preview(); setup.options.confirm.mockResolvedValueOnce(false);
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "cancelled" });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
		p = await preview(); await setup.flow.confirmFromRendererAction(p.id, p.hash);
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		expect(setup.options.human.confirmFromUserAction).toHaveBeenCalledTimes(1);
	});
	it.each(["profileId", "runtimeId", "workspaceId", "title", "brief", "taskId", "projectId"] as const)("changes to %s require another preview", async (field) => {
		const p = await preview();
		const replacement = { ...draft, [field]: field.endsWith("Id") && !["projectId", "taskId"].includes(field) ? "90000000-0000-4000-8000-000000000009" : "changed" };
		const changed = await setup.flow.preview(replacement);
		if (changed.ok && "preview" in changed) expect(changed.preview.hash).not.toBe(p.hash);
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
	});
	it("blocks runtime rebindings and profile changes after preview and during native approval", async () => {
		let p = await preview(); profile.runtime_id = "90000000-0000-4000-8000-000000000009";
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "runtime_binding_changed" });
		profile.runtime_id = draft.runtimeId; p = await preview();
		setup.options.confirm.mockImplementationOnce(async () => { profile.name = "Changed"; return true; });
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "preview_changed" });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
	});
	it("surfaces an admission binding conflict and requires another preview", async () => {
		const p = await preview();
		setup.options.taskOrchestrator.process.mockResolvedValueOnce({ requestId: "request", state: "rejected", failureCode: "runtime_binding_changed" } as DelegationRecord);
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "runtime_binding_changed" });
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		expect(setup.options.taskOrchestrator.process).toHaveBeenCalledOnce();
	});
	it.each(["policy_denied", "policy_unavailable", "unknown", "policy_runtime_unknown", "policy_location_unsafe"])("blocks %s without leaking policy content", async (code) => {
		setup.options.policy.mockResolvedValue({ code, content: "private policy contents" });
		expect(await setup.flow.preview(draft)).toEqual({ ok: false, code: "policy_unavailable" });
		setup.options.policy.mockResolvedValue({ code });
		const result = await setup.flow.preview(draft);
		expect(result).toEqual({ ok: false, code: code === "unknown" ? "policy_unavailable" : code });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
	});
	it("blocks policy changes, cancellation, or expiry during approval", async () => {
		let p = await preview(); setup.options.policy.mockResolvedValueOnce({ code: "policy_denied" });
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "policy_denied" });
		p = await preview(); setup.options.confirm.mockImplementationOnce(async () => { setup.flow.cancel(p.id); return true; });
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		p = await preview(); time = p.expiresAt;
		expect(await setup.flow.confirmFromRendererAction(p.id, p.hash)).toEqual({ ok: false, code: "confirmation_required" });
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
	});
	it("rejects forged previews, extra scopes and forged approval fields", async () => {
		expect(await setup.flow.confirmFromRendererAction("forged", "forged")).toEqual({ ok: false, code: "confirmation_required" });
		for (const extra of [{ token: "forged" }, { confirmed: true }, { dataScopes: ["repository"] }, { context: "files" }]) {
			expect(await setup.flow.preview({ ...draft, ...extra })).toEqual({ ok: false, code: "confirmation_required" });
		}
		expect(setup.options.human.confirmFromUserAction).not.toHaveBeenCalled();
	});
});

it("main-process tokens reject forgery, replay, expiration and a changed request hash", () => {
	const tokens = createDelegationConfirmationTokens(() => time);
	expect(tokens.consume("forged", "request")).toBe(false);
	let token = tokens.mint("request", time + 120_000);
	expect(tokens.consume(token, "request")).toBe(true);
	expect(tokens.consume(token, "request")).toBe(false);
	token = tokens.mint("request", time + 120_000);
	expect(tokens.consume(token, "changed")).toBe(false);
	expect(tokens.consume(token, "request")).toBe(false);
	token = tokens.mint("request", time + 120_000); time += 10_000;
	expect(tokens.consume(token, "request")).toBe(false);
	token = tokens.mint("request", time + 1); time++;
	expect(tokens.consume(token, "request")).toBe(false);
});
