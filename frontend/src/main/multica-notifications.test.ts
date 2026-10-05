// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMulticaNotifications, type MulticaNotificationsOptions, type NativeNotificationLike } from "./multica-notifications";

type NotificationEvent = "click" | "failed";

class FakeNotification implements NativeNotificationLike {
	readonly handlers = new Map<NotificationEvent, Array<() => void>>();
	readonly close = vi.fn();
	showCalls = 0;
	throwOnShow = false;

	constructor(readonly options: { title: string; body: string }) {}

	on(event: NotificationEvent, listener: () => void): unknown {
		const listeners = this.handlers.get(event) ?? [];
		listeners.push(listener);
		this.handlers.set(event, listeners);
		return this;
	}

	show(): void {
		this.showCalls += 1;
		if (this.throwOnShow) throw new Error("show failed");
	}

	emit(event: NotificationEvent): void {
		for (const listener of this.handlers.get(event) ?? []) listener();
	}
}

const payload = (itemId = "item-1") => ({
	slug: "project",
	itemId,
	issueKey: "PROJ-1",
	title: "New comment",
	body: "A comment was added",
});

function setup(overrides: Partial<MulticaNotificationsOptions> = {}) {
	const notifications: FakeNotification[] = [];
	const isSupported = vi.fn(() => true);
	const isWindowFocused = vi.fn(() => false);
	const isMulticaShown = vi.fn(() => false);
	const openInboxItem = vi.fn();
	const setBadge = vi.fn();
	const createNotification = vi.fn((options: { title: string; body: string }) => {
		const notification = new FakeNotification(options);
		notifications.push(notification);
		return notification;
	});
	const service = createMulticaNotifications({
		isSupported,
		createNotification,
		isWindowFocused,
		isMulticaShown,
		openInboxItem,
		setBadge,
		...overrides,
	});
	return { service, notifications, isSupported, isWindowFocused, isMulticaShown, openInboxItem, setBadge, createNotification };
}

