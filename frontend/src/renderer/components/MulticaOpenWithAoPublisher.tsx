import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpenWithAoDaemonState, OpenWithAoSnapshot } from "../../shared/multica-open-with-ao";
import { aoBridge } from "../lib/bridge";
import { buildOpenWithAoSnapshot } from "../lib/multica-open-with-ao-feed";
import { createLatestWinsPublisher, type LatestWinsPublisher } from "../lib/multica-status-publisher";
import { useEventsConnection } from "../hooks/useEventsConnection";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useMulticaLinksStore } from "../stores/multica-links-store";

export function MulticaOpenWithAoPublisher() {
	const { t } = useTranslation();
	const workspaces = useWorkspaceQuery().data;
	const links = useMulticaLinksStore((state) => state.links);
	const connection = useEventsConnection();
	const [daemon, setDaemon] = useState<OpenWithAoDaemonState>("stopped");
	const publisher = useRef<LatestWinsPublisher<OpenWithAoSnapshot> | null>(null);

	useEffect(() => {
		let active = true;
		let statusVersion = 0;
		const unsubscribe = aoBridge.daemon.onStatus((status) => {
			statusVersion += 1;
			if (active) setDaemon(status.state);
		});
		const requestVersion = statusVersion;
		void aoBridge.daemon.getStatus()
			.then((status) => {
				if (active && statusVersion === requestVersion) setDaemon(status.state);
			})
			.catch(() => undefined);

		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		const currentPublisher = createLatestWinsPublisher<OpenWithAoSnapshot>({
			publish: (snapshot) => aoBridge.multicaOpenWithAo.publish(snapshot),
			delayMs: 150,
		});
		publisher.current = currentPublisher;

		return () => {
			currentPublisher.dispose();
			publisher.current = null;
		};
	}, []);

	useEffect(() => {
		const snapshot = workspaces === undefined
			? { daemon, stale: false, projects: [] }
			: buildOpenWithAoSnapshot({
				workspaces,
				links,
				daemon,
				stale: connection === "disconnected",
				t,
			});
		publisher.current?.set(snapshot);
	}, [daemon, connection, links, t, workspaces]);

	return null;
}
