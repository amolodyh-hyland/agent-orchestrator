import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import contract from "../../../test/contracts/multica-delegation-v1.json";
import { resolveMulticaServer } from "../shared/multica";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";
import { createMulticaDelegationCoordinator, type DelegationJournal, type DelegationRecord } from "./multica-delegation-coordinator";
import type { MulticaCredentials } from "./multica-credentials";
import { createMulticaPublicApi } from "./multica-public-api";

function setup() {
	const server = resolveMulticaServer({ mode: "local", customUrl: "http://contract.local", apiUrl: "http://contract.local" })!;
	const rows = new Map<string, DelegationRecord>();
	const admissions = new Map<string, string>();
	const posts: { path: string; key: string | null; body?: unknown }[] = [];
	let state: keyof typeof contract.states = "queued";
	let loseResponse = false, emptyLookups = 0, denied = false;
	const journal: DelegationJournal = {
		evaluatePolicy: async () => ({ code: denied ? "policy_denied" : "policy_absent" }),
		get: async (id) => structuredClone(rows.get(id) ?? null),
		find: async (project, task) => structuredClone([...rows.values()].find((r) => r.projectId === project && r.taskId === task) ?? null),
		reserve: async (record) => {
			const existing = await journal.find(record.projectId, record.taskId);
			if (existing) { expect(existing.intent).toEqual(record.intent); return existing; }
			rows.set(record.requestId, structuredClone(record)); return structuredClone(record);
		},
		save: async (record) => {
			expect(rows.get(record.requestId)?.version).toBe(record.version);
			const next = { ...record, version: record.version + 1 };
			rows.set(next.requestId, structuredClone(next)); return structuredClone(next);
		},
	};
	const transport = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		expect(url.origin).toBe(server.config.apiUrl);
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer mul_CONTRACTcredential");
		expect(headers.get("X-Workspace-ID")).toBe(contract.workspace_id);
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		if (init?.method === "POST") {
			posts.push({ path: url.pathname, key: headers.get("Idempotency-Key"), body: init.body ? JSON.parse(String(init.body)) : undefined });
			const row = [...rows.values()][0];
			expect(row.confirmedBy).toBe("desktop-user");
			if (url.pathname.endsWith("/cancel")) {
				expect(url.pathname).toBe(`/api/v1/delegations/${contract.states.queued.delegation_id}/cancel`);
				expect(headers.get("If-Match")).toBe(`"${contract.states[state].revision}"`);
				expect(row.state).toBe("cancellation_requested");
				state = "cancelled"; return reply(contract.states.cancelled);
			}
			expect(url.pathname).toBe("/api/v1/delegations");
			expect(posts.at(-1)?.body).toEqual(contract.payload);
			expect(row).toMatchObject({ requestId: headers.get("Idempotency-Key"), attempted: true, state: "submission_unknown" });
			const key = headers.get("Idempotency-Key")!;
			const replay = admissions.has(key);
			if (replay) expect(admissions.get(key)).toBe(String(init.body));
			admissions.set(key, String(init.body));
			if (loseResponse) { loseResponse = false; throw new Error("response lost after acceptance"); }
			return reply(contract.states[state], replay ? 200 : 202);
		}
		if (url.pathname === "/api/v1/agents") return reply({ agents: [contract.profile] });
		if (url.pathname === `/api/v1/agents/${contract.profile.agent_id}`) return reply(contract.profile);
		if (url.pathname === `/api/v1/runtimes/${contract.runtime.runtime_id}`) return reply(contract.runtime);
		if (url.pathname === "/api/v1/delegations") {
			expect(url.searchParams.get("idempotency_key")).toBe([...rows.keys()][0]);
			return reply({ delegations: emptyLookups-- > 0 ? [] : [contract.states[state]] });
		}
		expect(url.pathname).toBe(`/api/v1/delegations/${contract.states.queued.delegation_id}`);
		return reply(contract.states[state]);
	});
	const client = createMulticaPublicApi({ server, workspaceId: contract.workspace_id, getConfiguredServer: () => server,
		credentials: { resolve: async () => ({ ok: true, token: "mul_CONTRACTcredential" }) } as unknown as MulticaCredentials,
		delegationsEnabled: true, fetch: transport });
	const services = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true,
		confirmations: createMainProcessDelegationAuthority(Buffer.alloc(32, 7)) });
	const confirm = vi.fn(async () => true);
	const flow = createDelegationConfirmationFlow({ ...services, client: async () => client, policy: journal.evaluatePolicy, confirm });
	const draft = { orchestrator: "task" as const, workspaceId: contract.workspace_id, profileId: contract.payload.agent_id,
		runtimeId: contract.payload.expected_runtime_id, projectId: contract.payload.source.project_id, taskId: contract.payload.source.task_id,
		title: contract.payload.task.title, brief: contract.payload.task.instructions };
	async function submit() {
		const preview = await flow.preview(draft);
		if (!preview.ok || !("preview" in preview)) return preview;
		return flow.confirmFromRendererAction(preview.preview.id, preview.preview.hash);
	}
	return { ...services, client, rows, posts, admissions, flow, confirm, draft, transport, submit,
		state: (next: typeof state) => { state = next; }, denied: () => { denied = true; },
		lose: (empty = 0) => { loseResponse = true; emptyLookups = empty; } };
}