describe("Multica notifications", () => {
	it("creates and shows a valid banner only after a user id is reported", () => {
		const { service, notifications, createNotification } = setup();

		service.showNotification(payload());
		expect(createNotification).not.toHaveBeenCalled();

		service.reportAuthSession("u1");
		service.showNotification(payload());

		expect(notifications).toHaveLength(1);
		expect(notifications[0].options).toEqual({ title: "New comment", body: "A comment was added" });
		expect(notifications[0].showCalls).toBe(1);
	});

	it("ignores invalid payloads and unsupported native notifications", () => {
		const { service, notifications, isSupported } = setup();
		service.reportAuthSession("u1");

		service.showNotification({ ...payload(), title: "" });
		service.showNotification("not an object");
		isSupported.mockReturnValue(false);
		service.showNotification(payload("unsupported"));

		expect(notifications).toHaveLength(0);
	});

	it("creates only one banner for the same item id", () => {
		const { service, notifications } = setup();
		service.reportAuthSession("u1");

		service.showNotification(payload());
		service.showNotification(payload());

		expect(notifications).toHaveLength(1);
	});

	it("suppresses banners only when AO is focused and Multica is shown, remembering suppressed items", () => {
		const isMulticaShown = vi.fn(() => true);
		const focusedAndShown = setup({ isWindowFocused: vi.fn(() => true), isMulticaShown });
		focusedAndShown.service.reportAuthSession("u1");
		focusedAndShown.service.showNotification(payload("suppressed"));
		expect(focusedAndShown.notifications).toHaveLength(0);

		isMulticaShown.mockReturnValue(false);
		focusedAndShown.service.showNotification(payload("suppressed"));
		expect(focusedAndShown.notifications).toHaveLength(0);

		const focusedAndHidden = setup({ isWindowFocused: () => true, isMulticaShown: () => false });
		focusedAndHidden.service.reportAuthSession("u1");
		focusedAndHidden.service.showNotification(payload("focused-hidden"));
		expect(focusedAndHidden.notifications).toHaveLength(1);

		const unfocusedAndShown = setup({ isWindowFocused: () => false, isMulticaShown: () => true });
		unfocusedAndShown.service.reportAuthSession("u1");
		unfocusedAndShown.service.showNotification(payload("unfocused-shown"));
		expect(unfocusedAndShown.notifications).toHaveLength(1);
	});

	it("registers only click and failed listeners", () => {
		const { service, notifications } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());

		expect([...notifications[0].handlers.keys()]).toEqual(["click", "failed"]);
	});

	it("opens only the inbox target on a banner click and ignores repeated clicks", () => {
		const { service, notifications, openInboxItem } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());

		notifications[0].emit("click");
		notifications[0].emit("click");

		expect(openInboxItem).toHaveBeenCalledExactlyOnceWith({ slug: "project", itemId: "item-1", issueKey: "PROJ-1" });
	});

	it("opens a banner that has had no events since it was shown", () => {
		const { service, notifications, openInboxItem } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());

		notifications[0].emit("click");

		expect(openInboxItem).toHaveBeenCalledExactlyOnceWith({ slug: "project", itemId: "item-1", issueKey: "PROJ-1" });
	});

	it.each([
		["sign out", (service: ReturnType<typeof setup>["service"]) => service.reportAuthSession(null)],
		["account switch", (service: ReturnType<typeof setup>["service"]) => service.reportAuthSession("u2")],
		["reset", (service: ReturnType<typeof setup>["service"]) => service.reset()],
	])("ignores a banner click after %s", (_name, invalidate) => {
		const { service, notifications, openInboxItem } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());

		invalidate(service);
		notifications[0].emit("click");

		expect(openInboxItem).not.toHaveBeenCalled();
	});

	it("keeps a banner valid after the same user id is reported again", () => {
		const { service, notifications, openInboxItem } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());
		service.reportAuthSession("u1");

		notifications[0].emit("click");

		expect(openInboxItem).toHaveBeenCalledExactlyOnceWith({ slug: "project", itemId: "item-1", issueKey: "PROJ-1" });
		expect(notifications[0].close).not.toHaveBeenCalled();
	});

	it.each([
		["account switch", "u2"],
		["sign out", null],
	])("closes live banners on %s", (_name, nextUser) => {
		const { service, notifications, setBadge } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload("item-1"));
		service.showNotification(payload("item-2"));

		service.reportAuthSession(nextUser);

		expect(notifications.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
		expect(setBadge).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("returns whether an auth report invalidated the session", () => {
		const { service } = setup();

		expect(service.reportAuthSession("u1")).toBe(false);
		expect(service.reportAuthSession("u1")).toBe(false);
		expect(service.reportAuthSession("u2")).toBe(true);
		expect(service.reportAuthSession(null)).toBe(true);
		expect(service.reportAuthSession(5)).toBe(false);

		const freshService = setup().service;
		expect(freshService.reportAuthSession(null)).toBe(true);
	});

	it("clears the badge only when a reported session is invalidated", () => {
		const { service, setBadge } = setup();
		service.reportAuthSession("u1");
		expect(setBadge).not.toHaveBeenCalled();

		service.reportAuthSession("u1");
		expect(setBadge).not.toHaveBeenCalled();

		service.reportAuthSession(null);
		expect(setBadge).toHaveBeenCalledExactlyOnceWith(0);

		service.reportAuthSession("u1");
		service.reportAuthSession("u2");
		expect(setBadge).toHaveBeenCalledTimes(3);
		expect(setBadge).toHaveBeenNthCalledWith(2, 0);
		expect(setBadge).toHaveBeenNthCalledWith(3, 0);
	});

	it("sanitizes unread badge counts", () => {
		const { service, setBadge } = setup();

		for (const value of [7, 2.9, -3, Number.NaN, "5", undefined]) service.setBadge(value);

		expect(setBadge.mock.calls.map(([count]) => count)).toEqual([7, 2, 0, 0, 0, 0]);
	});

	it("ignores positive badge counts after explicit sign out", () => {
		const { service, setBadge } = setup();
		service.reportAuthSession(null);
		setBadge.mockClear();

		service.setBadge(7);

		expect(setBadge).not.toHaveBeenCalled();
	});

	it("passes a zero badge count through after explicit sign out", () => {
		const { service, setBadge } = setup();
		service.reportAuthSession(null);
		setBadge.mockClear();

		service.setBadge(0);

		expect(setBadge).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("accepts a positive badge count before any auth report", () => {
		const { service, setBadge } = setup();

		service.setBadge(4);

		expect(setBadge).toHaveBeenCalledExactlyOnceWith(4);
	});

	it("accepts positive badge counts after signing in again", () => {
		const { service, setBadge } = setup();
		service.reportAuthSession("user-a");
		service.reportAuthSession(null);
		service.reportAuthSession("user-b");
		setBadge.mockClear();

		service.setBadge(5);

		expect(setBadge).toHaveBeenCalledExactlyOnceWith(5);
	});

	it("resets the session, closes live banners, and clears the badge contribution", () => {
		const { service, notifications, setBadge } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload("before-reset-1"));
		service.showNotification(payload("before-reset-2"));
		service.reset();

		expect(notifications.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
		expect(setBadge).toHaveBeenCalledExactlyOnceWith(0);
		service.showNotification(payload("after-reset"));
		expect(notifications).toHaveLength(2);

		service.reportAuthSession("u2");
		service.showNotification(payload("after-report"));
		expect(notifications).toHaveLength(3);
	});

	it("swallows notification creation and show failures", () => {
		const createFailure = setup({ createNotification: vi.fn(() => { throw new Error("create failed"); }) });
		createFailure.service.reportAuthSession("u1");
		expect(() => createFailure.service.showNotification(payload())).not.toThrow();

		let failingBanner: FakeNotification | undefined;
		const showFailure = setup({
			createNotification: vi.fn((options) => {
				failingBanner = new FakeNotification(options);
				failingBanner.throwOnShow = true;
				return failingBanner;
			}),
		});
		showFailure.service.reportAuthSession("u1");
		expect(() => showFailure.service.showNotification(payload())).not.toThrow();
		expect(failingBanner?.showCalls).toBe(1);
	});

	it("evicts the oldest banners after reaching the retention bound", () => {
		const { service, notifications, openInboxItem } = setup();
		service.reportAuthSession("u1");

		for (let index = 1; index <= 51; index += 1) service.showNotification(payload(`item-${index}`));

		expect(notifications).toHaveLength(51);
		expect(notifications[0].close).toHaveBeenCalledTimes(1);
		expect(notifications.slice(1).every(({ close }) => close.mock.calls.length === 0)).toBe(true);

		service.showNotification(payload("item-52"));
		expect(notifications[1].close).toHaveBeenCalledTimes(1);
		expect(notifications[2].close).not.toHaveBeenCalled();

		notifications[2].emit("click");
		expect(openInboxItem).toHaveBeenCalledExactlyOnceWith({ slug: "project", itemId: "item-3", issueKey: "PROJ-1" });
	});

	it("releases a failed banner before a later sign out", () => {
		const { service, notifications } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload("item-a"));
		service.showNotification(payload("item-b"));

		notifications[0].emit("failed");
		service.reportAuthSession(null);

		expect(notifications[0].close).not.toHaveBeenCalled();
		expect(notifications[1].close).toHaveBeenCalledExactlyOnceWith();
	});

	it("releases a clicked banner before a later sign out", () => {
		const { service, notifications } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload());

		notifications[0].emit("click");
		service.reportAuthSession(null);

		expect(notifications[0].close).not.toHaveBeenCalled();
	});

	it.each(["auth report", "reset"] as const)("continues releasing banners when one close throws during %s", (action) => {
		const { service, notifications } = setup();
		service.reportAuthSession("u1");
		service.showNotification(payload("item-a"));
		service.showNotification(payload("item-b"));
		notifications[0].close.mockImplementationOnce(() => { throw new Error("close failed"); });

		expect(() => {
			if (action === "auth report") service.reportAuthSession("u2");
			else service.reset();
		}).not.toThrow();
		expect(notifications[0].close).toHaveBeenCalledTimes(1);
		expect(notifications[1].close).toHaveBeenCalledExactlyOnceWith();
	});
});
