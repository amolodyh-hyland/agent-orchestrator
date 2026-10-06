import { describe, expect, it } from "vitest";
import { clampStatusText, MULTICA_STATUS_TONES, MULTICA_STATUS_TONE_ORDER } from "./multica-session-status";

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
