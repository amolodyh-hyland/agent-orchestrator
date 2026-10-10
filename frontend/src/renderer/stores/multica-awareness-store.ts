import { create } from "zustand";
import { EMPTY_AWARENESS_STATE, type AwarenessCommand, type AwarenessCommandResult, type AwarenessState } from "../../shared/multica-awareness";
import { aoBridge } from "../lib/bridge";

type MulticaAwarenessStore = {
	state: AwarenessState;
	/** Subscribes to main-process state pushes and fetches the current state. Idempotent. */
	load: () => Promise<void>;
	command: (command: AwarenessCommand) => Promise<AwarenessCommandResult>;
};

let subscribed = false;

export const useMulticaAwarenessStore = create<MulticaAwarenessStore>((set) => ({
	state: EMPTY_AWARENESS_STATE,
	load: async () => {
		if (subscribed) return;
		subscribed = true;
		let pushed = false;
		try {
			aoBridge.multicaAwareness.onState((state) => {
				pushed = true;
				set({ state });
			});
		} catch {
			// A missing bridge leaves awareness unavailable; AO keeps working.
		}
		try {
			const state = await aoBridge.multicaAwareness.getState();
			if (!pushed && state) set({ state });
		} catch {
			// A missing bridge leaves awareness unavailable; AO keeps working.
		}
	},
	command: async (command) => {
		try {
			const result = await aoBridge.multicaAwareness.command(command);
			if (result.ok) set({ state: result.state });
			return result;
		} catch {
			return { ok: false, reason: "save_failed" };
		}
	},
}));
