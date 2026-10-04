// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMulticaAuthSession } from "./multica-auth-session";

describe("Multica auth session", () => {
	it("starts with nothing reported and no active session", () => {
		const session = createMulticaAuthSession();

		expect(session.hasActiveSession()).toBe(false);
		expect(session.generation()).toBe(0);
	});

	it("does not invalidate the first user report or a repeat", () => {
		const session = createMulticaAuthSession();

		expect(session.report("u1")).toBe(false);
		expect(session.hasActiveSession()).toBe(true);
		expect(session.report("u1")).toBe(false);
		expect(session.generation()).toBe(0);
	});

	it("trims user ids before comparing accounts", () => {
		const session = createMulticaAuthSession();
		session.report("u1");

		expect(session.report("  u1 ")).toBe(false);
		expect(session.hasActiveSession()).toBe(true);
		expect(session.generation()).toBe(0);
	});

	it("invalidates when the reported account changes", () => {
		const session = createMulticaAuthSession();
		session.report("u1");

		expect(session.report("u2")).toBe(true);
		expect(session.generation()).toBe(1);
		expect(session.report("u2")).toBe(false);
		expect(session.generation()).toBe(1);
	});

	it("invalidates once when a user signs out", () => {
		const session = createMulticaAuthSession();
		session.report("u1");

		expect(session.report(null)).toBe(true);
		expect(session.hasActiveSession()).toBe(false);
		expect(session.generation()).toBe(1);
		expect(session.report(null)).toBe(false);
		expect(session.generation()).toBe(1);
	});

	it("invalidates when a user signs in after a signed-out report", () => {
		const session = createMulticaAuthSession();
		session.report(null);

		expect(session.report("u1")).toBe(true);
		expect(session.hasActiveSession()).toBe(true);
		expect(session.generation()).toBe(2);
	});

	it("invalidates when the first report is signed out", () => {
		const session = createMulticaAuthSession();

		expect(session.report(null)).toBe(true);
		expect(session.hasActiveSession()).toBe(false);
		expect(session.generation()).toBe(1);
	});

	it.each([
		["an empty string", ""],
		["a whitespace-only string", "   "],
		["a 257-character string", "u".repeat(257)],
		["a number", 7],
		["undefined", undefined],
		["an object", {}],
	])("ignores %s without changing the session or generation", (_label, value) => {
		const session = createMulticaAuthSession();
		session.report("u1");

		expect(session.report(value)).toBe(false);
		expect(session.hasActiveSession()).toBe(true);
		expect(session.generation()).toBe(0);
	});

	it("clears the session and increments generation when reset", () => {
		const session = createMulticaAuthSession();
		session.report("u1");

		session.reset();

		expect(session.hasActiveSession()).toBe(false);
		expect(session.generation()).toBe(1);
		expect(session.report("u2")).toBe(false);
		expect(session.generation()).toBe(1);
	});
});
