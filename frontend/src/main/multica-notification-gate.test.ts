// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MulticaNotificationGate, parseMulticaNotificationPayload, type MulticaNotificationPayload } from "./multica-notification-gate";

const validPayload: MulticaNotificationPayload = {
	slug: "my-project",
	itemId: "item-123",
	issueKey: "ABC-123",
	title: "Build failed",
	body: "The latest build failed.",
};

describe("parseMulticaNotificationPayload", () => {
	it("returns a complete valid payload unchanged", () => {
		expect(parseMulticaNotificationPayload(validPayload)).toEqual(validPayload);
	});

	it("accepts an empty slug and body", () => {
		expect(parseMulticaNotificationPayload({ ...validPayload, slug: "", body: "" })).toEqual({ ...validPayload, slug: "", body: "" });
	});

	it.each(["itemId", "issueKey", "title"] as const)("rejects a blank %s", (field) => {
		expect(parseMulticaNotificationPayload({ ...validPayload, [field]: " \t\n " })).toBeNull();
	});

	it.each([
		["slug", 256],
		["itemId", 256],
		["issueKey", 256],
		["title", 512],
		["body", 2_000],
	] as const)("accepts %s at its length limit", (field, length) => {
		expect(parseMulticaNotificationPayload({ ...validPayload, [field]: "x".repeat(length) })).not.toBeNull();
	});

	it.each([
		["slug", 256],
		["itemId", 256],
		["issueKey", 256],
		["title", 512],
		["body", 2_000],
	] as const)("rejects %s one character over its length limit", (field, length) => {
		expect(parseMulticaNotificationPayload({ ...validPayload, [field]: "x".repeat(length + 1) })).toBeNull();
	});

	it.each([null, 0, 42, "payload", ""])("rejects %s", (value) => {
		expect(parseMulticaNotificationPayload(value)).toBeNull();
	});

	it("rejects an object with a non-string field", () => {
		expect(parseMulticaNotificationPayload({ ...validPayload, body: 42 })).toBeNull();
	});

	it("drops extra keys", () => {
		expect(parseMulticaNotificationPayload({ ...validPayload, extra: "ignored" })).toEqual(validPayload);
	});
});

describe("MulticaNotificationGate", () => {
	it("shows the first event and drops the repeat", () => {
		const gate = new MulticaNotificationGate();

		expect(gate.shouldShow("item-1", false)).toBe(true);
		expect(gate.shouldShow("item-1", false)).toBe(false);
	});

	it("remembers an item suppressed while the user is looking", () => {
		const gate = new MulticaNotificationGate();

		expect(gate.shouldShow("item-1", true)).toBe(false);
		expect(gate.shouldShow("item-1", false)).toBe(false);
	});

	it("treats a whitespace-padded repeat as a duplicate", () => {
		const gate = new MulticaNotificationGate();

		expect(gate.shouldShow("item-1", false)).toBe(true);
		expect(gate.shouldShow("  item-1 \t", false)).toBe(false);
	});

	it("evicts the oldest item when the cap is exceeded", () => {
		const gate = new MulticaNotificationGate(2);

		expect(gate.shouldShow("item-1", false)).toBe(true);
		expect(gate.shouldShow("item-2", false)).toBe(true);
		expect(gate.shouldShow("item-3", false)).toBe(true);
		expect(gate.shouldShow("item-1", false)).toBe(true);
	});

	it("never shows a blank id", () => {
		const gate = new MulticaNotificationGate();

		expect(gate.shouldShow(" \t ", false)).toBe(false);
	});
});
