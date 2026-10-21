// Preserve server timestamp precision when comparing rows or sending badge watermarks.
export function notificationTimestamp(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.valueOf())) return "1970-01-01T00:00:00.000000000Z";
	const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
	return `${date.toISOString().slice(0, 19)}.${fraction.padEnd(9, "0").slice(0, 9)}Z`;
}
export function compareNotificationText(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}
export function compareNotificationBoundary(
	a: { id: string; createdAt: string },
	b: { id: string; createdAt: string },
): number {
	return (
		compareNotificationText(
			notificationTimestamp(a.createdAt),
			notificationTimestamp(b.createdAt),
		) || compareNotificationText(a.id, b.id)
	);
}
