import { describe, expect, it } from "vitest";
import {
	assignProjectColorSlot,
	fnv1a32,
	preferredProjectColorSlot,
	PROJECT_COLOR_HUES,
	PROJECT_COLOR_SLOTS,
	projectColorCss,
} from "./project-colors";

function oklchToSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
	const radians = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(radians);
	const b = chroma * Math.sin(radians);
	const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
	const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
	const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
	const l = lRoot ** 3;
	const m = mRoot ** 3;
	const s = sRoot ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	return linear.map((channel) => {
		const clipped = Math.max(0, Math.min(1, channel));
		return (clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055) * 255;
	}) as [number, number, number];
}

function surfaceLuminance(hex: string): number {
	const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function colorLuminance(rgb: [number, number, number]): number {
	const linear = rgb.map((channel) => channel / 255).map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

describe("project colors", () => {
	it("hashes UTF-8 bytes with 32-bit FNV-1a", () => {
		expect(fnv1a32("")).toBe(2166136261);
		expect(fnv1a32("a")).toBe(3826002220);
		expect(fnv1a32("project-1")).toBe(fnv1a32("project-1"));
		expect(fnv1a32("project-1")).not.toBe(fnv1a32("project-2"));
	});

	it("prefers the hash slot and probes forward with wrap-around", () => {
		const projectId = "my-project";
		const preferred = preferredProjectColorSlot(projectId);
		expect(assignProjectColorSlot(projectId, new Set())).toBe(preferred);
		expect(assignProjectColorSlot(projectId, new Set([preferred]))).toBe((preferred + 1) % PROJECT_COLOR_SLOTS);
		expect(
			assignProjectColorSlot(
				projectId,
				new Set(Array.from({ length: PROJECT_COLOR_SLOTS - 1 }, (_, offset) => (preferred + offset) % PROJECT_COLOR_SLOTS)),
			),
		).toBe((preferred + PROJECT_COLOR_SLOTS - 1) % PROJECT_COLOR_SLOTS);
		expect(assignProjectColorSlot(projectId, new Set(Array.from({ length: PROJECT_COLOR_SLOTS }, (_, slot) => slot)))).toBe(preferred);
	});

	it("returns the palette CSS values", () => {
		expect(PROJECT_COLOR_HUES).toEqual([20, 56, 92, 128, 164, 200, 236, 272, 308, 344]);
		expect(projectColorCss(0, "light")).toBe("oklch(0.56 0.15 20)");
		expect(projectColorCss(9, "dark")).toBe("oklch(0.74 0.14 344)");
		expect(projectColorCss(10, "light")).toBe(projectColorCss(0, "light"));
	});

	it("keeps palette colours accessible and distinct in both themes", () => {
		const surfaces = {
			light: ["#ffffff", "#ffffff", "#fafafa"],
			dark: ["#0c0c0e", "#121215", "#28282d"],
		} as const;
		for (const theme of ["light", "dark"] as const) {
			const colours = PROJECT_COLOR_HUES.map((hue) =>
				oklchToSrgb(theme === "light" ? 0.56 : 0.74, theme === "light" ? 0.15 : 0.14, hue),
			);
			for (const colour of colours) {
				for (const surface of surfaces[theme]) {
					const colourLum = colorLuminance(colour);
					const surfaceLum = surfaceLuminance(surface);
					const contrast = (Math.max(colourLum, surfaceLum) + 0.05) / (Math.min(colourLum, surfaceLum) + 0.05);
					expect(contrast).toBeGreaterThanOrEqual(3);
				}
			}
			let minDistance = Number.POSITIVE_INFINITY;
			for (let first = 0; first < colours.length; first += 1) {
				for (let second = first + 1; second < colours.length; second += 1) {
					const distance = Math.hypot(
						colours[first][0] - colours[second][0],
						colours[first][1] - colours[second][1],
						colours[first][2] - colours[second][2],
					);
					minDistance = Math.min(minDistance, distance);
				}
			}
			expect(minDistance).toBeGreaterThanOrEqual(35);
		}
	});
});
