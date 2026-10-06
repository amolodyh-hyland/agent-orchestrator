import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachOParseError } from "./makers/macho-archs";

// postMake's dmg/zip branches only need to prove they call the right
// maker-dmg functions with the right gates; the functions' own behavior
// (sealDmg's credential matrix, verifyMacArtifact's script invocation) is
// covered by makers/maker-dmg.test.ts. Mocking the whole module keeps this
// suite from spawning codesign/xcrun/bash indirectly through the real chain.
// vi.mock's factory is hoisted above the rest of the file (including plain
// const declarations), so the mock fns themselves must go through vi.hoisted.
const { sealDmg, verifyDmg, verifyMacArtifact, isSigningConfigured } = vi.hoisted(() => ({
	sealDmg: vi.fn<(path: string) => Promise<boolean>>(),
	verifyDmg: vi.fn<(path: string) => Promise<void>>(async () => undefined),
	verifyMacArtifact: vi.fn<(path: string) => Promise<void>>(async () => undefined),
	isSigningConfigured: vi.fn<() => boolean>(),
}));
vi.mock("./makers/maker-dmg", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./makers/maker-dmg")>();
	return { ...actual, sealDmg, verifyDmg, verifyMacArtifact, isSigningConfigured };
});

import config, {
	extraResourcesForPlatform,
	isMulticaCliSigningConfigured,
	macSignOptionsForFile,
	missingMulticaCliResources,
	missingMulticaResources,
	multicaCliBin,
	multicaDesktopOutDir,
	multicaNoticeDir,
	writeMulticaCliSha256,
	verifyMulticaCliResources,
	verifyPackagedMulticaCli,
} from "./forge.config";
import { MULTICA_CLI_STAGE_DIR } from "./scripts/stage-multica-cli.mjs";

// Minimal synthetic Mach-O headers (thin little-endian + fat big-endian), the
// two on-disk layouts the signing selector must tell apart. Full parser
// coverage lives in makers/macho-archs.test.ts; here the fixtures exist so the
// per-file signing decision is exercised against real file bytes.
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function thinMachO(cputype: number): Buffer {
	const buffer = Buffer.alloc(16);
	buffer.writeUInt32LE(0xfeedfacf, 0);
	buffer.writeUInt32LE(cputype, 4);
	return buffer;
}

function fatMachO(entries: number[]): Buffer {
	const buffer = Buffer.alloc(8 + entries.length * 20);
	buffer.writeUInt32BE(0xcafebabe, 0);
	buffer.writeUInt32BE(entries.length, 4);
	entries.forEach((cputype, index) => {
		buffer.writeUInt32BE(cputype, 8 + index * 20);
	});
	return buffer;
}

function withHostArch<T>(arch: string, run: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "arch");
	Object.defineProperty(process, "arch", { get: () => arch, configurable: true });
	try {
		return run();
	} finally {
		if (descriptor) Object.defineProperty(process, "arch", descriptor);
	}
}

let fixtureDir: string;

// The nested Node must sit at the real bundle path shape: the endsWith gate
// and the content selector are two halves of one decision.
function acpNodeWith(contents: Buffer): string {
	const binDir = join(
		fixtureDir,
		"Agent Orchestrator.app",
		"Contents",
		"Resources",
		"acp-runtime",
		"node",
		"bin",
	);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "node"), contents);
	return join(binDir, "node");
}

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "forge-signing-"));
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

describe("native runtime resources", () => {
	it("fails packaging when the macOS helper was not copied into Resources", async () => {
		mkdirSync(join(fixtureDir, "AO.app", "Contents", "Resources"), { recursive: true });
		const hook = config.hooks?.postPackage;
		expect(hook).toBeTypeOf("function");
		if (typeof hook !== "function") return;
		await expect(hook(config, { platform: "darwin", arch: "arm64", outputPaths: [fixtureDir] })).rejects.toThrow("packaged macOS update helper missing");
	});

	it("bundles the native update helper only on macOS", () => {
		expect(extraResourcesForPlatform("darwin")).toContain("update-helper");
		expect(extraResourcesForPlatform("linux")).not.toContain("update-helper");
		expect(extraResourcesForPlatform("win32")).not.toContain("update-helper");
	});

	it.each(["darwin", "linux"] as const)("bundles tmux on %s", (platform) => {
		expect(extraResourcesForPlatform(platform)).toContain("tmux");
	});

	it("does not bundle tmux on Windows", () => {
		expect(extraResourcesForPlatform("win32")).not.toContain("tmux");
	});
});

