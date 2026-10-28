import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fixtureRoot, fixtureSpawn as spawn, fixtureSpawnSync as spawnSync } from "./noetaxis-macos-fixture-registry.mjs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyAgentBrowserLicenses } from "./agent-browser-license.mjs";
import { buildDiskImage, buildPackages, writeManifest } from "./noetaxis-macos/package-artifacts.mjs";
import { assertRegistryConfiguration, readRegistryConfiguration, parseArgs, parseMulticaPin, stampVersion, validateRegistry } from "./noetaxis-macos/build.mjs";
import { makeBuildFixture } from "./noetaxis-macos-build-fixture.mjs";
import { copyFakeScripts } from "./noetaxis-macos-update-world.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const fakeScriptsDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-classic-scripts-"));
await copyFakeScripts(path.join(scriptDir, "noetaxis-macos"), fakeScriptsDir);
const installScript = path.join(fakeScriptsDir, "install.sh");
const rollbackScript = path.join(fakeScriptsDir, "rollback.sh");
after(async () => { await makeWritable(fakeScriptsDir); await rm(fakeScriptsDir, { recursive: true, force: true }); });
const revision = "8e2bc21fd5d95c525f536dc03b5e7b7f10b04c7c";
const version = "0.13.4-noetaxis.8e2bc21";
const registry = "https://proget.onbase.net/npm/npm";

function execute(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	return result;
}

async function makeWritable(directory) {
	const details = await lstat(directory).catch(() => undefined);
	if (!details || details.isSymbolicLink()) return;
	await chmod(directory, details.isDirectory() ? 0o755 : 0o644).catch(() => {});
	if (details.isDirectory()) {
		for (const name of await readdir(directory)) await makeWritable(path.join(directory, name));
	}
}

async function testRoot(t, label, retain = false) {
	const retainedBase = process.env.NOETAXIS_TEST_ARTIFACTS;
	let root;
	if (retain && retainedBase) {
		await mkdir(retainedBase, { recursive: true });
		root = path.join(retainedBase, `${label}-${Date.now()}-${process.pid}`);
		await mkdir(root, { recursive: true });
		console.log(`Retained test artifacts: ${root}`);
		await fixtureRoot(t, label, { root, retain: true });
	} else {
		root = await fixtureRoot(t, `${label}-`);
	}
	return root;
}

async function makeApp(appPath, appVersion, sourceRevision = "") {
	const contents = path.join(appPath, "Contents");
	const resources = path.join(contents, "Resources");
	await mkdir(path.join(resources, "daemon"), { recursive: true });
	for (const directory of ["MacOS", "Frameworks", "Resources/acp-runtime/node/bin"]) await mkdir(path.join(contents, directory), { recursive: true });
	const versionProperties = sourceRevision ? `<key>NoetaxisSourceRevision</key><string>${sourceRevision}</string>` : "";
	const info = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.agent-orchestrator.desktop</string><key>CFBundleShortVersionString</key><string>${appVersion}</string><key>CFBundleVersion</key><string>${appVersion}</string><key>CFBundlePackageType</key><string>APPL</string>${versionProperties}</dict></plist>`;
	await writeFile(path.join(contents, "Info.plist"), info);
	await writeFile(path.join(resources, "ao-updates-disabled"), "");
	const cli = `#!/bin/sh
case "$1" in
  version) printf 'dev\\n' ;;
  spawn) printf '  --effort string\\n' ;;
  project) printf '  --permission-fallback\\n' ;;
  status) printf 'ready\\n' ;;
  stop) echo "stop $*" >> "$(dirname "$0")/ao-stop-calls" ;;
esac
`;
	const cliPath = path.join(resources, "daemon/ao");
	await writeFile(cliPath, cli, { mode: 0o755 });
	await chmod(cliPath, 0o755);
	if (sourceRevision) {
		const signed = execute("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
		assert.equal(signed.status, 0, signed.stderr);
	}
	return appPath;
}

async function makeHandlerFixture(home) {
	const plist = path.join(home, "launch-services.plist");
	await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LSHandlers</key><array><dict><key>LSHandlerURLScheme</key><string>ao-app</string><key>LSHandlerRoleAll</key><string>dev.agent-orchestrator.desktop</string></dict></array></dict></plist>`);
	return plist;
}

async function makeFakeBin(root, pgrepMode = "idle", psMode = "plain") {
	const bin = path.join(root, `bin-${pgrepMode}-${psMode}`);
	await mkdir(bin, { recursive: true });
	// Kind modes match only the pgrep pattern for that part of a running AO.
	const kindPatterns = { desktop: "*/Contents/MacOS/*", daemon: '*"ao daemon"*', "chat-host": '*"ao chat-host"*', other: "*/Contents/" };
	const pgrep = pgrepMode === "busy"
		? `#!/bin/sh
case "$*" in *ShipIt*) exit 1;; *) echo 4242; exit 0;; esac
`
		: pgrepMode === "shipit"
		? `#!/bin/sh
case "$*" in *ShipIt*) exit 0;; *) exit 1;; esac
`
		: kindPatterns[pgrepMode]
		? `#!/bin/sh
echo "$*" >> "$(dirname "$0")/pgrep-calls"
case "$*" in ${kindPatterns[pgrepMode]}) echo 4242; exit 0;; *) exit 1;; esac
`
		: "#!/bin/sh\nexit 1\n";
	await writeFile(path.join(bin, "pgrep"), pgrep, { mode: 0o755 });
	// Nothing in the install tooling may stop a process; any such call is recorded and asserted absent.
	for (const name of ["kill", "pkill", "killall", "osascript", "launchctl"]) {
		await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$(dirname "$0")/kill-calls"\nexit 0\n`, { mode: 0o755 });
	}
	const fixtureCommands = {
		busy: "Contents/MacOS/Agent Orchestrator",
		desktop: "Contents/MacOS/Agent Orchestrator",
		daemon: "Contents/Resources/daemon/ao daemon",
		"chat-host": "Contents/Resources/daemon/ao chat-host s1 /tmp/data /tmp/worktrees",
		other: "Contents/Resources/acp-runtime/node/bin/node helper",
	};
	const fixtureExecutables = { busy: "Contents/MacOS/Agent Orchestrator", desktop: "Contents/MacOS/Agent Orchestrator", daemon: "Contents/Resources/daemon/ao", "chat-host": "Contents/Resources/daemon/ao", other: "Contents/Resources/acp-runtime/node/bin/node" };
	await writeFile(path.join(bin, "executables"), `*|/bin/bash\n${fixtureExecutables[pgrepMode] ? `4242|<APP>/${fixtureExecutables[pgrepMode]}\n` : ""}`);
	const ps = psMode === "chain" || psMode === "cycle"
		? `#!/bin/bash
echo call >> "$(dirname "$0")/ps-calls"
last="\${@: -1}"
case "$*" in
  *command=*) echo zsh ;;
  *ppid=*) ${psMode === "chain" ? 'echo $((last + 1))' : 'if [ "$last" = 5000 ]; then echo 6000; else echo 5000; fi'} ;;
  *) exit 1 ;;
esac
`
		: psMode === "wrapped-ancestor"
		? `#!/bin/sh
case "$*" in *command=*"-p 4000000"*|*"-p 4000000"*command=*) printf '%s\\n' '/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao daemon';; *command=*) printf '%s\\n' 'zsh';; *ppid=*"-p 4000000"*) printf '1\\n';; *ppid=*) printf '4000000\\n';; *) exit 1;; esac
`
		: psMode === "ao-ancestor"
		? `#!/bin/sh
case "$*" in *command=*) printf '%s\\n' '/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao daemon';; *ppid=*) printf '1\\n';; *) exit 1;; esac
`
		: `#!/bin/bash
pid="\${@: -1}"
command='zsh'
if [[ "$pid" == 4242 && -n '${fixtureCommands[pgrepMode] ?? ""}' ]]; then command="$APPS_DIR/Agent Orchestrator.app/${fixtureCommands[pgrepMode] ?? ""}"; fi
case "$*" in
  *pid=*ppid=*lstart=*command=*) printf '%s 1 Mon Oct 12 00:00:00 2026 %s\\n' "$pid" "$command" ;;
  *command=*) printf '%s\\n' "$command" ;;
  *lstart=*) printf 'Mon Oct 12 00:00:00 2026\\n' ;;
  *ppid=*) printf '1\\n' ;;
  *) exit 1 ;;
esac
`;
	await writeFile(path.join(bin, "ps"), ps, { mode: 0o755 });
	return bin;
}

function installEnv({ home, appsDir, aoHome, handlerPlist, bin, extra = {} }) {
	return {
		HOME: home,
		APPS_DIR: appsDir,
		AO_HOME: aoHome,
		LS_SERVICES_PLIST: handlerPlist,
		PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		// Hermetic: never look at the real machine's port 3001 unless a test installs a fake lsof.
		NOETAXIS_LSOF: path.join(bin, "no-lsof"),
		...extra,
	};
}

async function allFiles(root) {
	const result = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...(await allFiles(file)));
		else result.push(file);
	}
	return result;
}

