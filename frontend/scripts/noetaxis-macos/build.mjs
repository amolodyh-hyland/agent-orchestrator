import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackages, writeArtifactChecksums } from "./package-artifacts.mjs";
import { daemonBuildEnv } from "../go-build-env.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const defaultRegistry = "https://proget.onbase.net/npm/npm";
const publicRegistry = "https://registry.npmjs.org/";
const usage = "Usage: build.mjs [--ref <commit-or-tag>] [--base-version <x.y.z>] [--output <directory>] [--public-registry] [--registry <url>]\nDefault: https://proget.onbase.net/npm/npm (company VPN). --public-registry explicitly selects https://registry.npmjs.org/ without company npm credentials. --registry must match the selected mode; no other endpoints are allowed.";
const defaultBaseVersion = "0.13.4";
const agentBrowserVersion = "0.38.1";
const multicaModule = "github.com/multica-ai/multica/server";
const defaultOutputRoot = path.join(os.homedir(), "ao-builds");
const appName = "Agent Orchestrator.app";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status ?? result.signal}`);
}

function capture(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status ?? result.signal}`);
	return result.stdout.trim();
}

function captureBytes(command, args, options = {}) {
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status ?? result.signal}`);
	return result.stdout;
}

export function parseArgs(args) {
	let explicitRegistry;
	const options = { ref: "HEAD", baseVersion: defaultBaseVersion, registry: process.env.NOETAXIS_NPM_REGISTRY || defaultRegistry };
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index];
		if (name === "-h" || name === "--help") {
			options.help = true;
			continue;
		}
		if (name === "--public-registry") {
			options.publicRegistry = true;
			continue;
		}
		if (!["--ref", "--output", "--base-version", "--registry"].includes(name) || !args[index + 1]) {
			throw new Error(usage);
		}
		const key = { "--ref": "ref", "--output": "output", "--base-version": "baseVersion", "--registry": "registry" }[name];
		options[key] = args[index + 1];
		if (key === "registry") explicitRegistry = options[key];
		index += 1;
	}
	if (options.publicRegistry) options.registry = explicitRegistry || publicRegistry;
	return options;
}

export function parseMulticaPin(goMod) {
	const line = goMod.split(/\r?\n/).find((entry) => entry.trim().startsWith(`replace ${multicaModule} => `));
	const match = line?.trim().match(/^replace\s+github\.com\/multica-ai\/multica\/server\s+=>\s+(github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/server\s+(v0\.0\.0-\d{14}-([0-9a-f]{12}))$/);
	if (!match) throw new Error(`Could not read the pinned Multica server revision from backend/go.mod: ${line || "replace directive missing"}`);
	return { repository: match[1], version: match[2], shortRevision: match[3] };
}

export function validateRegistry(value, publicOptIn = false) {
	if (publicOptIn) {
		if (value !== publicRegistry && value !== publicRegistry.slice(0, -1)) {
			throw new Error("--public-registry requires https://registry.npmjs.org/; no other registry is allowed in public mode");
		}
		return publicRegistry;
	}
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Registry must be the internal ProGet npm endpoint https://proget.onbase.net/npm/npm");
	}
	if (![defaultRegistry, `${defaultRegistry}/`].includes(value) || parsed.protocol !== "https:" || parsed.hostname !== "proget.onbase.net" || parsed.pathname.replace(/\/$/, "") !== "/npm/npm" || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Registry must be the internal ProGet npm endpoint https://proget.onbase.net/npm/npm; public registries are blocked");
	}
	return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

function isWithin(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function stampVersion(baseVersion, revision) {
	if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error(`Base version must be three numeric components: ${baseVersion}`);
	return `${baseVersion}-noetaxis.${revision.slice(0, 7)}`;
}

async function makeTemporaryWritable(directory) {
	try {
		await chmod(directory, 0o755);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isDirectory()) await makeTemporaryWritable(child);
			else if (entry.isFile()) {
				try {
					await chmod(child, 0o644);
				} catch {}
			}
		}
	} catch {}
}

function supportedHost(env) {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The custom desktop build requires an Apple Silicon Mac and macOS");
	const npmVersion = capture("npm", ["--version"], env ? { env, cwd: path.dirname(env.npm_config_userconfig) } : {});
	const npmMajor = Number(npmVersion.split(".")[0]);
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor < 24 || npmMajor < 11) throw new Error(`Node 24 and npm 11 are required; found Node ${process.versions.node} and npm ${npmVersion}`);
	if (!capture("uname", ["-m"]).includes("arm64")) throw new Error("The build host must run natively as arm64");
}

function lockfiles(root) {
	return ["package-lock.json", "pnpm-lock.yaml"].map((name) => path.join(root, name));
}

async function readOptional(file) {
	try { return await readFile(file, "utf8"); }
	catch (error) {
		if (error.code === "ENOENT") return "";
		throw new Error("Could not read package-manager configuration; no configuration values are displayed");
	}
}

export function progetAuth(contents, env = process.env) {
	const entries = new Map();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*(\/\/[^\s=]+):(_authToken|_auth|username|_password|always-auth)\s*=\s*(.*?)\s*$/i);
		if (!match) continue;
		let url;
		try { url = new URL(`https:${match[1]}`); } catch { continue; }
		const authPath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
		if (url.hostname !== "proget.onbase.net" || url.port || url.username || url.password || url.search || url.hash || !"/npm/npm/".startsWith(authPath)) continue;
		let value = match[3];
		try {
			if (value.startsWith('"')) value = JSON.parse(value);
			else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
			value = value.replace(/\$\{([^}]+)\}/g, (_, key) => {
				if (!Object.hasOwn(env, key)) throw new Error();
				return env[key];
			});
			if (/[\r\n\0]/.test(value)) throw new Error();
		} catch { throw new Error("Could not resolve ProGet authentication; no configuration values are displayed"); }
		const field = { _authtoken: "_authToken", _auth: "_auth", username: "username", _password: "_password", "always-auth": "always-auth" }[match[2].toLowerCase()];
		entries.set(`//${url.host}${authPath}:${field}`, JSON.stringify(value));
	}
	return entries;
}

