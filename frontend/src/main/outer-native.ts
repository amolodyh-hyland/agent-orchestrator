import { createHash, randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	OUTER_STAGE,
	OUTER_CANCEL,
	OUTER_USER_ACTION,
	OUTER_RESULT,
	type OuterNativeDraft,
	type OuterStage,
} from "../shared/outer-native";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";

const controls = new Set([
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
		case "send":
			return (
				keys === "operation,sessionId,text" &&
				typeof v.sessionId === "string" &&
				v.sessionId.length > 0 &&
				v.sessionId.length < 256 &&
				typeof v.text === "string" &&
				v.text.trim().length > 0 &&
				Buffer.byteLength(v.text) <= 64 << 10
			);
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
	const trusted = (e: IpcMainInvokeEvent) =>
		!disposed &&
		!shell.isDestroyed() &&
		e.sender.id === shell.id &&
		e.senderFrame === shell.mainFrame;
	const invalidate = () => entries.clear();
	const navigation = (
		_e: unknown,
		_url: string,
		_inPlace: boolean,
		main: boolean
	) => {
		if (main) invalidate();
	};
	shell.on("did-start-navigation", navigation);
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
			const body = JSON.stringify({
				...entry.draft,
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
				!options.authority.verifyResponseMAC(
					raw,
					mac,
					response.headers.get("X-AO-Delegation-Response-MAC")
				)
			)
				throw new Error("outer_held");
			if (trusted(event))
				shell.send(OUTER_RESULT, {
					id,
					ok: true,
					uncertain: false,
					record: (JSON.parse(raw) as { record: unknown }).record,
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
			for (const c of [OUTER_STAGE, OUTER_CANCEL, OUTER_USER_ACTION])
				options.ipcMain.removeHandler(c);
		},
	};
}
