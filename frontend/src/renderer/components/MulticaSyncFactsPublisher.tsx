import { useEffect, useRef } from "react";
import type { MulticaSyncFacts } from "../../shared/multica-status-sync";
import { aoBridge } from "../lib/bridge";
import { buildMulticaSyncFacts } from "../lib/multica-sync-facts";
import { createLatestWinsPublisher, type LatestWinsPublisher } from "../lib/multica-status-publisher";
import { useEventsConnection } from "../hooks/useEventsConnection";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { useMulticaSyncStore } from "../stores/multica-sync-store";

// Tells the main process what the daemon says about the sessions that are linked to Multica issues,
// so status sync can map it. It renders nothing and publishes nothing until the workspaces are loaded.
export function MulticaSyncFactsPublisher() {
	const workspaces = useWorkspaceQuery().data;
	const links = useMulticaLinksStore((state) => state.links);
	const connection = useEventsConnection();
	const load = useMulticaSyncStore((state) => state.load);
	const publisher = useRef<LatestWinsPublisher<MulticaSyncFacts> | null>(null);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		const currentPublisher = createLatestWinsPublisher<MulticaSyncFacts>({
			publish: (facts) => aoBridge.multicaSync.publishFacts(facts),
			delayMs: 300,
		});
		publisher.current = currentPublisher;
		return () => {
			currentPublisher.dispose();
			publisher.current = null;
		};
	}, []);

	useEffect(() => {
		if (workspaces === undefined) return;
		publisher.current?.set(buildMulticaSyncFacts({ workspaces, links, stale: connection === "disconnected" }));
	}, [connection, links, workspaces]);

	return null;
}
