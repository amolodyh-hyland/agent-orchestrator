import { createHmac } from "node:crypto";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { registerFactoryRunConfirmation } from "./factory-run-confirmation";
import { RUN_PREVIEW, RUN_CONFIRM_CLICK, RUN_RESULT, type RunPreview } from "../shared/factory-run-confirmation";

function fixture() {
	const key = Buffer.alloc(32, 7); const authority = createMainProcessDelegationAuthority(key);
	const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
	const shell = { id: 7, mainFrame: {}, isDestroyed: () => false, isFocused: vi.fn(() => true), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
	const event = { sender: { id: 7 }, senderFrame: shell.mainFrame } as unknown as IpcMainInvokeEvent;
	const preview: Omit<RunPreview, "id" | "expiresAt"> = { feedback: {payload: "P2-1: correct stale source",sessionId:"s",sha:"a".repeat(40),round:1,targetDigest:"b".repeat(64)}, action: "evidence", digest: "a".repeat(64), detail: { run: { id: "run", projectId: "p", sessionId: "s", version: 3, stage: "implementation" }, evidence: [{ kind: "completion", confirmed: false }], observed: [], blockers: ["human_evidence_confirmation_required"], nextAction: "hold" } };
	const operations: string[] = [];
	const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
		const body = String(init.body); const input = JSON.parse(body) as { operation: string };
		expect((init.headers as Record<string, string>)["X-AO-Delegation-MAC"]).toBe(authority.runRequestMAC(body));
		operations.push(input.operation);
		const raw = JSON.stringify({ record: input.operation === "preview" ? preview : {} });
		const requestMAC = authority.runRequestMAC(body);
		const mac = createHmac("sha256", key).update(`journal-response-v1:${requestMAC}:${raw}`).digest("hex");
		return new Response(raw, { headers: { "X-AO-Delegation-Response-MAC": mac } });
	}) as unknown as typeof fetch;
	const confirm = vi.fn(async (_detail: string) => true);
	const registration = registerFactoryRunConfirmation({ ipcMain: { handle: (channel, callback) => { handlers.set(channel, callback); }, removeHandler: vi.fn() }, shellWebContents: shell as unknown as WebContents,
		authority, origin: () => "http://127.0.0.1:9999", fetch: fetcher, confirm });
	return { handlers, shell, event, preview, confirm, operations, registration };
}

describe("native run evidence confirmation", () => {
	it("requires the focused shell, native dialog and a single-use exact preview", async () => {
		const f = fixture();
		const p = await f.handlers.get(RUN_PREVIEW)!(f.event, "run", "evidence") as RunPreview;
		expect(f.operations).toEqual(["preview"]);
		const input = { id: p.id, digest: p.digest };
		await f.handlers.get(RUN_CONFIRM_CLICK)!({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, input);
		f.shell.isFocused.mockReturnValue(false);
		await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, input);
		f.shell.isFocused.mockReturnValue(true);
		await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, { ...input, token: "forged" });
		expect(f.confirm).not.toHaveBeenCalled();
		await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, input);
		expect(f.confirm).toHaveBeenCalledOnce();
		expect(f.confirm.mock.calls[0]?.[0]).toContain("Run intent:");
		expect(f.operations).toEqual(["preview", "preview", "confirm"]);
		expect(f.shell.send).toHaveBeenCalledWith(RUN_RESULT, { previewId: p.id, ok: true });
		await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, input);
		expect(f.confirm).toHaveBeenCalledOnce();
	});
	it("refuses stale evidence, cancellation, and navigation", async () => {
		for (const mode of ["stale", "cancel", "navigation"] as const) {
			const f = fixture();
			const p = await f.handlers.get(RUN_PREVIEW)!(f.event, "run", "evidence") as RunPreview;
			if (mode === "stale") f.preview.digest = "b".repeat(64);
			if (mode === "cancel") f.confirm.mockResolvedValue(false);
			if (mode === "navigation") {
				const [, callback] = f.shell.on.mock.calls[0] as unknown as [string, (...args: unknown[]) => void];
				callback({}, "https://changed.example", false, true);
			}
			await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, { id: p.id, digest: p.digest });
			expect(f.operations).not.toContain("confirm");
		}
	});
});

describe("native review findings continuation", () => {
 it("shows exact findings and target, then confirms one continuation",async()=>{
  const f=fixture();f.preview.action="feedback";
  const p=await f.handlers.get(RUN_PREVIEW)!(f.event,"run","feedback") as RunPreview;
  await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event,{id:p.id,digest:p.digest});
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.confirm.mock.calls[0]?.[0]).toContain("P2-1: correct stale source");
  expect(f.confirm.mock.calls[0]?.[0]).toContain("native acceptance is recorded separately");
  expect(f.operations).toEqual(["preview","preview","confirm"]);
 });
 it("does not confirm when the native decision outlives its preview",async()=>{
  const clock=vi.spyOn(Date,"now");let now=100000;clock.mockImplementation(()=>now);
  try {
   const f=fixture();f.preview.action="feedback";
   const p=await f.handlers.get(RUN_PREVIEW)!(f.event,"run","feedback") as RunPreview;
   f.confirm.mockImplementation(async()=>{now+=120001;return true});
   await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event,{id:p.id,digest:p.digest});
   expect(f.operations).not.toContain("confirm");
  }finally{clock.mockRestore()}
 });
});


it("shows native stage consent for metadata from a maximum-size specialist import", async () => {
 const f = fixture();
 f.preview.action = "advance";
 f.preview.detail.evidence = [{
  kind: "specialist_result", confirmed: true,
  specialistResult: {
   untrusted: true, serverOrigin: "http://127.0.0.1:4444", requestId: "request-result",
   readConsent: { id: "read", at: "2026-10-24T00:00:00Z" },
   importConsent: { id: "import", at: "2026-10-24T00:00:01Z" },
   result: { format: "text/plain", status: "completed", byte_count: 32768, digest: "c".repeat(64), revision: "d".repeat(64) },
  },
 }];
 const p = await f.handlers.get(RUN_PREVIEW)!(f.event, "run", "advance") as RunPreview;
 await f.handlers.get(RUN_CONFIRM_CLICK)!(f.event, { id: p.id, digest: p.digest });
 expect(f.confirm).toHaveBeenCalledOnce();
 const detail = f.confirm.mock.calls[0]![0];
 expect(detail.length).toBeLessThan(24000);
 expect(detail).toContain('"byte_count": 32768');
 expect(detail).toContain("c".repeat(64));
 expect(detail).toContain("d".repeat(64));
 expect(detail).toContain("No execution will start or resume.");
 expect(f.operations).toEqual(["preview", "preview", "confirm"]);
 expect(f.shell.send).toHaveBeenCalledWith(RUN_RESULT, { previewId: p.id, ok: true });
});
