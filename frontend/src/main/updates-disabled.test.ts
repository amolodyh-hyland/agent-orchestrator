import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UPDATES_DISABLED_MARKER, isUpdatesDisabledBuild } from "./updates-disabled";

describe("isUpdatesDisabledBuild", () => {
	it("returns true when the marker exists in Resources", () => {
		const resourcesPath = path.join(path.sep, "AO", "Resources");
		const markerPath = path.join(resourcesPath, UPDATES_DISABLED_MARKER);
		const exists = vi.fn((file: string) => file === markerPath);

		expect(isUpdatesDisabledBuild(resourcesPath, exists)).toBe(true);
		expect(exists).toHaveBeenCalledWith(markerPath);
	});

	it("returns false when the marker is missing", () => {
		const resourcesPath = path.join(path.sep, "AO", "Resources");
		const exists = vi.fn(() => false);

		expect(isUpdatesDisabledBuild(resourcesPath, exists)).toBe(false);
		expect(exists).toHaveBeenCalledWith(path.join(resourcesPath, UPDATES_DISABLED_MARKER));
	});

	it("returns false when Resources is unset or empty", () => {
		const exists = vi.fn(() => true);

		expect(isUpdatesDisabledBuild(undefined, exists)).toBe(false);
		expect(isUpdatesDisabledBuild("", exists)).toBe(false);
		expect(exists).not.toHaveBeenCalled();
	});
});
