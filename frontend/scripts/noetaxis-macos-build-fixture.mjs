import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot } from "./noetaxis-macos-fixture-registry.mjs";

export const fixtureRevision = "ab2b4da93000000000000000000000000000000000";
export const fixtureMulticaRevision = "4b32bc7710753a6d97277c3833a4d7d19e48b2f7";
const states = new Map();

export function daemonBuildEnv() { return { CGO_ENABLED: "1" }; }
export async function buildPackages() { return { fileCount: 1 }; }
export async function writeArtifactChecksums() {}

export function fakeSpawnSync(command, args, options = {}) {
	const state = states.get(globalThis.__noetaxisBuildFixture);
	assert.ok(state, "a build command requires an isolated fixture");
	const env = options.env ?? process.env;
	const snapshot = {};
	for (const directory of [options.cwd, options.cwd && path.join(options.cwd, "acp-runtime")].filter(Boolean)) {
		for (const name of ["package-lock.json", "pnpm-lock.yaml", ".npmrc"]) {
			const file = path.join(directory, name);
			if (existsSync(file)) snapshot[file] = readFileSync(file, "utf8");
		}
	}
	const configs = Object.fromEntries([env.npm_config_userconfig, env.npm_config_globalconfig].filter((file) => file?.includes("/noetaxis-npm-")).map((file) => [file, readFileSync(file, "utf8")]));
	state.calls.push({ command, args, options: { ...options, env: { ...env } }, snapshot, configs, configModes: Object.fromEntries(Object.keys(configs).map((file) => [file, statSync(file).mode & 0o777])) });
	let stdout = "";
	if (command === "npm" && args[0] === "--version") stdout = "11.6.0";
	else if (command === "uname") stdout = "arm64";
	else if (command === "git" && args[0] === "rev-parse") stdout = fixtureRevision;
	else if (command === "git" && args[0] === "worktree" && args[1] === "add") cpSync(state.source, args[3], { recursive: true });
	else if (command === "git" && args[0] === "clone") cpSync(state.multica, args.at(-1), { recursive: true });
	else if (command === "git" && args.includes("rev-parse")) stdout = fixtureMulticaRevision;
	else if (command === "git" && (args.includes("checkout") || args[0] === "worktree")) {}
	else if (command === "npm" && args[0] === "pack") writeFileSync(path.join(args[args.indexOf("--pack-destination") + 1], "package.tgz"), "fake archive");
	else if (command === "/usr/bin/tar") stdout = "license bytes\n";
	else if (command === "npm" || command === "corepack") {
		if (state.failInstall && args.includes("install")) return { status: 1, stdout: "", stderr: "registry unavailable" };
	}
	else if (command.endsWith("/electron-forge")) {
		const resources = path.join(options.cwd, "out/Agent Orchestrator.app/Contents/Resources");
		mkdirSync(resources, { recursive: true });
		writeFileSync(path.join(resources, "ao-updates-disabled"), "disabled");
	}
	else if (command === "/usr/libexec/PlistBuddy") {
		if (args[1].startsWith("Print :CFBundle")) stdout = `0.13.4-noetaxis.${fixtureRevision.slice(0, 7)}`;
	}
	else if (command !== "/usr/bin/codesign" && command !== "/usr/bin/xattr") assert.fail(`Unexpected build command: ${command} ${args.join(" ")}`);
	return { status: 0, stdout: options.encoding ? stdout : Buffer.from(stdout), stderr: "" };
}

export function fakeSpawn(command, args, options = {}) {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => {};
	queueMicrotask(() => {
		try {
			const result = fakeSpawnSync(command, args, options);
			child.stdout.end(result.stdout);
			child.stderr.end(result.stderr);
			child.emit("close", result.status, result.signal);
		} catch (error) { child.emit("error", error); }
	});
	return child;
}

