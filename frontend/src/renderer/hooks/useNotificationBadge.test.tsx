import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import {
	notificationBadgeCount,
	useNotificationBadge,
	type NotificationBadgeSource,
} from "./useNotificationBadge";

const item = (id: string, createdAt = "2026-10-20T12:00:00Z") => ({
	id,
	createdAt,
	status: "unread",
});
const source: NotificationBadgeSource = {
	key: "host-a",
	items: [item("new"), item("older", "2026-10-19T12:00:00Z")],
	total: 250,
};
function Badge({
	open = false,
	feed = source,
}: {
	open?: boolean;
	feed?: NotificationBadgeSource;
}) {
	return <span data-testid="count">{useNotificationBadge([feed], open)}</span>;
}
beforeEach(() => {
	localStorage.clear();
});

it("resets only the badge, persists through remount, and leaves unread rows intact", async () => {
	const view = render(<Badge />);
	expect(screen.getByTestId("count")).toHaveTextContent("250");
	view.rerender(<Badge open />);
	await waitFor(() =>
		expect(screen.getByTestId("count")).toHaveTextContent("0"),
	);
	expect(source.items.every((row) => row.status === "unread")).toBe(true);
	view.unmount();
	render(<Badge />);
	expect(screen.getByTestId("count")).toHaveTextContent("0");
});
it("counts new arrivals and other sources without reviving seen rows", async () => {
	const view = render(<Badge open />);
	await waitFor(() =>
		expect(screen.getByTestId("count")).toHaveTextContent("0"),
	);
	view.rerender(
		<Badge feed={{ ...source, items: [item("same-time"), ...source.items] }} />,
	);
	expect(screen.getByTestId("count")).toHaveTextContent("1");
	view.rerender(<Badge feed={{ ...source, key: "host-b" }} />);
	expect(screen.getByTestId("count")).toHaveTextContent("250");
});
it("reacts to a different window resetting its badge", () => {
	render(<Badge />);
	act(() => {
		localStorage.setItem(
			"ao.notifications.seen.v1",
			JSON.stringify({
				"host-a": { at: Date.parse(source.items[0].createdAt), ids: ["new"] },
			}),
		);
		window.dispatchEvent(
			new StorageEvent("storage", { key: "ao.notifications.seen.v1" }),
		);
	});
	expect(screen.getByTestId("count")).toHaveTextContent("0");
});
it("excludes read rows and accepts corrupt stored state", () => {
	expect(notificationBadgeCount(source)).toBe(250);
	expect(
		notificationBadgeCount(
			{ ...source, items: [{ ...item("new"), status: "read" }] },
			{ at: 0, ids: [] },
		),
	).toBe(0);
	localStorage.setItem("ao.notifications.seen.v1", "invalid");
	render(<Badge />);
	expect(screen.getByTestId("count")).toHaveTextContent("250");
});