test("build metadata pins Multica, restricts npm, and stamps the selected revision", () => {
	const pin = parseMulticaPin(`module example/backend\nreplace github.com/multica-ai/multica/server => github.com/amolodyh-hyland/multica/server v0.0.0-20261007172956-730184d835ff\n`);
	assert.deepEqual(pin, {
		repository: "github.com/amolodyh-hyland/multica",
		version: "v0.0.0-20261007172956-730184d835ff",
		shortRevision: "730184d835ff",
	});
	assert.equal(stampVersion("0.13.4", revision), version);
	assert.equal(validateRegistry(registry), registry);
	assert.throws(() => validateRegistry("https://registry.npmjs.org"), /public registries are blocked/);
});

function setBuildEnv(t, values) {
	for (const [key, value] of Object.entries(values)) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
}

test("registry selection keeps ProGet as the default and requires explicit public opt-in", (t) => {
	setBuildEnv(t, { NOETAXIS_NPM_REGISTRY: undefined });
	assert.deepEqual(parseArgs([]), { ref: "HEAD", baseVersion: "0.13.4", registry });
	assert.equal(validateRegistry(`${registry}/`), registry);
	const publicUrl = "https://registry.npmjs.org/";
	assert.deepEqual(parseArgs(["--public-registry"]), { ref: "HEAD", baseVersion: "0.13.4", registry: publicUrl, publicRegistry: true });
	assert.equal(validateRegistry(publicUrl, true), publicUrl);
	assert.equal(validateRegistry(publicUrl.slice(0, -1), true), publicUrl);
	process.env.NOETAXIS_NPM_REGISTRY = publicUrl;
	assert.throws(() => validateRegistry(parseArgs([]).registry), /public registries are blocked/);
	process.env.NOETAXIS_NPM_REGISTRY = registry;
	assert.equal(parseArgs(["--public-registry"]).registry, publicUrl);
	for (const args of [["--registry", publicUrl, "--public-registry"], ["--public-registry", "--registry", publicUrl]]) assert.equal(validateRegistry(parseArgs(args).registry, true), publicUrl);
	assert.throws(() => validateRegistry(parseArgs(["--public-registry", "--registry", registry]).registry, true), /requires https/);
});

test("registry validation rejects all other endpoints and URL decorations in either mode", () => {
	for (const url of ["http://registry.npmjs.org/", "https://registry.yarnpkg.com/", "https://example.com/", "not a URL", "https://registry.npmjs.org.evil/", "https://registry.npmjs.org/path", "https://registry.npmjs.org:8443/", "https://registry.npmjs.org:443/", "https://user:password@registry.npmjs.org/", "https://registry.npmjs.org/?token=x", "https://registry.npmjs.org/#x", "https://registry.npmjs.org/?", "https://registry.npmjs.org/#", `${registry}?token=x`, `${registry}#x`, "https://user:password@proget.onbase.net/npm/npm", "https://proget.onbase.net:8443/npm/npm"]) {
		for (const optIn of [false, true]) assert.throws(() => validateRegistry(url, optIn), /[Rr]egistry/);
	}
});

