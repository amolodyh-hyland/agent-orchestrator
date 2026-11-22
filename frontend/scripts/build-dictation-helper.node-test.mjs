import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { dictationBuildOptions, buildDictationHelper, DICTATION_HELPER_EXECUTABLE } from "./build-dictation-helper.mjs";

function build(overrides = {}) {
  const calls = [];
  const directories = [];
  const copies = [];
  buildDictationHelper({
    root: "/project/frontend",
    ensureDirectory: directory => directories.push(directory),
    copy: (...args) => copies.push(args),
    remove() {},
    run: (...args) => { calls.push(args); return { status: 0 }; },
    ...overrides,
  });
  return { calls, directories, copies };
}

describe("dictation helper packaging", () => {
  for (const [arch, cpu] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
    it(`compiles ${arch} into the latest helper app bundle with fork locale selection`, () => {
      const options = dictationBuildOptions("darwin", arch, "/project/frontend");
      assert.equal(options.command, "xcrun");
      assert.ok(options.args.includes(`${cpu}-apple-macosx11.0`));
      assert.ok(options.args.includes("/project/frontend/native/dictation-helper/main.swift"));
      assert.ok(options.args.includes("/project/frontend/native/dictation/DictationLocale.swift"));
      assert.equal(options.args.at(-1), path.join("/project/frontend", DICTATION_HELPER_EXECUTABLE));
      const plist = readFileSync(new URL("../native/dictation-helper/Info.plist", import.meta.url), "utf8");
      assert.match(plist, /NSMicrophoneUsageDescription/);
      assert.match(plist, /NSSpeechRecognitionUsageDescription/);
      assert.match(plist, /CFBundleIconFile/);
    });
  }

  it("retains the Windows system compiler and every robust capture/stop source", () => {
    const options = dictationBuildOptions("win32", "x64", "/project/frontend", "C:\\Windows");
    assert.match(options.command, /Framework64\\v4.0.30319\\csc.exe$/);
    assert.ok(options.args.some(arg => arg.endsWith("WPF\\System.Speech.dll")));
    assert.ok(options.args.some(arg => arg.endsWith("ao-dictation.exe")));
    for (const name of ["CaptureBuffer.cs", "WaveInApi.cs", "WaveInCapture.cs", "Dictation.Stop.cs", "Dictation.cs"]) {
      assert.ok(options.args.includes(path.join("/project/frontend/native/dictation", name)));
    }
    assert.throws(() => dictationBuildOptions("win32", "arm64"), /Unsupported/);
    assert.throws(() => dictationBuildOptions("linux", "x64"), /unsupported/);
  });

  it("copies the bundle privacy plist/icon and seals the complete helper", { skip: process.platform !== "darwin" }, () => {
    const { calls, copies } = build();
    assert.deepEqual(copies, [
      ["/project/frontend/native/dictation-helper/Info.plist", "/project/frontend/dictation-helper/Orchestrator.app/Contents/Info.plist"],
      ["/project/frontend/assets/icon.icns", "/project/frontend/dictation-helper/Orchestrator.app/Contents/Resources/icon.icns"],
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "xcrun");
    assert.equal(calls[1][0], "codesign");
    assert.ok(calls[1][1].includes("/project/frontend/native/dictation/entitlements.plist"));
    assert.equal(calls[1][1].at(-1), "/project/frontend/dictation-helper/Orchestrator.app");
  });

  it("does not silently fall back when a selected signing identity fails", { skip: process.platform !== "darwin" }, () => {
    const saved = process.env.NOETAXIS_SIGN_IDENTITY;
    process.env.NOETAXIS_SIGN_IDENTITY = "Existing Local Identity";
    try {
      assert.throws(() => build({ run: (command, args) => {
        if (command === "codesign") {
          assert.equal(args[args.indexOf("--sign") + 1], "Existing Local Identity");
          return { status: 1 };
        }
        return { status: 0 };
      } }), /signing failed/);
    } finally {
      if (saved === undefined) delete process.env.NOETAXIS_SIGN_IDENTITY;
      else process.env.NOETAXIS_SIGN_IDENTITY = saved;
    }
  });

  it("propagates compilation failure without signing", { skip: !["darwin", "win32"].includes(process.platform) }, () => {
    let calls = 0;
    assert.throws(() => build({ run: () => { calls++; return { status: 1 }; } }), /compilation failed/);
    assert.equal(calls, 1);
  });
});
