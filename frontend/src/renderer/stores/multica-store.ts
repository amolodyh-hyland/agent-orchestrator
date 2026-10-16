import { create } from "zustand";
import type { MulticaViewState } from "../../shared/multica";
import { aoBridge } from "../lib/bridge";
import { suppressNextMulticaHistoryChange } from "../lib/navigation-history";

const INITIAL_VIEW: MulticaViewState = { active: false, status: "unconfigured", url: "" };

type MulticaStore = {
	view: MulticaViewState;
	isLoaded: boolean;
	/** Visibility requested from the main process and not yet acknowledged by a state push. */
	pendingActive: boolean | null;
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
	pendingActive: null,
	load: async () => {
		if (subscribed) return;
		subscribed = true;
		// The main process owns the state; a push that lands before the initial
		// fetch resolves is newer than the fetch.
		let pushed = false;
		aoBridge.multica.onState((view) => {
			pushed = true;
			set((state) => ({ view, isLoaded: true, pendingActive: state.pendingActive === view.active ? null : state.pendingActive }));
		});
		try {
			const view = await aoBridge.multica.getState();
			if (!pushed && view) set({ view, isLoaded: true });
		} catch {
			// A missing bridge leaves Multica unavailable; AO keeps working.
		}
	},
	setActive: (active, options) => {
		const effective = get().pendingActive ?? get().view.active;
		if (options?.recordHistory === false && effective !== active) {
			suppressNextMulticaHistoryChange(active);
		}
		set({ pendingActive: active });
		void aoBridge.multica.setActive(active).catch(() => {
			if (get().pendingActive === active) set({ pendingActive: null });
		});
	},
	toggle: () => get().setActive(!get().view.active),
	reload: () => {
		void aoBridge.multica.reload().catch(() => undefined);
	},
}));
