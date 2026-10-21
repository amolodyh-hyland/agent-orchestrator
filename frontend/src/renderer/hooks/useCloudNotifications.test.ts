import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCpNotification } from "../lib/cloud-cp/types";
import { CloudCpError } from "../lib/cloud-cp/errors";
import { isCleared, useCloudNotifications } from "./useCloudNotifications";

const { cloudCpMock, subscribeNotificationsMock } = vi.hoisted(() => ({
	cloudCpMock: vi.fn(),
	subscribeNotificationsMock: vi.fn(async (_options?: { onEvent: (event: { sequence: number }) => void; after?: number }): Promise<void> => undefined),
}));

vi.mock("./useCloudCp", () => ({ useCloudCp: () => cloudCpMock() }));
vi.mock("./useCloudOrg", () => ({ useCloudOrg: () => ({ org: { id: "org-1" } }) }));
vi.mock("./useWorkspaceQuery", () => ({ cloudSessionsQueryKey: ["cloud-sessions"] }));
vi.mock("./useOrchestratorChildren", () => ({ orchestratorChildrenQueryKey: ["orchestrator-children"] }));
vi.mock("../lib/cloud-cp/stream-bridge", () => ({ subscribeNotificationEventsBridged: subscribeNotificationsMock }));
vi.mock("../lib/cloud-notification-hints", () => ({ subscribeCloudNotificationHints: () => () => undefined }));

const at = (value: string) => Date.parse(value);
const row = (overrides: Partial<{ revision: string; id: string; createdAt: string; updatedAt: string; status: "unread" | "read" }> = {}) => ({
	id: "cntf_1",
	revision: "1",
	createdAt: "2026-07-21T10:00:00Z",
	updatedAt: "2026-07-21T10:00:00Z",
	status: "read" as const,
	...overrides,
});

describe("isCleared", () => {
	it("keeps rows visible when nothing was cleared", () => {
		expect(isCleared(row(), { before: 0, ids: {} })).toBe(false);
	});

	it("hides rows at or before the clear-all cutoff", () => {
		expect(isCleared(row(), { before: at("2026-07-21T10:00:00Z"), ids: {} })).toBe(true);
	});

	it("shows rows created after the clear-all cutoff", () => {
		expect(isCleared(row({ createdAt: "2026-07-21T11:00:00Z" }), { before: at("2026-07-21T10:00:00Z"), ids: {} })).toBe(false);
	});

	it("keeps a cleared row hidden while its mark-read is still in flight", () => {
		const clears = { before: 0, ids: { cntf_1: at("2026-07-21T10:00:00Z") } };
		expect(isCleared(row({ status: "unread" }), clears)).toBe(true);
	});

	it("keeps a cleared row hidden after mark-read bumps its updatedAt", () => {
		const clears = { before: 0, ids: { cntf_1: at("2026-07-21T10:00:00Z") } };
		expect(isCleared(row({ updatedAt: "2026-07-21T10:05:00Z" }), clears)).toBe(true);
	});

	it("shows a cleared row again when the control plane re-raises it", () => {
		const clears = { before: at("2026-07-21T10:00:00Z"), ids: { cntf_1: at("2026-07-21T10:00:00Z") } };
		expect(isCleared(row({ status: "unread", updatedAt: "2026-07-21T12:00:00Z" }), clears)).toBe(false);
	});

	it("keeps a revived row visible after it is read, even under the clear-all cutoff", () => {
		const clears = { before: at("2026-07-21T12:00:00Z"), ids: { cntf_1: null } };
		expect(isCleared(row({ updatedAt: "2026-07-21T12:30:00Z" }), clears)).toBe(false);
	});

	it("uses the per-row marker over the clear-all cutoff", () => {
		const clears = { before: at("2026-07-21T09:00:00Z"), ids: { cntf_1: at("2026-07-21T10:00:00Z") } };
		expect(isCleared(row({ createdAt: "2026-07-21T10:00:00Z" }), clears)).toBe(true);
	});
});

