// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	EMPTY_MULTICA_SYNC_SNAPSHOT,
	MULTICA_SYNC_CHANGED_CHANNEL,
	MULTICA_SYNC_GET_STATE_CHANNEL,
	MULTICA_SYNC_PUBLISH_FACTS_CHANNEL,
	MULTICA_SYNC_REOPEN_CHANNEL,
	MULTICA_SYNC_RESUME_CHANNEL,
	MULTICA_SYNC_SET_LINK_CHANNEL,
	MULTICA_SYNC_SET_SETTINGS_CHANNEL,
	MULTICA_SYNC_SYNC_NOW_CHANNEL,
	type MulticaSyncSnapshot,
} from "../shared/multica-status-sync";
import { registerMulticaStatusSyncIpc } from "./multica-status-sync-ipc";

const SHELL_ID = 7;
const ref = { sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" };
const snapshot: MulticaSyncSnapshot = { settings: { enabled: true, moveOutOfBacklog: true }, killSwitch: false, links: [] };

function setup() {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const ipcMain = {
		handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel);
		}),
	};
	let listener: ((value: MulticaSyncSnapshot) => void) | undefined;
	const engine = {
		getSnapshot: vi.fn(() => snapshot),
		setSettings: vi.fn(async () => snapshot),
		setLink: vi.fn(async () => snapshot),
		resume: vi.fn(async () => snapshot),
		reopen: vi.fn(async () => snapshot),
		syncNow: vi.fn(async () => snapshot),
		setFacts: vi.fn(),
		onChanged: vi.fn((next: (value: MulticaSyncSnapshot) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		}),
	};
	const shell = { id: SHELL_ID, isDestroyed: vi.fn(() => false), send: vi.fn() };
	const registered = registerMulticaStatusSyncIpc({ ipcMain, shellWebContents: shell, engine });
	const invoke = (channel: string, payload?: unknown, senderId = SHELL_ID) => handlers.get(channel)?.({ sender: { id: senderId } }, payload);
	return { ipcMain, engine, shell, registered, invoke, emit: (value: MulticaSyncSnapshot) => listener?.(value), handlers };
}