export async function registryBuildEnv(configDir, registry, inherited = process.env) {
	const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(?:npm_config_|pnpm_|corepack_|npm_(?:token|auth_token|auth|password|username)$|node_auth_token$|yarn_npm_auth_token$)/i.test(key)));
	const auth = new Map();
	if (registry === defaultRegistry) {
		const prefix = inherited.npm_config_prefix || inherited.NPM_CONFIG_PREFIX || path.dirname(path.dirname(process.execPath));
		const files = [inherited.npm_config_globalconfig || inherited.NPM_CONFIG_GLOBALCONFIG || path.join(prefix, "etc/npmrc"), inherited.npm_config_userconfig || inherited.NPM_CONFIG_USERCONFIG || path.join(inherited.HOME || os.homedir(), ".npmrc")];
		for (const file of files) for (const [key, value] of progetAuth(await readOptional(file), inherited)) auth.set(key, value);
		const authEnv = Object.entries(inherited).filter(([key]) => /^npm_config_\/\//i.test(key)).map(([key, value]) => `${key.slice(11)}=${JSON.stringify(value)}`).join("\n");
		for (const [key, value] of progetAuth(authEnv, inherited)) auth.set(key, value);
	}
	const corepackAuth = {};
	const scopes = new Map();
	for (const [key, value] of auth) {
		const split = key.lastIndexOf(":");
		const scope = key.slice(0, split);
		if (!scopes.has(scope)) scopes.set(scope, {});
		scopes.get(scope)[key.slice(split + 1)] = JSON.parse(value);
	}
	for (const [, credentials] of [...scopes].sort(([left], [right]) => right.length - left.length)) {
		if (credentials._authToken) { corepackAuth.COREPACK_NPM_TOKEN = credentials._authToken; break; }
		const basic = credentials._auth ? Buffer.from(credentials._auth, "base64").toString("utf8") : credentials.username && credentials._password ? `${credentials.username}:${Buffer.from(credentials._password, "base64").toString("utf8")}` : "";
		if (basic.includes(":")) {
			corepackAuth.COREPACK_NPM_USERNAME = basic.slice(0, basic.indexOf(":"));
			corepackAuth.COREPACK_NPM_PASSWORD = basic.slice(basic.indexOf(":") + 1);
			break;
		}
	}
	const base = `registry=${registry}\n@jsr:registry=${registry}\n`;
	const userconfig = path.join(configDir, "user-npmrc");
	const globalconfig = path.join(configDir, "global-npmrc");
	const xdg = path.join(configDir, "config");
	await mkdir(path.join(xdg, "pnpm"), { recursive: true });
	await writeFile(userconfig, base + [...auth].map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
	await writeFile(globalconfig, base, { mode: 0o600 });
	await writeFile(path.join(xdg, "pnpm/rc"), base, { mode: 0o600 });
	return {
		...env, ...corepackAuth,
		npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry,
		npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig,
		npm_config_globalconfig: globalconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
		npm_config_replace_registry_host: registry === defaultRegistry ? "npmjs" : "always",
		NPM_CONFIG_REPLACE_REGISTRY_HOST: registry === defaultRegistry ? "npmjs" : "always",
		npm_config_loglevel: "error", NPM_CONFIG_LOGLEVEL: "error",
		npm_config_manage_package_manager_versions: "false", npm_config_ignore_pnpmfile: "true",
		XDG_CONFIG_HOME: xdg, PNPM_HOME: path.join(configDir, "pnpm"),
		COREPACK_NPM_REGISTRY: registry.replace(/\/$/, ""), COREPACK_HOME: path.join(configDir, "corepack"),
		COREPACK_ENABLE_PROJECT_SPEC: "0", COREPACK_ENABLE_ENV_FILE: "0",
	};
}

export async function checkMulticaConfiguration(root, registry) {
	const fail = () => { throw new Error("Unsupported Multica package-manager configuration; refusing to start pnpm. Configuration dependencies, hooks, registry overrides and foreign tarballs are forbidden; no configuration values are displayed."); };
	const forbidden = (key) => /configdependencies|pnpmfile|registr(?:y|ies)|managepackagemanagerversions/.test(key.replace(/[^a-z]/gi, "").toLowerCase());
	const checkUrls = (text) => {
		for (const match of text.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>},]+/gi)) {
			if (!match[0].startsWith(`${registry.replace(/\/$/, "")}/`)) fail();
			const url = new URL(match[0]);
			if (url.username || url.password || url.search || url.hash) fail();
		}
	};
	const walk = (value, dependencies = false) => {
		if (typeof value === "string") { if (dependencies || /\.(?:tgz|tar\.gz)(?:[?#]|$)/i.test(value)) checkUrls(value); return; }
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (forbidden(key)) fail();
			walk(child, dependencies || /dependencies|overrides|resolutions/i.test(key));
		}
	};
	const manifest = await readOptional(path.join(root, "package.json"));
	try {
		const parsed = JSON.parse(manifest);
		if (parsed.packageManager && parsed.packageManager !== "pnpm@10.28.2") fail();
		walk(parsed);
	} catch { fail(); }
	const yaml = await readOptional(path.join(root, "pnpm-workspace.yaml"));
	for (const line of yaml.split(/\r?\n/)) {
		if (/^\s*(?:#|$)/.test(line)) continue;
		if (/[{}\[\]\\]/.test(line) || /^\s*(?:%|---|\.\.\.|[?:]\s|<<\s*:)/.test(line) || /(?:^|[\s:])[&*!][\w]/.test(line)) fail();
		const key = line.match(/^\s*(?:"([^"]+)"|'((?:[^']|'')+)'|([^:#]+))\s*:/);
		if (key && forbidden(key[1] || key[2] || key[3])) fail();
		checkUrls(line);
	}
	for (const line of (await readOptional(path.join(root, ".npmrc"))).split(/\r?\n/)) {
		if (!/^\s*(?:[;#].*)?$/.test(line) && !/^\s*shamefully-hoist\s*=\s*true\s*$/.test(line)) fail();
	}
	for (const name of [".pnpmfile.cjs", ".pnpmfile.mjs", ".pnpmfile.js"]) {
		const entry = await lstat(path.join(root, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
		if (entry) fail();
	}
}

export async function prepareRegistry(root, registry, hoist = false) {
	for (const file of lockfiles(root)) {
		const contents = await readOptional(file);
		if (!contents) continue;
		const target = `${registry.replace(/\/$/, "")}/`;
		const routed = contents.replace(/https?:\/\/(?:registry\.npmjs\.(?:org|com)|registry\.yarnpkg\.com|proget\.onbase\.net\/npm\/npm)(?=\/|["'\s]|$)\/?/g, target);
		const downloads = [...routed.matchAll(/(?:"resolved"\s*:\s*"|tarball:\s*["']?)(https?:\/\/[^"'\s}]+)/gi)];
		if (downloads.some((match) => !match[1].startsWith(target))) throw new Error("A foreign package download remains in a lockfile; refusing to install dependencies");
		if (routed !== contents) await writeFile(file, routed, "utf8");
	}
	await writeFile(path.join(root, ".npmrc"), `registry=${registry}\n@jsr:registry=${registry}\n${hoist ? "shamefully-hoist=true\n" : ""}`, "utf8");
}

function plistSet(plistPath, key, value) {
	const add = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], { stdio: "ignore" });
	if (add.status !== 0) run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

function plistRead(plistPath, key) {
	return capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
}

function clearQuarantine(appPath) {
	const attributes = spawnSync("/usr/bin/xattr", ["-lr", appPath], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
	if (attributes.error) throw attributes.error;
	if (attributes.status !== 0) throw new Error("Could not inspect app quarantine attributes");
	if (attributes.stdout.includes("com.apple.quarantine")) run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath]);
}

function parseDatabaseSchema(root) {
	const migrationDir = path.join(root, "backend/internal/storage/sqlite/migrations");
	const names = readdirSync(migrationDir);
	const versions = names.map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1]).filter(Boolean).map(Number);
	if (versions.length === 0) throw new Error(`No SQLite migrations found in ${migrationDir}`);
	return Math.max(...versions);
}

// The internal registry mirror serves no npm signature metadata, so corepack cannot
// verify the pnpm download. Applied only to the install;
// the electron-vite child runs with the cached pnpm and without this override.
const corepackEnv = { COREPACK_INTEGRITY_KEYS: "0" };

async function seedAgentBrowserLicenses(workDir, env, frontendDir) {
	const archiveDir = path.join(workDir, "agent-browser-package");
	const licenseDir = path.join(workDir, "agent-browser-licenses");
	await mkdir(archiveDir, { recursive: true });
	await mkdir(licenseDir, { recursive: true });
	run("npm", [
		"pack", `agent-browser@${agentBrowserVersion}`, "--ignore-scripts",
		"--pack-destination", archiveDir, "--registry", env.npm_config_registry,
		"--replace-registry-host", env.npm_config_replace_registry_host,
	], { cwd: frontendDir, env });
	const archive = path.join(archiveDir, (await readdir(archiveDir)).find((name) => name.endsWith(".tgz")) || "");
	if (!archive.endsWith(".tgz")) throw new Error(`${env.npm_config_registry === publicRegistry ? "Public" : "Internal"} registry did not provide the pinned agent-browser package`);
	const files = [
		["package/LICENSE", "LICENSE-agent-browser"],
		["package/cli/src/native/a11y/LICENSE-axe-core.txt", "LICENSE-axe-core"],
		["package/cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt", "LICENSE-axe-core-THIRD-PARTY"],
	];
	for (const [member, name] of files) {
		const license = captureBytes("/usr/bin/tar", ["-xOzf", archive, member]);
		await writeFile(path.join(licenseDir, name), license);
	}
	return licenseDir;
}

async function updateFrontendVersion(frontendDir, version) {
	const file = path.join(frontendDir, "package.json");
	const packageJson = JSON.parse(await readFile(file, "utf8"));
	packageJson.version = version;
	await writeFile(file, `${JSON.stringify(packageJson, null, "\t")}\n`, "utf8");
}

async function findAppBundle(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const child = path.join(directory, entry.name);
		if (entry.isDirectory() && entry.name === "Agent Orchestrator.app") return child;
		if (entry.isDirectory()) {
			const found = await findAppBundle(child);
			if (found) return found;
		}
	}
	return "";
}

export async function buildNoetaxis(options) {
	const registry = validateRegistry(options.registry, options.publicRegistry);
	const configDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-npm-"));
	try {
		return await buildWithRegistry(options, registry, await registryBuildEnv(configDir, registry));
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
}

async function buildWithRegistry(options, registry, npmEnv) {
	supportedHost(npmEnv);
	const goEnv = daemonBuildEnv({ cwd: path.join(repoRoot, "backend") });
	const commit = capture("git", ["rev-parse", "--verify", `${options.ref}^{commit}`], { cwd: repoRoot });
	const version = stampVersion(options.baseVersion, commit);
	const outputDir = path.resolve(options.output || path.join(defaultOutputRoot, `noetaxis-${version}`));
	if (isWithin("/Applications", outputDir)) throw new Error("Build output must be outside /Applications");
	if (isWithin(repoRoot, outputDir)) throw new Error("Build output must be outside the AO checkout");
	const outputEntries = await readdir(outputDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
	if (outputEntries.length > 0) throw new Error(`Build output directory is not empty: ${outputDir}`);
	await mkdir(outputDir, { recursive: true });
	const workDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-build-"));
	const sourceWorktree = path.join(workDir, "ao-source");
	let worktreeAdded = false;
	try {
		run("git", ["worktree", "add", "--detach", sourceWorktree, commit], { cwd: repoRoot });
		worktreeAdded = true;
		const goMod = await readFile(path.join(sourceWorktree, "backend/go.mod"), "utf8");
		const multicaPin = parseMulticaPin(goMod);
		const frontendDir = path.join(sourceWorktree, "frontend");
		const productUiDir = path.join(sourceWorktree, "packages/product-ui");
		const multicaDir = path.join(workDir, "multica");
		for (const directory of [sourceWorktree, frontendDir, productUiDir, path.join(frontendDir, "acp-runtime")]) await prepareRegistry(directory, registry);
		run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: frontendDir, env: npmEnv });
		run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: productUiDir, env: npmEnv });
		const licenseDir = await seedAgentBrowserLicenses(workDir, npmEnv, frontendDir);
		run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://${multicaPin.repository}.git`, multicaDir], { cwd: workDir });
		run("git", ["-C", multicaDir, "checkout", "--detach", multicaPin.shortRevision]);
		await checkMulticaConfiguration(multicaDir, registry);
		await prepareRegistry(multicaDir, registry, true);
		const pnpmEnv = registry === defaultRegistry ? { ...npmEnv, ...corepackEnv } : npmEnv;
		const pnpmCommand = "corepack";
		run(pnpmCommand, ["pnpm@10.28.2", "--ignore-pnpmfile", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`], {
			cwd: multicaDir,
			env: pnpmEnv,
		});
		run(pnpmCommand, ["pnpm@10.28.2", "--ignore-pnpmfile", "--filter", "@multica/desktop", "exec", "electron-vite", "build"], {
			cwd: multicaDir,
			env: npmEnv,
		});
		const multicaRevision = capture("git", ["-C", multicaDir, "rev-parse", "HEAD"]);
		if (!multicaRevision.startsWith(multicaPin.shortRevision)) throw new Error("Multica checkout does not match backend/go.mod pin");
		const multicaOut = path.join(multicaDir, "apps/desktop/out");
		const buildEnv = {
			...npmEnv,
			CGO_ENABLED: goEnv.CGO_ENABLED,
			AO_MULTICA_DESKTOP_OUT: multicaOut,
			AO_RELEASE_REPO: "amolodyh-hyland/agent-orchestrator",
			AO_SCRATCH_SWIFT_CACHE: path.join(workDir, "swift-cache"),
			AO_AGENT_BROWSER_LICENSE_DIR: licenseDir,
		};
		run("npm", ["run", "build:daemon"], { cwd: frontendDir, env: buildEnv });
		await updateFrontendVersion(frontendDir, version);
		run("npm", ["run", "build:tmux"], { cwd: frontendDir, env: buildEnv });
		run("npm", ["run", "browser-runtime:prepare"], { cwd: frontendDir, env: buildEnv });
		run("npm", ["run", "build:acp-runtime"], { cwd: frontendDir, env: buildEnv });
		const forgeOut = path.join(frontendDir, "out");
		const forgeBin = path.join(frontendDir, "node_modules/.bin/electron-forge");
		run(forgeBin, ["package", "--platform=darwin", "--arch=arm64"], { cwd: frontendDir, env: buildEnv });
		const packagedApp = await findAppBundle(forgeOut);
		if (!packagedApp) throw new Error(`electron-forge did not create ${appName} in ${forgeOut}`);
		const resources = path.join(packagedApp, "Contents/Resources");
		if (!(await readFile(path.join(resources, "ao-updates-disabled")).catch(() => undefined))) {
			throw new Error("Packaged app is missing the updates-disabled marker");
		}
		const infoPlist = path.join(packagedApp, "Contents/Info.plist");
		const databaseSchema = parseDatabaseSchema(sourceWorktree);
		plistSet(infoPlist, "NoetaxisSourceRevision", commit);
		plistSet(infoPlist, "NoetaxisBuildRef", commit);
		plistSet(infoPlist, "NoetaxisDatabaseSchema", String(databaseSchema));
		plistSet(infoPlist, "NoetaxisMulticaRevision", multicaRevision);
		if (plistRead(infoPlist, "CFBundleShortVersionString") !== version || plistRead(infoPlist, "CFBundleVersion") !== version) {
			throw new Error("Packaged app does not contain the requested version stamp");
		}
		const dictationHelper = path.join(resources, "dictation-helper", "ao-dictation");
		run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", path.join(frontendDir, "native/dictation/entitlements.plist"), dictationHelper]);
		run("/usr/bin/codesign", ["--force", "--deep", "--preserve-metadata=entitlements", "--sign", "-", "--timestamp=none", packagedApp]);
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", packagedApp]);
		clearQuarantine(packagedApp);
		const outputApp = path.join(outputDir, "Applications", "Agent Orchestrator.app");
		await mkdir(path.dirname(outputApp), { recursive: true });
		await cp(packagedApp, outputApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		const packaged = await buildPackages({ appPath: outputApp, outputDir, version, revision: commit });
		const buildInfo = [
			`Version: ${version}`,
			`AO source revision: ${commit}`,
			`Multica source revision: ${multicaRevision}`,
			`Database schema: ${databaseSchema}`,
			`Registry: ${new URL(registry).host}`,
			`Signature: ad-hoc; not notarized`,
			`Built at: ${new Date().toISOString()}`,
			`App: ${outputApp}`,
			`Manifest: ${packaged.manifestPath} (${packaged.fileCount} regular files)`,
			`PKG: ${packaged.pkgPath}`,
			`DMG: ${packaged.dmgPath}`,
			`Installer: ${packaged.installerDir}`,
			`Checksums: ${packaged.checksumsPath}`,
			"",
		].join("\n");
		await writeFile(path.join(outputDir, "BUILD-INFO.txt"), buildInfo, "utf8");
		await writeArtifactChecksums(outputDir);
		console.log(`Build complete: ${outputDir}`);
		console.log(`Version: ${version}`);
		console.log(`AO revision: ${commit}`);
		console.log(`Multica revision: ${multicaRevision}`);
		return { outputDir, appPath: outputApp, version, commit, multicaRevision };
	} finally {
		if (worktreeAdded) {
			const remove = spawnSync("git", ["worktree", "remove", "--force", sourceWorktree], { cwd: repoRoot, stdio: "ignore" });
			if (remove.status !== 0) {
				await makeTemporaryWritable(sourceWorktree);
				spawnSync("git", ["worktree", "remove", "--force", sourceWorktree], { cwd: repoRoot, stdio: "ignore" });
			}
		}
		await makeTemporaryWritable(workDir);
		await rm(workDir, { recursive: true, force: true });
		if (worktreeAdded) spawnSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage);
		} else {
			await buildNoetaxis(options);
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
