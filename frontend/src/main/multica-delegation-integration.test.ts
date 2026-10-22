import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";
import { createMulticaDelegationCoordinator, type DelegationRecord } from "./multica-delegation-coordinator";
import { createDaemonDelegationJournal } from "./multica-delegation-journal";
import { readMulticaDelegationEnabled, writeMulticaDelegationEnabled } from "./multica-settings";
import { registerDesktopDelegation } from "./multica-delegation-desktop";
import { createMulticaCredentials } from "./multica-credentials";
import { DELEGATION_SETTINGS, DELEGATION_ENABLE_CLICK, DELEGATION_STATUS, DELEGATION_CANCEL_CLICK, DELEGATION_CANCEL_PREVIEW, DELEGATION_CONFIRM_CLICK, DELEGATION_CREDENTIAL, DELEGATION_PREVIEW, DELEGATION_RESULT, type DelegationConfirmationResult } from "../shared/multica-delegation-confirmation";
import type { DelegationSendGuard } from "./multica-delegation-policy";
import type { PublicDelegation } from "./multica-public-api-model";

const key = Buffer.alloc(32, 7);
const authority = createMainProcessDelegationAuthority(key);
let dir: string;
let origin: string;
let child: ChildProcessWithoutNullStreams | undefined;
let fixture: DelegationRecord;

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "ao-delegation-real-journal-"));
	const backend = path.resolve(process.cwd(), "../backend");
	fixture = JSON.parse(await readFile(path.join(backend, "internal/delegationauth/testdata/record.json"), "utf8"));
	const binary = path.join(dir, process.platform === "win32" ? "journal-fixture.exe" : "journal-fixture");
	await promisify(execFile)("go", ["build", "-o", binary, "./internal/httpd/testdata/delegation-journal"], {
		cwd: backend, env: process.env, timeout: 240_000,
	});
	const launched = spawn(binary, [dir], { stdio: "pipe", windowsHide: true });
	child = launched;
	launched.stdin.write(`${JSON.stringify({ browserToken: "test-browser-only", delegationKey: key.toString("base64url") })}\n`);
	origin = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("journal fixture startup timeout")), 20_000);
		const lines = createInterface({ input: launched.stdout });
		lines.on("line", (line) => {
			if (line.startsWith("journal-test-origin:")) { clearTimeout(timer); resolve(line.slice("journal-test-origin:".length)); }
		});
		launched.once("error", (error) => { clearTimeout(timer); reject(error); });
		launched.once("exit", () => { clearTimeout(timer); reject(new Error("journal fixture exited")); });
	});
}, 270_000);
afterAll(async () => {
	if (child && child.exitCode === null) {
		const launched = child;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { launched.kill(); resolve(); }, 5000);
			launched.once("exit", () => { clearTimeout(timer); resolve(); });
			launched.stdin.end();
		});
	}
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function rawRequest(body: object, signed = false) {
	const serialized = JSON.stringify({ requestNonce: randomUUID(), ...body });
	return fetch(`${origin}/internal/multica-delegation-journal`, {
		method: "POST", headers: { "content-type": "application/json", ...(signed ? { "X-AO-Delegation-MAC": authority.requestMAC(serialized) } : {}) }, body: serialized,
	});
}