test("build help describes the two modes without running the build", () => {
	const help = execute(process.execPath, [path.join(scriptDir, "noetaxis-macos/build.mjs"), "--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--public-registry/);
	assert.match(help.stdout, /Default: https:\/\/proget\.onbase\.net\/npm\/npm/);
	assert.match(help.stdout, /https:\/\/registry\.npmjs\.org\//);
});

test("default build preserves ProGet commands, lock routing, environment, and metadata", async (t) => {
	setBuildEnv(t, { NOETAXIS_NPM_REGISTRY: undefined, COREPACK_INTEGRITY_KEYS: undefined });
	const f = await makeBuildFixture(t);
	await f.run();
	const steps = f.calls.filter(({ command, args }) => ["npm", "corepack"].includes(command) && args[0] !== "--version" && !args.includes("config"));
	assert.equal(steps.length, 9);
	assert.deepEqual(steps.slice(0, 3).map(({ args }) => args[0]), ["ci", "ci", "pack"]);
	const defaultEnv = {
		...process.env,
		npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry,
		npm_config_replace_registry_host: "npmjs", NPM_CONFIG_REPLACE_REGISTRY_HOST: "npmjs",
		npm_config_loglevel: "error", NPM_CONFIG_LOGLEVEL: "error", COREPACK_NPM_REGISTRY: registry,
	};
	for (const step of steps) {
		const scoped = step.command === "corepack" ? { "npm_config_@jsr:registry": registry } : {};
		const extra = step.args.includes("install") ? { COREPACK_INTEGRITY_KEYS: "0" } : step.args[0] === "run" ? {
			CGO_ENABLED: "1", AO_MULTICA_DESKTOP_OUT: path.join(step.options.env.AO_SCRATCH_SWIFT_CACHE, "../multica/apps/desktop/out"),
			AO_RELEASE_REPO: "amolodyh-hyland/agent-orchestrator", AO_SCRATCH_SWIFT_CACHE: step.options.env.AO_SCRATCH_SWIFT_CACHE,
			AO_AGENT_BROWSER_LICENSE_DIR: path.join(step.options.env.AO_SCRATCH_SWIFT_CACHE, "../agent-browser-licenses"),
		} : {};
		assert.deepEqual(step.options.env, { ...defaultEnv, ...scoped, ...extra });
		assert.equal(step.options.env.npm_config_registry, registry);
		assert.equal(step.options.env.NPM_CONFIG_REGISTRY, registry);
		assert.equal(step.options.env.COREPACK_NPM_REGISTRY, registry);
		assert.equal(step.options.env.npm_config_replace_registry_host, "npmjs");
		if (step.args[0] === "ci") assert.deepEqual(step.args, ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", "npmjs"]);
		for (const [file, contents] of Object.entries(step.snapshot)) {
			if (file.endsWith(".npmrc")) assert.match(contents, /@company:registry=/);
			if (file.endsWith("pnpm-lock.yaml")) assert.match(contents, /https:\/\/proget\.onbase\.net\/npm\/npm\/example/);
		}
		assert.equal(step.options.env.COREPACK_INTEGRITY_KEYS, step.args.includes("install") ? "0" : undefined);
	}
	assert.deepEqual(steps.filter(({ command }) => command === "corepack").map(({ args }) => args), [
		["pnpm@10.28.2", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`],
		["pnpm@10.28.2", "--filter", "@multica/desktop", "exec", "electron-vite", "build"],
	]);
	assert.deepEqual(steps.filter(({ args }) => args[0] === "run").map(({ args }) => args), [["run", "build:daemon"], ["run", "build:tmux"], ["run", "browser-runtime:prepare"], ["run", "build:acp-runtime"]]);
	assert.match(await readFile(path.join(f.root, "output/BUILD-INFO.txt"), "utf8"), /^Registry: proget\.onbase\.net$/m);
});

test("public opt-in reaches every build step and isolates credentials and lockfile hosts", async (t) => {
	setBuildEnv(t, { NOETAXIS_NPM_REGISTRY: registry, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry, npm_config__auth: "fixture-secret", NPM_CONFIG_USERCONFIG: "/must-not-read-company-config", npm_config_userconfig: "/must-not-read-company-config", COREPACK_NPM_REGISTRY: registry, COREPACK_NPM_TOKEN: "fixture-secret", COREPACK_INTEGRITY_KEYS: "0", COREPACK_ENV_FILE: "/must-not-read-company-env", NPM_TOKEN: "fixture-secret", NPM_AUTH_TOKEN: "fixture-secret", NODE_AUTH_TOKEN: "fixture-secret" });
	const f = await makeBuildFixture(t, { lockRegistry: `${registry}/` });
	await f.run(["--public-registry"]);
	const steps = f.calls.filter(({ command, args }) => !args.includes("config") && (["npm", "corepack"].includes(command) || command.endsWith("/electron-forge")));
	assert.equal(steps.length, 11);
	for (const step of steps) {
		const env = step.options.env;
		assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
		assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
		assert.equal(env.COREPACK_NPM_REGISTRY, "https://registry.npmjs.org");
		assert.equal(env.COREPACK_ENABLE_ENV_FILE, "0");
		assert.equal(env.npm_config_replace_registry_host, "always");
		for (const key of ["COREPACK_NPM_TOKEN", "COREPACK_INTEGRITY_KEYS", "COREPACK_ENV_FILE", "NPM_TOKEN", "NPM_AUTH_TOKEN", "NODE_AUTH_TOKEN", "npm_config__auth"]) assert.equal(env[key], undefined, key);
		assert.deepEqual(Object.values(step.configs), ["", ""]);
		assert.equal(env.npm_config_userconfig, env.NPM_CONFIG_USERCONFIG);
		assert.equal(env.npm_config_globalconfig, env.NPM_CONFIG_GLOBALCONFIG);
		assert.doesNotMatch(step.args.join(" "), /proget/);
		for (const [file, contents] of Object.entries(step.snapshot)) {
			assert.doesNotMatch(contents, /proget|MISSING_COMPANY_TOKEN/, file);
			assert.match(contents, /https:\/\/registry\.npmjs\.org\//, file);
			if (file.endsWith("pnpm-lock.yaml")) assert.doesNotMatch(contents, /npmjs\.org\/\//);
		}
	}
	const install = steps.find(({ command, args }) => command === "corepack" && args.includes("install"));
	assert.ok(install.args.includes("--registry=https://registry.npmjs.org/"));
	assert.match(Object.values(install.snapshot).join("\n"), /shamefully-hoist=true/);
	for (const step of steps.filter(({ args }) => ["ci", "pack"].includes(args[0]))) {
		assert.equal(step.args[step.args.indexOf("--registry") + 1], "https://registry.npmjs.org/");
		assert.equal(step.args[step.args.indexOf("--replace-registry-host") + 1], "always");
	}
	assert.match(await readFile(path.join(f.root, "output/BUILD-INFO.txt"), "utf8"), /^Registry: registry\.npmjs\.org$/m);
	await assert.rejects(readFile(steps[0].options.env.npm_config_userconfig), { code: "ENOENT" });
});

test("public builds reject unrecognized lockfile downloads without installing them", async (t) => {
	const f = await makeBuildFixture(t, { multicaLock: 'packages:\n  example@1.0.0:\n    resolution: {tarball: https://private.example/npm/example.tgz}\n' });
	await assert.rejects(f.run(["--public-registry"]), /non-public npm download/);
	assert.equal(f.calls.some(({ command }) => command === "corepack"), false);
});

test("public registry failures stop the build without a ProGet retry", async (t) => {
	const f = await makeBuildFixture(t, { failInstall: true });
	await assert.rejects(f.run(["--public-registry"]), /corepack failed/);
	assert.equal(f.calls.filter(({ command, args }) => command === "corepack" && !args.includes("config")).length, 1);
	assert.equal(f.calls.some(({ command, args }) => command === "npm" && args[0] === "run"), false);
});

test("registry preflight rejects scoped npm/env and pnpm overrides without displaying secrets", async (t) => {
	for (const source of ["npmConfig", "pnpmConfig"]) {
		for (const url of ["https://registry.npmjs.org/", "https://other.example/npm/", "https://user:fixture-secret@other.example/npm/?fixture-secret#fixture-secret"]) {
			const f = await makeBuildFixture(t, { [source]: { "@company:registry": url } });
			await assert.rejects(f.run(), (error) => {
				assert.match(error.message, /disallowed registry override.*proget\.onbase\.net/);
				assert.doesNotMatch(error.message, /fixture-secret|other\.example|@company/);
				return true;
			});
			assert.equal(f.calls.some(({ args }) => args.includes("install")), false);
			if (source === "npmConfig") assert.equal(f.calls.some(({ args }) => args[0] === "ci"), false);
		}
	}
	const f = await makeBuildFixture(t, { pnpmConfig: { "registries": { "@company": "https://other.example/" } } });
	await assert.rejects(f.run(["--public-registry"]), /disallowed registry override.*registry\.npmjs\.org/);
});

test("registry configuration checks fail closed on command errors and malformed output", () => {
	for (const source of ['process.stdout.write("fixture-secret"); process.exit(1)', 'process.stdout.write("fixture-secret")', 'process.stdout.write("[]")', 'process.stdout.write("{}")']) {
		assert.throws(() => readRegistryConfiguration(process.execPath, ["-e", source], {}), (error) => {
			assert.match(error.message, /refusing to install dependencies/);
			assert.doesNotMatch(error.message, /fixture-secret/);
			return true;
		});
	}
	assert.doesNotThrow(() => assertRegistryConfiguration({ "@company:registry": `${registry}/`, "//proget.onbase.net/npm/npm/:_authToken": "fixture-secret" }, registry));
});

test("actual pnpm 10.28.2 configuration isolates public mode and rejects foreign scopes in ProGet mode", { skip: !process.env.NOETAXIS_TEST_PNPM_CLI && "Set NOETAXIS_TEST_PNPM_CLI to the pinned pnpm 10.28.2 bin/pnpm.cjs for offline effective-config verification" }, async (t) => {
	const cli = process.env.NOETAXIS_TEST_PNPM_CLI;
	const root = await testRoot(t, "noetaxis-effective-config");
	const home = path.join(root, "home");
	const config = path.join(root, "xdg");
	const userconfig = path.join(root, "user-npmrc");
	const globalconfig = path.join(root, "global-npmrc");
	await mkdir(home, { recursive: true });
	await mkdir(path.join(config, "pnpm"), { recursive: true });
	await writeFile(userconfig, "");
	await writeFile(globalconfig, "");
	setBuildEnv(t, { HOME: home, XDG_CONFIG_HOME: config, PNPM_HOME: path.join(root, "untrusted-pnpm"), npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig, npm_config_globalconfig: globalconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry, NOETAXIS_NPM_REGISTRY: registry, CI: "1", COREPACK_ENABLE_NETWORK: "0" });
	const globalRc = path.join(config, "pnpm/rc");
	await writeFile(globalRc, `@company:registry=${registry}\n//proget.onbase.net/npm/npm/:_authToken=fixture-secret\n`);
	const version = execute(process.execPath, [cli, "--version"], { cwd: root, env: process.env });
	assert.equal(version.status, 0);
	assert.equal(version.stdout.trim(), "10.28.2");
	const baseline = readRegistryConfiguration(process.execPath, [cli, "config", "list", "--json"], { cwd: root, env: process.env });
	assert.equal(baseline["@company:registry"], registry, "the control must demonstrate pnpm independently loading its global rc");
	const f = await makeBuildFixture(t, { configCli: cli });
	await f.run(["--public-registry"]);
	const pnpm = f.calls.find(({ command, args }) => command === "corepack" && args.includes("install"));
	const effective = readRegistryConfiguration(process.execPath, [cli, "config", "list", "--json"], { cwd: root, env: pnpm.options.env });
	assert.equal(effective.registry, "https://registry.npmjs.org/");
	assert.equal(effective["@company:registry"], undefined);
	assert.equal(effective["//proget.onbase.net/npm/npm/:_authToken"], undefined);
	assert.equal(effective["@jsr:registry"], "https://registry.npmjs.org/");
	assert.doesNotThrow(() => assertRegistryConfiguration(effective, "https://registry.npmjs.org/"));
	assert.equal(effective["manage-package-manager-versions"], false);
	assert.equal(effective["ignore-pnpmfile"], true);
	const allowed = await makeBuildFixture(t, { configCli: cli });
	await allowed.run();
	const internalPnpm = allowed.calls.find(({ command, args }) => command === "corepack" && args.includes("install"));
	const internalConfig = readRegistryConfiguration(process.execPath, [cli, "config", "list", "--json"], { cwd: root, env: internalPnpm.options.env });
	assert.equal(internalConfig["@company:registry"], registry);
	assert.equal(internalConfig["//proget.onbase.net/npm/npm/:_authToken"], "fixture-secret");
	assert.equal(internalConfig["@jsr:registry"], registry);
	for (const url of ["https://registry.npmjs.org/", "https://private.example/npm/"]) {
		await writeFile(globalRc, `@company:registry=${url}\n//private.example/:_authToken=fixture-secret\n`);
		const blocked = await makeBuildFixture(t, { configCli: cli });
		await assert.rejects(blocked.run(), (error) => { assert.match(error.message, /disallowed registry override/); assert.doesNotMatch(error.message, /fixture-secret|private\.example/); return true; });
		assert.equal(blocked.calls.some(({ args }) => args.includes("install")), false);
	}
	await writeFile(globalRc, "");
	for (const npmrc of [userconfig, globalconfig]) {
		await writeFile(npmrc, "@foreign:registry=https://private.example/\n//private.example/:_authToken=fixture-secret\n");
		const blocked = await makeBuildFixture(t, { configCli: cli });
		await assert.rejects(blocked.run(), /disallowed registry override/);
		assert.equal(blocked.calls.some(({ args }) => args[0] === "ci"), false);
		await writeFile(npmrc, "");
	}
	const projectBlocked = await makeBuildFixture(t, { configCli: cli });
	await writeFile(path.join(projectBlocked.source, "frontend/.npmrc"), "@foreign:registry=https://private.example/\n");
	await assert.rejects(projectBlocked.run(), /disallowed registry override/);
	assert.equal(projectBlocked.calls.some(({ args }) => args[0] === "ci"), false);
	process.env["npm_config_@company:registry"] = "https://private.example/";
	t.after(() => { delete process.env["npm_config_@company:registry"]; });
	const envBlocked = await makeBuildFixture(t, { configCli: cli });
	await assert.rejects(envBlocked.run(), /disallowed registry override/);
	assert.equal(envBlocked.calls.some(({ args }) => args[0] === "ci"), false);
	await writeFile(globalRc, "@foreign:registry=https://private.example/\n//private.example/:_authToken=fixture-secret\n");
	const publicExternal = await makeBuildFixture(t, { configCli: cli });
	await publicExternal.run(["--public-registry"]);
});

test("agent-browser license files copy byte-for-byte from the internal package", async (t) => {
	const root = await testRoot(t, "noetaxis-license-test");
	const source = path.join(root, "source");
	const output = path.join(root, "output");
	await mkdir(source, { recursive: true });
	await mkdir(output, { recursive: true });
	const files = ["LICENSE-agent-browser", "LICENSE-axe-core", "LICENSE-axe-core-THIRD-PARTY"];
	for (const [index, name] of files.entries()) await writeFile(path.join(source, name), Buffer.from(`license-${index}\n\n`));
	await copyAgentBrowserLicenses(source, output);
	for (const name of files) assert.deepEqual(await readFile(path.join(output, name)), await readFile(path.join(source, name)));
});

test("install guard blocks inherited AO environment and daemon ancestry", async (t) => {
	const root = await testRoot(t, "noetaxis-guard-test");
	const home = path.join(root, "home");
	const appsDir = path.join(root, "Applications");
	const aoHome = path.join(home, ".ao");
	const artifactDir = path.join(root, "build");
	const appPath = path.join(artifactDir, "Applications/Agent Orchestrator.app");
	await mkdir(path.dirname(appPath), { recursive: true });
	await mkdir(appsDir, { recursive: true });
	await mkdir(home, { recursive: true });
	await makeApp(appPath, version, revision);
	await writeManifest(appPath, path.join(artifactDir, "MANIFEST.sha256"));
	const handlerPlist = await makeHandlerFixture(home);
	// AO_HOME itself would trip the environment check, so these runs rely on the default ~/.ao.
	const guardEnv = (bin) => {
		const { AO_HOME, ...env } = installEnv({ home, appsDir, aoHome, handlerPlist, bin });
		return env;
	};
	const plainEnv = guardEnv(await makeFakeBin(root, "idle", "plain"));
	const dryRun = (env) => execute("/bin/bash", [installScript, "--dry-run", appPath], { cwd: repoRoot, env });
	const control = dryRun(plainEnv);
	assert.equal(control.status, 0, control.stderr);
	const session = dryRun({ ...plainEnv, AO_SESSION_ID: "fixture-session" });
	assert.equal(session.status, 20, session.stderr);
	assert.match(session.stderr, /inherited Agent Orchestrator environment/);
	const ancestry = dryRun(guardEnv(await makeFakeBin(root, "idle", "ao-ancestor")));
	assert.equal(ancestry.status, 20, ancestry.stderr);
	assert.match(ancestry.stderr, /running inside Agent Orchestrator/);
	const wrapped = dryRun(guardEnv(await makeFakeBin(root, "idle", "wrapped-ancestor")));
	assert.equal(wrapped.status, 20, wrapped.stderr);
	assert.match(wrapped.stderr, /running inside Agent Orchestrator/);
	assert.equal(await readdir(appsDir).then((entries) => entries.length), 0);
	for (const [mode, limit] of [["chain", 140], ["cycle", 12]]) {
		const bin = await makeFakeBin(root, "idle", mode);
		const bounded = dryRun(guardEnv(bin));
		assert.equal(bounded.status, 0, bounded.stderr);
		const calls = (await readFile(path.join(bin, "ps-calls"), "utf8")).trim().split("\n").length;
		assert.ok(calls > 2 && calls <= limit, `${mode} walk made ${calls} ps calls`);
	}
});

test("isolated install is dry-runnable, backed up, idempotent, and reversible", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-install-test");
	const home = path.join(root, "home");
	const aoHome = path.join(home, ".ao");
	const appsDir = path.join(root, "Applications");
	const artifactDir = path.join(root, "build");
	const sourceApp = path.join(artifactDir, "Applications/Agent Orchestrator.app");
	const targetApp = path.join(appsDir, "Agent Orchestrator.app");
	await mkdir(path.dirname(sourceApp), { recursive: true });
	await mkdir(path.join(aoHome, "data"), { recursive: true });
	await mkdir(appsDir, { recursive: true });
	await makeApp(sourceApp, version, revision);
	await writeManifest(sourceApp, path.join(artifactDir, "MANIFEST.sha256"));
	await makeApp(targetApp, "0.13.4");
	const database = path.join(aoHome, "data/ao.db");
	const schema = execute("/usr/bin/sqlite3", [database, "create table goose_db_version (version_id integer, is_applied integer); insert into goose_db_version values (190,1);"]);
	assert.equal(schema.status, 0, schema.stderr);
	for (const name of ["app-state.json", "update-settings.json", "editor-settings.json"]) await writeFile(path.join(aoHome, name), name);
	const handlerPlist = await makeHandlerFixture(home);
	const idleBin = await makeFakeBin(root);
	const env = installEnv({ home, appsDir, aoHome, handlerPlist, bin: idleBin });
	const dryRun = execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", sourceApp], { cwd: repoRoot, env });
	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.equal(await readFile(path.join(targetApp, "Contents/Info.plist"), "utf8").then((text) => text.includes("0.13.4")), true);
	assert.equal(await readdir(path.join(home, "ao-backups")).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)).then((entries) => entries.length), 0);
	const busyBin = await makeFakeBin(root, "busy");
	const busy = execute("/bin/bash", [installScript, "--allow-ao-session", sourceApp], { cwd: repoRoot, env: installEnv({ home, appsDir, aoHome, handlerPlist, bin: busyBin }) });
	assert.equal(busy.status, 21, busy.stderr);
	assert.equal(await readFile(path.join(targetApp, "Contents/Info.plist"), "utf8").then((text) => text.includes("0.13.4")), true);
	const installed = execute("/bin/bash", [installScript, "--allow-ao-session", sourceApp], { cwd: repoRoot, env });
	assert.equal(installed.status, 0, installed.stderr);
	assert.match(installed.stdout, /ao-app:\/\/ handler: registered/);
	assert.match(installed.stdout, /--effort/);
	assert.match(installed.stdout, /--permission-fallback/);
	assert.match(installed.stdout, /SQLite schema version: 190/);
	assert.equal(await readFile(path.join(targetApp, "Contents/Info.plist"), "utf8").then((text) => text.includes(version)), true);
	const backupRoot = path.join(home, "ao-backups");
	let backups = (await readdir(backupRoot)).map((name) => path.join(backupRoot, name));
	assert.equal(backups.length, 1);
	let backupDir = backups[0];
	assert.ok((await readdir(backupDir)).some((name) => name.endsWith(".app.bak")));
	for (const name of ["app-state.json", "update-settings.json", "editor-settings.json"]) assert.equal(await readFile(path.join(backupDir, name), "utf8"), name);
	assert.equal(execute("/usr/bin/sqlite3", [path.join(backupDir, "data/ao.db"), "select max(version_id) from goose_db_version where is_applied=1;"]).stdout.trim(), "190");
	const repeatedInstall = execute("/bin/bash", [installScript, "--allow-ao-session", sourceApp], { cwd: repoRoot, env });
	assert.equal(repeatedInstall.status, 0, repeatedInstall.stderr);
	assert.match(repeatedInstall.stdout, /Already installed/);
	assert.equal((await readdir(backupRoot)).length, 1);
	const firstRollback = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--backup-dir", backupDir], { cwd: repoRoot, env });
	assert.equal(firstRollback.status, 0, firstRollback.stderr);
	assert.match(firstRollback.stdout, /Restored app version: 0\.13\.4/);
	assert.equal(await readFile(path.join(targetApp, "Contents/Info.plist"), "utf8").then((text) => text.includes("0.13.4")), true);
	assert.equal(execute("/usr/bin/sqlite3", [database, "delete from goose_db_version; insert into goose_db_version values (999,1);"] ).status, 0);
	const secondInstall = execute("/bin/bash", [installScript, "--allow-ao-session", sourceApp], { cwd: repoRoot, env });
	assert.equal(secondInstall.status, 0, secondInstall.stderr);
	backups = (await readdir(backupRoot)).map((name) => path.join(backupRoot, name)).sort();
	backupDir = backups.at(-1);
	assert.equal(execute("/usr/bin/sqlite3", [database, "delete from goose_db_version; insert into goose_db_version values (888,1);"] ).status, 0);
	const databaseRollback = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--restore-db", "--backup-dir", backupDir], { cwd: repoRoot, env });
	assert.equal(databaseRollback.status, 0, databaseRollback.stderr);
	assert.equal(execute("/usr/bin/sqlite3", [database, "select max(version_id) from goose_db_version where is_applied=1;"]).stdout.trim(), "999");
	const savedDirs = async () => (await readdir(backupDir)).filter((name) => name.startsWith("rollback-current-data-")).sort();
	const firstSaved = await savedDirs();
	assert.equal(firstSaved.length, 1);
	const savedVersion = (name) => execute("/usr/bin/sqlite3", [path.join(backupDir, name, "ao.db"), "select max(version_id) from goose_db_version where is_applied=1;"]).stdout.trim();
	assert.equal(savedVersion(firstSaved[0]), "888");
	assert.equal(execute("/usr/bin/sqlite3", [database, "delete from goose_db_version; insert into goose_db_version values (777,1);"]).status, 0);
	const repeatedRollback = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--restore-db", "--backup-dir", backupDir], { cwd: repoRoot, env });
	assert.equal(repeatedRollback.status, 0, repeatedRollback.stderr);
	const allSaved = await savedDirs();
	assert.equal(allSaved.length, 2);
	assert.equal(savedVersion(firstSaved[0]), "888");
	assert.deepEqual(allSaved.filter((name) => name !== firstSaved[0]).map(savedVersion), ["777"]);
});

test("install explains which part of AO is still running and never stops a process", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-background-test");
	await makeApp(f.targetApp, "0.13.4");
	const cli = `${f.targetApp}/Contents/Resources/daemon/ao`;
	const attempt = async (mode, args) => {
		const bin = await makeFakeBin(f.root, mode);
		const env = { ...f.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
		const result = execute("/bin/bash", [installScript, "--allow-ao-session", ...args, f.sourceApp], { cwd: repoRoot, env });
		const killed = await readFile(path.join(bin, "kill-calls"), "utf8").catch(() => "");
		assert.equal(killed, "", `${mode} must not stop any process`);
		return result;
	};
	const desktop = await attempt("desktop", ["--dry-run"]);
	assert.equal(desktop.status, 21, desktop.stderr);
	assert.match(desktop.stderr, /desktop app is still running/);
	assert.match(desktop.stderr, /Cmd\+Q only close its window/);
	assert.match(desktop.stderr, /"Quit AO Completely"/);
	assert.match(desktop.stderr, /pid 4242/);
	const daemon = await attempt("daemon", ["--dry-run"]);
	assert.equal(daemon.status, 21, daemon.stderr);
	assert.match(daemon.stderr, /AO daemon is still running/);
	assert.ok(daemon.stderr.includes(`"${cli}" stop`), daemon.stderr);
	assert.match(daemon.stderr, /--allow-background-processes/);
	assert.match(daemon.stderr, /ends the work of every active session/);
	assert.match(daemon.stderr, /chat hosts keep running until their sessions are ended separately/);
	const chatHost = await attempt("chat-host", ["--dry-run"]);
	assert.equal(chatHost.status, 21, chatHost.stderr);
	assert.match(chatHost.stderr, /chat host processes are still running/);
	assert.match(chatHost.stderr, /survive both .* and "ao stop"/);
	assert.match(chatHost.stderr, /PKG installer has no override/);
	assert.ok(chatHost.stderr.includes(`"${cli}" session ls`), chatHost.stderr);
	assert.match(chatHost.stderr, /reopen AO.*let their turns finish or end them yourself.*quit completely again/);
	const other = await attempt("other", ["--dry-run"]);
	assert.equal(other.status, 21, other.stderr);
	assert.match(other.stderr, /helper processes are still running/);
	for (const mode of ["daemon", "chat-host", "other"]) {
		const allowed = await attempt(mode, ["--dry-run", "--allow-background-processes"]);
		assert.equal(allowed.status, 0, `${mode}: ${allowed.stderr}`);
		assert.match(allowed.stderr, /continuing with .* still running .* --allow-background-processes/i);
	}
	// The flag never reaches the desktop app or ShipIt.
	assert.equal((await attempt("desktop", ["--dry-run", "--allow-background-processes"])).status, 21);
	assert.equal((await attempt("shipit", ["--dry-run", "--allow-background-processes"])).status, 22);
	assert.equal(await installedVersion(f.targetApp), "old");
	// A real install with only the daemon left refuses without the flag and swaps with it.
	assert.equal((await attempt("daemon", [])).status, 21);
	assert.equal(await installedVersion(f.targetApp), "old");
	const installed = await attempt("daemon", ["--allow-background-processes"]);
	assert.equal(installed.status, 0, installed.stderr);
	assert.equal(await installedVersion(f.targetApp), "new");
	// The pgrep patterns are pinned: each part of AO is looked up by its exact, regex-escaped bundle path.
	const escape = (text) => text.replace(/[\][\\.*^$(){}?+|]/g, "\\$&");
	const pgrepArgs = async (mode) => (await readFile(path.join(f.root, `bin-${mode}-plain`, "pgrep-calls"), "utf8")).trim().split("\n");
	const desktopCalls = await pgrepArgs("desktop");
	assert.ok(desktopCalls.includes(`-if ${escape(`${f.targetApp}/Contents/MacOS/`)}`), desktopCalls.join("\n"));
	assert.ok((await pgrepArgs("daemon")).includes(`-if ${escape(`${cli} daemon`)}`));
	assert.ok((await pgrepArgs("chat-host")).includes(`-if ${escape(`${cli} chat-host`)}`));
	assert.ok((await pgrepArgs("other")).includes(`-if ${escape(`${f.targetApp}/Contents/`)}`));
	// The bundled ao CLI is only ever named in messages, never run with stop.
	for (const app of [f.targetApp]) {
		assert.equal(await readFile(path.join(app, "Contents/Resources/daemon/ao-stop-calls"), "utf8").catch(() => ""), "");
	}
	// The flagged install is recorded for audit; an unflagged install is not marked.
	const backupRoot = path.join(f.home, "ao-backups");
	const records = await Promise.all((await readdir(backupRoot)).map((name) => readFile(path.join(backupRoot, name, "BACKUP_COMPLETE"), "utf8")));
	assert.equal(records.length, 1);
	assert.match(records[0], /^allow_background_processes=1$/m);
});

test("the install tooling never runs kill, pkill, killall or the bundled ao stop", async () => {
	// Builtins and absolute paths bypass a PATH shim, so check the code itself: no line outside
	// comments, messages and help text may execute them.
	const files = ["common.sh", "install.sh", "rollback.sh", "pkg-scripts/preinstall", "pkg-scripts/postinstall"];
	for (const file of files) {
		const lines = (await readFile(path.join(scriptDir, "noetaxis-macos", file), "utf8")).split("\n");
		let inHeredoc = false;
		// noetaxis_bounded is the one documented exception: the watchdog of the script's own helper
		// commands (see noetaxis-macos-update.node-test.mjs, which pins exactly what it may signal).
		let inWatchdog = false;
		lines.forEach((line, index) => {
			if (/^noetaxis_bounded\(\) \{/.test(line)) inWatchdog = true;
			else if (inWatchdog && line === "}") { inWatchdog = false; return; }
			if (inWatchdog) return;
			if (/<<'?EOF'?$/.test(line)) inHeredoc = true;
			else if (line === "EOF") inHeredoc = false;
			const code = line.trim();
			// Only pure messages are skipped: a message line that pipes, chains or substitutes commands is checked.
			const outsideQuotes = code.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
			const pureMessage = /^(noetaxis_error|printf|echo)\b/.test(code) && !/[|;`]|&&|\$\(/.test(outsideQuotes);
			if (inHeredoc || code.startsWith("#") || pureMessage) return;
			const where = `${file}:${index + 1}: ${code}`;
			assert.doesNotMatch(code, /(^|[\s;|&(`$]|\/)(kill|pkill|killall)(\s|$)/, where);
			assert.doesNotMatch(code, /["']?\$(\{?cli\}?|\{?app_path\}?\/[^\s"']*ao)["']?\s+stop\b/, where);
			assert.doesNotMatch(code, /\bao\s+stop\b/, where);
			// Quitting by script (AppleScript, launchctl, open -a ... quit) is also a way to stop AO.
			assert.doesNotMatch(code, /(^|[\s;|&(`$]|\/)(osascript|launchctl)(\s|$)/, where);
			assert.doesNotMatch(code, /tell application|\bto quit\b|\bterminate\b|SIGTERM|SIGKILL/i, where);
		});
	}
});

test("a port 3001 listener with no bundle process is only a warning, and an AO daemon from another bundle path does not block", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-port-test");
	await makeApp(f.targetApp, "0.13.4");
	const lsof = path.join(f.root, "fake-lsof");
	await writeFile(lsof, "#!/bin/sh\necho \"$*\" > \"$(dirname \"$0\")/lsof-calls\"\nprintf 'p9876\\n'\n", { mode: 0o755 });
	const env = { ...f.env, NOETAXIS_LSOF: lsof };
	const result = execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /listening on port 3001 \(pid 9876\)/);
	assert.match(result.stderr, /Nothing is stopped for you/);
	assert.match(await readFile(path.join(f.root, "lsof-calls"), "utf8"), /-iTCP:3001 -sTCP:LISTEN/);
	// With no listener the run is silent.
	await writeFile(lsof, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const quiet = execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env });
	assert.equal(quiet.status, 0, quiet.stderr);
	assert.doesNotMatch(quiet.stderr, /listening on port/);
	// A daemon from a different bundle (a backup copy or another install) must not block this one.
	const otherApp = path.join(f.root, "Elsewhere/Agent Orchestrator.app");
	const runner = path.join(otherApp, "Contents/Resources/daemon/ao");
	await mkdir(path.dirname(runner), { recursive: true });
	await writeFile(runner, '#!/bin/sh\nwhile [ -e "$NOETAXIS_FIXTURE_ROOT/.fixture-alive" ]; do /bin/sleep 0.1; done\n', { mode: 0o755 });
	spawn("/bin/sh", [runner, "daemon"], { stdio: "ignore", detached: true });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const realEnv = { ...env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
	const other = execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env: realEnv });
	assert.equal(other.status, 0, `a daemon from another bundle path must not block: ${other.stderr}`);
	// Neither does one running from a moved backup copy under ~/ao-backups; only the port warning can see it.
	const backupApp = path.join(f.home, "ao-backups/20261010-000000/Agent Orchestrator-0.13.4-20261010-000000-1.app.bak");
	const backupRunner = path.join(backupApp, "Contents/Resources/daemon/ao");
	await mkdir(path.dirname(backupRunner), { recursive: true });
	await writeFile(backupRunner, '#!/bin/sh\nwhile [ -e "$NOETAXIS_FIXTURE_ROOT/.fixture-alive" ]; do /bin/sleep 0.1; done\n', { mode: 0o755 });
	spawn("/bin/sh", [backupRunner, "daemon"], { stdio: "ignore", detached: true });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await writeFile(lsof, "#!/bin/sh\nprintf 'p9876\\n'\n", { mode: 0o755 });
	const fromBackup = execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env: { ...realEnv, NOETAXIS_LSOF: lsof } });
	assert.equal(fromBackup.status, 0, `a daemon from a backup path must not be mistaken for the target app: ${fromBackup.stderr}`);
	assert.match(fromBackup.stderr, /listening on port 3001/);
});

test("process lookup matches a bundle path literally even when it contains regex metacharacters", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-regex-test");
	const weirdApps = path.join(f.root, "Parent/Contents/Apps (v1)+[x]");
	const weirdApp = path.join(weirdApps, "Agent Orchestrator.app");
	await mkdir(weirdApps, { recursive: true });
	await makeApp(weirdApp, "0.13.4");
	const lookalike = path.join(weirdApps, "Agent OrchestratorXapp");
	const bin = f.env.PATH.split(":")[0];
	const commandFile = path.join(bin, "process-command");
	await writeFile(path.join(bin, "pgrep"), `#!/bin/bash
pattern="\${@: -1}"
if /usr/bin/grep -Eq -- "$pattern" "$(dirname "$0")/process-command"; then printf '4242\\n'; else exit 1; fi
`, { mode: 0o755 });
	await writeFile(path.join(bin, "ps"), `#!/bin/bash
pid="\${@: -1}"
command="$(cat "$(dirname "$0")/process-command")"
case "$*" in
  *pid=*ppid=*lstart=*command=*) printf '%s 1 Mon Oct 12 00:00:00 2026 %s\\n' "$pid" "$command" ;;
  *command=*) printf '%s\\n' "$command" ;;
  *lstart=*) printf 'Mon Oct 12 00:00:00 2026\\n' ;;
  *ppid=*) printf '1\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
	await writeFile(path.join(bin, "executables"), "4242|<APP>/Contents/Resources/daemon/ao\n*|/bin/bash\n");
	const env = { ...f.env, APPS_DIR: weirdApps };
	const dryRun = () => execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env });
	await writeFile(commandFile, `${lookalike}/Contents/Resources/daemon/ao daemon\n`);
	assert.equal(dryRun().status, 0, "a lookalike path must not count as the installed app");
	const runner = `${weirdApp}/Contents/Resources/daemon/ao`;
	await writeFile(commandFile, `${runner} daemon\n`);
	const refused = dryRun();
	assert.equal(refused.status, 21, `a real process under a path with metacharacters must be found: ${refused.stderr}`);
	assert.match(refused.stderr, /still running/);
	assert.ok(runner.startsWith(weirdApp));
});

test("rollback and the PKG preinstall apply the same background-process preflight", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-background-rollback-test");
	await makeApp(f.targetApp, "0.13.4");
	const installed = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
	assert.equal(installed.status, 0, installed.stderr);
	const daemonBin = await makeFakeBin(f.root, "daemon");
	const env = { ...f.env, PATH: `${daemonBin}:/usr/bin:/bin:/usr/sbin:/sbin` };
	const refused = execute("/bin/bash", [rollbackScript, "--allow-ao-session"], { cwd: repoRoot, env });
	assert.equal(refused.status, 21, refused.stderr);
	assert.match(refused.stderr, /AO daemon is still running/);
	assert.equal(await installedVersion(f.targetApp), "new");
	// --restore-db is never covered by the flag while a daemon holds the database.
	const database = path.join(f.aoHome, "data/ao.db");
	await writeFile(database, "live");
	const restoreRefused = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--allow-background-processes", "--restore-db"], { cwd: repoRoot, env });
	assert.equal(restoreRefused.status, 21, restoreRefused.stderr);
	assert.match(restoreRefused.stderr, /--restore-db cannot run while the AO daemon is running/);
	assert.equal(await readFile(database, "utf8"), "live");
	assert.equal(await installedVersion(f.targetApp), "new");
	const allowed = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--allow-background-processes"], { cwd: repoRoot, env });
	assert.equal(allowed.status, 0, allowed.stderr);
	assert.equal(await installedVersion(f.targetApp), "old");
	// A daemon from an earlier flagged install is invisible to the process check; its port listener still blocks --restore-db.
	const lsof = path.join(f.root, "fake-lsof");
	await writeFile(lsof, "#!/bin/sh\nprintf 'p9876\\n'\n", { mode: 0o755 });
	const idleBin = await makeFakeBin(f.root);
	const listenerEnv = { ...f.env, PATH: `${idleBin}:/usr/bin:/bin:/usr/sbin:/sbin`, NOETAXIS_LSOF: lsof };
	await writeFile(database, "live");
	const portRefused = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--restore-db"], { cwd: repoRoot, env: listenerEnv });
	assert.equal(portRefused.status, 21, portRefused.stderr);
	assert.match(portRefused.stderr, /--restore-db cannot run while something listens on port 3001 \(pid 9876\)/);
	assert.equal(await readFile(database, "utf8"), "live");
	const portAppOnly = execute("/bin/bash", [rollbackScript, "--allow-ao-session"], { cwd: repoRoot, env: listenerEnv });
	assert.equal(portAppOnly.status, 0, portAppOnly.stderr);
	const desktopBin = await makeFakeBin(f.root, "desktop");
	const desktop = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--allow-background-processes"], { cwd: repoRoot, env: { ...f.env, PATH: `${desktopBin}:/usr/bin:/bin:/usr/sbin:/sbin` } });
	assert.equal(desktop.status, 21, desktop.stderr);
	// The PKG preinstall has no flag: a surviving daemon always stops it before anything is backed up.
	const preinstall = path.join(fakeScriptsDir, "pkg-scripts/preinstall");
	const packaged = path.join(f.root, "pkg-scripts");
	await mkdir(packaged, { recursive: true });
	await cp(preinstall, path.join(packaged, "preinstall"));
	await cp(path.join(fakeScriptsDir, "common.sh"), path.join(packaged, "common.sh"));
	delete env.AO_HOME;
	const pkg = execute("/bin/bash", [path.join(packaged, "preinstall")], { cwd: repoRoot, env });
	assert.equal(pkg.status, 21, pkg.stderr);
	assert.match(pkg.stderr, /Resources\/daemon\/ao" stop/);
	assert.equal(await installedVersion(f.targetApp), "old");
});

test("schema check reads a WAL database that has no -wal/-shm files and never fails", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-schema-test");
	const dataDir = path.join(root, "data");
	await mkdir(dataDir);
	const database = path.join(dataDir, "ao.db");
	const setup = execute("/usr/bin/sqlite3", [database, "pragma journal_mode=wal; create table goose_db_version (version_id integer, is_applied integer); insert into goose_db_version values (190,1);"]);
	assert.equal(setup.status, 0, setup.stderr);
	await rm(`${database}-wal`, { force: true });
	await rm(`${database}-shm`, { force: true });
	const check = (target) => execute("/bin/bash", ["-c", 'source "$1"; noetaxis_print_schema_version "$2"', "check", path.join(scriptDir, "noetaxis-macos/common.sh"), target], { env: { ...process.env, TMPDIR: root } });
	const readable = check(database);
	assert.equal(readable.status, 0, readable.stderr);
	assert.match(readable.stdout, /SQLite schema version: 190/);
	assert.deepEqual((await readdir(dataDir)).sort(), ["ao.db"]);
	const unreadable = check(path.join(root, "missing.db"));
	assert.equal(unreadable.status, 0, unreadable.stderr);
	assert.match(unreadable.stdout, /could not be read/);
});

test("install refuses to run as root without a console user", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-root-test");
	const bin = path.join(root, "bin");
	await mkdir(bin, { recursive: true });
	await writeFile(path.join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
	const check = execute("/bin/bash", ["-c", 'source "$1"; noetaxis_require_human_user', "check", path.join(scriptDir, "noetaxis-macos/common.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUDO_USER: "root", USER: "root" } });
	assert.equal(check.status, 29);
	assert.match(check.stderr, /without a console user/);
	const human = execute("/bin/bash", ["-c", 'source "$1"; noetaxis_require_human_user', "check", path.join(scriptDir, "noetaxis-macos/common.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUDO_USER: "someone" } });
	assert.equal(human.status, 0, human.stderr);
});

async function installFixture(t, label) {
	const root = await testRoot(t, label);
	const home = path.join(root, "home");
	const aoHome = path.join(home, ".ao");
	const appsDir = path.join(root, "Applications");
	const artifactDir = path.join(root, "build");
	const sourceApp = path.join(artifactDir, "Applications/Agent Orchestrator.app");
	const targetApp = path.join(appsDir, "Agent Orchestrator.app");
	await mkdir(path.dirname(sourceApp), { recursive: true });
	await mkdir(path.join(aoHome, "data"), { recursive: true });
	await mkdir(appsDir, { recursive: true });
	await makeApp(sourceApp, version, revision);
	await writeManifest(sourceApp, path.join(artifactDir, "MANIFEST.sha256"));
	const bin = await makeFakeBin(root);
	const env = installEnv({ home, appsDir, aoHome, handlerPlist: await makeHandlerFixture(home), bin });
	return { root, home, aoHome, appsDir, artifactDir, sourceApp, targetApp, bin, env };
}

const installedVersion = (app) => readFile(path.join(app, "Contents/Info.plist"), "utf8").then((text) => text.includes(version) ? "new" : "old");

test("install refuses an app that fails manifest or signature verification and leaves the current app alone", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-verify-test");
	await makeApp(f.targetApp, "0.13.4");
	const run = () => execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
	await writeFile(path.join(f.sourceApp, "Contents/Resources/extra-file"), "not in the manifest");
	const extra = run();
	assert.equal(extra.status, 24, extra.stderr);
	assert.match(extra.stderr, /Not in manifest: \.\/Contents\/Resources\/extra-file/);
	await rm(path.join(f.sourceApp, "Contents/Resources/extra-file"));
	await writeFile(path.join(f.sourceApp, "Contents/Resources/ao-updates-disabled"), "tampered");
	const tampered = run();
	assert.equal(tampered.status, 24, tampered.stderr);
	await writeFile(path.join(f.sourceApp, "Contents/Resources/ao-updates-disabled"), "");
	await rm(path.join(f.artifactDir, "MANIFEST.sha256"));
	const missing = run();
	assert.equal(missing.status, 24, missing.stderr);
	await rm(path.join(f.sourceApp, "Contents/_CodeSignature"), { recursive: true, force: true });
	await writeManifest(f.sourceApp, path.join(f.artifactDir, "MANIFEST.sha256"));
	const unsigned = run();
	assert.equal(unsigned.status, 31, unsigned.stderr);
	assert.match(unsigned.stderr, /Code signature verification failed/);
	assert.equal(await installedVersion(f.targetApp), "old");
	assert.deepEqual((await readdir(f.appsDir)).sort(), ["Agent Orchestrator.app"]);
	assert.equal(await readdir(path.join(f.home, "ao-backups")).catch(() => []).then((entries) => entries.length), 0);
});

test("rollback ignores a backup that has no BACKUP_COMPLETE record", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-incomplete-backup-test");
	await makeApp(f.targetApp, "0.13.4");
	const install = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
	assert.equal(install.status, 0, install.stderr);
	const backupRoot = path.join(f.home, "ao-backups");
	const [complete] = await readdir(backupRoot);
	const incomplete = path.join(backupRoot, `${complete}-zz-incomplete`);
	await mkdir(incomplete, { recursive: true });
	await makeApp(path.join(incomplete, "Agent Orchestrator.app.bak"), "0.0.1");
	const rollback = execute("/bin/bash", [rollbackScript, "--allow-ao-session"], { cwd: repoRoot, env: f.env });
	assert.equal(rollback.status, 0, rollback.stderr);
	assert.match(rollback.stdout, /Restored app version: 0\.13\.4/);
	assert.equal(await installedVersion(f.targetApp), "old");
	const noComplete = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--backup-dir", incomplete], { cwd: repoRoot, env: f.env });
	assert.equal(noComplete.status, 40, noComplete.stderr);
});

test("an interrupted install restores the previous app when /Applications has none", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-restore-test");
	const oldApp = path.join(f.root, "backup/Agent Orchestrator.app.bak");
	await mkdir(path.dirname(oldApp), { recursive: true });
	await makeApp(oldApp, "0.13.4");
	const restore = () => execute("/bin/bash", ["-c", 'source "$1"; noetaxis_restore_previous_app "$2" "$3"', "check", path.join(scriptDir, "noetaxis-macos/common.sh"), f.targetApp, oldApp], { env: f.env });
	const restored = restore();
	assert.equal(restored.status, 0, restored.stderr);
	assert.equal(await installedVersion(f.targetApp), "old");
	assert.equal(await lstat(oldApp).catch(() => undefined), undefined);
	await makeApp(oldApp, "0.0.1");
	const keptNew = restore();
	assert.equal(keptNew.status, 0, keptNew.stderr);
	assert.ok(await lstat(oldApp), "an installed app must not be replaced by the backup");
});

test("PKG preinstall backs up state before moving the app, and postinstall verifies the installed app", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-pkg-scripts-test");
	delete f.env.AO_HOME;
	await makeApp(f.targetApp, "0.13.4");
	await writeFile(path.join(f.aoHome, "app-state.json"), "state");
	const packaged = path.join(f.root, "pkg-scripts");
	await mkdir(packaged, { recursive: true });
	for (const [from, name] of [["pkg-scripts/preinstall", "preinstall"], ["pkg-scripts/postinstall", "postinstall"], ["common.sh", "common.sh"]]) {
		await cp(path.join(fakeScriptsDir, from), path.join(packaged, name));
	}
	const pre = path.join(packaged, "preinstall");
	const post = path.join(packaged, "postinstall");
	const idBin = path.join(f.root, "root-bin");
	await mkdir(idBin, { recursive: true });
	await writeFile(path.join(idBin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
	const noUser = execute("/bin/bash", [pre], { cwd: repoRoot, env: { ...f.env, PATH: `${idBin}:${f.env.PATH}`, SUDO_USER: "root", USER: "root" } });
	assert.equal(noUser.status, 29, noUser.stderr);
	assert.equal(await installedVersion(f.targetApp), "old");
	assert.equal(await readdir(path.join(f.home, "ao-backups")).catch(() => []).then((entries) => entries.length), 0);
	const ran = execute("/bin/bash", [pre], { cwd: repoRoot, env: f.env });
	assert.equal(ran.status, 0, ran.stderr);
	const backupRoot = path.join(f.home, "ao-backups");
	const [backup] = await readdir(backupRoot);
	const backupDir = path.join(backupRoot, backup);
	assert.match(await readFile(path.join(backupDir, "BACKUP_COMPLETE"), "utf8"), /app_backup=Agent Orchestrator-0\.13\.4-[^\n]*\.app\.bak\napp_version=0\.13\.4/);
	assert.equal(await readFile(path.join(backupDir, "app-state.json"), "utf8"), "state");
	assert.equal(await lstat(f.targetApp).catch(() => undefined), undefined);
	const missing = execute("/bin/bash", [post], { cwd: repoRoot, env: f.env });
	assert.notEqual(missing.status, 0);
	await cp(f.sourceApp, f.targetApp, { recursive: true, verbatimSymlinks: true });
	const verified = execute("/bin/bash", [post], { cwd: repoRoot, env: f.env });
	assert.equal(verified.status, 0, verified.stderr);
	assert.match(verified.stdout, /Installed 0\.13\.4-noetaxis\.8e2bc21/);
	await rm(path.join(f.targetApp, "Contents/Resources/ao-updates-disabled"));
	const broken = execute("/bin/bash", [post], { cwd: repoRoot, env: f.env });
	assert.notEqual(broken.status, 0);
});

async function makeBuild(root, name, buildVersion, buildRevision) {
	const artifactDir = path.join(root, name);
	const appPath = path.join(artifactDir, "Applications/Agent Orchestrator.app");
	await mkdir(path.dirname(appPath), { recursive: true });
	await makeApp(appPath, buildVersion, buildRevision);
	await writeManifest(appPath, path.join(artifactDir, "MANIFEST.sha256"));
	return appPath;
}

// Starts install.sh paused at `point`, runs `atPause`, delivers `signal` and resolves with the exit code.
async function interruptInstall(f, sourceApp, point, signal, atPause) {
	const marker = path.join(f.root, `pause-${point}-${signal}`);
	const child = spawn("/bin/bash", [installScript, "--allow-ao-session", sourceApp], {
		cwd: repoRoot,
		env: { ...f.env, NOETAXIS_TEST_PAUSE_AT: point, NOETAXIS_TEST_PAUSE_MARKER: marker },
		stdio: "ignore",
	});
	const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve(code ?? sig)));
	for (let waited = 0; waited < 300; waited += 1) {
		if (await lstat(marker).catch(() => undefined)) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(await lstat(marker).catch(() => undefined), `install never reached ${point}`);
	await atPause();
	child.kill(signal);
	return exited;
}

const backupEntries = async (f) => {
	const root = path.join(f.home, "ao-backups");
	const dirs = await readdir(root).catch(() => []);
	return Promise.all(dirs.map(async (name) => ({ dir: path.join(root, name), files: await readdir(path.join(root, name)) })));
};

for (const [point, signal, code] of [["after-staged", "SIGTERM", 143], ["after-record", "SIGTERM", 143], ["after-old-moved", "SIGTERM", 143], ["after-old-moved", "SIGINT", 130], ["after-old-moved", "SIGHUP", 129]]) {
	test(`${signal} at ${point} leaves the previous app installed and the backup marked aborted`, { skip: process.platform !== "darwin" }, async (t) => {
		const f = await installFixture(t, "noetaxis-signal-test");
		await makeApp(f.targetApp, "0.13.4");
		const atPause = async () => {
			if (point === "after-staged") {
				assert.equal((await backupEntries(f)).length, 0);
				assert.ok((await readdir(f.appsDir)).some((name) => name.startsWith(".Agent-Orchestrator-installing-")));
			}
			if (point === "after-record") {
				const [backup] = await backupEntries(f);
				assert.ok(backup.files.includes("BACKUP_COMPLETE"), "the record must exist before the old app moves");
				assert.equal(await installedVersion(f.targetApp), "old");
			}
			if (point === "after-old-moved") {
				assert.equal(await lstat(f.targetApp).catch(() => undefined), undefined);
				const [backup] = await backupEntries(f);
				assert.ok(backup.files.includes("BACKUP_COMPLETE") && backup.files.some((name) => name.endsWith(".app.bak")));
			}
		};
		assert.equal(await interruptInstall(f, f.sourceApp, point, signal, atPause), code);
		assert.equal(await installedVersion(f.targetApp), "old");
		assert.deepEqual((await readdir(f.appsDir)).sort(), ["Agent Orchestrator.app"]);
		for (const backup of await backupEntries(f)) {
			assert.ok(!backup.files.includes("BACKUP_COMPLETE"));
			assert.ok(backup.files.includes("BACKUP_ABORTED") || point === "after-staged");
		}
	});
}

test("SIGTERM between the swap and the completion flag keeps the new app and its completed backup", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-signal-window-test");
	await makeApp(f.targetApp, "0.13.4");
	assert.equal(await interruptInstall(f, f.sourceApp, "after-swap", "SIGTERM", async () => {}), 143);
	assert.equal(await installedVersion(f.targetApp), "new");
	const [backup] = await backupEntries(f);
	assert.ok(backup.files.includes("BACKUP_COMPLETE") && !backup.files.includes("BACKUP_ABORTED"));
});

test("SIGTERM after the new app is in place keeps it and its completed backup", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-signal-installed-test");
	await makeApp(f.targetApp, "0.13.4");
	assert.equal(await interruptInstall(f, f.sourceApp, "after-installed", "SIGTERM", async () => {}), 143);
	assert.equal(await installedVersion(f.targetApp), "new");
	assert.deepEqual((await readdir(f.appsDir)).sort(), ["Agent Orchestrator.app"]);
	const [backup] = await backupEntries(f);
	assert.ok(backup.files.includes("BACKUP_COMPLETE") && !backup.files.includes("BACKUP_ABORTED"));
});

test("good install, interrupted install, then rollback still restores the original app", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-aborted-rollback-test");
	await makeApp(f.targetApp, "0.13.4");
	const first = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
	assert.equal(first.status, 0, first.stderr);
	const secondApp = await makeBuild(f.root, "build-two", "0.13.4-noetaxis.1234567", `1234567${"0".repeat(33)}`);
	assert.equal(await interruptInstall(f, secondApp, "after-old-moved", "SIGTERM", async () => {}), 143);
	assert.equal(await installedVersion(f.targetApp), "new");
	const rollback = execute("/bin/bash", [rollbackScript, "--allow-ao-session"], { cwd: repoRoot, env: f.env });
	assert.equal(rollback.status, 0, rollback.stderr);
	assert.match(rollback.stdout, /Restored app version: 0\.13\.4/);
	assert.doesNotMatch(rollback.stdout, /already restored/i);
	assert.equal(await installedVersion(f.targetApp), "old");
});

test("a bundled CLI that fails its post-install checks produces labelled warnings, not a failed install", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-warning-test");
	await writeFile(path.join(f.sourceApp, "Contents/Resources/daemon/ao"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	execute("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", f.sourceApp]);
	await writeManifest(f.sourceApp, path.join(f.artifactDir, "MANIFEST.sha256"));
	const install = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
	assert.equal(install.status, 0, install.stderr);
	assert.match(install.stdout, /WARNING: "ao version" failed/);
	assert.match(install.stdout, /WARNING: the bundled ao CLI does not list spawn --effort/);
	assert.match(install.stdout, /WARNING: the bundled ao CLI does not list project set-config --permission-fallback/);
	assert.equal(await installedVersion(f.targetApp), "new");
});

test("backup record hands a root-made backup to the console user without following symlinks", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-chown-test");
	const bin = path.join(root, "bin");
	const backup = path.join(root, "backup");
	const outside = path.join(root, "outside");
	await mkdir(bin, { recursive: true });
	await mkdir(backup, { recursive: true });
	await writeFile(outside, "x");
	await symlink(outside, path.join(backup, "link"));
	await writeFile(path.join(backup, "ao.db"), "db");
	// Fake root for `id -u` only; `id -u <name>` and `id -g <name>` fall through to the real id.
	await writeFile(path.join(bin, "id"), '#!/bin/sh\nif [ "$*" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n', { mode: 0o755 });
	const me = os.userInfo().username;
	const run = execute("/bin/bash", ["-c", 'source "$1"; noetaxis_write_backup_record "$2" NONE NONE', "check", path.join(scriptDir, "noetaxis-macos/common.sh"), backup], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUDO_USER: me } });
	assert.equal(run.status, 0, run.stderr);
	assert.match(await readFile(path.join(backup, "BACKUP_COMPLETE"), "utf8"), /app_backup=NONE/);
	assert.equal(await readFile(outside, "utf8"), "x");
});

