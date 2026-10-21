import {
	notificationTimestamp,
	compareNotificationText,
} from "../lib/notification-order";
import { useQueries } from "@tanstack/react-query";
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
	countUnseen?: (seen: Seen) => Promise<number>;
};
type Seen = { at: number; ids: string[]; timestamp?: string };
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
	notificationTimestamp(item.updatedAt ?? item.createdAt);
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
					(!seen.timestamp || typeof seen.timestamp === "string") &&
					seen.ids.every((id) => typeof id === "string"),
				);
			}),
		);
	} catch {
		return {};
	}
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
			const at = source.items
				.map(timestamp)
				.sort(compareNotificationText)
				.at(-1)!;
			const previous = next[source.key];
			const previousAt = previous
				? notificationTimestamp(
						previous.timestamp ?? new Date(previous.at).toISOString(),
					)
				: "";
			if (previousAt > at) continue;
			const ids = new Set(previousAt === at ? previous?.ids : []);
			for (const item of source.items)
				if (timestamp(item) === at) ids.add(item.id);
			next[source.key] = {
				at: Date.parse(at),
				timestamp: at,
				ids: [...ids].sort(),
			};
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
	const counts = useQueries({
		queries: sources.map((source) => {
			const seen = state[source.key];
			return {
				queryKey: [
					"notification-badge",
					source.key,
					seen,
					source.total,
					source.items.map((item) => [
						item.id,
						item.status,
						item.updatedAt ?? item.createdAt,
					]),
				],
				queryFn: () => source.countUnseen!(seen),
				enabled: !open && Boolean(seen && source.countUnseen),
				retry: 1,
			};
		}),
	});
	return sources.reduce(
		(total, source, index) =>
			total +
			(open ? 0 : state[source.key] ? (counts[index].data ?? 0) : source.total),
		0,
	);
}
