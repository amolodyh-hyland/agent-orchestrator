import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { helperBuildOptions, buildUpdateHelper } from "./build-update-helper.mjs";

describe("macOS update helper build", () => {
  for (const [arch, cpu] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
    it(`compiles ${arch} independently of the host architecture`, () => {
      const { output, args } = helperBuildOptions(arch, "/project/frontend");
      assert.equal(output, "/project/frontend/update-helper/ao-update-progress");
      assert.ok(args.includes(`${cpu}-apple-macosx11.0`));
      assert.ok(args.includes("/project/frontend/native/update-helper/UpdateProgressState.swift"));
      assert.ok(args.includes("/project/frontend/native/update-helper/main.swift"));
    });
  }
  it("rejects unsupported architectures before spawning", () => {
    assert.throws(() => helperBuildOptions("universal"), /Unsupported/);
  });
  it("refuses a non-macOS build instead of silently shipping a missing helper", () => {
    assert.throws(() => buildUpdateHelper({ platform: "linux", run: () => { throw new Error("must not spawn"); } }), /must be built on macOS/);
  });
  it("keeps the Swift module cache under the supplied scratch root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ao-update-helper-test-"));
    const cacheRoot = path.join(root, "swift-cache");
    const previousCache = process.env.AO_SCRATCH_SWIFT_CACHE;
    let args = [];
    try {
      process.env.AO_SCRATCH_SWIFT_CACHE = cacheRoot;
      buildUpdateHelper({ arch: "arm64", platform: "darwin", root: path.join(root, "frontend"), run: (_command, nextArgs) => { args = nextArgs; return { status: 0 }; } });
      const cacheIndex = args.indexOf("-module-cache-path");
      assert.ok(cacheIndex >= 0);
      assert.equal(args[cacheIndex + 1], path.join(cacheRoot, "update-helper", "arm64"));
    } finally {
      if (previousCache === undefined) delete process.env.AO_SCRATCH_SWIFT_CACHE;
      else process.env.AO_SCRATCH_SWIFT_CACHE = previousCache;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