test("install removes stale staging directories of dead processes only", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-stale-staging-test");
	const stale = path.join(f.appsDir, ".Agent-Orchestrator-installing-20200101-000000-99999999.app");
	const live = path.join(f.appsDir, `.Agent-Orchestrator-installing-20200101-000000-${process.pid}.app`);
	const unrelated = path.join(f.appsDir, "Other.app");
	// pid 1 is alive but owned by root: kill -0 would report EPERM and wrongly call it dead.
	const otherUser = path.join(f.appsDir, ".Agent-Orchestrator-installing-20200101-000000-1.app");
	const outside = path.join(f.root, "outside");
	const link = path.join(f.appsDir, ".Agent-Orchestrator-installing-20200101-000000-99999998.app");
	for (const dir of [stale, live, unrelated, otherUser, outside]) await mkdir(dir, { recursive: true });
	await writeFile(path.join(outside, "keep"), "keep");
	await symlink(outside, link);
	const fakePs = path.join(f.root, "staging-ps");
	await writeFile(fakePs, `#!/bin/sh\ncase "$2" in 1|${process.pid}) printf 'PID\\n%s\\n' "$2"; exit 0;; *) exit 1;; esac\n`, { mode: 0o755 });
	const install = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: { ...f.env, NOETAXIS_PS: fakePs } });
	assert.equal(install.status, 0, install.stderr);
	assert.deepEqual((await readdir(f.appsDir)).sort(), [path.basename(live), path.basename(otherUser), path.basename(link), "Agent Orchestrator.app", "Other.app"].sort());
	assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "keep");
});

