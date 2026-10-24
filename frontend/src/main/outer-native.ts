import { createHash, randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	OUTER_STAGE,
	OUTER_CANCEL,
	OUTER_USER_ACTION,
	OUTER_RESULT,
	OUTER_READ,
	type OuterNativeDraft,
	type OuterStage,
	type OuterReadQuery,
	type OuterReadResponse,
} from "../shared/outer-native";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import { validOuterDesktopRequest } from "../shared/outer-desktop";

const controls = new Set([
	"desktop.control",
	"session.spawn",
	"orchestrator.ensure",
	"session.send",
	"session.restore",
	"session.resume",
	"session.kill",
	"session.switch",
	"chat.send",
	"chat.settings",
	"chat.approval",
	"chat.input",
	"chat.cancel",
	"project.settings",
	"project.config",
	"project.permissions",
	"task.prepare",
	"run.create",
	"run.evidence",
	"run.advance",
	"review.trigger",
	"review.cancel",
	"pr.merge",
	"pr.resolve",
	"terminal.bind",
]);
function validDraft(value: unknown): value is OuterNativeDraft {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return false;
	const v = value as Record<string, unknown>;
	const keys = Object.keys(v).sort().join(",");
	switch (v.operation) {
		case "plan":
			return (
				keys === "digest,operation,planId" &&
				typeof v.planId === "string" &&
				v.planId.length >= 16 && v.planId.length <= 128 &&
				typeof v.digest === "string" && /^[a-f0-9]{64}$/.test(v.digest)
			);
		case "send": {
			if (
				!v.expected ||
				typeof v.expected !== "object" ||
				Array.isArray(v.expected)
			)
				return false;
			const expected = v.expected as Record<string, unknown>;
			return (
				keys === "expected,operation,sessionId,text" &&
				Object.keys(expected).sort().join(",") ===
					"bindingRevision,controllerGeneration,scopeRevision,settingsDigest" &&
				Number.isSafeInteger(expected.bindingRevision) &&
				(expected.bindingRevision as number) > 0 &&
				Number.isSafeInteger(expected.scopeRevision) &&
				(expected.scopeRevision as number) > 0 &&
				typeof expected.controllerGeneration === "string" &&
				expected.controllerGeneration.length > 0 &&
				expected.controllerGeneration.length < 256 &&
				typeof expected.settingsDigest === "string" &&
				/^[a-f0-9]{64}$/.test(expected.settingsDigest) &&
				typeof v.sessionId === "string" &&
				v.sessionId.length > 0 &&
				v.sessionId.length < 256 &&
				typeof v.text === "string" &&
				v.text.trim().length > 0 &&
				Buffer.byteLength(v.text) <= 64 << 10
			);
		}
		case "setup":
			return (
				keys === "config,operation" &&
				!!v.config &&
				typeof v.config === "object" &&
				!Array.isArray(v.config)
			);
		case "scope":
			return (
				keys ===
					"foregroundReserve,operation,paused,projectIds,revision" &&
				Number.isSafeInteger(v.revision) &&
				(v.revision as number) > 0 &&
				typeof v.paused === "boolean" &&
				typeof v.foregroundReserve === "boolean" &&
				Array.isArray(v.projectIds) &&
				v.projectIds.length <= 32 &&
				v.projectIds.every(
					(id) =>
						typeof id === "string" &&
						id.length > 0 &&
						id.length < 256
				)
			);
		case "control": {
			if (
				keys !== "control,operation" ||
				!v.control ||
				typeof v.control !== "object" ||
				Array.isArray(v.control)
			)
				return false;
			const c = v.control as Record<string, unknown>;
			if (
				c.action === "desktop.control" &&
				(c.targetId !== "" ||
					c.pendingId !== undefined ||
					c.generation !== undefined ||
					!validOuterDesktopRequest(c.body))
			)
				return false;
			return (
				Object.keys(c).every((k) =>
					[
						"action",
						"targetId",
						"pendingId",
						"generation",
						"body",
					].includes(k)
				) &&
				controls.has(String(c.action)) &&
				typeof c.targetId === "string" &&
				c.targetId.length < 256 &&
				(c.pendingId === undefined ||
					(typeof c.pendingId === "string" &&
						c.pendingId.length < 256)) &&
				(c.generation === undefined ||
					(typeof c.generation === "string" &&
						c.generation.length < 256)) &&
				c.body !== undefined
			);
		}
		default:
			return false;
	}
}

