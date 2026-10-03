import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaViewState } from "../../shared/multica";

type Bridge = NonNullable<typeof window.ao>["multica"];

// The store subscribes to main-process pushes once per module instance, so each
// test loads a fresh copy.
async function freshStore() {
	vi.resetModules();
	return (await import("./multica-store")).useMulticaStore;
}

describe("multica store", () => {
	let original: Bridge;
	let pushState: (state: MulticaViewState) => void;
	const onState = vi.fn();

	beforeEach(() => {
		original = { ...window.ao!.multica };
		onState.mockReset();
		onState.mockImplementation((listener: (state: MulticaViewState) => void) => {
			pushState = listener;
			return () => undefined;
		});
		window.ao!.multica.onState = onState;
		window.ao!.multica.setActive = vi.fn(async (active: boolean): Promise<MulticaViewState> => ({ active, status: "ready", url: "" }));
		window.ao!.multica.reload = vi.fn(async (): Promise<MulticaViewState> => ({ active: true, status: "loading", url: "" }));
	});

	afterEach(() => {
		Object.assign(window.ao!.multica, original);
	});

	it("starts on the AO view with Multica unconfigured", async () => {
		const store = await freshStore();
		expect(store.getState().view).toEqual({ active: false, status: "unconfigured", url: "" });
	});

	it("loads the current state once and then follows main-process pushes", async () => {
		const loaded: MulticaViewState = { active: false, status: "idle", url: "http://localhost:3000/" };
		window.ao!.multica.getState = vi.fn(async () => loaded);
		const store = await freshStore();

		await store.getState().load();
		await store.getState().load();

		expect(store.getState().view).toEqual(loaded);
		expect(onState).toHaveBeenCalledOnce();
		pushState({ ...loaded, active: true, status: "ready" });
		expect(store.getState().view).toEqual({ ...loaded, active: true, status: "ready" });
	});

	it("prefers a push that arrives before the initial fetch resolves", async () => {
		let resolveFetch: (state: MulticaViewState) => void = () => undefined;
		window.ao!.multica.getState = vi.fn(() => new Promise<MulticaViewState>((resolve) => (resolveFetch = resolve)));
		const store = await freshStore();

		const loading = store.getState().load();
		pushState({ active: true, status: "ready", url: "http://localhost:3000/" });
		resolveFetch({ active: false, status: "idle", url: "http://localhost:3000/" });
		await loading;

		expect(store.getState().view.status).toBe("ready");
	});

	it("keeps AO usable when the bridge cannot report state", async () => {
		window.ao!.multica.getState = vi.fn(async () => {
			throw new Error("no bridge");
		});
		const store = await freshStore();

		await expect(store.getState().load()).resolves.toBeUndefined();

		expect(store.getState().view.active).toBe(false);
	});

	it("asks the main process to switch, flipping from the current state", async () => {
		const store = await freshStore();

		store.getState().toggle();
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(true);

		store.setState({ view: { active: true, status: "ready", url: "" } });
		store.getState().toggle();
		expect(window.ao!.multica.setActive).toHaveBeenLastCalledWith(false);
	});

	it("asks the main process to reload on retry", async () => {
		const store = await freshStore();

		store.getState().reload();

		expect(window.ao!.multica.reload).toHaveBeenCalledOnce();
	});
});
