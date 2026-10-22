import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { DELEGATION_PREVIEW, DELEGATION_CANCEL_PREVIEW, DELEGATION_CONFIRM_CLICK, DELEGATION_RESULT, DELEGATION_CREDENTIAL } from "../shared/multica-delegation-confirmation";
import type { createDelegationConfirmationFlow } from "./multica-delegation-confirmation";

export function registerDelegationConfirmationIpc(options: {
	ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	shellWebContents: Pick<WebContents, "id" | "mainFrame" | "isDestroyed" | "isFocused" | "send" | "on" | "removeListener">;
	flow: ReturnType<typeof createDelegationConfirmationFlow>;
	setCredential: (workspaceId: string, token: string) => Promise<boolean>;
}) {
	const { ipcMain, shellWebContents: shell, flow } = options;
	let disposed = false;
	const pending = new Set<string>();
	const trusted = (event: IpcMainInvokeEvent) => !disposed && !shell.isDestroyed() && event.sender.id === shell.id && event.senderFrame === shell.mainFrame;
	const invalidate = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) flow.invalidate(); };
	shell.on("did-start-navigation", invalidate);
	ipcMain.handle(DELEGATION_PREVIEW, (event, draft: unknown) => trusted(event) ? flow.preview(draft) : { ok: false, code: "confirmation_required" });
	ipcMain.handle(DELEGATION_CANCEL_PREVIEW, (event, id: unknown) => { if (trusted(event) && typeof id === "string") flow.cancel(id); });
	ipcMain.handle(DELEGATION_CREDENTIAL, async (event, workspaceId: unknown, token: unknown) => {
		if (!trusted(event) || typeof workspaceId !== "string" || typeof token !== "string") return false;
		flow.invalidate();
		try { return await options.setCredential(workspaceId, token); } catch { return false; }
	});
	ipcMain.handle(DELEGATION_CONFIRM_CLICK, async (event, request: unknown) => {
		if (!trusted(event) || !shell.isFocused() || !request || typeof request !== "object") return;
		const input = request as { id?: unknown; hash?: unknown };
		if (Object.keys(input).length !== 2 || typeof input.id !== "string" || typeof input.hash !== "string") return;
		if (pending.has(input.id)) return;
		pending.add(input.id);
		try {
			const result = await flow.confirmFromRendererAction(input.id, input.hash);
			if (trusted(event)) shell.send(DELEGATION_RESULT, { previewId: input.id, result });
		} finally { pending.delete(input.id); }
	});
	return { dispose() {
		disposed = true;
		flow.dispose();
		shell.removeListener("did-start-navigation", invalidate);
		for (const channel of [DELEGATION_PREVIEW, DELEGATION_CANCEL_PREVIEW, DELEGATION_CONFIRM_CLICK, DELEGATION_CREDENTIAL]) ipcMain.removeHandler(channel);
	} };
}
