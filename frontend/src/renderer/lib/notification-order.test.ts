import { expect, it } from "vitest";
import {
	compareNotificationBoundary,
	notificationTimestamp,
} from "./notification-order";
it("orders server timestamps without losing fractional precision", () => {
	expect(
		compareNotificationBoundary(
			{ id: "z", createdAt: "2026-10-20T12:00:00.123456Z" },
			{ id: "a", createdAt: "2026-10-20T12:00:00.123457Z" },
		),
	).toBeLessThan(0);
	expect(notificationTimestamp("2026-10-20T13:00:00.123456+01:00")).toBe(
		"2026-10-20T12:00:00.123456000Z",
	);
	expect(
		compareNotificationBoundary(
			{ id: "a", createdAt: "2026-10-20T12:00:00Z" },
			{ id: "b", createdAt: "2026-10-20T12:00:00Z" },
		),
	).toBeLessThan(0);
});
