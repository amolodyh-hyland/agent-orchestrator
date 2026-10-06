import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type MulticaDesktopBundle = {
	/** file:// URL of Multica's built renderer entry. */
	rendererUrl: string;
	/** Multica's built preload. Sandboxed preloads must be CommonJS. */
	preloadPath: string;
};

const PRELOAD_NAMES = ["index.js", "index.cjs"];

/**
 * Locates Multica's electron-vite output (`apps/desktop/out`): the renderer at
 * `renderer/index.html` and the preload at `preload/index.js`. Returns null
 * when either is missing so the host can show a clear error instead of a blank
 * view.
 */
export function resolveMulticaDesktopBundle(
	outDir: string | undefined,
	exists: (file: string) => boolean = existsSync,
): MulticaDesktopBundle | null {
	if (!outDir) return null;
	const renderer = path.join(outDir, "renderer", "index.html");
	if (!exists(renderer)) return null;
	const preload = PRELOAD_NAMES.map((name) => path.join(outDir, "preload", name)).find((file) => exists(file));
	if (!preload) return null;
	return { rendererUrl: pathToFileURL(renderer).href, preloadPath: preload };
}
