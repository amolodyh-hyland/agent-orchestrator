// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MULTICA_CLI_STAGE_DIR, stageMulticaCli } from "./stage-multica-cli.mjs";

let tempDir;
let binaryPath;
let noticeDir;
let destDir;

function writeFixture(file, contents = file) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "stage-multica-cli-"));
	binaryPath = path.join(tempDir, "build", "multica");
	noticeDir = path.join(tempDir, "notices");
	destDir = path.join(tempDir, MULTICA_CLI_STAGE_DIR);
	writeFixture(binaryPath, "fake executable");
	chmodSync(binaryPath, 0o755);
	writeFixture(path.join(noticeDir, "LICENSE"), "license text");
	writeFixture(path.join(noticeDir, "NOTICE"), "notice text");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("stageMulticaCli", () => {
	it("stages a dereferenced executable and both attribution files", () => {
		const linkedBinary = path.join(tempDir, "linked-multica");
		symlinkSync(binaryPath, linkedBinary);

		expect(stageMulticaCli(linkedBinary, noticeDir, destDir, "darwin")).toBe(destDir);
		const stagedBinary = path.join(destDir, "multica");
		expect(lstatSync(stagedBinary).isSymbolicLink()).toBe(false);
		expect(readFileSync(stagedBinary, "utf8")).toBe("fake executable");
		expect(() => accessSync(stagedBinary, constants.X_OK)).not.toThrow();
		expect(readFileSync(path.join(destDir, "LICENSE"), "utf8")).toBe("license text");
		expect(readFileSync(path.join(destDir, "NOTICE"), "utf8")).toBe("notice text");
	});

	it("uses the Windows executable name", () => {
		stageMulticaCli(binaryPath, noticeDir, destDir, "win32");
		expect(existsSync(path.join(destDir, "multica.exe"))).toBe(true);
	});

	it("rejects missing, relative, non-file and non-executable binaries", () => {
		expect(() => stageMulticaCli(undefined, noticeDir, destDir, "darwin")).toThrow("AO_MULTICA_CLI_BIN is required");
		expect(() => stageMulticaCli("relative/multica", noticeDir, destDir, "darwin")).toThrow("must be an absolute path");
		expect(() => stageMulticaCli(path.join(tempDir, "missing"), noticeDir, destDir, "darwin")).toThrow("binary is missing");
		expect(() => stageMulticaCli(tempDir, noticeDir, destDir, "darwin")).toThrow("binary is not a file");
		chmodSync(binaryPath, 0o644);
		expect(() => stageMulticaCli(binaryPath, noticeDir, destDir, "darwin")).toThrow("binary is not executable");
	});

	it("requires a notice directory containing LICENSE and NOTICE files", () => {
		expect(() => stageMulticaCli(binaryPath, undefined, destDir, "darwin")).toThrow("AO_MULTICA_NOTICE_DIR is required");
		expect(() => stageMulticaCli(binaryPath, path.join(tempDir, "missing"), destDir, "darwin")).toThrow("not a directory");
		const missingNotice = path.join(tempDir, "missing-notice");
		writeFixture(path.join(missingNotice, "LICENSE"));
		expect(() => stageMulticaCli(binaryPath, missingNotice, destDir, "darwin")).toThrow("Multica NOTICE is missing");
		const missingLicense = path.join(tempDir, "missing-license");
		writeFixture(path.join(missingLicense, "NOTICE"));
		expect(() => stageMulticaCli(binaryPath, missingLicense, destDir, "darwin")).toThrow("Multica LICENSE is missing");
	});
});
