import { useEffect, useSyncExternalStore } from "react";

type BadgeItem = {
	id: string;
	status: string;
	createdAt: string;
	updatedAt?: string;
};
export type NotificationBadgeSource = {
	key: string;
	items: BadgeItem[];
	total: number;
};
type Seen = { at: number; ids: string[] };
const storageKey = "ao.notifications.seen.v1";
const listeners = new Set<() => void>();
let fallback = "{}";
const snapshot = () => {
	try {
		return window.localStorage.getItem(storageKey) ?? "{}";
	} catch {
		return fallback;
	}
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === storageKey || event.key === null) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
};
const timestamp = (item: BadgeItem) =>
	Date.parse(item.updatedAt ?? item.createdAt) || 0;
function parse(raw: string): Record<string, Seen> {
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry): entry is [string, Seen] => {
				const seen = entry[1] as Partial<Seen> | null;
				return Boolean(
					seen &&
					Number.isFinite(seen.at) &&
					Array.isArray(seen.ids) &&
					seen.ids.every((id) => typeof id === "string"),
				);
			}),
		);
	} catch {
		return {};
	}
}

export function notificationBadgeCount(
	source: NotificationBadgeSource,
	seen?: Seen,
): number {
	if (!seen || !Number.isFinite(seen.at) || !Array.isArray(seen.ids))
		return source.total;
	return source.items.filter(
		(item) =>
			item.status === "unread" &&
			(timestamp(item) > seen.at ||
				(timestamp(item) === seen.at && !seen.ids.includes(item.id))),
	).length;
}

export function useNotificationBadge(
	sources: NotificationBadgeSource[],
	open = false,
): number {
	const raw = useSyncExternalStore(subscribe, snapshot);
	const state = parse(raw);
	useEffect(() => {
		if (!open) return;
		const next = parse(snapshot());
		for (const source of sources) {
			if (source.items.length === 0) continue;
			const at = Math.max(...source.items.map(timestamp));
			const previous = next[source.key];
			if (previous?.at > at) continue;
			const ids = new Set(previous?.at === at ? previous.ids : []);
			for (const item of source.items)
				if (timestamp(item) === at) ids.add(item.id);
			next[source.key] = { at, ids: [...ids].sort() };
		}
		const value = JSON.stringify(next);
		if (value === snapshot()) return;
		fallback = value;
		try {
			window.localStorage.setItem(storageKey, value);
		} catch {
			/* Keep badge state in memory when storage is unavailable. */
		}
		for (const listener of listeners) listener();
	}, [open, sources]);
	return sources.reduce(
		(count, source) =>
			count + notificationBadgeCount(source, state[source.key]),
		0,
	);
}
