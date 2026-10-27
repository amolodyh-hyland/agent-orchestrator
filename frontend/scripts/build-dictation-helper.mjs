import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function dictationBuildOptions(platform, arch, root = frontend, windowsDir = process.env.WINDIR || "C:\\Windows") {
  const outputDir = path.join(root, "dictation-helper");
  if (platform === "darwin") {
    const cpu = { arm64: "arm64", x64: "x86_64" }[arch];
    if (!cpu) throw new Error(`Unsupported dictation architecture: ${arch}`);
    return {
      command: "xcrun", outputDir,
      args: ["swiftc", "-target", `${cpu}-apple-macosx11.0`, "-O", "-module-cache-path", path.join(root, ".vite", "dictation-swift-cache"),
        path.join(root, "native/dictation/DictationLocale.swift"), path.join(root, "native/dictation/main.swift"),
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", path.join(root, "native/dictation/info.plist"),
        "-o", path.join(outputDir, "ao-dictation")],
    };
  }
  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`Unsupported Windows dictation architecture: ${arch}`);
    const framework = path.win32.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319");
    return {
      command: path.win32.join(framework, "csc.exe"), outputDir,
      args: ["/nologo", "/target:exe", "/platform:x64", "/optimize+", `/out:${path.join(outputDir, "ao-dictation.exe")}`,
        `/reference:${path.win32.join(framework, "WPF", "System.Speech.dll")}`, "/reference:System.Web.Extensions.dll", path.join(root, "native/dictation/CaptureBuffer.cs"), path.join(root, "native/dictation/WaveInApi.cs"), path.join(root, "native/dictation/WaveInCapture.cs"), path.join(root, "native/dictation/Dictation.Stop.cs"), path.join(root, "native/dictation/Dictation.cs")],
    };
  }
  throw new Error(`Dictation is unsupported on ${platform}`);
}

export function buildDictationHelper({ platform = process.platform, arch = process.arch, run = spawnSync, ensureDirectory = mkdirSync } = {}) {
  if (platform !== process.platform) throw new Error("Dictation helpers must be compiled on the target OS");
  const options = dictationBuildOptions(platform, arch);
  ensureDirectory(options.outputDir, { recursive: true });
  const result = run(options.command, options.args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dictation helper compilation failed (${result.status})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--if-supported" && args.length === 1) {
    if (["darwin", "win32"].includes(process.platform)) buildDictationHelper();
  } else {
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--arch")) throw new Error("Usage: build-dictation-helper.mjs [--arch arm64|x64|--if-supported]");
    buildDictationHelper({ arch: args[1] ?? process.arch });
  }
}
