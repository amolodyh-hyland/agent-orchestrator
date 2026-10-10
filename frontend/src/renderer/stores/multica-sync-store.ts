import { create } from "zustand";
import {
	EMPTY_MULTICA_SYNC_SNAPSHOT,
	type MulticaSyncLinkRef,
	type MulticaSyncSettingsPatch,
	type MulticaSyncSnapshot,
} from "../../shared/multica-status-sync";
import { aoBridge } from "../lib/bridge";

type MulticaSyncStore = {
	snapshot: MulticaSyncSnapshot;
	load: () => Promise<void>;
	setSettings: (patch: MulticaSyncSettingsPatch) => Promise<void>;
	setLink: (request: MulticaSyncLinkRef & { enabled: boolean }) => Promise<void>;
	resume: (ref: MulticaSyncLinkRef) => Promise<void>;
	reopen: (ref: MulticaSyncLinkRef) => Promise<void>;
	syncNow: (ref: MulticaSyncLinkRef) => Promise<void>;
};

let subscribed = false;

export const useMulticaSyncStore = create<MulticaSyncStore>((set) => {
	const apply = async (request: () => Promise<MulticaSyncSnapshot>): Promise<void> => {
		try {
			set({ snapshot: await request() });
		} catch {
			// The current state stays visible when a request fails.
		}
	};
	return {
		snapshot: EMPTY_MULTICA_SYNC_SNAPSHOT,
		load: async () => {
			if (subscribed) return;
			subscribed = true;
			let pushed = false;
			try {
				aoBridge.multicaSync.onChanged((snapshot) => {
					pushed = true;
					set({ snapshot });
				});
			} catch {
				// A missing bridge leaves status sync unavailable; AO keeps working.
			}
			try {
				const snapshot = await aoBridge.multicaSync.getState();
				if (!pushed) set({ snapshot });
			} catch {
				// A missing bridge leaves status sync unavailable; AO keeps working.
			}
		},
		setSettings: (patch) => apply(() => aoBridge.multicaSync.setSettings(patch)),
		setLink: (request) => apply(() => aoBridge.multicaSync.setLink(request)),
		resume: (ref) => apply(() => aoBridge.multicaSync.resume(ref)),
		// The caller has asked the user; main refuses a reopen without this flag.
		reopen: (ref) => apply(() => aoBridge.multicaSync.reopen({ ...ref, confirmed: true })),
		syncNow: (ref) => apply(() => aoBridge.multicaSync.syncNow(ref)),
	};
});

/** For tests: forget that the store subscribed to the bridge. */
export function resetMulticaSyncStoreSubscription(): void {
	subscribed = false;
}
