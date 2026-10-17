import { create } from "zustand";
import type { MulticaViewState } from "../../shared/multica";
import { aoBridge } from "../lib/bridge";
import { suppressNextMulticaHistoryChange } from "../lib/navigation-history";

const INITIAL_VIEW: MulticaViewState = { active: false, status: "unconfigured", url: "" };

type MulticaStore = {
	view: MulticaViewState;
	isLoaded: boolean;
	/** Visibility of the newest request whose reply has not arrived; null when none is in flight. */
	pendingActive: boolean | null;
	/** Subscribes to main-process state pushes and fetches the current state. Idempotent. */
	load: () => Promise<void>;
	setActive: (active: boolean, options?: { recordHistory?: boolean }) => void;
	toggle: () => void;
	reload: () => void;
};

let subscribed = false;
// Requests are answered in order, one reply each, so a reply is matched to its
// request by sequence, not by the visibility it asked for.
let requestSeq = 0;
let inFlight: Array<{ seq: number; active: boolean }> = [];

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
		const effective = get().pendingActive ?? get().view.active;
		if (options?.recordHistory === false && effective !== active) {
			suppressNextMulticaHistoryChange(active);
		}
		const seq = ++requestSeq;
		inFlight.push({ seq, active });
		set({ pendingActive: active });
		const settle = () => {
			inFlight = inFlight.filter((request) => request.seq !== seq);
			set({ pendingActive: inFlight.length ? inFlight[inFlight.length - 1].active : null });
		};
		void aoBridge.multica.setActive(active).then(settle, settle);
	},
	toggle: () => get().setActive(!get().view.active),
	reload: () => {
		void aoBridge.multica.reload().catch(() => undefined);
	},
}));
