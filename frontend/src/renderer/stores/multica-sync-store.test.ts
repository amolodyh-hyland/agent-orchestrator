import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MULTICA_SYNC_SNAPSHOT, type MulticaSyncSnapshot } from "../../shared/multica-status-sync";
import { resetMulticaSyncStoreSubscription, useMulticaSyncStore } from "./multica-sync-store";

type Bridge = NonNullable<typeof window.ao>["multicaSync"];

const on: MulticaSyncSnapshot = { settings: { enabled: true, moveOutOfBacklog: false }, killSwitch: false, links: [] };
const ref = { sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" };

describe("multica sync store", () => {
	let original: Bridge;

	beforeEach(() => {
		original = { ...window.ao!.multicaSync };
		resetMulticaSyncStoreSubscription();
		useMulticaSyncStore.setState({ snapshot: EMPTY_MULTICA_SYNC_SNAPSHOT });
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaSync, original);
	});

	it("starts with everything off", () => {
		expect(useMulticaSyncStore.getState().snapshot.settings).toEqual({ enabled: false, moveOutOfBacklog: true });
	});

	it("loads the state once and follows pushed changes", async () => {
		let push: ((snapshot: MulticaSyncSnapshot) => void) | undefined;
		window.ao!.multicaSync.getState = vi.fn(async () => on);
		window.ao!.multicaSync.onChanged = vi.fn((listener) => {
			push = listener;
			return () => undefined;
		});

		await useMulticaSyncStore.getState().load();
		await useMulticaSyncStore.getState().load();
		expect(window.ao!.multicaSync.getState).toHaveBeenCalledTimes(1);
		expect(useMulticaSyncStore.getState().snapshot).toEqual(on);

		push?.({ ...on, killSwitch: true });
		expect(useMulticaSyncStore.getState().snapshot.killSwitch).toBe(true);
	});

	it("keeps a pushed state over an older answer to the first read", async () => {
		let push: ((snapshot: MulticaSyncSnapshot) => void) | undefined;
		window.ao!.multicaSync.onChanged = vi.fn((listener) => {
			push = listener;
			return () => undefined;
		});
		window.ao!.multicaSync.getState = vi.fn(async () => {
			push?.({ ...on, killSwitch: true });
			return EMPTY_MULTICA_SYNC_SNAPSHOT;
		});

		await useMulticaSyncStore.getState().load();
		expect(useMulticaSyncStore.getState().snapshot.killSwitch).toBe(true);
	});

	it("sends each action to the bridge and shows the state it answers with", async () => {
		window.ao!.multicaSync.setSettings = vi.fn(async () => on);
		window.ao!.multicaSync.setLink = vi.fn(async () => on);
		window.ao!.multicaSync.resume = vi.fn(async () => on);
		window.ao!.multicaSync.reopen = vi.fn(async () => on);
		window.ao!.multicaSync.syncNow = vi.fn(async () => on);
		const store = useMulticaSyncStore.getState();

		await store.setSettings({ enabled: true });
		expect(window.ao!.multicaSync.setSettings).toHaveBeenCalledWith({ enabled: true });
		expect(useMulticaSyncStore.getState().snapshot).toEqual(on);

		await store.setLink({ ...ref, enabled: true });
		expect(window.ao!.multicaSync.setLink).toHaveBeenCalledWith({ ...ref, enabled: true });
		await store.resume(ref);
		expect(window.ao!.multicaSync.resume).toHaveBeenCalledWith(ref);
		await store.syncNow(ref);
		expect(window.ao!.multicaSync.syncNow).toHaveBeenCalledWith(ref);
	});

	it("only ever asks for a reopen as a confirmed one", async () => {
		window.ao!.multicaSync.reopen = vi.fn(async () => on);
		await useMulticaSyncStore.getState().reopen(ref);
		expect(window.ao!.multicaSync.reopen).toHaveBeenCalledExactlyOnceWith({ ...ref, confirmed: true });
	});

	it("keeps the current state when the bridge fails", async () => {
		window.ao!.multicaSync.setSettings = vi.fn(async () => {
			throw new Error("bridge down");
		});
		useMulticaSyncStore.setState({ snapshot: on });
		await expect(useMulticaSyncStore.getState().setSettings({ enabled: false })).resolves.toBeUndefined();
		expect(useMulticaSyncStore.getState().snapshot).toEqual(on);
	});
});