describe("Multica delegation v1 shared contract", () => {
	it("uses the identical versioned fixture when the peer checkout is supplied", () => {
		expect(contract.version).toBe(1);
		if (process.env.MULTICA_CONTRACT_FIXTURE) expect(JSON.parse(readFileSync(process.env.MULTICA_CONTRACT_FIXTURE, "utf8"))).toEqual(contract);
	});
	it.each(contract.scenarios)("$id", async (scenario) => {
		const f = setup();
		try {
			switch (scenario.id) {
				case "profile_discovery":
					expect(await f.client.listAgents()).toEqual({ ok: true, data: { agents: [contract.profile] } });
					expect(await f.client.getRuntime(contract.runtime.runtime_id)).toEqual({ ok: true, data: contract.runtime });
					break;
				case "confirmed_submission":
					f.confirm.mockResolvedValueOnce(false);
					expect(await f.submit()).toEqual({ ok: false, code: "cancelled" });
					expect(f.rows.size).toBe(0); expect(f.posts).toEqual([]);
					expect(await f.submit()).toMatchObject({ ok: true, state: "accepted" });
					expect(f.posts).toHaveLength(1);
					break;
				case "idempotent_retry": {
					f.lose(2);
					expect(await f.submit()).toMatchObject({ ok: true, state: "submission_unknown" });
					const id = [...f.rows.keys()][0];
					await f.projectOrchestrator.processTask(f.draft.projectId, f.draft.taskId);
					expect(f.posts).toHaveLength(1);
					expect(await f.submit()).toMatchObject({ ok: true, requestId: id, state: "accepted" });
					expect(f.confirm).toHaveBeenCalledTimes(2); expect(f.rows.size).toBe(1);
					expect(f.posts).toHaveLength(2); expect(f.posts[0]).toEqual(f.posts[1]);
					expect(f.admissions.size).toBe(1);
					break;
				}
				case "status_reconciliation": {
					f.lose(); await f.submit(); const id = [...f.rows.keys()][0];
					f.state("running");
					expect(await f.projectOrchestrator.reconcile(id)).toMatchObject({ found: true, record: { state: "accepted", remote: contract.states.running } });
					f.state("completed"); await f.taskOrchestrator.reconcile(id);
					f.state("queued");
					expect(await f.taskOrchestrator.reconcile(id)).toMatchObject({ record: { state: "terminal", remote: contract.states.completed } });
					expect(f.posts).toHaveLength(1);
					break;
				}
				case "policy_denial":
					f.denied(); expect(await f.submit()).toEqual({ ok: false, code: scenario.policy_code });
					expect(f.posts).toHaveLength(scenario.expected_posts!); expect(f.rows.size).toBe(0);
					break;
				case "cancellation": {
					await f.submit(); const id = [...f.rows.keys()][0];
					expect(await f.human.cancelFromUserAction(id, { id: "cancel", userId: "desktop-user", at: contract.states.queued.created_at }, () => true, contract.states.queued.delegation_id)).toMatchObject({ state: "terminal", remote: contract.states.cancelled });
					expect(f.posts).toHaveLength(2); break;
				}
				default: throw new Error(`unverified scenario: ${scenario.id}`);
			}
		} finally { f.flow.dispose(); }
	});
});