describe("Multica desktop resources", () => {
	it("includes Multica resources only when explicitly enabled", () => {
		expect(extraResourcesForPlatform("darwin", true)).toContain("multica-desktop");
		expect(extraResourcesForPlatform("darwin", true)).toContain("ao-updates-disabled");
		expect(extraResourcesForPlatform("darwin", false)).not.toContain("multica-desktop");
		expect(extraResourcesForPlatform("darwin", false)).not.toContain("ao-updates-disabled");
	});

	it("uses AO_MULTICA_DESKTOP_OUT for the default resource selection", () => {
		vi.stubEnv("AO_MULTICA_DESKTOP_OUT", undefined);
		expect(extraResourcesForPlatform("darwin")).not.toContain("multica-desktop");
		expect(extraResourcesForPlatform("darwin")).not.toContain("ao-updates-disabled");

		vi.stubEnv("AO_MULTICA_DESKTOP_OUT", " /tmp/multica/out ");
		expect(extraResourcesForPlatform("darwin")).toContain("multica-desktop");
		expect(extraResourcesForPlatform("darwin")).toContain("ao-updates-disabled");
	});

	it("trims AO_MULTICA_DESKTOP_OUT and returns undefined when blank", () => {
		vi.stubEnv("AO_MULTICA_DESKTOP_OUT", undefined);
		expect(multicaDesktopOutDir()).toBeUndefined();
		vi.stubEnv("AO_MULTICA_DESKTOP_OUT", "   ");
		expect(multicaDesktopOutDir()).toBeUndefined();
		vi.stubEnv("AO_MULTICA_DESKTOP_OUT", "  /tmp/multica/out  ");
		expect(multicaDesktopOutDir()).toBe("/tmp/multica/out");
	});

	it("checks for the renderer, a supported preload entry point, and the update marker", () => {
		const resourcesPath = "/fake/resources";
		const complete = new Set([
			"multica-desktop/renderer/index.html",
			"multica-desktop/preload/index.js",
			"ao-updates-disabled",
		]);
		const existsIn = (files: Set<string>) => (file: string) =>
			files.has(file.slice(resourcesPath.length + 1).replaceAll("\\", "/"));

		expect(missingMulticaResources(resourcesPath, existsIn(complete))).toEqual([]);
		expect(missingMulticaResources(resourcesPath, existsIn(new Set()))).toEqual([
			"multica-desktop/renderer/index.html",
			"multica-desktop/preload/index.js",
			"ao-updates-disabled",
		]);
		const commonJsPreload = new Set(complete);
		commonJsPreload.delete("multica-desktop/preload/index.js");
		commonJsPreload.add("multica-desktop/preload/index.cjs");
		expect(missingMulticaResources(resourcesPath, existsIn(commonJsPreload))).toEqual([]);
	});
});