describe("multica status sync IPC", () => {
	it("only answers the shell", async () => {
		const { invoke, engine } = setup();

		expect(invoke(MULTICA_SYNC_GET_STATE_CHANNEL, undefined, 99)).toEqual(EMPTY_MULTICA_SYNC_SNAPSHOT);
		await invoke(MULTICA_SYNC_SET_SETTINGS_CHANNEL, { enabled: true }, 99);
		await invoke(MULTICA_SYNC_SET_LINK_CHANNEL, { ...ref, enabled: true }, 99);
		await invoke(MULTICA_SYNC_RESUME_CHANNEL, ref, 99);
		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, { ...ref, confirmed: true }, 99);
		await invoke(MULTICA_SYNC_SYNC_NOW_CHANNEL, ref, 99);
		expect(invoke(MULTICA_SYNC_PUBLISH_FACTS_CHANNEL, { stale: false, sessions: [] }, 99)).toEqual({ ok: false });

		expect(engine.setSettings).not.toHaveBeenCalled();
		expect(engine.setLink).not.toHaveBeenCalled();
		expect(engine.resume).not.toHaveBeenCalled();
		expect(engine.reopen).not.toHaveBeenCalled();
		expect(engine.syncNow).not.toHaveBeenCalled();
		expect(engine.setFacts).not.toHaveBeenCalled();
	});

	it("passes valid requests from the shell to the engine", async () => {
		const { invoke, engine } = setup();

		expect(invoke(MULTICA_SYNC_GET_STATE_CHANNEL)).toEqual(snapshot);
		await invoke(MULTICA_SYNC_SET_SETTINGS_CHANNEL, { enabled: true, moveOutOfBacklog: false });
		await invoke(MULTICA_SYNC_SET_LINK_CHANNEL, { ...ref, enabled: true });
		await invoke(MULTICA_SYNC_RESUME_CHANNEL, ref);
		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, { ...ref, confirmed: true });
		await invoke(MULTICA_SYNC_SYNC_NOW_CHANNEL, ref);

		expect(engine.setSettings).toHaveBeenCalledWith({ enabled: true, moveOutOfBacklog: false });
		expect(engine.setLink).toHaveBeenCalledWith({ ...ref, enabled: true });
		expect(engine.resume).toHaveBeenCalledWith(ref);
		expect(engine.reopen).toHaveBeenCalledWith(ref);
		expect(engine.syncNow).toHaveBeenCalledWith(ref);
	});

	it("ignores malformed payloads", async () => {
		const { invoke, engine } = setup();

		await invoke(MULTICA_SYNC_SET_SETTINGS_CHANNEL, { enabled: "yes" });
		await invoke(MULTICA_SYNC_SET_SETTINGS_CHANNEL, { other: true });
		await invoke(MULTICA_SYNC_SET_SETTINGS_CHANNEL, null);
		await invoke(MULTICA_SYNC_SET_LINK_CHANNEL, { ...ref, enabled: "true" });
		await invoke(MULTICA_SYNC_SET_LINK_CHANNEL, { ...ref, workspaceSlug: "../x", enabled: true });
		await invoke(MULTICA_SYNC_SET_LINK_CHANNEL, { ...ref, issueIdentifier: "mul-1", enabled: true });
		await invoke(MULTICA_SYNC_RESUME_CHANNEL, { sessionId: "s/1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		await invoke(MULTICA_SYNC_SYNC_NOW_CHANNEL, "MUL-1");

		expect(engine.setSettings).not.toHaveBeenCalled();
		expect(engine.setLink).not.toHaveBeenCalled();
		expect(engine.resume).not.toHaveBeenCalled();
		expect(engine.syncNow).not.toHaveBeenCalled();
	});

	it("never reopens an issue without the explicit confirmation", async () => {
		const { invoke, engine } = setup();

		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, ref);
		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, { ...ref, confirmed: false });
		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, { ...ref, confirmed: "true" });
		await invoke(MULTICA_SYNC_REOPEN_CHANNEL, { ...ref, confirmed: 1 });

		expect(engine.reopen).not.toHaveBeenCalled();
	});

	it("accepts only well-formed facts", () => {
		const { invoke, engine } = setup();
		const session = { sessionId: "s-1", provisioning: "ready", column: "building", activity: "active", terminated: false, prs: ["open"] };

		expect(invoke(MULTICA_SYNC_PUBLISH_FACTS_CHANNEL, { stale: false, sessions: [session] })).toEqual({ ok: true });
		expect(engine.setFacts).toHaveBeenCalledTimes(1);

		for (const bad of [
			null,
			{ stale: false },
			{ stale: "no", sessions: [] },
			{ stale: false, sessions: [{ ...session, column: "review" }] },
			{ stale: false, sessions: [{ ...session, extra: 1 }] },
			{ stale: false, sessions: [{ ...session, prs: ["open", "weird"] }] },
			{ stale: false, sessions: [session, session] },
			{ stale: false, sessions: [{ ...session, sessionId: "a/b" }] },
			{ stale: false, sessions: [session], extra: true },
		]) {
			expect(invoke(MULTICA_SYNC_PUBLISH_FACTS_CHANNEL, bad)).toEqual({ ok: false });
		}
		expect(engine.setFacts).toHaveBeenCalledTimes(1);
	});

	it("pushes every change to the shell and stops after dispose", () => {
		const { emit, shell, registered, ipcMain } = setup();

		emit(snapshot);
		expect(shell.send).toHaveBeenCalledWith(MULTICA_SYNC_CHANGED_CHANNEL, snapshot);

		registered.dispose();
		emit(snapshot);
		expect(shell.send).toHaveBeenCalledTimes(1);
		expect(ipcMain.removeHandler).toHaveBeenCalledTimes(7);
	});

	it("does not send to a destroyed shell", () => {
		const { emit, shell } = setup();
		shell.isDestroyed.mockReturnValue(true);
		emit(snapshot);
		expect(shell.send).not.toHaveBeenCalled();
	});
});