test("native PKG structure is verifiable without running Installer", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-packaging-test", true);
	const sourceApp = path.join(root, "source/Applications/Agent Orchestrator.app");
	const outputDir = path.join(root, "artifacts");
	await mkdir(path.dirname(sourceApp), { recursive: true });
	await makeApp(sourceApp, version, revision);
	const artifacts = await buildPackages({ appPath: sourceApp, outputDir, version, revision, createDiskImage: false });
	assert.ok(artifacts.fileCount >= 3);
	assert.equal(artifacts.installerDir, path.join(outputDir, "installer"));
	assert.equal(artifacts.checksumsPath, path.join(outputDir, "SHA256SUMS"));
	assert.deepEqual(await readFile(path.join(artifacts.installerDir, "survivors.sh")), await readFile(path.join(scriptDir, "noetaxis-macos/survivors.sh")));
	assert.match(await readFile(artifacts.checksumsPath, "utf8"), new RegExp(path.basename(artifacts.pkgPath).replaceAll(".", "\\.")));
	const signature = execute("/usr/sbin/pkgutil", ["--check-signature", artifacts.pkgPath]);
	assert.match(`${signature.stdout}\n${signature.stderr}`, /no signature|not signed|unsigned/i);
	const expanded = path.join(root, "expanded");
	const expansion = execute("/usr/sbin/pkgutil", ["--expand-full", artifacts.pkgPath, expanded]);
	assert.equal(expansion.status, 0, expansion.stderr);
	const payload = execute("/usr/sbin/pkgutil", ["--payload-files", artifacts.pkgPath]);
	assert.equal(payload.status, 0, payload.stderr);
	assert.match(payload.stdout, /Agent Orchestrator\.app\/Contents\/Info\.plist/);
	assert.match(payload.stdout, /Agent Orchestrator\.app\/Contents\/Resources\/ao-updates-disabled/);
	const expandedFiles = await allFiles(expanded);
	assert.ok(expandedFiles.some((file) => file.includes(path.join("Payload", "Agent Orchestrator.app", "Contents", "Info.plist"))));
	assert.ok(expandedFiles.some((file) => path.basename(file) === "preinstall"));
	assert.ok(expandedFiles.some((file) => path.basename(file) === "postinstall"));
	const packageInfo = await Promise.all(expandedFiles.filter((file) => path.basename(file) === "PackageInfo").map((file) => readFile(file, "utf8")));
	assert.ok(packageInfo.some((text) => /relocatable="false"/.test(text) && /<upgrade-bundle>/.test(text) && /<bundle-version\/>/.test(text)), packageInfo.join("\n"));
	assert.equal(artifacts.dmgPath, "");
});