describe("Multica CLI resources", () => {
	function executableFixture(platform: NodeJS.Platform): Buffer {
		if (platform === "darwin") return thinMachO(CPU_TYPE_ARM64);
		if (platform === "linux") return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
		if (platform === "win32") return Buffer.from("MZ\x90\x00\x03\x00", "binary");
		throw new Error(`unsupported fixture platform: ${platform}`);
	}

	function writeCliPackage(
		cliDirectory: string,
		platform: NodeJS.Platform = "darwin",
		binaryContents = executableFixture(platform),
		checksumContents?: string,
	): void {
		mkdirSync(cliDirectory, { recursive: true });
		const binaryName = platform === "win32" ? "multica.exe" : "multica";
		const binaryPath = join(cliDirectory, binaryName);
		writeFileSync(binaryPath, binaryContents);
		chmodSync(binaryPath, 0o755);
		const digest = createHash("sha256").update(binaryContents).digest("hex");
		writeFileSync(join(cliDirectory, "multica.sha256"), checksumContents ?? `${digest}  ${binaryName}\n`);
		writeFileSync(join(cliDirectory, "LICENSE"), "license text");
		writeFileSync(join(cliDirectory, "NOTICE"), "notice text");
	}

	it("trims the package-time CLI and notices inputs", () => {
		expect(multicaCliBin({ AO_MULTICA_CLI_BIN: "  /build/multica  " })).toBe("/build/multica");
		expect(multicaCliBin({ AO_MULTICA_CLI_BIN: "   " })).toBeUndefined();
		expect(multicaNoticeDir({ AO_MULTICA_NOTICE_DIR: "  /source/multica  " })).toBe("/source/multica");
		expect(multicaNoticeDir({})).toBeUndefined();
	});

	it("adds the staged CLI resource only when bundling it", () => {
		vi.stubEnv("AO_MULTICA_CLI_BIN", undefined);
		expect(extraResourcesForPlatform("darwin", false)).not.toContain(MULTICA_CLI_STAGE_DIR);
		expect(extraResourcesForPlatform("darwin", false, true)).toContain(MULTICA_CLI_STAGE_DIR);
	});

	it("reports each missing packaged CLI file", () => {
		const resourcesPath = "/fake/resources";
		const complete = new Set([
			"multica-cli/multica",
			"multica-cli/LICENSE",
			"multica-cli/NOTICE",
			"multica-cli/multica.sha256",
		]);
		const existsIn = (files: Set<string>) => (file: string) =>
			files.has(file.slice(resourcesPath.length + 1).replaceAll("\\", "/"));

		expect(missingMulticaCliResources(resourcesPath, "darwin", existsIn(complete))).toEqual([]);
		expect(missingMulticaCliResources(resourcesPath, "darwin", existsIn(new Set()))).toEqual([
			"multica-cli/multica",
			"multica-cli/LICENSE",
			"multica-cli/NOTICE",
			"multica-cli/multica.sha256",
		]);
		expect(missingMulticaCliResources(resourcesPath, "win32", existsIn(new Set()))[0]).toBe("multica-cli/multica.exe");
	});

	it("writes a SHA-256 record for the staged platform binary", () => {
		const stageDir = join(fixtureDir, "multica-cli");
		mkdirSync(stageDir, { recursive: true });
		writeFileSync(join(stageDir, "multica"), "fake executable");

		const checksumPath = writeMulticaCliSha256(stageDir, "darwin");
		const expected = createHash("sha256").update("fake executable").digest("hex");
		expect(checksumPath).toBe(join(stageDir, "multica.sha256"));
		expect(readFileSync(checksumPath, "utf8")).toBe(`${expected}  multica\n`);
	});

	it("rejects an unsigned packaged binary whose bytes differ from the recorded checksum", () => {
		const resourcesPath = join(fixtureDir, "resources");
		const cliDirectory = join(resourcesPath, "multica-cli");
		writeCliPackage(cliDirectory);
		writeFileSync(join(cliDirectory, "multica"), Buffer.concat([executableFixture("darwin"), Buffer.from("tampered")]));

		expect(() => verifyPackagedMulticaCli(resourcesPath, "darwin", {})).toThrow("SHA-256 does not match");
	});

	it("rejects a directory in place of the packaged executable", () => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		mkdirSync(cliDirectory, { recursive: true });
		mkdirSync(join(cliDirectory, "multica"));
		writeFileSync(join(cliDirectory, "multica.sha256"), `${"a".repeat(64)}  multica\n`);

		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("not a regular file");
	});

	it.skipIf(process.platform === "win32")("rejects a packaged executable without its executable bit", () => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		writeCliPackage(cliDirectory);
		chmodSync(join(cliDirectory, "multica"), 0o644);

		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("not executable");
	});

	it("rejects a malformed checksum or a checksum naming another file", () => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		writeCliPackage(cliDirectory, "darwin", executableFixture("darwin"), "sha256 multica\n");
		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("checksum is malformed");

		const digest = createHash("sha256").update(executableFixture("darwin")).digest("hex");
		writeFileSync(join(cliDirectory, "multica.sha256"), `${digest}  another-file\n`);
		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("checksum is malformed");
	});

	it("skips the digest comparison only after codesign verifies a signed macOS build", () => {
		const resourcesPath = join(fixtureDir, "resources");
		const cliDirectory = join(resourcesPath, "multica-cli");
		writeCliPackage(cliDirectory);
		writeFileSync(join(cliDirectory, "multica"), thinMachO(CPU_TYPE_X86_64));
		const env = { APPLE_SIGNING_IDENTITY: "Developer ID Application", CSC_LINK: "" };
		const verifyCodeSignature = vi.fn();

		expect(isMulticaCliSigningConfigured(env)).toBe(true);
		expect(() => verifyPackagedMulticaCli(resourcesPath, "darwin", env, { verifyCodeSignature })).not.toThrow();
		expect(verifyCodeSignature).toHaveBeenCalledWith(join(cliDirectory, "multica"));
		writeFileSync(join(cliDirectory, "multica.sha256"), "invalid checksum\n");
		expect(() => verifyPackagedMulticaCli(resourcesPath, "darwin", env, { verifyCodeSignature })).toThrow("checksum is malformed");
	});

	it("fails packaging when codesign rejects the packaged binary", () => {
		const resourcesPath = join(fixtureDir, "resources");
		const cliDirectory = join(resourcesPath, "multica-cli");
		writeCliPackage(cliDirectory);
		const verifyCodeSignature = vi.fn(() => {
			throw new Error("signature verification failed");
		});

		expect(() => verifyPackagedMulticaCli(resourcesPath, "darwin", { CSC_LINK: "certificate" }, { verifyCodeSignature })).toThrow(
			"signature verification failed",
		);
		expect(verifyCodeSignature).toHaveBeenCalledOnce();
	});

	it("still checks the digest on Linux when macOS signing variables are set", () => {
		const resourcesPath = join(fixtureDir, "resources");
		const cliDirectory = join(resourcesPath, "multica-cli");
		writeCliPackage(cliDirectory, "linux");
		writeFileSync(join(cliDirectory, "multica"), Buffer.concat([executableFixture("linux"), Buffer.from("tampered")]));
		const verifyCodeSignature = vi.fn();

		expect(() =>
			verifyPackagedMulticaCli(resourcesPath, "linux", { APPLE_SIGNING_IDENTITY: "identity" }, { verifyCodeSignature }),
		).toThrow("SHA-256 does not match");
		expect(verifyCodeSignature).not.toHaveBeenCalled();
	});

	it.each([
		["darwin", "multica"],
		["linux", "multica"],
		["win32", "multica.exe"],
	] as const)("accepts the %s executable header", (platform, binaryName) => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		writeCliPackage(cliDirectory, platform);
		expect(() => verifyMulticaCliResources(cliDirectory, platform)).not.toThrow();
		expect(readFileSync(join(cliDirectory, binaryName)).length).toBeGreaterThan(0);
	});

	it("rejects an executable with the wrong target format", () => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		writeCliPackage(cliDirectory);
		writeFileSync(join(cliDirectory, "multica"), "wrong executable format");

		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("wrong executable format");
	});

	it("rejects a directory in place of the packaged NOTICE", () => {
		const cliDirectory = join(fixtureDir, "multica-cli");
		writeCliPackage(cliDirectory);
		rmSync(join(cliDirectory, "NOTICE"));
		mkdirSync(join(cliDirectory, "NOTICE"));

		expect(() => verifyMulticaCliResources(cliDirectory, "darwin")).toThrow("NOTICE is not a regular file");
	});

	it("fails post-package verification when bundled CLI resources are missing", async () => {
		vi.stubEnv("AO_MULTICA_CLI_BIN", "/build/multica");
		const hook = config.hooks?.postPackage;
		expect(hook).toBeTypeOf("function");
		if (typeof hook !== "function") return;
		await expect(hook(config, { platform: "win32", arch: "x64", outputPaths: [fixtureDir] })).rejects.toThrow(
			"packaged Multica CLI resources missing",
		);
	});
});