export async function makeBuildFixture(t, options = {}) {
	const root = await fixtureRoot(t, "noetaxis-build-fixture-");
	const source = path.join(root, "source");
	const multica = path.join(root, "multica");
	const registry = options.lockRegistry ?? "https://registry.npmjs.org/";
	for (const directory of ["", "frontend", "frontend/acp-runtime", "packages/product-ui"]) {
		const dir = path.join(source, directory);
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "package.json"), '{"version":"0.13.4"}');
		await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/example": { resolved: `${registry}example/-/example-1.0.0.tgz` } } }));
		await writeFile(path.join(dir, ".npmrc"), "@company:registry=https://proget.onbase.net/npm/npm\n//proget.onbase.net/npm/npm/:_authToken=${MISSING_COMPANY_TOKEN}\n");
	}
	await mkdir(path.join(source, "backend/internal/storage/sqlite/migrations"), { recursive: true });
	await writeFile(path.join(source, "backend/internal/storage/sqlite/migrations/190_fixture.sql"), "");
	await writeFile(path.join(source, "backend/go.mod"), `replace github.com/multica-ai/multica/server => github.com/amolodyh-hyland/multica/server v0.0.0-20261020093039-${fixtureMulticaRevision.slice(0, 12)}\n`);
	await mkdir(multica, { recursive: true });
	await writeFile(path.join(multica, "pnpm-lock.yaml"), options.multicaLock ?? `packages:\n  example@1.0.0:\n    resolution: {tarball: ${registry}example/-/example-1.0.0.tgz}\n`);
	await writeFile(path.join(multica, ".npmrc"), options.multicaNpmrc ?? "shamefully-hoist=true\n");
	await writeFile(path.join(multica, "package.json"), JSON.stringify(options.multicaPackage ?? { name: "multica", version: "0.0.0" }));
	await writeFile(path.join(multica, "pnpm-workspace.yaml"), options.multicaWorkspace ?? "packages:\n  - apps/*\n");
	if (options.pnpmfile) await writeFile(path.join(multica, ".pnpmfile.cjs"), options.pnpmfile);
	const userNpmrc = path.join(root, "auth-user-npmrc");
	const globalNpmrc = path.join(root, "auth-global-npmrc");
	await writeFile(userNpmrc, options.userNpmrc ?? "", { mode: 0o600 });
	await writeFile(globalNpmrc, "", { mode: 0o600 });
	const buildFile = new URL("./noetaxis-macos/build.mjs", import.meta.url);
	const fixtureURL = pathToFileURL(options.realCommands ? path.join(root, "native-stubs.mjs") : import.meta.filename).href;
	if (options.realCommands) await writeFile(path.join(root, "native-stubs.mjs"), 'export function daemonBuildEnv(){return {CGO_ENABLED:"1"}}; export async function buildPackages(){}; export async function writeArtifactChecksums(){};');
	const contents = (await readFile(buildFile, "utf8"))
		.replace('import { spawn } from "node:child_process";', options.realCommands ? 'import { spawn } from "node:child_process";' : `import { fakeSpawn as spawn } from ${JSON.stringify(fixtureURL)};`)
		.replace('"./parsers/ini.cjs"', JSON.stringify(new URL("./parsers/ini.cjs", buildFile).href))
		.replace('"./parsers/js-yaml.mjs"', JSON.stringify(new URL("./parsers/js-yaml.mjs", buildFile).href))
		.replace('"./package-artifacts.mjs"', JSON.stringify(fixtureURL))
		.replace('"../go-build-env.mjs"', JSON.stringify(fixtureURL))
		.replace('const repoRoot = path.resolve(scriptDir, "../../..");', `const repoRoot = ${JSON.stringify(source)};`)
		.replace('await registryBuildEnv(configDir, registry)', `await registryBuildEnv(configDir, registry, { ...process.env, npm_config_userconfig: ${JSON.stringify(userNpmrc)}, npm_config_globalconfig: ${JSON.stringify(globalNpmrc)} })`)
		.replace('process.platform !== "darwin" || process.arch !== "arm64"', 'false');
	const file = path.join(root, "build.mjs");
	await writeFile(file, contents);
	const build = await import(pathToFileURL(file));
	const state = { root, source, multica, calls: [], failInstall: options.failInstall };
	states.set(root, state);
	t.after(() => states.delete(root));
	return {
		...state, file,
		async run(args = []) {
			assert.equal(globalThis.__noetaxisBuildFixture, undefined);
			globalThis.__noetaxisBuildFixture = root;
			try { return await build.buildNoetaxis(build.parseArgs(["--output", path.join(root, "output"), ...args])); }
			finally { delete globalThis.__noetaxisBuildFixture; }
		},
	};
}
