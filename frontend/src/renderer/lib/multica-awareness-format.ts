import type { MulticaStatusTone } from "../../shared/multica-session-status";

/** Dot colour per tone, from the same tokens the session status chips use. */
export const toneDotClass: Record<MulticaStatusTone, string> = {
	ready: "bg-success",
	attention: "bg-error",
	pending: "bg-warning",
	working: "bg-primary",
	done: "bg-muted-foreground",
	unknown: "bg-muted-foreground",
};

/** "2 min ago" in the app language; empty when the time is missing or unreadable. */
export function formatSince(since: string | null, nowMs: number, locale: string): string {
	if (!since) return "";
	const then = Date.parse(since);
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((then - nowMs) / 1000);
	const abs = Math.abs(seconds);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
	if (abs < 60) return format.format(seconds, "second");
	if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
	if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
	return format.format(Math.round(seconds / 86400), "day");
}
