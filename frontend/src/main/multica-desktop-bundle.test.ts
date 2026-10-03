import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMulticaDesktopBundle } from "./multica-desktop-bundle";

const OUT = path.join(path.sep, "multica", "apps", "desktop", "out");
const has = (...files: string[]) => (file: string) => files.includes(file);

describe("resolveMulticaDesktopBundle", () => {
	it("finds the built renderer and preload", () => {
		const renderer = path.join(OUT, "renderer", "index.html");
		const preload = path.join(OUT, "preload", "index.js");

		const bundle = resolveMulticaDesktopBundle(OUT, has(renderer, preload));

		expect(bundle?.preloadPath).toBe(preload);
		expect(bundle?.rendererUrl).toBe(`file://${renderer}`);
	});

	it("reports nothing when the directory is unset or either half is missing", () => {
		const renderer = path.join(OUT, "renderer", "index.html");
		const preload = path.join(OUT, "preload", "index.js");

		expect(resolveMulticaDesktopBundle(undefined, has(renderer, preload))).toBeNull();
		expect(resolveMulticaDesktopBundle(OUT, has(preload))).toBeNull();
		expect(resolveMulticaDesktopBundle(OUT, has(renderer))).toBeNull();
	});

	it("never accepts an ES-module preload, which a sandboxed view cannot load", () => {
		const renderer = path.join(OUT, "renderer", "index.html");

		expect(resolveMulticaDesktopBundle(OUT, has(renderer, path.join(OUT, "preload", "index.mjs")))).toBeNull();
	});
});
