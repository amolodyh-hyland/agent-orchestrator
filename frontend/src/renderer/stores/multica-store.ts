import { create } from "zustand";
import type { MulticaViewState } from "../../shared/multica";
import { aoBridge } from "../lib/bridge";
import { suppressNextMulticaHistoryChange } from "../lib/navigation-history";

const INITIAL_VIEW: MulticaViewState = { active: false, status: "unconfigured", url: "" };

type MulticaStore = {
	view: MulticaViewState;
	isLoaded: boolean;
	/** Subscribes to main-process state pushes and fetches the current state. Idempotent. */
	load: () => Promise<void>;
	setActive: (active: boolean, options?: { recordHistory?: boolean }) => void;
	toggle: () => void;
	reload: () => void;
};

let subscribed = false;

export const useMulticaStore = create<MulticaStore>((set, get) => ({
	view: INITIAL_VIEW,
	isLoaded: false,
	load: async () => {
		if (subscribed) return;
		subscribed = true;
		// The main process owns the state; a push that lands before the initial
		// fetch resolves is newer than the fetch.
		let pushed = false;
		aoBridge.multica.onState((view) => {
			pushed = true;
			set({ view, isLoaded: true });
		});
		try {
			const view = await aoBridge.multica.getState();
			if (!pushed && view) set({ view, isLoaded: true });
		} catch {
			// A missing bridge leaves Multica unavailable; AO keeps working.
		}
	},
	setActive: (active, options) => {
		if (options?.recordHistory === false && get().view.active !== active) {
			suppressNextMulticaHistoryChange(active);
		}
		void aoBridge.multica.setActive(active).catch(() => undefined);
	},
	toggle: () => get().setActive(!get().view.active),
	reload: () => {
		void aoBridge.multica.reload().catch(() => undefined);
	},
}));
