import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { RUN_PREVIEW, RUN_CANCEL, RUN_CONFIRM_CLICK, RUN_RESULT, type RunAction, type RunPreview } from "../shared/factory-run-confirmation";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import { createDelegationConfirmationTokens } from "./multica-delegation-confirmation-tokens";

// Reuses the private boot authority and the delegation native-confirmation pattern.
// No key, token, signing, or confirm operation is exposed through preload.
export function registerFactoryRunConfirmation(options: {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "mainFrame" | "isDestroyed" | "isFocused" | "send" | "on" | "removeListener">;
	authority: MainProcessDelegationAuthority; origin: () => string | null;
	fetch: typeof fetch; confirm: (detail: string) => Promise<boolean>;
}) {
	const shell = options.shellWebContents;
	const tokens = createDelegationConfirmationTokens(Date.now);
	const entries = new Map<string, { preview: RunPreview; origin: string; pending: boolean }>();
	let disposed = false;
	let generation = 0;
	const trusted = (e: IpcMainInvokeEvent) => !disposed && !shell.isDestroyed() && e.sender.id === shell.id && e.senderFrame === shell.mainFrame;
	const invalidate = () => { generation++; entries.clear(); tokens.clear(); };
	const navigation = (_e: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) invalidate(); };
	shell.on("did-start-navigation", navigation);
	async function request(operation: "preview" | "confirm", runId: string, action: RunAction, expectedVersion = 0, digest = ""): Promise<unknown> {
		const base = options.origin(); if (!base) throw new Error("confirmation_required");
		const url = new URL(base);
		if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("confirmation_required");
		const body = JSON.stringify({ operation, runId, action, expectedVersion, digest, nonce: randomUUID(), expires: Date.now() + 9000 });
		const mac = options.authority.runRequestMAC(body);
		const response = await options.fetch(`${url.origin}/internal/factory-run-confirmation`, { method: "POST", body,
			redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "X-AO-Delegation-MAC": mac } });
		if (!response.ok || !response.body) throw new Error("confirmation_required");
		const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
		try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4 << 20) throw new Error("confirmation_required"); chunks.push(value); } }
		finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
		if (!options.authority.verifyResponseMAC(raw, mac, response.headers.get("X-AO-Delegation-Response-MAC"))) throw new Error("confirmation_required");
		return (JSON.parse(raw) as { record: unknown }).record;
	}
	options.ipcMain.handle(RUN_PREVIEW, async (event, runId: unknown, action: unknown) => {
		if (!trusted(event) || typeof runId !== "string" || runId.length > 128 || (action !== "evidence" && action !== "advance" && action !== "feedback" && action !== "pause_feedback" && action !== "resume_feedback")) return null;
		invalidate(); const version = generation;
		try {
			const origin = options.origin();
			const data = await request("preview", runId, action) as Omit<RunPreview, "id" | "expiresAt">;
			if (!trusted(event) || version !== generation || origin !== options.origin() || data.detail.run.id !== runId || data.action !== action || !/^[a-f0-9]{64}$/.test(data.digest)) return null;
			const preview: RunPreview = { ...data, id: randomUUID(), expiresAt: Date.now() + 120_000 };
			entries.set(preview.id, { preview, origin: origin!, pending: false });
			return structuredClone(preview);
		} catch { return null; }
	});
	options.ipcMain.handle(RUN_CANCEL, (event, id: unknown) => { if (trusted(event) && typeof id === "string") entries.delete(id); });
	options.ipcMain.handle(RUN_CONFIRM_CLICK, async (event, input: unknown) => {
		if (!trusted(event) || !shell.isFocused() || !input || typeof input !== "object") return;
		const value = input as { id?: unknown; digest?: unknown };
		if (Object.keys(value).length !== 2 || typeof value.id !== "string" || typeof value.digest !== "string") return;
		const entry = entries.get(value.id); if (!entry || entry.pending || value.digest !== entry.preview.digest) return;
		entry.pending = true;
		const current = () => trusted(event) && shell.isFocused() && entries.get(entry.preview.id) === entry && entry.preview.expiresAt > Date.now() && entry.origin === options.origin();
		let ok = false;
		try {
			const p = entry.preview;
			if (!current()) return;
			const before = await request("preview", p.detail.run.id, p.action) as RunPreview;
			if (!current() || before.digest !== p.digest) return;
			const claim = [...p.detail.evidence].reverse().find((value) => { const e = value as { confirmed?: boolean; kind?: string }; return !e.confirmed && ["created", "completion", "review"].includes(e.kind ?? ""); });
			const feedback = p.action === "feedback" ? `Approve ONE continuation of the existing implementer, within the original usage scope. No new station will start. Approval expires two minutes after confirmation unless actual provider submission begins. Queueing does not consume approval; native acceptance is recorded separately. Unknown delivery is held without resubmission.\n\nExact target and payload:\n${JSON.stringify(p.feedback, null, 2)}` : "";
			const detail = [feedback,`Run: ${p.detail.run.id}`, `Project: ${p.detail.run.projectId}`, `Session: ${p.detail.run.sessionId}`,
				`Version: ${p.detail.run.version}; stage: ${p.detail.run.stage}; action: ${p.action}`, `Evidence digest: ${p.digest}`, `Run intent:\n${JSON.stringify(p.detail.run, null, 2)}`,
				p.action === "evidence" ? "Confirm this run intent and exact claim. Verify the applicable design digest, source revision, policy and required checks, check output and execution environment, and attributed reviewer independence. Labels supplied by the submitter are claims." : p.action === "advance" ? "Record this stage decision only. No execution will start or resume." : p.action === "feedback" ? "Authorize the exact next turn shown above." : "Change feedback admission only. Pending authority is revoked; allowing new approvals never replays old deliveries.",
				`Evidence:\n${JSON.stringify(p.action === "advance" ? p.detail.evidence : claim, null, 2)}`, `Current owned source:\n${JSON.stringify(p.detail.observed, null, 2)}`, `Blockers: ${p.detail.blockers.join(", ")}`].join("\n\n");
			if (detail.length > 24_000 || !await options.confirm(detail) || !current()) return;
			const token = tokens.mint(p.digest, p.expiresAt);
			if (!tokens.consume(token, p.digest)) return;
			await request("confirm", p.detail.run.id, p.action, p.detail.run.version, p.digest);
			ok = true;
		} catch { /* Failure is closed; a new preview and native confirmation are required. */ }
		finally { entries.delete(entry.preview.id); if (trusted(event)) shell.send(RUN_RESULT, { previewId: entry.preview.id, ok }); }
	});
	return { invalidate, dispose() { disposed = true; invalidate(); shell.removeListener("did-start-navigation", navigation); for (const channel of [RUN_PREVIEW, RUN_CANCEL, RUN_CONFIRM_CLICK]) options.ipcMain.removeHandler(channel); } };
}
