// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCombinedBadge } from "./combined-badge";

describe("combined badge", () => {
	it("starts with both counts at zero", () => {
		const badge = createCombinedBadge();

		expect(badge.setAo(0)).toBe(0);
		expect(badge.setMultica(0)).toBe(0);
	});

	it("returns the sum of both counts after either source updates", () => {
		const badge = createCombinedBadge();

		expect(badge.setAo(3)).toBe(3);
		expect(badge.setMultica(4)).toBe(7);
		expect(badge.setAo(2)).toBe(6);
	});

	it("keeps Multica's count when AO updates", () => {
		const badge = createCombinedBadge();

		badge.setMultica(5);

		expect(badge.setAo(2)).toBe(7);
	});

	it("keeps AO's count when Multica updates", () => {
		const badge = createCombinedBadge();

		badge.setAo(5);

		expect(badge.setMultica(2)).toBe(7);
	});

	it("replaces the previous value from the same source", () => {
		const badge = createCombinedBadge();

		badge.setAo(3);
		expect(badge.setAo(2)).toBe(2);
		badge.setMultica(4);
		expect(badge.setMultica(1)).toBe(3);
	});

	it("clears a source when its count is zero or invalid", () => {
		const badge = createCombinedBadge();

		badge.setAo(3);
		badge.setMultica(4);
		expect(badge.setAo(0)).toBe(4);
		expect(badge.setMultica("invalid")).toBe(0);
	});

	it("floors positive fractions", () => {
		const badge = createCombinedBadge();

		expect(badge.setAo(2.9)).toBe(2);
		expect(badge.setMultica(0.9)).toBe(2);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined])(
		"treats %s as zero",
		(count) => {
			const badge = createCombinedBadge();

			badge.setAo(3);
			expect(badge.setMultica(count)).toBe(3);
			expect(badge.setAo(count)).toBe(0);
		},
	);

	it("returns the updated totals from each setter", () => {
		const badge = createCombinedBadge();
		const setAo = vi.fn(badge.setAo);
		const setMultica = vi.fn(badge.setMultica);

		expect(setAo(2)).toBe(2);
		expect(setMultica(3)).toBe(5);
		expect(setAo).toHaveBeenCalledOnce();
		expect(setMultica).toHaveBeenCalledOnce();
	});
});