test("native DMG is mounted read-only, inspected, and detached", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-dmg-test", true);
	const sourceApp = path.join(root, "source/Applications/Agent Orchestrator.app");
	const outputDir = path.join(root, "artifacts");
	await mkdir(path.dirname(sourceApp), { recursive: true });
	await mkdir(outputDir, { recursive: true });
	await makeApp(sourceApp, version, revision);
	let dmgPath;
	try {
		dmgPath = await buildDiskImage({ appPath: sourceApp, outputDir, version });
	} catch (error) {
		if (/Device not configured/i.test(error.message)) {
			await makeWritable(root);
			await rm(root, { recursive: true, force: true });
			t.skip("Host denied hdiutil virtual disk creation (Device not configured)");
			return;
		}
		throw error;
	}
	const mountPoint = path.join(root, "dmg-mount");
	await mkdir(mountPoint, { recursive: true });
	const mounted = execute("/usr/bin/hdiutil", ["attach", dmgPath, "-readonly", "-nobrowse", "-mountpoint", mountPoint]);
	assert.equal(mounted.status, 0, mounted.stderr);
	try {
		assert.equal(await lstat(path.join(mountPoint, "Agent Orchestrator.app")).then((details) => details.isDirectory()), true);
		assert.equal(await readlink(path.join(mountPoint, "Applications")), "/Applications");
		assert.match(await readFile(path.join(mountPoint, "Read Me.txt"), "utf8"), /ad-hoc signature/);
	} finally {
		const detached = execute("/usr/bin/hdiutil", ["detach", mountPoint]);
		assert.equal(detached.status, 0, detached.stderr);
	}
});
