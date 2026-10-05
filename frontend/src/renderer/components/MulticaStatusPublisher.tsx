import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../lib/bridge";
import { buildMulticaStatusSnapshot } from "../lib/multica-link-status";
import { createLatestWinsPublisher } from "../lib/multica-status-publisher";
import { useEventsConnection } from "../hooks/useEventsConnection";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useMulticaLinksStore } from "../stores/multica-links-store";

export function MulticaStatusPublisher() {
	const { t } = useTranslation();
	const workspaces = useWorkspaceQuery().data;
	const links = useMulticaLinksStore((state) => state.links);
	const connection = useEventsConnection();
	const publisher = useRef<ReturnType<typeof createLatestWinsPublisher> | null>(null);

	useEffect(() => {
		const currentPublisher = createLatestWinsPublisher({
			publish: (snapshot) => aoBridge.multicaStatus.publish(snapshot),
			// Match the event transport's 150 ms invalidation window.
			delayMs: 150,
		});
		publisher.current = currentPublisher;

		return () => {
			currentPublisher.dispose();
			publisher.current = null;
		};
	}, []);

	useEffect(() => {
		if (workspaces === undefined) return;

		const snapshot = buildMulticaStatusSnapshot({
			links,
			workspaces,
			stale: links.length > 0 && connection === "disconnected",
			t,
		});
		publisher.current?.set(snapshot);
	}, [links, workspaces, connection, t]);

	return null;
}