it("a later range clear dismisses a previously revived row again", () => {
 const through = { id: "z", createdAt: "2026-07-22T00:00:00Z", clearedRevision: "10" };
 expect(isCleared(row({ status: "read" }), { before: 0, ids: { cntf_1: null }, through })).toBe(true);
 expect(isCleared(row({ status: "unread", revision: "11", updatedAt: "2026-07-24T00:00:00Z" }), { before: 0, ids: { cntf_1: null }, through })).toBe(false);
});

function cloudRow(overrides: Partial<CloudCpNotification> = {}): CloudCpNotification {
	return {
		id: "cntf_1",
	revision: "1",
		source: "cloud",
		orgId: "org-1",
		type: "ready_to_merge",
		title: "Pull request ready to merge",
		body: "acme/cloud#8 is ready to merge.",
		status: "read",
		createdAt: "2026-07-21T10:00:00Z",
		updatedAt: "2026-07-21T10:00:00Z",
		...overrides,
	};
}

describe("useCloudNotifications clearing", () => {
	let items: CloudCpNotification[];
	const listNotifications = vi.fn();
	const markNotificationsRead = vi.fn();
 const clearNotificationsThrough = vi.fn();

	function renderCloudNotifications(
		userId = "user-1",
		queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	) {
		cloudCpMock.mockReturnValue({
			client: { listNotifications, markNotificationsRead, clearNotificationsThrough },
			ready: true,
			baseUrl: "https://cloud.test",
			userId,
		});
		const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
		return renderHook(() => useCloudNotifications("all", { live: false }), { wrapper });
	}

	beforeEach(() => {
		window.localStorage.clear();
		items = [cloudRow()];
		listNotifications.mockReset().mockImplementation(async () => ({
			items,
			unreadCount: items.filter((item) => item.status === "unread").length,
			page: { hasMore: false },
			latestSequence: 0,
		}));
		markNotificationsRead.mockReset().mockResolvedValue({ updated: 1 });
 clearNotificationsThrough.mockReset().mockResolvedValue({ updated: 150, clearedRevision: "10" });
	});

	it("discards unsafe timestamp range markers persisted by older clients", async () => {
		localStorage.setItem("ao.cloudNotifications.cleared:https://cloud.test:org-1:user-1", JSON.stringify({
			before: 0, ids: {}, through: { id: "z", createdAt: "2026-07-22T00:00:00Z", clearedAt: at("2026-07-23T00:00:00Z") },
		}));
		items = [cloudRow({ status: "unread" })];
		const { result } = renderCloudNotifications();
		await waitFor(() => expect(result.current.items[0]?.status).toBe("unread"));
	});

	it("persists a range boundary covering unloaded Cloud history", async () => {
  items = [cloudRow({ id: "newer", createdAt: "2026-07-22T10:00:00Z", status: "unread" }), cloudRow({ status: "unread" })];
  const { result } = renderCloudNotifications();
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  const boundary = { id: items[1].id, createdAt: items[1].createdAt };
  await act(() => result.current.clearThrough(boundary));
  expect(clearNotificationsThrough).toHaveBeenCalledWith("org-1", boundary);
  expect(result.current.items.map((item) => item.id)).toEqual(["newer"]);
  const saved = JSON.parse(localStorage.getItem("ao.cloudNotifications.cleared:https://cloud.test:org-1:user-1")!);
  expect(isCleared(cloudRow({ id: "unloaded", createdAt: "2026-07-20T00:00:00Z" }), saved)).toBe(true);
 });

	it("keeps a re-raise between commit and clear response visible across remounts", async () => {
		items = [cloudRow({ status: "unread", revision: "9007199254740994" })];
		const original = items[0];
		let reply!: (result: { updated: number; clearedRevision: string }) => void;
		clearNotificationsThrough.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
		const first = renderCloudNotifications();
		await waitFor(() => expect(first.result.current.items).toHaveLength(1));
		let clearing!: Promise<void>;
		act(() => { clearing = first.result.current.clearThrough(original); });
		// Read transaction commits revision ...995, then the server re-raises
		// the row before that transaction's HTTP response reaches this window.
		// Timestamps deliberately tie: bigint revisions must decide visibility.
		items = [cloudRow({ ...original, status: "unread", revision: "9007199254740996" })];
		await act(async () => {
			reply({ updated: 1, clearedRevision: "9007199254740995" });
			await clearing;
		});
		await waitFor(() => expect(first.result.current.items[0]?.status).toBe("unread"));
		first.unmount();
		const second = renderCloudNotifications();
		await waitFor(() => expect(second.result.current.items[0]?.revision).toBe("9007199254740996"));
		// A later click must not hide the revived generation again.
		items = items.map((item) => ({ ...item, status: "read", revision: "9007199254740997" }));
		await act(() => second.result.current.refetch());
		expect(second.result.current.items).toHaveLength(1);
	});

	it("does not advance a wider clear when clearing a narrower range again", async () => {
		const ranges = [
			{ id: "z", createdAt: "2026-07-23T00:00:00Z", clearedRevision: "10" },
			{ id: "z", createdAt: "2026-07-21T00:00:00Z", clearedRevision: "20" },
		];
		expect(isCleared(row({ status: "unread", revision: "15", createdAt: "2026-07-22T00:00:00Z" }), { before: 0, ids: {}, ranges })).toBe(false);
		expect(isCleared(row({ status: "read", revision: "19", createdAt: "2026-07-20T00:00:00Z" }), { before: 0, ids: {}, ranges })).toBe(true);
	});

 it("refreshes a second open window when its recipient-scoped read event arrives", async () => {
  items = [cloudRow({ status: "unread" })];
  const first = renderCloudNotifications();
  await waitFor(() => expect(first.result.current.items[0]?.status).toBe("unread"));
  const callbacks: Array<(event: { sequence: number }) => void> = [];
  subscribeNotificationsMock.mockImplementation((options) => { callbacks.push(options!.onEvent); return new Promise<void>(() => {}); });
  const secondClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: secondClient }, children);
  const second = renderHook(() => useCloudNotifications("all"), { wrapper });
  await waitFor(() => expect(second.result.current.items[0]?.status).toBe("unread"));
  markNotificationsRead.mockImplementation(async () => { items = items.map((item) => ({ ...item, status: "read" })); return { updated: 1 }; });
  await act(() => first.result.current.markRead([items[0].id]));
  expect(second.result.current.items[0]?.status).toBe("unread");
  act(() => callbacks[0]({ sequence: 1 }));
  await waitFor(() => expect(second.result.current.items[0]?.status).toBe("read"));
 });

	it("hides a read row without asking the control plane to mark it read again", async () => {
		const { result } = renderCloudNotifications();
		await waitFor(() => expect(result.current.items).toHaveLength(1));

		await act(() => result.current.clearOne(items[0]));

		expect(markNotificationsRead).not.toHaveBeenCalled();
		expect(result.current.items).toHaveLength(0);
	});

	it("treats a 404 for an already-read row as cleared", async () => {
		items = [cloudRow({ status: "unread" })];
		markNotificationsRead.mockRejectedValue(new CloudCpError("The notification was not found.", { status: 404 }));
		const { result } = renderCloudNotifications();
		await waitFor(() => expect(result.current.items).toHaveLength(1));

		await act(() => result.current.clearOne(items[0]));

		expect(markNotificationsRead).toHaveBeenCalledWith("org-1", ["cntf_1"]);
		expect(result.current.items).toHaveLength(0);
	});

		it("puts the row back when marking it read fails", async () => {
			items = [cloudRow({ status: "unread" })];
			markNotificationsRead.mockRejectedValue(new CloudCpError("Service unavailable.", { status: 503 }));
			const { result } = renderCloudNotifications();
			await waitFor(() => expect(result.current.items).toHaveLength(1));

		await act(() => expect(result.current.clearOne(items[0])).rejects.toThrow("Service unavailable."));

			expect(result.current.items).toHaveLength(1);
		});

		it("puts all rows back when marking all read fails", async () => {
			items = [cloudRow({ status: "unread" })];
			markNotificationsRead.mockRejectedValue(new CloudCpError("Service unavailable.", { status: 503 }));
			const { result } = renderCloudNotifications();
			await waitFor(() => expect(result.current.items).toHaveLength(1));

			await act(() => expect(result.current.clearAll()).rejects.toThrow("Service unavailable."));

			expect(markNotificationsRead).toHaveBeenCalledWith("org-1");
			expect(result.current.items).toHaveLength(1);
			expect(window.localStorage.getItem("ao.cloudNotifications.cleared:https://cloud.test:org-1:user-1")).toBeNull();
		});

		it("scopes cleared rows to the signed-in cloud user", async () => {
			const first = renderCloudNotifications("user-1");
		await waitFor(() => expect(first.result.current.items).toHaveLength(1));
		await act(() => first.result.current.clearAll());
		expect(first.result.current.items).toHaveLength(0);
		first.unmount();

		const second = renderCloudNotifications("user-2");
			await waitFor(() => expect(second.result.current.items).toHaveLength(1));
		});

		it("does not show another user's cached rows when accounts share an org", async () => {
			const firstRow = cloudRow({ id: "cntf_private_a", title: "Private for A" });
			const secondRow = cloudRow({ id: "cntf_private_b", title: "Private for B" });
			let finishSecondFetch: () => void = () => undefined;
			const secondFetchPending = new Promise<void>((resolve) => { finishSecondFetch = resolve; });
			listNotifications
				.mockResolvedValueOnce({ items: [firstRow], unreadCount: 0, page: { hasMore: false }, latestSequence: 0 })
				.mockImplementationOnce(async () => {
					await secondFetchPending;
					return { items: [secondRow], unreadCount: 0, page: { hasMore: false }, latestSequence: 0 };
				});
			const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			const first = renderCloudNotifications("user-1", queryClient);
			await waitFor(() => expect(first.result.current.items).toEqual([firstRow]));
			first.unmount();

			const second = renderCloudNotifications("user-2", queryClient);
			expect(second.result.current.items).toEqual([]);
			expect(second.result.current.data).toBeUndefined();
			await act(async () => { finishSecondFetch(); });
			await waitFor(() => expect(second.result.current.items).toEqual([secondRow]));
		});

	it("keeps a re-raised row visible after it is read again", async () => {
		const { result } = renderCloudNotifications();
		await waitFor(() => expect(result.current.items).toHaveLength(1));
		await act(() => result.current.clearAll());
		expect(result.current.items).toHaveLength(0);

		// Re-raised in place: back to unread with a newer updatedAt.
		items = [cloudRow({ status: "unread", updatedAt: "2026-07-21T12:00:00Z" })];
		await act(() => result.current.refetch());
		await waitFor(() => expect(result.current.items).toHaveLength(1));

		// Opening the panel marks it read, which must not hide it again.
		items = [cloudRow({ status: "read", updatedAt: "2026-07-21T12:05:00Z" })];
		await act(() => result.current.refetch());
		await waitFor(() => expect(result.current.items[0]?.status).toBe("read"));
		expect(result.current.items).toHaveLength(1);
	});
});

it("reconnects the notification stream after it closes and resumes after the last event", async () => {
	const listNotifications = vi.fn(async () => ({ items: [], unreadCount: 0, page: { hasMore: false }, latestSequence: 0 }));
	cloudCpMock.mockReturnValue({ client: { listNotifications }, ready: true, baseUrl: "https://cloud.test", userId: "user-1" });
	subscribeNotificationsMock.mockReset().mockImplementation(async (options?: { onEvent: (event: { sequence: number }) => void }) => {
		if (subscribeNotificationsMock.mock.calls.length === 1) options?.onEvent({ sequence: 42 });
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
	const hook = renderHook(() => useCloudNotifications("all"), { wrapper });
	await waitFor(() => expect(subscribeNotificationsMock).toHaveBeenCalledTimes(2), { timeout: 2500 });
	expect(subscribeNotificationsMock.mock.calls[1]?.[0]).toMatchObject({ after: 42 });
	hook.unmount();
});
