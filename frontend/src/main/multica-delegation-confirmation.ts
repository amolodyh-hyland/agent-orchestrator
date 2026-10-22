import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { delegationFailureLabels, delegationPolicyLabels, type DelegationDraft, type DelegationPreview, type DelegationConfirmationResult } from "../shared/multica-delegation-confirmation";
import type { DelegationIntent, MainProcessDelegationActions, MulticaDelegationCoordinator } from "./multica-delegation-coordinator";
import { delegationPolicyDecision, resolveDelegationRuntime, type DelegationPolicyResolver, type DelegationRuntimeResolver } from "./multica-delegation-policy";
import { createDelegation, uuid } from "./multica-public-api-model";
import type { createMulticaPublicApi } from "./multica-public-api";
import { createDelegationConfirmationTokens } from "./multica-delegation-confirmation-tokens";

type Client = Pick<ReturnType<typeof createMulticaPublicApi>, "binding" | "getAgent" | "getRuntime">;
type Entry = { preview: DelegationPreview; intent: DelegationIntent; pending: boolean };
type Options = {
	client: (workspaceId: string) => Promise<Client>;
	policy: DelegationPolicyResolver;
	resolveRuntimeClass?: DelegationRuntimeResolver;
	human: MainProcessDelegationActions;
	taskOrchestrator: MulticaDelegationCoordinator;
	projectOrchestrator: MulticaDelegationCoordinator;
	confirm: (preview: DelegationPreview, detail: string) => Promise<boolean>;
	now?: () => number;
};
const TTL_MS = 120_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeFailure = (error: unknown): DelegationConfirmationResult => ({ ok: false,
	code: error instanceof Error && Object.hasOwn(delegationFailureLabels, error.message) ? error.message : "confirmation_required",
});

function draftOf(input: unknown): DelegationDraft {
	if (!input || typeof input !== "object") throw new Error("confirmation_required");
	const d = input as DelegationDraft;
	if (d.orchestrator !== "task" && d.orchestrator !== "project") throw new Error("confirmation_required");
	const payload = createDelegation({ agent_id: d.profileId, expected_runtime_id: d.runtimeId,
		source: { system: "ao", project_id: d.projectId, task_id: d.taskId }, task: { title: d.title, instructions: d.brief } });
	const result: DelegationDraft = { orchestrator: d.orchestrator, workspaceId: uuid(d.workspaceId),
		profileId: payload.agent_id, runtimeId: payload.expected_runtime_id, projectId: payload.source.project_id,
		taskId: payload.source.task_id, title: payload.task.title, brief: payload.task.instructions };
	if (!isDeepStrictEqual(result, input) || /(?:mul_|mat_|mcn_|mpi_|mpc_)[A-Za-z0-9_-]+/.test(JSON.stringify(result))) throw new Error("confirmation_required");
	return result;
}

export function delegationConfirmationDetail(p: DelegationPreview): string {
	return [`Profile: ${p.profileName} (${p.request.profileId})`, `Bound runtime: ${p.request.runtimeId}`,
		`Server: ${p.serverOrigin} (${p.serverKey})`, `Workspace: ${p.request.workspaceId}`,
		`AO project: ${p.request.projectId}`, `AO task: ${p.request.taskId}`,
		`Policy source: ${delegationPolicyLabels[p.policy]}`,
		"Approved scope: task brief and AO project/task identifiers only. No files, roots, attachments or history.",
		`Title: ${p.request.title}`, `Task brief:\n${p.request.brief}`].join("\n\n");
}

