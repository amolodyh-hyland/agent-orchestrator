import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dictationBuildOptions, buildDictationHelper } from "./build-dictation-helper.mjs";

describe("dictation helper packaging", () => {
  for (const [arch, cpu] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
    it(`builds ${arch} with embedded privacy descriptions and a separate compiler cache`, () => {
      const { command, args, outputDir } = dictationBuildOptions("darwin", arch, "/project/frontend");
      assert.equal(command, "xcrun");
      assert.ok(args.includes(`${cpu}-apple-macosx11.0`));
      assert.ok(args.includes("/project/frontend/native/dictation/info.plist"));
      assert.ok(args.includes("/project/frontend/.vite/dictation-swift-cache"));
      assert.equal(outputDir, "/project/frontend/dictation-helper");
      const plist = readFileSync(new URL("../native/dictation/info.plist", import.meta.url), "utf8");
      assert.match(plist, /NSMicrophoneUsageDescription/);
      assert.match(plist, /NSSpeechRecognitionUsageDescription/);
    });
  }
  it("uses the Windows system compiler and in-process speech assembly without package downloads", () => {
    const options = dictationBuildOptions("win32", "x64", "/project/frontend", "C:\\Windows");
    assert.match(options.command, /Framework64\\v4.0.30319\\csc.exe$/);
    assert.ok(options.args.some(arg => arg.endsWith("WPF\\System.Speech.dll")));
    assert.ok(options.args.some(arg => arg.endsWith("ao-dictation.exe")));
    assert.throws(() => dictationBuildOptions("win32", "arm64"), /Unsupported/);
    assert.throws(() => dictationBuildOptions("linux", "x64"), /unsupported/);
  });
  it("propagates compiler failure", { skip: !["darwin", "win32"].includes(process.platform) }, () => {
    assert.throws(() => buildDictationHelper({ ensureDirectory() {}, run: () => ({ status: 1 }) }), /compilation failed/);
  });
});
