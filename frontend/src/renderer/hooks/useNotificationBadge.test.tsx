import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
	useNotificationBadge,
	type NotificationBadgeSource,
} from "./useNotificationBadge";
const item = (id: string, createdAt = "2026-10-20T12:00:00Z") => ({
	id,
	createdAt,
	status: "unread",
});
const countUnseen = vi.fn();
const source: NotificationBadgeSource = {
	key: "host-a",
	items: [item("new"), item("older", "2026-10-19T12:00:00Z")],
	total: 250,
	countUnseen,
};
let client: QueryClient;
const Wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={client}>{children}</QueryClientProvider>
);
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
	countUnseen.mockReset().mockResolvedValue(0);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
it("resets only the badge and persists the watermark through remount", async () => {
	const view = render(<Badge />, { wrapper: Wrapper });
	expect(screen.getByTestId("count")).toHaveTextContent("250");
	view.rerender(<Badge open />);
	expect(screen.getByTestId("count")).toHaveTextContent("0");
	expect(source.items.every((row) => row.status === "unread")).toBe(true);
	view.unmount();
	render(<Badge />, { wrapper: Wrapper });
	await waitFor(() =>
		expect(countUnseen).toHaveBeenCalledWith(
			expect.objectContaining({
				at: Date.parse(source.items[0].createdAt),
				ids: ["new"],
			}),
		),
	);
	expect(screen.getByTestId("count")).toHaveTextContent("0");
});
it("uses the server count for 150 arrivals even when only 100 rows are loaded", async () => {
	const view = render(<Badge open />, { wrapper: Wrapper });
	countUnseen.mockResolvedValue(150);
	const items = Array.from({ length: 100 }, (_, i) =>
		item(`arrival-${i}`, "2026-10-21T12:00:00Z"),
	);
	view.rerender(<Badge feed={{ ...source, total: 400, items }} />);
	await waitFor(() =>
		expect(screen.getByTestId("count")).toHaveTextContent("150"),
	);
	expect(countUnseen).toHaveBeenCalledWith(
		expect.objectContaining({
			at: Date.parse(source.items[0].createdAt),
			ids: ["new"],
		}),
	);
});
it("reacts to a different window resetting the badge and keeps other sources independent", async () => {
	const view = render(<Badge />, { wrapper: Wrapper });
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
	await waitFor(() => expect(countUnseen).toHaveBeenCalled());
	expect(screen.getByTestId("count")).toHaveTextContent("0");
	view.rerender(<Badge feed={{ ...source, key: "host-b" }} />);
	expect(screen.getByTestId("count")).toHaveTextContent("250");
});
it("ignores corrupt saved state", () => {
	localStorage.setItem("ao.notifications.seen.v1", "invalid");
	render(<Badge />, { wrapper: Wrapper });
	expect(screen.getByTestId("count")).toHaveTextContent("250");
});

it("retains server timestamp precision in persisted badge boundaries", async () => {
	const precise = "2026-10-20T12:00:00.123456789Z";
	const feed = { ...source, items: [item("nanosecond", precise)] };
	const view = render(<Badge open feed={feed} />, { wrapper: Wrapper });
	view.rerender(<Badge feed={feed} />);
	await waitFor(() =>
		expect(countUnseen).toHaveBeenCalledWith(
			expect.objectContaining({ timestamp: precise, ids: ["nanosecond"] }),
		),
	);
});