function validRead(value: unknown): value is OuterReadQuery {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return false;
	const v = value as Record<string, unknown>;
	const keys = Object.keys(v).sort().join(",");
	if (v.projection === "view") return keys === "projection";
	if (v.projection === "facts")
		return (
			keys === "kind,limit,projectId,projection" &&
			typeof v.projectId === "string" &&
			v.projectId.trim().length > 0 &&
			v.projectId.length <= 256 &&
			["reports", "sessions", "runs"].includes(String(v.kind)) &&
			Number.isSafeInteger(v.limit) &&
			Number(v.limit) >= 1 &&
			Number(v.limit) <= 50
		);
	return (
		v.projection === "audit" &&
		(keys === "after,limit,projection" ||
			(keys === "after,limit,projectId,projection" &&
				typeof v.projectId === "string" &&
				v.projectId.trim().length > 0 &&
				v.projectId.length <= 256)) &&
		Number.isSafeInteger(v.after) &&
		Number(v.after) >= 0 &&
		Number.isSafeInteger(v.limit) &&
		Number(v.limit) >= 1 &&
		Number(v.limit) <= 100
	);
}

async function verifiedOuterRecord(
	response: Response,
	mac: string,
	authority: MainProcessDelegationAuthority
): Promise<unknown> {
	if (!response.ok || !response.body) throw new Error("outer_held");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4 << 20) throw new Error("outer_held");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const raw = new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks)
	);
	if (
		!authority.verifyResponseMAC(
			raw,
			mac,
			response.headers.get("X-AO-Delegation-Response-MAC")
		)
	)
		throw new Error("outer_held");
	const result: unknown = JSON.parse(raw);
	if (!result || typeof result !== "object" || !("record" in result))
		throw new Error("outer_held");
	return result.record;
}

