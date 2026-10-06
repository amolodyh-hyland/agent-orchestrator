import { create } from "zustand";
import type {
	MulticaIssueLink,
	MulticaIssueLinkAddRequest,
	MulticaIssueLinkAddResult,
	MulticaIssueLinkOpenRequest,
	MulticaIssueLinkRemoveRequest,
} from "../../shared/multica-issue-links";
import { aoBridge } from "../lib/bridge";

type MulticaLinksStore = {
	links: MulticaIssueLink[];
	load: () => Promise<void>;
	add: (request: MulticaIssueLinkAddRequest) => Promise<MulticaIssueLinkAddResult>;
	remove: (request: MulticaIssueLinkRemoveRequest) => Promise<void>;
	openIssue: (request: MulticaIssueLinkOpenRequest) => Promise<boolean>;
};

let subscribed = false;

export const useMulticaLinksStore = create<MulticaLinksStore>((set) => ({
	links: [],
	load: async () => {
		if (subscribed) return;
		subscribed = true;
		let pushed = false;
		try {
			aoBridge.multicaLinks.onChanged((links) => {
				pushed = true;
				set({ links });
			});
		} catch {
			// A missing bridge leaves issue links unavailable; AO keeps working.
		}
		try {
			const links = await aoBridge.multicaLinks.list();
			if (!pushed) set({ links });
		} catch {
			// A missing bridge leaves issue links unavailable; AO keeps working.
		}
	},
	add: async (request) => {
		try {
			const result = await aoBridge.multicaLinks.add(request);
			if (result.ok) set({ links: result.links });
			return result;
		} catch {
			return { ok: false, reason: "save_failed" };
		}
	},
	remove: async (request) => {
		try {
			const links = await aoBridge.multicaLinks.remove(request);
			set({ links });
		} catch {
			// Keep the current links visible when unlinking fails.
		}
	},
	openIssue: async (request) => {
		try {
			return await aoBridge.multicaLinks.openIssue(request);
		} catch {
			return false;
		}
	},
}));
