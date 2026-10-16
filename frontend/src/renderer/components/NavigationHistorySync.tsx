import { useEffect } from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
	consumeSuppressedMulticaHistoryChange,
	historyIndex,
	isTopbarSessionClosed,
	markTopbarSessionOpened,
	notifyNavigationRestore,
	readAONavigationLocationForHref,
	sessionIdFromHistoryHref,
	writeAONavigationLocation,
	type AONavigationLocation,
	type NavigationHistoryLike,
} from "../lib/navigation-history";
import { useMulticaStore } from "../stores/multica-store";
import { useUiStore } from "../stores/ui-store";

function isHostRoute(href: string): boolean {
	const hashIndex = href.indexOf("#");
	const route = hashIndex >= 0 ? href.slice(hashIndex + 1) : href;
	return route.startsWith("/host/");
}

function defaultLocation(href: string): AONavigationLocation {
	return {
		version: 1,
		href,
		settingsModal: null,
		multicaActive: false,
	};
}

export function NavigationHistorySync() {
	const router = useRouter();
	const navigate = useNavigate();
	const routeHref = useRouterState({ select: (state) => state.location.href });

	useEffect(() => {
		const history = router.history;
		const historyLike = history as unknown as NavigationHistoryLike;
		let applyingHistoryRestore = false;
		let previousHref = history.location.href;
		let previousIndex = historyIndex(history.location.state);
		let historyTip = previousIndex ?? 0;

		const unsubscribeSettings = useUiStore.subscribe((state, previous) => {
			if (applyingHistoryRestore || state.settingsModal === previous.settingsModal) return;
			writeAONavigationLocation(historyLike, { settingsModal: state.settingsModal });
		});

		const unsubscribeMultica = useMulticaStore.subscribe((state, previous) => {
			if (
				applyingHistoryRestore ||
				!state.isLoaded ||
				state.view.active === previous.view.active ||
				consumeSuppressedMulticaHistoryChange(state.view.active)
			) return;
			writeAONavigationLocation(historyLike, { multicaActive: state.view.active }, previous.isLoaded ? "push" : "replace");
		});

		const unsubscribeHistory = history.subscribe(({ location, action }) => {
			const routeChanged = location.href !== previousHref;
			previousHref = location.href;
			const index = historyIndex(location.state);
			const knownHistoryTip = historyTip;
			const isTraversal = action.type !== "PUSH" && action.type !== "REPLACE";
			const direction = index !== null && previousIndex !== null && index < previousIndex ? -1 : 1;
			if (action.type === "PUSH" && index !== null) historyTip = index;
			else if (index !== null) historyTip = Math.max(historyTip, index);
			previousIndex = index;

			if (routeChanged && (action.type === "PUSH" || action.type === "REPLACE") && !isHostRoute(location.href)) {
				const sessionId = sessionIdFromHistoryHref(location.href);
				if (sessionId) markTopbarSessionOpened(sessionId);
			}

			if (routeChanged && (action.type === "PUSH" || action.type === "REPLACE")) {
				const multica = useMulticaStore.getState();
				if (multica.pendingActive ?? multica.view.active) {
					useMulticaStore.getState().setActive(false, { recordHistory: false });
				}
				writeAONavigationLocation(historyLike, {
					settingsModal: useUiStore.getState().settingsModal,
					multicaActive: false,
					sessionView: null,
				}, "replace");
			}

			if (!isTraversal) return;

			const restored = readAONavigationLocationForHref(location.state, location.href);
			const sessionId = restored?.sessionView?.sessionId ?? sessionIdFromHistoryHref(location.href);
			const hostScoped = Boolean(restored?.sessionView?.hostId) || isHostRoute(location.href);
			if (sessionId && !hostScoped && isTopbarSessionClosed(sessionId)) {
				if (direction < 0 && history.canGoBack()) history.back();
				else if (direction > 0 && index !== null && index < knownHistoryTip) history.forward();
				else void navigate({ to: "/sessions", replace: true });
				return;
			}

			const locationToRestore = restored ?? defaultLocation(location.href);
			applyingHistoryRestore = true;
			useUiStore.setState({ settingsModal: locationToRestore.settingsModal });
			const multica = useMulticaStore.getState();
			if ((multica.pendingActive ?? multica.view.active) !== locationToRestore.multicaActive) {
				useMulticaStore.getState().setActive(locationToRestore.multicaActive, { recordHistory: false });
			}
			notifyNavigationRestore(locationToRestore);
			queueMicrotask(() => {
				applyingHistoryRestore = false;
			});
		});

		return () => {
			unsubscribeSettings();
			unsubscribeMultica();
			unsubscribeHistory();
		};
	}, [navigate, router]);

	useEffect(() => {
		const history = router.history as unknown as NavigationHistoryLike;
		if (readAONavigationLocationForHref(history.location.state, history.location.href)) return;
		writeAONavigationLocation(
			history,
			{
				settingsModal: useUiStore.getState().settingsModal,
				multicaActive: useMulticaStore.getState().view.active,
				sessionView: null,
			},
			"replace",
		);
	}, [routeHref, router]);

	return null;
}