export function registerOuterNative(options: {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<
		WebContents,
		| "id"
		| "mainFrame"
		| "isDestroyed"
		| "isFocused"
		| "send"
		| "on"
		| "removeListener"
	>;
	authority: MainProcessDelegationAuthority;
	origin: () => string | null;
	fetch: typeof fetch;
	confirmPlan?: (detail: string) => Promise<boolean>;
}) {
	const shell = options.shellWebContents;
	const entries = new Map<
		string,
		{
			stage: OuterStage;
			slot: string;
			draft: OuterNativeDraft;
			origin: string;
		}
	>();
	let disposed = false;
	let navigationEpoch = 0;
	const trusted = (e: IpcMainInvokeEvent) =>
		!disposed &&
		!shell.isDestroyed() &&
		e.sender.id === shell.id &&
		e.senderFrame === shell.mainFrame;
	const invalidate = () => {
		entries.clear();
		navigationEpoch++;
	};
	const navigation = (
		_e: unknown,
		_url: string,
		_inPlace: boolean,
		main: boolean
	) => {
		if (main) invalidate();
	};
	shell.on("did-start-navigation", navigation);
	options.ipcMain.handle(OUTER_READ, async (event, query: unknown) => {
		if (!trusted(event) || !validRead(query)) return null;
		const origin = options.origin();
		const epoch = navigationEpoch;
		if (!origin) return null;
		try {
			const url = new URL(origin);
			if (
				url.protocol !== "http:" ||
				url.hostname !== "127.0.0.1" ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				return null;
			const body = JSON.stringify({
				...query,
				nonce: randomUUID(),
				expires: Date.now() + 9000,
			});
			const mac = options.authority.outerReadRequestMAC(body);
			const response = await options.fetch(
				`${url.origin}/internal/outer/read`,
				{
					method: "POST",
					body,
					redirect: "error",
					credentials: "omit",
					signal: AbortSignal.timeout(10_000),
					headers: {
						"content-type": "application/json",
						"X-AO-Delegation-MAC": mac,
					},
				}
			);
			const record = await verifiedOuterRecord(
				response,
				mac,
				options.authority
			);
			if (
				!trusted(event) ||
				navigationEpoch !== epoch ||
				origin !== options.origin() ||
				!record ||
				typeof record !== "object" ||
				!("projection" in record) ||
				record.projection !== query.projection ||
				!("data" in record)
			)
				return null;
			return record as OuterReadResponse;
		} catch {
			return null;
		}
	});
	options.ipcMain.handle(
		OUTER_STAGE,
		(event, slot: unknown, value: unknown) => {
			if (
				!trusted(event) ||
				typeof slot !== "string" ||
				slot.length > 256 ||
				!validDraft(value)
			)
				return null;
			const origin = options.origin();
			if (!origin) return null;
			try {
				const url = new URL(origin);
				if (
					url.protocol !== "http:" ||
					url.hostname !== "127.0.0.1" ||
					url.username ||
					url.password ||
					url.pathname !== "/" ||
					url.search ||
					url.hash
				)
					return null;
				const raw = JSON.stringify(value);
				if (Buffer.byteLength(raw) > 128 << 10) return null;
				for (const [id, entry] of entries)
					if (
						entry.slot === slot ||
						entry.stage.expiresAt <= Date.now()
					)
						entries.delete(id);
				if (entries.size >= 64) return null;
				const stage = {
					id: randomUUID(),
					digest: createHash("sha256").update(raw).digest("hex"),
					expiresAt: Date.now() + 120_000,
				};
				entries.set(stage.id, {
					stage,
					slot,
					draft: JSON.parse(raw) as OuterNativeDraft,
					origin,
				});
				return stage;
			} catch {
				return null;
			}
		}
	);
	options.ipcMain.handle(OUTER_CANCEL, (event, id: unknown) => {
		if (trusted(event) && typeof id === "string") entries.delete(id);
	});
	options.ipcMain.handle(OUTER_USER_ACTION, async (event, input: unknown) => {
		if (
			!trusted(event) ||
			!shell.isFocused() ||
			!input ||
			typeof input !== "object"
		)
			return;
		const v = input as { id?: unknown; digest?: unknown };
		if (
			Object.keys(v).length !== 2 ||
			typeof v.id !== "string" ||
			typeof v.digest !== "string"
		)
			return;
		const entry = entries.get(v.id);
		if (!entry || entry.stage.digest !== v.digest) return;
		if (
			entry.stage.expiresAt <= Date.now() ||
			entry.origin !== options.origin()
		) {
			entries.delete(v.id);
			shell.send(OUTER_RESULT, { id: v.id, ok: false, uncertain: false });
			return;
		}
		// Consume before any await. Ambiguous submission is never retried by IPC.
		entries.delete(v.id);
		const id = entry.stage.id;
		let attempted = false;
		try {
			let cancelled = false;
			if (entry.draft.operation === "plan") {
				const epoch = navigationEpoch;
				const readBody = JSON.stringify({
					projection: "view", nonce: randomUUID(), expires: Date.now() + 9000,
				});
				const readMAC = options.authority.outerReadRequestMAC(readBody);
				const preview = await options.fetch(`${entry.origin}/internal/outer/read`, {
					method: "POST", body: readBody, redirect: "error", credentials: "omit",
					signal: AbortSignal.timeout(10_000),
					headers: { "content-type": "application/json", "X-AO-Delegation-MAC": readMAC },
				});
				const record = await verifiedOuterRecord(preview, readMAC, options.authority) as OuterReadResponse;
				if (record.projection !== "view" || !record.data.actionsEnabled)
					throw new Error("outer_held");
				const draft = entry.draft;
				const plan = record.data.plans.find((p) => p.plan.id === draft.planId && p.digest === draft.digest);
				if (!plan || new Date(plan.approvedAt).getFullYear() > 1970 || new Date(plan.expiresAt).getFullYear() > 1970)
					throw new Error("outer_held");
				const detail = JSON.stringify({
					request: plan.plan.request.humanMessage,
					outerSessionId: plan.plan.request.sessionId,
					generation: plan.plan.request.controllerGeneration,
					scopeRevision: plan.plan.request.scopeRevision,
					digest: plan.digest,
					operationCount: plan.plan.actions.length,
					sourceClarificationAndDisclosure: plan.plan.sources,
					actions: plan.plan.actions,
					submissionDeadline: "Two minutes after confirmation. Each turn is single use; no follow-up authority.",
				}, null, 2);
				cancelled = !(await options.confirmPlan?.(detail));
				if (!trusted(event) || !shell.isFocused() || epoch !== navigationEpoch ||
					entry.origin !== options.origin() || entry.stage.expiresAt <= Date.now())
					throw new Error("outer_held");
			}
			const body = JSON.stringify({
				...entry.draft,
				...(cancelled ? { operation: "plan.cancel" } : {}),
				id,
				nonce: randomUUID(),
				expires: Date.now() + 9000,
			});
			const mac = options.authority.outerRequestMAC(body);
			attempted = true;
			const response = await options.fetch(
				`${entry.origin}/internal/outer/native`,
				{
					method: "POST",
					body,
					redirect: "error",
					credentials: "omit",
					signal: AbortSignal.timeout(10_000),
					headers: {
						"content-type": "application/json",
						"X-AO-Delegation-MAC": mac,
					},
				}
			);
			const record = await verifiedOuterRecord(
				response,
				mac,
				options.authority
			);
			if (trusted(event))
				shell.send(OUTER_RESULT, {
					id,
					ok: true,
					uncertain: false,
					record,
				});
		} catch {
			if (trusted(event))
				shell.send(OUTER_RESULT, {
					id,
					ok: false,
					uncertain: attempted,
				});
		}
	});
	return {
		invalidate,
		dispose() {
			disposed = true;
			invalidate();
			shell.removeListener("did-start-navigation", navigation);
			for (const c of [
				OUTER_STAGE,
				OUTER_CANCEL,
				OUTER_USER_ACTION,
				OUTER_READ,
			])
				options.ipcMain.removeHandler(c);
		},
	};
}