type MacSignOptions = {
	identity?: string;
	optionsForFile?: typeof macSignOptionsForFile;
};

async function loadMacSignOptions(env: {
	APPLE_SIGNING_IDENTITY?: string;
	CSC_LINK?: string;
}): Promise<MacSignOptions | undefined> {
	vi.stubEnv("APPLE_SIGNING_IDENTITY", env.APPLE_SIGNING_IDENTITY ?? "");
	vi.stubEnv("CSC_LINK", env.CSC_LINK ?? "");
	vi.resetModules();
	const { default: envConfig } = await import("./forge.config");
	return envConfig.packagerConfig?.osxSign as MacSignOptions | undefined;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	sealDmg.mockReset();
	verifyDmg.mockReset().mockImplementation(async () => undefined);
	verifyMacArtifact.mockReset().mockImplementation(async () => undefined);
	isSigningConfigured.mockReset();
});

describe("macOS signing", () => {
	const NODE_ENTITLEMENTS = [
		"com.apple.security.cs.allow-jit",
		"com.apple.security.cs.allow-unsigned-executable-memory",
	];

	it("allows the bundled Node runtime to execute V8 JIT code on Intel Macs", () => {
		expect(macSignOptionsForFile(acpNodeWith(thinMachO(CPU_TYPE_X86_64)))).toEqual({
			entitlements: NODE_ENTITLEMENTS,
		});
	});

	it("keeps the override for a universal binary carrying an x86_64 slice", () => {
		expect(macSignOptionsForFile(acpNodeWith(fatMachO([CPU_TYPE_X86_64, CPU_TYPE_ARM64])))).toEqual({
			entitlements: NODE_ENTITLEMENTS,
		});
	});

	it("keeps electron-osx-sign defaults for every other bundle file", () => {
		const foreign = join(fixtureDir, "elsewhere", "agent-orchestrator");
		mkdirSync(join(fixtureDir, "elsewhere"), { recursive: true });
		writeFileSync(foreign, thinMachO(CPU_TYPE_X86_64));
		expect(macSignOptionsForFile(foreign)).toEqual({});
	});

	it("keeps the narrower default JIT entitlement when the binary has no x86_64 slice", () => {
		expect(macSignOptionsForFile(acpNodeWith(thinMachO(CPU_TYPE_ARM64)))).toEqual({});
		expect(macSignOptionsForFile(acpNodeWith(fatMachO([CPU_TYPE_ARM64])))).toEqual({});
	});

	it("fails the signing pass when the file cannot be parsed", () => {
		expect(() => macSignOptionsForFile(acpNodeWith(Buffer.from("garbage header")))).toThrow(
			MachOParseError,
		);
		expect(() =>
			macSignOptionsForFile(acpNodeWith(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))),
		).toThrow(MachOParseError);
	});

	it("never consults the host architecture", () => {
		const acpNode = acpNodeWith(thinMachO(CPU_TYPE_ARM64));
		const fromX64Host = withHostArch("x64", () => macSignOptionsForFile(acpNode));
		const fromArm64Host = withHostArch("arm64", () => macSignOptionsForFile(acpNode));
		const fromAbsurdHost = withHostArch("ppc64", () => macSignOptionsForFile(acpNode));
		expect(fromX64Host).toEqual({});
		expect(fromArm64Host).toEqual({});
		expect(fromAbsurdHost).toEqual({});
	});

	it.each([
		{
			name: "an explicit signing identity",
			env: { APPLE_SIGNING_IDENTITY: "Developer ID Application: AO (TEAMID)" },
			identity: "Developer ID Application: AO (TEAMID)",
		},
		{
			name: "a CSC_LINK certificate",
			env: { CSC_LINK: "base64-certificate" },
			identity: undefined,
		},
	])("wires the per-file override when signing with $name", async ({ env, identity }) => {
		const signOptions = await loadMacSignOptions(env);

		expect(signOptions?.identity).toBe(identity);
		expect(signOptions?.optionsForFile).toEqual(expect.any(Function));
	});

	it("leaves unsigned local packages unsigned", async () => {
		await expect(loadMacSignOptions({})).resolves.toBeUndefined();
	});
});

