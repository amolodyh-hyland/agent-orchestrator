import { describe, expect, it } from "vitest";
import {
	clampStatusText,
	isMulticaStatusSnapshot,
	MAX_STATUS_DETAIL,
	MAX_STATUS_ENTRIES,
	MAX_STATUS_LABEL,
	MAX_STATUS_SESSION_ID,
	MULTICA_STATUS_TONES,
	MULTICA_STATUS_TONE_ORDER,
	type MulticaLinkStatusEntry,
	type MulticaStatusSnapshot,
} from "./multica-session-status";

const entry = (overrides: Partial<MulticaLinkStatusEntry> = {}): MulticaLinkStatusEntry => ({
	sessionId: "session-1",
	tone: "ready",
	label: "Ready",
	detail: "Pull request checks passed",
	...overrides,
});

const snapshot = (entries: MulticaLinkStatusEntry[] = [], stale = false): MulticaStatusSnapshot => ({ stale, entries });

describe("isMulticaStatusSnapshot", () => {
	it("accepts empty, single-entry, and multi-entry snapshots", () => {
		expect(isMulticaStatusSnapshot(snapshot())).toBe(true);
		expect(isMulticaStatusSnapshot(snapshot([entry()]))).toBe(true);
		expect(
			isMulticaStatusSnapshot(
				snapshot([
					entry(),
					entry({ sessionId: "session-2", tone: "working", label: "Working", detail: "Agent is running" }),
				]),
			),
		).toBe(true);
	});

	it.each([
		["null", null],
		["array", []],
		["string", "snapshot"],
		["number", 1],
		["missing stale", { entries: [] }],
		["wrong stale type", { stale: "false", entries: [] }],
		["missing entries", { stale: false }],
		["wrong entries type", { stale: false, entries: {} }],
		["extra snapshot key", { stale: false, entries: [], extra: true }],
		["entry array", { stale: false, entries: [[]] }],
		["entry with non-plain prototype", { stale: false, entries: [Object.assign(Object.create({ inherited: true }), entry())] }],
		["missing session id", { stale: false, entries: [{ tone: "ready", label: "Ready", detail: "" }] }],
		["wrong session id type", { stale: false, entries: [entry({ sessionId: 1 } as never)] }],
		["empty session id", { stale: false, entries: [entry({ sessionId: "" })] }],
		["overlong session id", { stale: false, entries: [entry({ sessionId: "s".repeat(MAX_STATUS_SESSION_ID + 1) })] }],
		["missing tone", { stale: false, entries: [{ sessionId: "session-1", label: "Ready", detail: "" }] }],
		["wrong tone type", { stale: false, entries: [entry({ tone: 1 } as never)] }],
		["unknown tone", { stale: false, entries: [entry({ tone: "blocked" as MulticaLinkStatusEntry["tone"] })] }],
		["missing label", { stale: false, entries: [{ sessionId: "session-1", tone: "ready", detail: "" }] }],
		["wrong label type", { stale: false, entries: [entry({ label: null } as never)] }],
		["empty label", { stale: false, entries: [entry({ label: "" })] }],
		["overlong label", { stale: false, entries: [entry({ label: "l".repeat(MAX_STATUS_LABEL + 1) })] }],
		["missing detail", { stale: false, entries: [{ sessionId: "session-1", tone: "ready", label: "Ready" }] }],
		["wrong detail type", { stale: false, entries: [entry({ detail: false } as never)] }],
		["overlong detail", { stale: false, entries: [entry({ detail: "d".repeat(MAX_STATUS_DETAIL + 1) })] }],
		["duplicate session id", { stale: false, entries: [entry(), entry({ tone: "done" })] }],
		["extra entry key", { stale: false, entries: [{ ...entry(), extra: true }] }],
		["symbol entry key", { stale: false, entries: [Object.assign(entry(), { [Symbol("extra")]: true })] }],
	])("rejects %s", (_name, value) => {
		expect(isMulticaStatusSnapshot(value)).toBe(false);
	});

	it("accepts exactly the maximum number of entries and rejects one more", () => {
		const entries = Array.from({ length: MAX_STATUS_ENTRIES + 1 }, (_, index) => entry({ sessionId: `session-${index}` }));
		expect(isMulticaStatusSnapshot(snapshot(entries.slice(0, MAX_STATUS_ENTRIES)))).toBe(true);
		expect(isMulticaStatusSnapshot(snapshot(entries))).toBe(false);
	});

	it("measures session id, label, and detail limits in code points", () => {
		expect(isMulticaStatusSnapshot(snapshot([entry({ sessionId: "😀".repeat(MAX_STATUS_SESSION_ID) })]))).toBe(true);
		expect(isMulticaStatusSnapshot(snapshot([entry({ sessionId: "😀".repeat(MAX_STATUS_SESSION_ID + 1) })]))).toBe(false);
		expect(isMulticaStatusSnapshot(snapshot([entry({ label: "😀".repeat(MAX_STATUS_LABEL) })]))).toBe(true);
		expect(isMulticaStatusSnapshot(snapshot([entry({ label: "😀".repeat(MAX_STATUS_LABEL + 1) })]))).toBe(false);
		expect(isMulticaStatusSnapshot(snapshot([entry({ detail: "😀".repeat(MAX_STATUS_DETAIL) })]))).toBe(true);
		expect(isMulticaStatusSnapshot(snapshot([entry({ detail: "😀".repeat(MAX_STATUS_DETAIL + 1) })]))).toBe(false);
	});

	it("accepts clamped emoji text as a label", () => {
		const label = clampStatusText("😀".repeat(100), MAX_STATUS_LABEL);
		expect(isMulticaStatusSnapshot(snapshot([entry({ label })]))).toBe(true);
	});
});

describe("status tones", () => {
	it("uses the expected order and keeps the tone list sorted by that order", () => {
		expect(MULTICA_STATUS_TONE_ORDER).toEqual({ ready: 0, attention: 1, pending: 2, working: 3, done: 4, unknown: 5 });
		expect([...MULTICA_STATUS_TONES].sort((left, right) => MULTICA_STATUS_TONE_ORDER[left] - MULTICA_STATUS_TONE_ORDER[right])).toEqual(
			MULTICA_STATUS_TONES,
		);
	});
});

describe("clampStatusText", () => {
	it("leaves short text unchanged", () => {
		expect(clampStatusText("Ready", 5)).toBe("Ready");
	});

	it("cuts long text and appends an ellipsis", () => {
		expect(clampStatusText("Ready to merge", 8)).toBe("Ready t…");
	});

	it("does not split a surrogate pair at the cut boundary", () => {
		expect(clampStatusText("ab😀cd", 4)).toBe("ab😀…");
	});

	it("returns an empty string when max is below one", () => {
		expect(clampStatusText("Ready", 0)).toBe("");
	});
});
