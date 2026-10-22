import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerDelegationConfirmationIpc } from "./multica-delegation-confirmation-ipc";
import { DELEGATION_STATUS, DELEGATION_CANCEL_CLICK, DELEGATION_PREVIEW, DELEGATION_CANCEL_PREVIEW, DELEGATION_CONFIRM_CLICK, DELEGATION_CREDENTIAL, DELEGATION_RESULT } from "../shared/multica-delegation-confirmation";

function fixture() {
	const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
	const flow = { preview: vi.fn(async () => ({ ok: false as const, code: "policy_denied" })), cancel: vi.fn(),
		confirmFromRendererAction: vi.fn(async () => ({ ok: false as const, code: "cancelled" })), invalidate: vi.fn(), dispose: vi.fn() };
	const shell = { id: 7, mainFrame: {}, isDestroyed: () => false, isFocused: vi.fn(() => true), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
	const ipcMain = { handle: (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, callback); }, removeHandler: vi.fn() };
	const status = { status: vi.fn(async () => ({ ok: true as const, status: null })), cancelFromRendererAction: vi.fn(async () => ({ ok: true })), resume: vi.fn(), revokeConfirmation: vi.fn(), invalidate: vi.fn(), dispose: vi.fn() };
	const registration = registerDelegationConfirmationIpc({ ipcMain, flow, status,
		shellWebContents: shell as unknown as WebContents, setCredential: vi.fn(async () => true) });
	const event = { sender: { id: shell.id }, senderFrame: shell.mainFrame } as unknown as IpcMainInvokeEvent;
	return { handlers, flow, status, shell, registration, event };
}

describe("desktop-only delegation confirmation IPC", () => {
	it("accepts only the shell main frame, never embedded Multica, browser tabs or child frames", async () => {
		const f = fixture();
		for (const event of [{ ...f.event, sender: { id: 99 } }, { ...f.event, senderFrame: {} }]) {
			await f.handlers.get(DELEGATION_PREVIEW)!(event as IpcMainInvokeEvent, {});
			await f.handlers.get(DELEGATION_CONFIRM_CLICK)!(event as IpcMainInvokeEvent, { id: "preview", hash: "hash" });
		}
		expect(f.flow.preview).not.toHaveBeenCalled();
		expect(f.flow.confirmFromRendererAction).not.toHaveBeenCalled();
	});
	it("exposes preview and revocation but no mint, token, coordinator or automation channel", async () => {
		const f = fixture();
		expect([...f.handlers.keys()]).toEqual([DELEGATION_STATUS, DELEGATION_CANCEL_CLICK, DELEGATION_PREVIEW, DELEGATION_CANCEL_PREVIEW, DELEGATION_CREDENTIAL, DELEGATION_CONFIRM_CLICK]);
		await f.handlers.get(DELEGATION_PREVIEW)!(f.event, { taskId: "task" });
		expect(f.flow.confirmFromRendererAction).not.toHaveBeenCalled();
		await f.handlers.get(DELEGATION_CANCEL_PREVIEW)!(f.event, "preview");
		expect(f.flow.cancel).toHaveBeenCalledWith("preview");
		await f.handlers.get(DELEGATION_CONFIRM_CLICK)!(f.event, { id: "preview", hash: "hash", token: "forged" });
		expect(f.flow.confirmFromRendererAction).not.toHaveBeenCalled();
		await f.handlers.get(DELEGATION_CONFIRM_CLICK)!(f.event, { id: "preview", hash: "hash" });
		expect(f.flow.confirmFromRendererAction).toHaveBeenCalledExactlyOnceWith("preview", "hash");
		expect(f.shell.send).toHaveBeenCalledWith(DELEGATION_RESULT, { previewId: "preview", result: { ok: false, code: "cancelled" } });
	});
	it("blocks background confirmation and invalidates previews on navigation and disposal", async () => {
		const f = fixture(); f.shell.isFocused.mockReturnValue(false);
		await f.handlers.get(DELEGATION_CONFIRM_CLICK)!(f.event, { id: "preview", hash: "hash" });
		expect(f.flow.confirmFromRendererAction).not.toHaveBeenCalled();
		const [, navigation] = f.shell.on.mock.calls[0] as unknown as [string, (...args: unknown[]) => void];
		navigation({}, "https://artifact.example", false, false);
		expect(f.flow.invalidate).not.toHaveBeenCalled();
		navigation({}, "https://shell.example", false, true);
		expect(f.flow.invalidate).toHaveBeenCalledOnce();
		f.registration.dispose();
		await f.handlers.get(DELEGATION_PREVIEW)!(f.event, {});
		expect(f.flow.preview).not.toHaveBeenCalled();
	});
	it("gates cancellation to the focused shell main frame and never accepts a supplied approval", async () => {
		const f = fixture();
		const input = { requestId: "request", remoteId: "remote" };
		for (const event of [{ ...f.event, sender: { id: 99 } }, { ...f.event, senderFrame: {} }]) {
			await f.handlers.get(DELEGATION_CANCEL_CLICK)!(event as IpcMainInvokeEvent, input);
		}
		f.shell.isFocused.mockReturnValue(false);
		await f.handlers.get(DELEGATION_CANCEL_CLICK)!(f.event, input);
		f.shell.isFocused.mockReturnValue(true);
		await f.handlers.get(DELEGATION_CANCEL_CLICK)!(f.event, { ...input, token: "forged" });
		expect(f.status.cancelFromRendererAction).not.toHaveBeenCalled();
		await f.handlers.get(DELEGATION_CANCEL_CLICK)!(f.event, input);
		expect(f.status.cancelFromRendererAction).toHaveBeenCalledExactlyOnceWith(input);
	});
	it("keeps status read-only and resumes polling only when saving a credential succeeds", async () => {
		const f = fixture();
		await f.handlers.get(DELEGATION_STATUS)!(f.event, "project", "task");
		expect(f.status.status).toHaveBeenCalledWith("project", "task");
		expect(f.flow.confirmFromRendererAction).not.toHaveBeenCalled();
		expect(f.status.cancelFromRendererAction).not.toHaveBeenCalled();
		await f.handlers.get(DELEGATION_CREDENTIAL)!(f.event, "workspace", "mul_replacement");
		expect(f.status.resume).toHaveBeenCalledWith("workspace");
		f.registration.dispose();
		expect(f.status.dispose).toHaveBeenCalledOnce();
	});

});
