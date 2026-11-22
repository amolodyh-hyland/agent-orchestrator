import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the built helper's executable lives, inside its app bundle. */
export const DICTATION_HELPER_EXECUTABLE = path.join("dictation-helper", "Orchestrator.app", "Contents", "MacOS", "Orchestrator");

// An app bundle, not a bare binary, so macOS names it Orchestrator and shows
// the app icon when it asks for microphone and speech recognition access.
export function dictationBuildOptions(platform, arch, root = frontend, windowsDir = process.env.WINDIR || "C:\\Windows") {
  const outputDir = path.join(root, "dictation-helper");
  if (platform === "darwin") {
    const cpu = { arm64: "arm64", x64: "x86_64" }[arch];
    if (!cpu) throw new Error(`Unsupported macOS dictation helper architecture: ${arch}`);
    const bundle = path.join(outputDir, "Orchestrator.app");
    const cache = process.env.AO_SCRATCH_SWIFT_CACHE || path.join(root, ".vite", "dictation-swift-cache", arch);
    return {
      command: "xcrun", outputDir, bundle, cache,
      args: ["swiftc", "-target", `${cpu}-apple-macosx11.0`, "-O",
        path.join(root, "native/dictation/DictationLocale.swift"), path.join(root, "native/dictation-helper/main.swift"),
        "-module-cache-path", cache, "-o", path.join(root, DICTATION_HELPER_EXECUTABLE)],
    };
  }
  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`Unsupported Windows dictation helper architecture: ${arch}`);
    const framework = path.win32.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319");
    return {
      command: path.win32.join(framework, "csc.exe"), outputDir,
      args: ["/nologo", "/target:exe", "/platform:x64", "/optimize+", `/out:${path.join(outputDir, "ao-dictation.exe")}`,
        `/reference:${path.win32.join(framework, "WPF", "System.Speech.dll")}`, "/reference:System.Web.Extensions.dll",
        ...["CaptureBuffer.cs", "WaveInApi.cs", "WaveInCapture.cs", "Dictation.Stop.cs", "Dictation.cs"].map(name => path.join(root, "native/dictation", name))],
    };
  }
  throw new Error(`Dictation is unsupported on ${platform}`);
}

export function buildDictationHelper({ platform = process.platform, arch = process.arch, root = frontend,
  run = spawnSync, ensureDirectory = mkdirSync, copy = copyFileSync, remove = rmSync } = {}) {
  if (platform !== process.platform) throw new Error("Dictation helpers must be compiled on the target OS");
  const options = dictationBuildOptions(platform, arch, root);
  remove(options.outputDir, { recursive: true, force: true });
  ensureDirectory(options.outputDir, { recursive: true });
  if (options.bundle) {
    ensureDirectory(path.join(options.bundle, "Contents", "MacOS"), { recursive: true });
    ensureDirectory(path.join(options.bundle, "Contents", "Resources"), { recursive: true });
    ensureDirectory(options.cache, { recursive: true });
    copy(path.join(root, "native/dictation-helper/Info.plist"), path.join(options.bundle, "Contents", "Info.plist"));
    copy(path.join(root, "assets", "icon.icns"), path.join(options.bundle, "Contents", "Resources", "icon.icns"));
  }
  const compile = run(options.command, options.args, { stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) throw new Error(`Dictation helper compilation failed (${compile.status})`);
  if (!options.bundle) return;
  const identity = process.env.NOETAXIS_SIGN_IDENTITY?.trim() || "-";
  if (/[\r\n\u0000]/.test(identity)) throw new Error("Invalid dictation signing identity");
  // Seal the full bundle's privacy metadata and icon; release signing re-signs it.
  const seal = run("codesign", ["--force", "--sign", identity, "--timestamp=none",
    "--entitlements", path.join(root, "native/dictation/entitlements.plist"), options.bundle], { stdio: "inherit" });
  if (seal.error) throw seal.error;
  if (seal.status !== 0) throw new Error(`macOS dictation helper signing failed (${seal.status})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--if-supported") {
    if (["darwin", "win32"].includes(process.platform)) buildDictationHelper();
    process.exit(0);
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--arch")) throw new Error("Usage: build-dictation-helper.mjs [--arch arm64|x64]");
  buildDictationHelper({ arch: args[1] ?? process.arch });
}
