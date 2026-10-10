import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AWARENESS_STATE, type AwarenessState } from "../../shared/multica-awareness";

const bridge = vi.hoisted(() => ({
	listener: null as ((state: AwarenessState) => void) | null,
	getState: vi.fn(),
	command: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		multicaAwareness: {
			getState: bridge.getState,
			command: bridge.command,
			onState: (listener: (state: AwarenessState) => void) => {
				bridge.listener = listener;
				return () => undefined;
			},
		},
	},
}));

describe("multica awareness store", () => {
	beforeEach(() => {
		vi.resetModules();
		bridge.listener = null;
		bridge.getState.mockReset();
		bridge.command.mockReset();
	});

	it("loads once, takes the pushed state over a slower initial fetch, and applies command results", async () => {
		const { useMulticaAwarenessStore } = await import("./multica-awareness-store");
		let resolveInitial: (state: AwarenessState) => void = () => undefined;
		bridge.getState.mockReturnValue(new Promise((resolve) => (resolveInitial = resolve)));
		const loading = useMulticaAwarenessStore.getState().load();
		void useMulticaAwarenessStore.getState().load();
		const pushed = { ...EMPTY_AWARENESS_STATE, masterEnabled: true };
		bridge.listener?.(pushed);
		resolveInitial({ ...EMPTY_AWARENESS_STATE, masterEnabled: false });
		await loading;
		expect(bridge.getState).toHaveBeenCalledTimes(1);
		expect(useMulticaAwarenessStore.getState().state.masterEnabled).toBe(true);

		bridge.command.mockResolvedValue({ ok: true, state: { ...EMPTY_AWARENESS_STATE, maxSockets: 3 } });
		expect(await useMulticaAwarenessStore.getState().command({ type: "setMaxSockets", value: 3 })).toMatchObject({ ok: true });
		expect(useMulticaAwarenessStore.getState().state.maxSockets).toBe(3);

		bridge.command.mockResolvedValue({ ok: false, reason: "socket_cap" });
		await useMulticaAwarenessStore.getState().command({ type: "setMaxSockets", value: 1 });
		expect(useMulticaAwarenessStore.getState().state.maxSockets).toBe(3);

		bridge.command.mockRejectedValue(new Error("gone"));
		expect(await useMulticaAwarenessStore.getState().command({ type: "setMaster", enabled: false })).toEqual({ ok: false, reason: "save_failed" });
	});
});
