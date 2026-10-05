import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export const MULTICA_DESKTOP_STAGE_DIR = "multica-desktop";

export function stageMulticaDesktop(outDir, destDir) {
	const rendererIndex = path.join(outDir, "renderer", "index.html");
	if (!existsSync(rendererIndex)) {
		throw new Error(
			`Missing Multica desktop output file ${path.join("renderer", "index.html")}; run electron-vite build in apps/desktop first.`,
		);
	}
	const preloadIndex = path.join(outDir, "preload", "index.js");
	const preloadCommonJS = path.join(outDir, "preload", "index.cjs");
	if (!existsSync(preloadIndex) && !existsSync(preloadCommonJS)) {
		throw new Error(
			`Missing Multica desktop output file ${path.join("preload", "index.js")} or ${path.join("preload", "index.cjs")}; run electron-vite build in apps/desktop first.`,
		);
	}

	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	const skipMaps = (source) => !source.endsWith(".map");
	cpSync(path.join(outDir, "renderer"), path.join(destDir, "renderer"), {
		recursive: true,
		dereference: true,
		filter: skipMaps,
	});
	cpSync(path.join(outDir, "preload"), path.join(destDir, "preload"), {
		recursive: true,
		dereference: true,
		filter: skipMaps,
	});
	return destDir;
}
