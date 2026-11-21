import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

const presenters = new Map<string, symbol[]>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };

export function useBrowserPresentation(sessionId: string, active: boolean) {
	const token = useRef(Symbol()).current;
	const isPresenter = useCallback(() => presenters.get(sessionId)?.at(-1) === token, [sessionId, token]);
	const canControl = useCallback((ownerId = sessionId) => !presenters.get(ownerId)?.length || presenters.get(ownerId)?.at(-1) === token, [sessionId, token]);
	const snapshot = useCallback(() => active && canControl(), [active, canControl]);
	const presenting = useSyncExternalStore(subscribe, snapshot, () => false);
	const claim = useCallback(() => {
		if (!active) return;
		presenters.set(sessionId, [...(presenters.get(sessionId) ?? []).filter((item) => item !== token), token]);
		notify();
	}, [active, sessionId, token]);
	useLayoutEffect(() => {
		claim();
		return () => {
			const remaining = presenters.get(sessionId)?.filter((item) => item !== token) ?? [];
			if (remaining.length) presenters.set(sessionId, remaining);
			else presenters.delete(sessionId);
			notify();
		};
	}, [claim, sessionId, token]);
	return { presenting, isPresenter, canControl, claim };
}
