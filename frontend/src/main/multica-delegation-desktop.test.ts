import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DELEGATION_ENABLE_CLICK, DELEGATION_SETTINGS, DELEGATION_PREVIEW } from "../shared/multica-delegation-confirmation";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import type { MulticaCredentials } from "./multica-credentials";
import { registerDesktopDelegation } from "./multica-delegation-desktop";

function setup() {
	const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
	const listeners: ((...args: unknown[]) => void)[] = [];
	const shell = { id: 7, mainFrame: {}, isDestroyed: () => false, isFocused: vi.fn(() => true), send: vi.fn(),
		on: (_name: string, listener: (...args: unknown[]) => void) => listeners.push(listener), removeListener: vi.fn() };
	const confirmEnable = vi.fn(async () => false);
	const fetch = vi.fn<typeof globalThis.fetch>();
	const desktop = registerDesktopDelegation({
		ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: vi.fn() } as unknown as IpcMain,
		shellWebContents: shell as unknown as WebContents, authority: createMainProcessDelegationAuthority(Buffer.alloc(32, 7)),
		credentials: {} as MulticaCredentials, daemonOrigin: () => null,
		readSettings: async () => ({ mode: "local", customUrl: "http://contract.local", apiUrl: "http://contract.local", delegationEnabled: true }),
		confirm: vi.fn(async () => true), confirmCancellation: vi.fn(async () => true), confirmEnable, fetch,
	});
	const event = { sender: { id: 7 }, senderFrame: shell.mainFrame } as unknown as IpcMainInvokeEvent;
	return { desktop, shell, listeners, handlers, event, fetch, confirmEnable,
		settings: () => handlers.get(DELEGATION_SETTINGS)!(event), enable: (value: unknown, sender = event) => handlers.get(DELEGATION_ENABLE_CLICK)!(sender, value) };
}

describe("desktop delegation rollout", () => {
	it("starts disabled even with a supplied settings field and needs native approval", async () => {
		const f = setup();
		try {
			expect(f.settings()).toEqual({ enabled: false });
			expect(await f.handlers.get(DELEGATION_PREVIEW)!(f.event, { orchestrator: "task", workspaceId: "10000000-0000-4000-8000-000000000001",
				profileId: "20000000-0000-4000-8000-000000000002", runtimeId: "30000000-0000-4000-8000-000000000003",
				projectId: "project", taskId: "task", title: "Review", brief: "Review" })).toEqual({ ok: false, code: "delegations_disabled" });
			await f.enable(true); expect(f.settings()).toEqual({ enabled: false });
			f.confirmEnable.mockResolvedValueOnce(true);
			await f.enable(true); expect(f.settings()).toEqual({ enabled: true });
			await f.enable(false); expect(f.settings()).toEqual({ enabled: false });
			expect(f.confirmEnable).toHaveBeenCalledTimes(2);
			expect(f.fetch).not.toHaveBeenCalled();
		} finally { f.desktop.dispose(); }
		const restarted = setup(); expect(restarted.settings()).toEqual({ enabled: false }); restarted.desktop.dispose();
	});
	it("rejects embedded frames, background actions and supplied approval objects", async () => {
		const f = setup();
		try {
			for (const event of [{ ...f.event, sender: { id: 99 } }, { ...f.event, senderFrame: {} }]) await f.enable(true, event as IpcMainInvokeEvent);
			await f.enable({ enabled: true, approved: true });
			f.shell.isFocused.mockReturnValue(false); await f.enable(true);
			expect(f.confirmEnable).not.toHaveBeenCalled(); expect(f.settings()).toEqual({ enabled: false });
		} finally { f.desktop.dispose(); }
	});
	it.each(["disable", "navigate", "dispose", "connection"] as const)("revokes pending enablement on %s", async (action) => {
		const f = setup();
		let release!: (approved: boolean) => void;
		f.confirmEnable.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
		const enabling = f.enable(true);
		if (action === "disable") await f.enable(false);
		if (action === "navigate") for (const listener of f.listeners) listener({}, "app://shell", false, true);
		if (action === "dispose") f.desktop.dispose();
		if (action === "connection") f.desktop.invalidate();
		release(true); await enabling;
		expect(f.settings()).toEqual({ enabled: false }); expect(f.fetch).not.toHaveBeenCalled(); f.desktop.dispose();
	});
});
