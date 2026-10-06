// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MULTICA_DESKTOP_STAGE_DIR, stageMulticaDesktop } from "./stage-multica-desktop.mjs";

let tempDir;
let outDir;
let destDir;

function writeOutput(relativePath, contents = relativePath) {
	const file = path.join(outDir, relativePath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "stage-multica-desktop-"));
	outDir = path.join(tempDir, "out");
	destDir = path.join(tempDir, MULTICA_DESKTOP_STAGE_DIR);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("stageMulticaDesktop", () => {
	it("copies renderer and preload, skips maps and main, and replaces stale output", () => {
		writeOutput("renderer/index.html", "renderer html");
		writeOutput("renderer/assets/app.js", "renderer js");
		writeOutput("renderer/assets/app.js.map", "renderer map");
		writeOutput("preload/index.js", "preload js");
		writeOutput("preload/index.js.map", "preload map");
		writeOutput("main/index.js", "main js");
		mkdirSync(destDir, { recursive: true });
		writeFileSync(path.join(destDir, "stale.txt"), "stale");

		expect(stageMulticaDesktop(outDir, destDir)).toBe(destDir);
		expect(readFileSync(path.join(destDir, "renderer", "index.html"), "utf8")).toBe("renderer html");
		expect(readFileSync(path.join(destDir, "renderer", "assets", "app.js"), "utf8")).toBe("renderer js");
		expect(readFileSync(path.join(destDir, "preload", "index.js"), "utf8")).toBe("preload js");
		expect(existsSync(path.join(destDir, "renderer", "assets", "app.js.map"))).toBe(false);
		expect(existsSync(path.join(destDir, "preload", "index.js.map"))).toBe(false);
		expect(existsSync(path.join(destDir, "main"))).toBe(false);
		expect(existsSync(path.join(destDir, "stale.txt"))).toBe(false);
	});

	it("throws a build hint when renderer/index.html is missing", () => {
		writeOutput("preload/index.js");

		expect(() => stageMulticaDesktop(outDir, destDir)).toThrow(
			"renderer/index.html; run electron-vite build in apps/desktop first",
		);
	});

	it("dereferences renderer symlinks into regular staged files", () => {
		writeOutput("renderer/index.html");
		writeOutput("preload/index.js");
		writeOutput("shared.js", "symlink target");
		mkdirSync(path.join(outDir, "renderer", "assets"), { recursive: true });
		symlinkSync("../../shared.js", path.join(outDir, "renderer", "assets", "linked.js"));

		stageMulticaDesktop(outDir, destDir);

		const stagedLink = path.join(destDir, "renderer", "assets", "linked.js");
		expect(lstatSync(stagedLink).isSymbolicLink()).toBe(false);
		expect(readFileSync(stagedLink, "utf8")).toBe("symlink target");
	});

	it("throws a build hint when both preload entry points are missing", () => {
		writeOutput("renderer/index.html");

		expect(() => stageMulticaDesktop(outDir, destDir)).toThrow(
			"preload/index.js or preload/index.cjs; run electron-vite build in apps/desktop first",
		);
	});

	it("accepts preload/index.cjs", () => {
		writeOutput("renderer/index.html");
		writeOutput("preload/index.cjs", "preload commonjs");

		stageMulticaDesktop(outDir, destDir);

		expect(readFileSync(path.join(destDir, "preload", "index.cjs"), "utf8")).toBe("preload commonjs");
	});
});