describe("coordinators against the real daemon SQLite journal", () => {
	it.each([
		["task", "credentials", "cancel"], ["project", "policy", "brief"],
		["task", "policy", "profile"], ["project", "credentials", "close"],
		["task", "none", "none"], ["project", "none", "none"],
		["task", "cancel_credentials", "navigation"], ["project", "cancel_credentials", "credential"],
		["task", "cancel_credentials", "disable"], ["project", "cancel_credentials", "dispose"],
		["task", "credentials", "disable"],
		["task", "retry", "none"], ["project", "retry", "none"],
	] as const)("desktop %s confirmation at %s wait with %s uses the production dispatch path", async (orchestrator, waitAt, revoke) => {
		const payload = fixture.intent.payload;
		const posts: string[] = [];
		const attempts: { key: string; body: string }[] = [];
		const reservations: { proposed: string; returned: string }[] = [];
		const delegationId = randomUUID(), remoteTaskId = randomUUID();
		let cancelled = false;
		const provider = createServer((req, res) => {
			const profile = { agent_id: payload.agent_id, workspace_id: fixture.intent.binding.workspaceId, name: "Reviewer",
				runtime_id: payload.expected_runtime_id, runtime_bound: true, permission_mode: "private", can_invoke: true,
				invocation_targets: [], archived: false, availability: "online" };
			if (req.method === "POST") posts.push(req.url!);
			if (req.url?.endsWith("/cancel")) cancelled = true;
			const data = waitAt === "retry" && req.url?.startsWith("/api/v1/delegations?") ? { delegations: [] } : req.url?.startsWith("/api/v1/agents/") ? profile : req.url?.startsWith("/api/v1/runtimes/") ? {
				runtime_id: payload.expected_runtime_id, workspace_id: fixture.intent.binding.workspaceId, availability: "online",
			} : { delegation_id: delegationId, task_id: remoteTaskId, workspace_id: fixture.intent.binding.workspaceId,
				agent_id: payload.agent_id, runtime_id: payload.expected_runtime_id, status: cancelled ? "cancelled" : "queued", terminal: cancelled,
				result: "private-result", error: "private-error", work_directory: "/private/work",
				revision: "first", created_at: new Date().toISOString() };
			const respond = () => {
				res.writeHead(req.method === "POST" && !req.url?.endsWith("/cancel") ? 202 : 200, { "content-type": "application/json" });
				res.end(JSON.stringify(data));
			};
			if (waitAt === "retry" && req.method === "POST" && req.url === "/api/v1/delegations") {
				let body = "";
				req.on("data", (chunk) => { body += String(chunk); });
				req.on("end", () => {
					attempts.push({ key: String(req.headers["idempotency-key"]), body });
					if (attempts.length === 1) { req.socket.destroy(); return; }
					respond();
				});
			} else respond();
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
		const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
		const frame = {};
		const results: DelegationConfirmationResult[] = [];
		const listeners: ((...args: unknown[]) => void)[] = [];
		const shell = { id: 7, mainFrame: frame, isDestroyed: () => false, isFocused: () => true,
			on: (_name: string, listener: (...args: unknown[]) => void) => listeners.push(listener), removeListener: () => undefined,
			send: (channel: string, value: { result: DelegationConfirmationResult }) => { if (channel === DELEGATION_RESULT) results.push(value.result); } };
		const event = { sender: { id: shell.id }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
		const credentials = createMulticaCredentials({ stateDir: path.join(dir, randomUUID()),
			vault: { isProtected: () => false, encrypt: () => { throw new Error("must not encrypt"); }, decrypt: () => { throw new Error("must not decrypt"); } },
			readProfileConfig: async () => null });
		let armed = false;
		let held = false;
		let cancelArmed = false, cancelRead = false;
		let release!: () => void;
		const resumed = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const paused = new Promise<void>((resolve) => { entered = resolve; });
		const resolveCredential = credentials.resolve;
		credentials.resolve = async (...args) => {
			if (((armed && waitAt === "credentials") || (waitAt === "cancel_credentials" && cancelArmed && cancelRead)) && !held) { held = true; entered(); await resumed; }
			return resolveCredential(...args);
		};
		const confirm = vi.fn(async () => true);
		const confirmCancellation = vi.fn(async () => false);
		const confirmEnable = vi.fn(async () => true);
		const settingsDir = path.join(dir, randomUUID());
		const register = () => registerDesktopDelegation({
			ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: () => undefined } as unknown as IpcMain,
			shellWebContents: shell as unknown as WebContents, authority, credentials, daemonOrigin: () => origin,
			readEnabled: () => readMulticaDelegationEnabled(settingsDir), writeEnabled: (enabled) => writeMulticaDelegationEnabled(settingsDir, enabled),
			readSettings: async () => ({ mode: "local", customUrl: providerOrigin, apiUrl: providerOrigin }), confirm, confirmCancellation, confirmEnable,
			fetch: async (input, init) => {
				if (String(input).startsWith(origin) && init?.body) {
					const request = JSON.parse(String(init.body)) as { operation: string; record?: DelegationRecord };
					if (request.operation === "save" && request.record?.attempted) armed = true;
					const response = await fetch(input, init);
					if (waitAt === "retry" && request.operation === "reserve" && request.record) {
						const value = await response.clone().json() as { record: DelegationRecord };
						reservations.push({ proposed: request.record.requestId, returned: value.record.requestId });
					}
					if (armed && request.operation === "evaluatePolicy" && waitAt === "policy" && !held) { held = true; entered(); await resumed; }
					return response;
				}
				if (cancelArmed && String(input) === `${providerOrigin}/api/v1/delegations/${delegationId}`) cancelRead = true;
				return fetch(input, init);
			},
		});
		let desktop = register();
		try {
			expect(await handlers.get(DELEGATION_CREDENTIAL)!(event, fixture.intent.binding.workspaceId, "mul_FIXTUREdesktop0001")).toBe(true);
			const draft = { orchestrator, workspaceId: fixture.intent.binding.workspaceId, profileId: payload.agent_id, runtimeId: payload.expected_runtime_id,
				projectId: payload.source.project_id, taskId: randomUUID(), title: payload.task.title, brief: payload.task.instructions };
			expect(await handlers.get(DELEGATION_SETTINGS)!(event)).toEqual({ enabled: false });
			expect(await handlers.get(DELEGATION_PREVIEW)!(event, draft)).toEqual({ ok: false, code: "delegations_disabled" });
			expect(posts).toEqual([]);
			await handlers.get(DELEGATION_ENABLE_CLICK)!(event, true);
			expect(confirmEnable).toHaveBeenCalledOnce();
			const value = await handlers.get(DELEGATION_PREVIEW)!(event, draft) as DelegationConfirmationResult;
			if (!value.ok || !("preview" in value)) throw new Error(JSON.stringify(value));
			const processing = handlers.get(DELEGATION_CONFIRM_CLICK)!(event, { id: value.preview.id, hash: value.preview.hash });
			if (waitAt === "credentials" || waitAt === "policy") {
				await paused;
				expect(confirm).toHaveBeenCalledOnce();
				expect(await createDaemonDelegationJournal(() => origin, authority).find(draft.projectId, draft.taskId)).toMatchObject({ attempted: true, state: "submission_unknown" });
				if (revoke === "brief" || revoke === "profile") {
					const replacing = handlers.get(DELEGATION_PREVIEW)!(event, { ...draft, ...(revoke === "brief" ? { brief: "Changed brief" } : { profileId: randomUUID() }) });
					release();
					await replacing;
				} else if (revoke === "disable") await handlers.get(DELEGATION_ENABLE_CLICK)!(event, false);
				else await handlers.get(DELEGATION_CANCEL_PREVIEW)!(event, value.preview.id);
				release();
			}
			await processing;
			if (waitAt === "retry") {
				const journal = createDaemonDelegationJournal(() => origin, authority);
				const unknown = await journal.find(draft.projectId, draft.taskId);
				expect(unknown).toMatchObject({ state: "submission_unknown", attempted: true, remote: null });
				expect(results).toEqual([{ ok: true, requestId: unknown!.requestId, state: "submission_unknown" }]);
				await handlers.get(DELEGATION_CONFIRM_CLICK)!(event, { id: value.preview.id, hash: value.preview.hash });
				expect(results.at(-1)).toEqual({ ok: false, code: "confirmation_required" });
				expect(confirm).toHaveBeenCalledOnce(); expect(posts).toHaveLength(1);
				desktop.dispose(); desktop = register();
				expect(await handlers.get(DELEGATION_SETTINGS)!(event)).toEqual({ enabled: true });
				expect(confirmEnable).toHaveBeenCalledOnce();
				expect(await handlers.get(DELEGATION_STATUS)!(event, draft.projectId, draft.taskId)).toMatchObject({ status: { requestId: unknown!.requestId, state: "submission_unknown" } });
				expect(posts).toHaveLength(1);
				const retryPreview = async () => {
					const next = await handlers.get(DELEGATION_PREVIEW)!(event, draft) as DelegationConfirmationResult;
					if (!next.ok || !("preview" in next)) throw new Error(JSON.stringify(next));
					expect(next.preview.id).not.toBe(value.preview.id);
					return next.preview;
				};
				const declined = await retryPreview();
				confirm.mockResolvedValueOnce(false);
				await handlers.get(DELEGATION_CONFIRM_CLICK)!(event, { id: declined.id, hash: declined.hash });
				expect(results.at(-1)).toEqual({ ok: false, code: "cancelled" });
				expect(posts).toHaveLength(1); expect(reservations).toHaveLength(1);
				const approved = await retryPreview();
				await handlers.get(DELEGATION_CONFIRM_CLICK)!(event, { id: approved.id, hash: approved.hash });
				expect(results.at(-1)).toEqual({ ok: true, requestId: unknown!.requestId, state: "accepted" });
				expect(confirm).toHaveBeenCalledTimes(3);
				expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
				expect(attempts[1].key).toBe(unknown!.requestId);
				expect(JSON.parse(attempts[1].body)).toEqual(unknown!.intent.payload);
				expect(reservations).toHaveLength(2);
				expect(reservations[1].proposed).not.toBe(unknown!.requestId);
				expect(reservations.map((entry) => entry.returned)).toEqual([unknown!.requestId, unknown!.requestId]);
				expect(await journal.find(draft.projectId, draft.taskId)).toMatchObject({ requestId: unknown!.requestId, confirmationId: unknown!.confirmationId, state: "accepted", remote: { delegation_id: delegationId, task_id: remoteTaskId } });
				return;
			}
			if (revoke === "none" || waitAt === "cancel_credentials") {
				expect(posts).toEqual(["/api/v1/delegations"]);
				expect(results).toEqual([expect.objectContaining({ ok: true, state: "accepted" })]);
				const observed = await handlers.get(DELEGATION_STATUS)!(event, draft.projectId, draft.taskId) as { status: { requestId: string; remoteId: string } };
				expect(observed.status).toMatchObject({ state: "accepted", remoteId: delegationId, remoteStatus: "queued" });
				for (const privateValue of ["private-result", "private-error", "/private/work", draft.brief]) expect(JSON.stringify(observed)).not.toContain(privateValue);
				const cancellation = { requestId: observed.status.requestId, remoteId: delegationId };
				await handlers.get(DELEGATION_CANCEL_CLICK)!(event, cancellation);
				expect(posts).toEqual(["/api/v1/delegations"]);
				confirmCancellation.mockImplementationOnce(async () => { cancelArmed = true; return true; });
				const cancelling = handlers.get(DELEGATION_CANCEL_CLICK)!(event, cancellation);
				if (waitAt === "cancel_credentials") {
					await paused;
					expect(confirmCancellation).toHaveBeenCalledTimes(2);
					expect(await createDaemonDelegationJournal(() => origin, authority).get(cancellation.requestId)).toMatchObject({ state: "cancellation_requested", cancellation: { userId: "desktop-user" } });
					if (revoke === "navigation") for (const listener of listeners.values()) listener({}, "app://shell", false, true);
					if (revoke === "credential") await handlers.get(DELEGATION_CREDENTIAL)!(event, draft.workspaceId, "mul_REPLACEMENTcredential");
					if (revoke === "disable") await handlers.get(DELEGATION_ENABLE_CLICK)!(event, false);
					if (revoke === "dispose") desktop.dispose();
					release();
					await cancelling;
					expect(posts).toEqual(["/api/v1/delegations"]);
					return;
				}
				await cancelling;
				expect(posts).toEqual(["/api/v1/delegations", `/api/v1/delegations/${delegationId}/cancel`]);
				expect(await handlers.get(DELEGATION_STATUS)!(event, draft.projectId, draft.taskId)).toMatchObject({ status: { state: "terminal", remoteStatus: "cancelled" } });
			} else {
				expect(posts).toEqual([]);
				expect(results).toEqual([{ ok: false, code: revoke === "disable" ? "delegations_disabled" : "confirmation_required" }]);
			}
		} finally {
			release(); desktop.dispose(); provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	}, 30_000);
	it.each(["task", "project"] as const)("persists and dispatches the %s preview only after user approval", async (orchestrator) => {
		const binding = fixture.intent.binding;
		const payload = fixture.intent.payload;
		const taskId = `confirmation-flow-${orchestrator}`;
		const journal = createDaemonDelegationJournal(() => origin, authority);
		const remote: PublicDelegation = { delegation_id: randomUUID(), task_id: randomUUID(), workspace_id: binding.workspaceId,
			agent_id: payload.agent_id, runtime_id: payload.expected_runtime_id, status: "queued", terminal: false,
			revision: "first", created_at: new Date().toISOString() };
		const client = {
			binding,
			getAgent: async () => ({ ok: true as const, data: { agent_id: payload.agent_id, workspace_id: binding.workspaceId, name: "Reviewer",
				runtime_id: payload.expected_runtime_id, runtime_bound: true, permission_mode: "private", can_invoke: true, invocation_targets: [], archived: false, availability: "online" as const } }),
			getRuntime: async () => ({ ok: true as const, data: { runtime_id: payload.expected_runtime_id, workspace_id: binding.workspaceId, availability: "online" as const } }),
			delegate: vi.fn(async (_payload: unknown, _key: string, _confirmed: boolean, guard: DelegationSendGuard) => {
				const code = await guard(); return code ? { ok: false as const, code } : { ok: true as const, data: remote };
			}),
			getDelegation: async () => ({ ok: true as const, data: remote }),
			listDelegations: async () => ({ ok: true as const, data: { delegations: [] } }),
			cancelDelegation: async () => ({ ok: true as const, data: remote }),
		};
		const coordinator = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true, confirmations: authority });
		const confirm = vi.fn(async () => false);
		const flow = createDelegationConfirmationFlow({ ...coordinator, client: async () => client, policy: journal.evaluatePolicy, confirm });
		const draft = { orchestrator, workspaceId: binding.workspaceId, profileId: payload.agent_id, runtimeId: payload.expected_runtime_id,
			projectId: payload.source.project_id, taskId, title: payload.task.title, brief: payload.task.instructions };
		let result = await flow.preview(draft);
		if (!result.ok || !("preview" in result)) throw new Error(JSON.stringify(result));
		expect(await journal.find(draft.projectId, taskId)).toBeNull();
		expect(await flow.confirmFromRendererAction(result.preview.id, result.preview.hash)).toEqual({ ok: false, code: "cancelled" });
		expect(await journal.find(draft.projectId, taskId)).toBeNull();
		expect(client.delegate).not.toHaveBeenCalled();
		confirm.mockResolvedValue(true);
		result = await flow.preview(draft);
		if (!result.ok || !("preview" in result)) throw new Error(JSON.stringify(result));
		const preview = result.preview;
		expect(await flow.confirmFromRendererAction(preview.id, preview.hash)).toMatchObject({ ok: true, state: "accepted" });
		expect(await journal.find(draft.projectId, taskId)).toMatchObject({ confirmedBy: "desktop-user", intent: { binding,
			payload: { ...payload, source: { ...payload.source, task_id: taskId } } }, state: "accepted", remote });
		expect(await flow.confirmFromRendererAction(preview.id, preview.hash)).toEqual({ ok: false, code: "confirmation_required" });
		expect(client.delegate).toHaveBeenCalledOnce();
	});
	it("rejects forged HTTP confirmations and saves even with a matching payload hash", async () => {
		expect((await rawRequest({ operation: "reserve", record: fixture })).status).toBe(403);
		expect((await rawRequest({ operation: "save", record: fixture })).status).toBe(403);
		const forged = createMainProcessDelegationAuthority(Buffer.alloc(32, 8));
		expect((await rawRequest({ operation: "reserve", record: fixture, confirmationProof: forged.confirmationProof(fixture) }, true)).status).toBe(403);
		const journal = createDaemonDelegationJournal(() => origin, authority);
		expect(await journal.get(fixture.requestId)).toBeNull();
	});
	it("deduplicates independent coordinators and blocks a rerun of running work", async () => {
		const binding = fixture.intent.binding;
		let remote: PublicDelegation = {
			delegation_id: "40000000-0000-4000-8000-000000000004", task_id: "50000000-0000-4000-8000-000000000005", workspace_id: binding.workspaceId,
			agent_id: fixture.intent.payload.agent_id, runtime_id: fixture.intent.payload.expected_runtime_id, status: "running", terminal: false,
			revision: "opaque-1", created_at: "2026-10-21T12:00:00Z",
		};
		const admitted = new Map<string, PublicDelegation>();
		const client = {
			binding,
			delegate: vi.fn(async (_payload: unknown, requestId: string, _confirmed: boolean, guard: DelegationSendGuard) => { const code = await guard(); if (code) return { ok: false as const, code }; admitted.set(requestId, remote); return { ok: true as const, data: remote }; }),
			listDelegations: vi.fn(async (query: { idempotencyKey?: string } = {}) => ({ ok: true as const, data: { delegations: admitted.has(query.idempotencyKey ?? "") ? [remote] : [] } })),
			getDelegation: vi.fn(async () => ({ ok: true as const, data: remote })),
			cancelDelegation: vi.fn(async () => ({ ok: true as const, data: remote })),
		};
		const make = () => createMulticaDelegationCoordinator({ journal: createDaemonDelegationJournal(() => origin, authority), client: () => client, enabled: true, confirmations: authority });
		const first = make(), second = make();
		expect(first.taskOrchestrator).not.toHaveProperty("confirm");
		expect(first.projectOrchestrator).not.toHaveProperty("cancel");
		const approval = { id: "real-confirmation", userId: "human-user", at: "2026-10-21T12:00:00Z" };
		const confirmed = await Promise.all([first.human.confirmFromUserAction(fixture.intent, approval), second.human.confirmFromUserAction(fixture.intent, approval)]);
		expect(confirmed[0].requestId).toBe(confirmed[1].requestId);
		const id = confirmed[0].requestId;
		const processed = await Promise.allSettled([first.taskOrchestrator.process(id, () => true), second.taskOrchestrator.process(id, () => true)]);
		expect(processed.some((result) => result.status === "fulfilled")).toBe(true);
		await second.taskOrchestrator.process(id, () => true);
		expect(admitted.size).toBe(1);
		expect([...admitted.keys()]).toEqual([id]);
		await expect(second.human.confirmFromUserAction(fixture.intent, { ...approval, id: "blocked-rerun" }, id)).rejects.toThrow("journal_conflict");
		expect(admitted.size).toBe(1);
		remote = { ...remote, status: "completed", terminal: true, revision: "done" };
		await first.taskOrchestrator.process(id, () => true);
		const rerun = await second.human.confirmFromUserAction(fixture.intent, { ...approval, id: "terminal-rerun" }, id);
		expect(rerun.requestId).not.toBe(id);
		const calls = client.delegate.mock.calls.length;
		await first.taskOrchestrator.process(id, () => true);
		expect(client.delegate.mock.calls).toHaveLength(calls);
	});
	it("rejects signed records with unknown nested fields or escaped secrets", async () => {
		const extra = { ...fixture, intent: { ...fixture.intent, debug: "unapproved" } };
		expect((await rawRequest({ operation: "reserve", record: extra, confirmationProof: authority.confirmationProof(fixture) }, true)).status).toBe(403);
		const secret = { ...fixture, confirmedBy: "mul_hidden" };
		const serialized = JSON.stringify({ requestNonce: randomUUID(), operation: "reserve", record: secret, confirmationProof: authority.confirmationProof(secret) }).replace("mul_hidden", "\\u006dul_hidden");
		const response = await fetch(`${origin}/internal/multica-delegation-journal`, { method: "POST", headers: { "content-type": "application/json", "X-AO-Delegation-MAC": authority.requestMAC(serialized) }, body: serialized });
		expect(response.status).toBe(403);
	});
	it("enforces changing policy decisions through the authenticated existing journal channel", async () => {
		const managed = path.join(dir, "policy-decision.json");
		await mkdir(path.dirname(managed), { recursive: true });
		const journal = createDaemonDelegationJournal(() => origin, authority);
		const target = fixture.intent;
		const policy = {
			version: 1, revision: "private-company-policy", validUntil: new Date(Date.now() + 60000).toISOString(), effect: "deny",
			serverOrigins: [target.binding.origin], workspaceIds: [target.binding.workspaceId], profileIds: [target.payload.agent_id],
			runtimeClasses: ["local"], dataScopes: ["task_brief"], actions: ["delegate"],
		};
		const client = { binding: target.binding, delegate: vi.fn(), getDelegation: vi.fn(), listDelegations: vi.fn(), cancelDelegation: vi.fn() };
		const services = createMulticaDelegationCoordinator({ journal, client: () => client, enabled: true, confirmations: authority, resolveRuntimeClass: async () => "local" });
		const approval = { id: "policy-confirmation", userId: "human", at: "2026-10-21T12:00:00Z" };
		const intent = { ...target, payload: { ...target.payload, source: { ...target.payload.source, task_id: "policy-task" } } };
		try {
			await writeFile(managed, JSON.stringify({ code: "policy_denied", privatePolicy: policy }));
			await expect(services.human.confirmFromUserAction(intent, approval)).rejects.toThrow(/^policy_denied$/);
			await writeFile(managed, JSON.stringify({ code: "policy_allowed", privatePolicy: policy }));
			const confirmed = await services.human.confirmFromUserAction(intent, approval);
			await writeFile(managed, JSON.stringify({ code: "policy_denied", privatePolicy: policy }));
			expect(await services.taskOrchestrator.process(confirmed.requestId, () => true)).toMatchObject({ failureCode: "policy_denied", attempted: false });
			expect(client.delegate).not.toHaveBeenCalled();
			expect(JSON.stringify(await journal.get(confirmed.requestId))).not.toContain("private-company-policy");
			const response = await rawRequest({ operation: "evaluatePolicy", policyRequest: {
				serverOrigin: target.binding.origin, workspaceId: target.binding.workspaceId, profileId: target.payload.agent_id,
				runtimeId: target.payload.expected_runtime_id, runtimeClass: "local", dataScopes: ["task_brief"], action: "delegate",
			} }, true);
			expect(await response.json()).toEqual({ record: { code: "policy_denied" } });
			expect((await rawRequest({ operation: "evaluatePolicy" })).status).toBe(403);
		} finally { await rm(managed, { force: true }); }
	});

});