describe("postMake artifact verification", () => {
	// #3879: a valid outer seal did not prove the bundled Intel ACP Node could
	// actually run JavaScript. The dmg branch already ran verify-mac-artifact.sh
	// through sealDmg/verifyDmg; these cases prove the zip branch — the artifact
	// electron-updater installs auto-updates from, and per-arch what CI ships
	// for x64 — gets the same nested-Node check instead of shipping unverified.
	function darwinResult(artifacts: string[]) {
		return [{ artifacts, packageJSON: {}, platform: "darwin" as const, arch: "x64" as const }];
	}

	it("verifies a signed zip with the canonical script, gated on isSigningConfigured", async () => {
		isSigningConfigured.mockReturnValue(true);
		const makeResults = darwinResult(["/out/make/zip/agent-orchestrator-darwin-x64.zip"]);

		await config.hooks?.postMake?.({} as never, makeResults);

		expect(verifyMacArtifact).toHaveBeenCalledWith("/out/make/zip/agent-orchestrator-darwin-x64.zip");
	});

	it("skips zip verification for an unsigned local build", async () => {
		isSigningConfigured.mockReturnValue(false);
		const makeResults = darwinResult(["/out/make/zip/agent-orchestrator-darwin-x64.zip"]);

		await config.hooks?.postMake?.({} as never, makeResults);

		expect(verifyMacArtifact).not.toHaveBeenCalled();
	});

	it("still seals and verifies the dmg through the existing sealDmg/verifyDmg path", async () => {
		isSigningConfigured.mockReturnValue(true);
		sealDmg.mockResolvedValue(true);
		const makeResults = darwinResult(["/out/make/app.dmg"]);

		await config.hooks?.postMake?.({} as never, makeResults);

		expect(sealDmg).toHaveBeenCalledWith("/out/make/app.dmg");
		expect(verifyDmg).toHaveBeenCalledWith("/out/make/app.dmg");
		expect(verifyMacArtifact).not.toHaveBeenCalled();
	});

	it("verifies both the dmg and the zip when a make run produces both", async () => {
		isSigningConfigured.mockReturnValue(true);
		sealDmg.mockResolvedValue(true);
		const makeResults = darwinResult([
			"/out/make/zip/agent-orchestrator-darwin-x64.zip",
			"/out/make/app.dmg",
		]);

		await config.hooks?.postMake?.({} as never, makeResults);

		expect(verifyMacArtifact).toHaveBeenCalledWith("/out/make/zip/agent-orchestrator-darwin-x64.zip");
		expect(verifyDmg).toHaveBeenCalledWith("/out/make/app.dmg");
	});

	it("never verifies non-darwin artifacts", async () => {
		const makeResults = [
			{
				artifacts: ["/out/make/agent-orchestrator.exe"],
				packageJSON: {},
				platform: "win32" as const,
				arch: "x64" as const,
			},
		];

		await config.hooks?.postMake?.({} as never, makeResults);

		expect(sealDmg).not.toHaveBeenCalled();
		expect(verifyDmg).not.toHaveBeenCalled();
		expect(verifyMacArtifact).not.toHaveBeenCalled();
	});
});