export function createDelegationConfirmationFlow(options: Options) {
	const now = options.now ?? Date.now;
	const previews = new Map<string, Entry>();
	const tokens = createDelegationConfirmationTokens(now);
	let disposed = false;
	function current(entry: Entry) {
		if (disposed || previews.get(entry.preview.id) !== entry || entry.preview.expiresAt <= now()) throw new Error("confirmation_required");
	}
	async function validate(entry: Entry) {
		current(entry);
		const client = await options.client(entry.preview.request.workspaceId);
		if (!isDeepStrictEqual(client.binding, entry.intent.binding)) throw new Error("connection_changed");
		const profile = await client.getAgent(entry.intent.payload.agent_id);
		if (!profile.ok) throw new Error(profile.code);
		if (profile.data.runtime_id !== entry.intent.payload.expected_runtime_id) throw new Error("runtime_binding_changed");
		if (!profile.data.runtime_bound || !profile.data.can_invoke || profile.data.archived || profile.data.availability !== "online") throw new Error("target_unavailable");
		if (profile.data.name !== entry.preview.profileName) throw new Error("preview_changed");
		const runtime = await client.getRuntime(entry.intent.payload.expected_runtime_id);
		if (!runtime.ok) throw new Error(runtime.code);
		if (runtime.data.availability !== "online") throw new Error("target_unavailable");
		const runtimeClass = await resolveDelegationRuntime(options.resolveRuntimeClass, client.binding, runtime.data.runtime_id);
		const decision = await delegationPolicyDecision(options.policy, Object.freeze({
			serverOrigin: client.binding.origin, workspaceId: client.binding.workspaceId,
			profileId: profile.data.agent_id, runtimeId: runtime.data.runtime_id, runtimeClass,
			dataScopes: Object.freeze(["task_brief"] as const), action: "delegate",
		}));
		if (decision !== "policy_allowed" && decision !== "policy_absent") throw new Error(decision);
		current(entry);
		return decision;
	}
	return {
		async preview(input: unknown): Promise<DelegationConfirmationResult> {
			try {
				if (disposed) throw new Error("confirmation_required");
				const request = draftOf(input);
				const client = await options.client(request.workspaceId);
				if (client.binding.workspaceId !== request.workspaceId) throw new Error("connection_changed");
				const profile = await client.getAgent(request.profileId);
				if (!profile.ok) throw new Error(profile.code);
				for (const [id, e] of previews) {
					if (e.preview.expiresAt <= now() || (e.preview.request.projectId === request.projectId && e.preview.request.taskId === request.taskId)) previews.delete(id);
				}
				if (previews.size >= 64) throw new Error("confirmation_required");
				const intent: DelegationIntent = { binding: { ...client.binding }, payload: createDelegation({
					agent_id: request.profileId, expected_runtime_id: request.runtimeId,
					source: { system: "ao", project_id: request.projectId, task_id: request.taskId }, task: { title: request.title, instructions: request.brief },
				}) };
				const preview: DelegationPreview = { id: randomUUID(), hash: "", expiresAt: now() + TTL_MS, request,
					serverKey: client.binding.serverKey, serverOrigin: client.binding.origin, profileName: profile.data.name,
					scope: "task_brief", policy: "policy_absent" };
				const entry: Entry = { intent, preview, pending: false };
				previews.set(preview.id, entry);
				try { preview.policy = await validate(entry); }
				catch (error) { previews.delete(preview.id); throw error; }
				preview.hash = digest({ intent, request, scope: preview.scope, policy: preview.policy, profileName: preview.profileName });
				return { ok: true, preview: structuredClone(preview) };
			} catch (error) { return safeFailure(error); }
		},
		cancel(id: string) { previews.delete(id); },
		async confirmFromRendererAction(id: string, hash: string): Promise<DelegationConfirmationResult> {
			const entry = previews.get(id);
			if (!entry || entry.pending || entry.preview.hash !== hash) return { ok: false, code: "confirmation_required" };
			entry.pending = true;
			try {
				if (await validate(entry) !== entry.preview.policy) throw new Error("preview_changed");
				if (!await options.confirm(structuredClone(entry.preview), delegationConfirmationDetail(entry.preview))) return { ok: false, code: "cancelled" };
				if (await validate(entry) !== entry.preview.policy) throw new Error("preview_changed");
				const token = tokens.mint(hash, entry.preview.expiresAt);
				if (!tokens.consume(token, entry.preview.hash)) throw new Error("confirmation_required");
				const record = await options.human.confirmFromUserAction(structuredClone(entry.intent), {
					id: randomUUID(), userId: "desktop-user", at: new Date(now()).toISOString(),
				});
				current(entry);
				const coordinator = entry.preview.request.orchestrator === "task" ? options.taskOrchestrator : options.projectOrchestrator;
				const result = await coordinator.process(record.requestId);
				if (result.failureCode) throw new Error(result.failureCode);
				return { ok: true, requestId: result.requestId, state: result.state };
			} catch (error) { return safeFailure(error); }
			finally { previews.delete(id); }
		},
		invalidate() { previews.clear(); tokens.clear(); },
		dispose() { disposed = true; previews.clear(); tokens.clear(); },
	};
}
