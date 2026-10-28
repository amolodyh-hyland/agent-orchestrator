import { beforeEach, describe, expect, it, vi } from "vitest";

const getUiSettings = vi.fn();
const setUiSettings = vi.fn();

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		uiSettings: {
			get: (...args: unknown[]) => getUiSettings(...args),
			set: (...args: unknown[]) => setUiSettings(...args),
		},
	},
}));

import { useFactoryControlsStore } from "./factory-controls-store";

describe("factory-controls-store", () => {
	beforeEach(() => {
		getUiSettings.mockReset();
		setUiSettings.mockReset();
		getUiSettings.mockResolvedValue({ locale: "en", factoryControlsEnabled: false });
		setUiSettings.mockImplementation(async (settings: { factoryControlsEnabled: boolean }) => settings);
		useFactoryControlsStore.setState({ enabled: false, loaded: false, saving: false, saveError: false });
	});

	it("defaults to disabled before load", () => {
		expect(useFactoryControlsStore.getState().enabled).toBe(false);
	});

	it("loads the persisted setting from the main process", async () => {
		getUiSettings.mockResolvedValue({ locale: "en", factoryControlsEnabled: true });
		await useFactoryControlsStore.getState().load();
		expect(useFactoryControlsStore.getState()).toMatchObject({ enabled: true, loaded: true });
	});

	it("persists changes", async () => {
		await useFactoryControlsStore.getState().setEnabled(true);
		expect(setUiSettings).toHaveBeenCalledWith({ factoryControlsEnabled: true });
		expect(useFactoryControlsStore.getState()).toMatchObject({ enabled: true, saving: false, saveError: false });
	});

	it("does not reload after the first successful load", async () => {
		await useFactoryControlsStore.getState().load();
		await useFactoryControlsStore.getState().load();
		expect(getUiSettings).toHaveBeenCalledTimes(1);
	});

	it("shares one persisted read across concurrent startup callers", async () => {
		let resolveGet: ((settings: { factoryControlsEnabled: boolean }) => void) | undefined;
		getUiSettings.mockReturnValue(
			new Promise<{ factoryControlsEnabled: boolean }>((resolve) => {
				resolveGet = resolve;
			}),
		);

		const first = useFactoryControlsStore.getState().load();
		const second = useFactoryControlsStore.getState().load();
		expect(getUiSettings).toHaveBeenCalledTimes(1);
		resolveGet?.({ factoryControlsEnabled: true });
		await Promise.all([first, second]);

		expect(useFactoryControlsStore.getState()).toMatchObject({ enabled: true, loaded: true });
	});

	it("does not let a late persisted read overwrite a newer user selection", async () => {
		let resolveGet: ((settings: { factoryControlsEnabled: boolean }) => void) | undefined;
		getUiSettings.mockReturnValue(
			new Promise<{ factoryControlsEnabled: boolean }>((resolve) => {
				resolveGet = resolve;
			}),
		);

		const loading = useFactoryControlsStore.getState().load();
		await useFactoryControlsStore.getState().setEnabled(true);
		resolveGet?.({ factoryControlsEnabled: false });
		await loading;

		expect(useFactoryControlsStore.getState().enabled).toBe(true);
	});

	it("keeps the default usable when persisted settings cannot be read", async () => {
		getUiSettings.mockRejectedValue(new Error("IPC unavailable"));
		await expect(useFactoryControlsStore.getState().load()).resolves.toBeUndefined();
		expect(useFactoryControlsStore.getState()).toMatchObject({ enabled: false, loaded: true });
	});

	it("keeps the current value and exposes an error when persistence fails", async () => {
		setUiSettings.mockRejectedValue(new Error("disk full"));
		await expect(useFactoryControlsStore.getState().setEnabled(true)).resolves.toBeUndefined();
		expect(useFactoryControlsStore.getState()).toMatchObject({
			enabled: false,
			saving: false,
			saveError: true,
		});
	});
});