describe("packaged authentication callback registration", () => {
	it("declares ao-app in the macOS bundle and Linux package metadata", () => {
		expect(config.packagerConfig?.protocols).toEqual([
			{
				name: "Agent Orchestrator authentication callback",
				schemes: ["ao-app"],
			},
		]);

		const makers = config.makers as Array<{
			name?: string;
			config?: { options?: { mimeType?: string[] } };
		}>;
		for (const name of [
			"@electron-forge/maker-deb",
			"@electron-forge/maker-rpm",
		]) {
			const maker = makers.find((candidate) => candidate.name === name);
			expect(maker?.config?.options?.mimeType).toEqual([
				"x-scheme-handler/ao-app",
			]);
		}
	});
});

describe("packaged native dependencies", () => {
	it("keeps the SQLite runtime available to the Vite main bundle", () => {
		const ignore = config.packagerConfig?.ignore;
		expect(ignore).toBeTypeOf("function");
		if (typeof ignore !== "function") return;

		expect(ignore("/.vite/build/main.js")).toBe(false);
		expect(ignore("/node_modules")).toBe(false);
		expect(ignore("/node_modules/better-sqlite3/build/Release/better_sqlite3.node")).toBe(false);
		expect(ignore("/node_modules/bindings/bindings.js")).toBe(false);
		expect(ignore("/node_modules/file-uri-to-path/index.js")).toBe(false);
		expect(ignore("/node_modules/react/index.js")).toBe(true);
		expect(ignore("/src/main.ts")).toBe(true);
		expect(config.hooks?.prePackage).toBeTypeOf("function");
	});
});
