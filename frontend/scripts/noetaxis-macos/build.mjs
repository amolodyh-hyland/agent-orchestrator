import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import ini from "./parsers/ini.cjs";
import { load as loadYaml, dump as dumpYaml, JSON_SCHEMA } from "./parsers/js-yaml.mjs";
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

const activeChildren = new Set();

async function commandResult(command, args, options = {}) {
	const { encoding, maxBuffer = 1024 * 1024, ...spawnOptions } = options;
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, spawnOptions);
		activeChildren.add(child);
		const stdout = [];
		let bytes = 0;
		child.stdout?.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > maxBuffer) { child.kill(); reject(new Error(`${path.basename(command)} output exceeded its limit`)); }
			else stdout.push(chunk);
		});
		child.stderr?.resume();
		child.once("error", (error) => { activeChildren.delete(child); reject(error); });
		child.once("close", (status, signal) => {
			activeChildren.delete(child);
			const output = Buffer.concat(stdout);
			resolve({ status, signal, stdout: encoding ? output.toString(encoding) : output });
		});
	});
}

async function run(command, args, options = {}) {
	const result = await commandResult(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status ?? result.signal}`);
}

async function capture(command, args, options = {}) {
	return (await captureBytes(command, args, { encoding: "utf8", ...options })).trim();
}

async function captureBytes(command, args, options = {}) {
	const result = await commandResult(command, args, options);
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

async function supportedHost(env) {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The custom desktop build requires an Apple Silicon Mac and macOS");
	const npmVersion = await capture("npm", ["--version"], env ? { env, cwd: path.dirname(env.npm_config_userconfig) } : {});
	const npmMajor = Number(npmVersion.split(".")[0]);
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor < 24 || npmMajor < 11) throw new Error(`Node 24 and npm 11 are required; found Node ${process.versions.node} and npm ${npmVersion}`);
	if (!(await capture("uname", ["-m"])).includes("arm64")) throw new Error("The build host must run natively as arm64");
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

function resolveNpmValue(value, env) {
	return String(value).replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (original, escapes, key, optional) => {
		if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
		if (!Object.hasOwn(env, key) && !optional) throw new Error("Could not resolve ProGet authentication; no configuration values are displayed");
		return escapes.slice(escapes.length / 2) + (env[key] ?? "");
	});
}

export function progetAuth(contents, env = process.env) {
	const entries = new Map();
	for (const [key, rawValue] of Object.entries(ini.parse(contents))) {
		const match = key.match(/^(\/\/[^\s=]+):(_authToken|_auth|username|_password|always-auth)$/i);
		if (!match) continue;
		let url;
		try { url = new URL(`https:${match[1]}`); } catch { continue; }
		const authPath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
		if (url.hostname !== "proget.onbase.net" || url.port || url.username || url.password || url.search || url.hash || !"/npm/npm/".startsWith(authPath)) continue;
		if (!["string", "boolean", "number"].includes(typeof rawValue)) throw new Error("Unsupported ProGet authentication; no configuration values are displayed");
		const value = resolveNpmValue(rawValue, env);
		if (/[\r\n\0]/.test(value)) throw new Error("Could not resolve ProGet authentication; no configuration values are displayed");
		const field = { _authtoken: "_authToken", _auth: "_auth", username: "username", _password: "_password", "always-auth": "always-auth" }[match[2].toLowerCase()];
		entries.set(`//${url.host}${authPath}:${field}`, JSON.stringify(value));
	}
	return entries;
}

async function progetAuthSources(inherited) {
	const settings = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => /^npm_config_/i.test(key) && value !== "").map(([key, value]) => [key.slice(11).toLowerCase().replaceAll("_", "-"), value]));
	const home = inherited.HOME || os.homedir();
	const configPath = (value) => {
		const expanded = resolveNpmValue(value, inherited).trim();
		return expanded.startsWith("~/") ? path.resolve(home, expanded.slice(2)) : path.resolve(expanded);
	};
	const userFile = configPath(settings.userconfig || path.join(home, ".npmrc"));
	const userContents = await readOptional(userFile);
	const user = ini.parse(userContents);
	const nodePrefix = path.dirname(path.dirname(process.execPath));
	const defaultPrefix = inherited.PREFIX || (inherited.DESTDIR ? path.join(inherited.DESTDIR, nodePrefix) : nodePrefix);
	const prefix = configPath(settings.prefix || user.prefix || defaultPrefix);
	const globalFile = configPath(settings.globalconfig || user.globalconfig || path.join(prefix, "etc/npmrc"));
	return [await readOptional(globalFile), userContents];
}

export async function registryBuildEnv(configDir, registry, inherited = process.env) {
	const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(?:npm_config_|pnpm_|corepack_|npm_(?:token|auth_token|auth|password|username)$|node_auth_token$|yarn_npm_auth_token$)/i.test(key)));
	const auth = new Map();
	if (registry === defaultRegistry) {
		for (const contents of await progetAuthSources(inherited)) for (const [key, value] of progetAuth(contents, inherited)) auth.set(key, value);
		const authEnv = Object.entries(inherited).filter(([key, value]) => /^npm_config_\/\//i.test(key) && value !== "").map(([key, value]) => `${key.slice(11)}=${JSON.stringify(value)}`).join("\n");
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
		npm_config_replace_registry_host: "npmjs",
		NPM_CONFIG_REPLACE_REGISTRY_HOST: "npmjs",
		npm_config_loglevel: "error", NPM_CONFIG_LOGLEVEL: "error",
		npm_config_manage_package_manager_versions: "false", npm_config_ignore_pnpmfile: "true",
		XDG_CONFIG_HOME: xdg, PNPM_HOME: path.join(configDir, "pnpm"),
		COREPACK_NPM_REGISTRY: registry.replace(/\/$/, ""), COREPACK_HOME: path.join(configDir, "corepack"),
		COREPACK_ENABLE_PROJECT_SPEC: "0", COREPACK_ENABLE_ENV_FILE: "0",
	};
}

function parseYaml(contents) {
	try { return loadYaml(contents, { schema: JSON_SCHEMA }); }
	catch { throw new Error("Unsupported YAML package-manager data; no configuration values are displayed"); }
}

function routeRegistryUrl(value, registry) {
	return value.replace(/^https?:\/\/(?:registry\.npmjs\.(?:org|com)|registry\.yarnpkg\.com|proget\.onbase\.net\/npm\/npm)(?=\/|$)\/?/i, `${registry.replace(/\/$/, "")}/`);
}

function selectedRegistryUrl(value, registry) {
	try {
		const url = new URL(value);
		const target = new URL(registry);
		return value.startsWith(`${registry.replace(/\/$/, "")}/`) && url.origin === target.origin && url.pathname.startsWith(`${target.pathname.replace(/\/$/, "")}/`) && !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}

function externalDependency(value) {
	if (/^(?:workspace:|catalog:|link:|file:(?!\/\/[^/])|npm:)/.test(value)) return false;
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/|git@|[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#.*)?$)/i.test(value);
}

export async function checkMulticaConfiguration(root, registry) {
	const fail = () => { throw new Error("Unsupported Multica package-manager configuration; refusing to start pnpm. Configuration dependencies, hooks, registry overrides and foreign tarballs are forbidden; no configuration values are displayed."); };
	const forbidden = (key) => /configdependencies|pnpmfile|registr(?:y|ies)|managepackagemanagerversions|lockfile|workspacedir/.test(key.replace(/[^a-z]/gi, "").toLowerCase());
	const seen = new Set();
	const walk = (value, dependencies = false) => {
		if (typeof value === "string") {
			if ((dependencies && externalDependency(value) || /\.(?:tgz|tar\.gz)(?:[?#]|$)/i.test(value)) && !selectedRegistryUrl(value, registry)) fail();
			return;
		}
		if (!value || typeof value !== "object") return;
		if (seen.has(value)) fail();
		seen.add(value);
		for (const [key, child] of Object.entries(value)) {
			if (forbidden(key)) fail();
			walk(child, dependencies || /^(?:dependencies|devDependencies|optionalDependencies|peerDependencies|overrides|resolutions|catalog|catalogs)$/.test(key));
		}
	};
	try {
		const manifest = JSON.parse(await readOptional(path.join(root, "package.json")));
		if (manifest.packageManager && manifest.packageManager !== "pnpm@10.28.2") fail();
		if (manifest.pnpm && Object.keys(manifest.pnpm).some((key) => !["onlyBuiltDependencies", "overrides", "patchedDependencies"].includes(key))) fail();
		walk(manifest);
		const workspace = parseYaml(await readOptional(path.join(root, "pnpm-workspace.yaml")));
		if (workspace && (typeof workspace !== "object" || Array.isArray(workspace) || Object.keys(workspace).some((key) => !["packages", "catalog", "catalogs"].includes(key)))) fail();
		walk(workspace);
	} catch { fail(); }
	for (const line of (await readOptional(path.join(root, ".npmrc"))).split(/\r?\n/)) {
		if (!/^\s*(?:[;#].*)?$/.test(line) && !/^\s*shamefully-hoist\s*=\s*true\s*$/.test(line)) fail();
	}
	for (const name of [".pnpmfile.cjs", ".pnpmfile.mjs", ".pnpmfile.js", "npm-shrinkwrap.json", "pnpm-lock.yml"]) {
		const entry = await lstat(path.join(root, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
		if (entry) fail();
	}
}

export async function prepareRegistry(root, registry, hoist = false) {
	const fail = () => { throw new Error("A foreign package download or unpinned Git source remains in a lockfile; refusing to install dependencies"); };
	if (await readOptional(path.join(root, "npm-shrinkwrap.json"))) fail();
	for (const file of lockfiles(root)) {
		const contents = await readOptional(file);
		if (!contents) continue;
		const json = file.endsWith(".json");
		let parsed;
		try { parsed = json ? JSON.parse(contents) : parseYaml(contents); } catch { fail(); }
		let changed = false;
		const pins = new Set();
		let gitResolved = false;
		const seen = new Set();
		const walk = (value, key = "", packageName = "", dependencies = false) => {
			if (typeof value === "string") {
				if (["resolved", "tarball"].includes(key) || (["specifier", "version"].includes(key) || dependencies) && externalDependency(value) || /^(?:git[+:]|github:|gitlab:|bitbucket:)/i.test(value)) {
					const routed = routeRegistryUrl(value, registry);
					if (selectedRegistryUrl(routed, registry)) { changed ||= routed !== value; return routed; }
					const git = value.match(/^git\+(?:https:\/\/|ssh:\/\/git@)github\.com\/electron\/node-gyp\.git#([0-9a-f]{40})$/);
					if (json && packageName === "@electron/node-gyp" && git) {
						pins.add(git[1]);
						if (key === "resolved") gitResolved = true;
					} else if (!/^(?:file:(?!\/\/[^/])|link:(?!\/\/)|workspace:|\.\.?\/)/.test(value)) fail();
				}
				return value;
			}
			if (!value || typeof value !== "object") return value;
			if (seen.has(value)) fail();
			seen.add(value);
			for (const [childKey, child] of Object.entries(value)) {
				if (childKey === "resolved" && value.link === true && typeof child === "string" && !/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(child)) continue;
				const name = childKey.includes("node_modules/") ? childKey.split("node_modules/").at(-1) : dependencies ? childKey : packageName;
				value[childKey] = walk(child, childKey, name, dependencies && typeof child === "string" || /^(?:dependencies|devDependencies|optionalDependencies|peerDependencies|overrides|resolutions)$/.test(childKey));
			}
			return value;
		};
		walk(parsed);
		if (pins.size > 1 || pins.size && !gitResolved) fail();
		if (changed) await writeFile(file, json ? `${JSON.stringify(parsed, null, "\t")}\n` : dumpYaml(parsed, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }), "utf8");
	}
	await writeFile(path.join(root, ".npmrc"), `registry=${registry}\n@jsr:registry=${registry}\n${hoist ? "shamefully-hoist=true\n" : ""}`, "utf8");
}

async function plistSet(plistPath, key, value) {
	const add = await commandResult("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], { stdio: "ignore" });
	if (add.status !== 0) await run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

async function plistRead(plistPath, key) {
	return capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
}

async function clearQuarantine(appPath) {
	const attributes = await commandResult("/usr/bin/xattr", ["-lr", appPath], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
	if (attributes.status !== 0) throw new Error("Could not inspect app quarantine attributes");
	if (attributes.stdout.includes("com.apple.quarantine")) await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath]);
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
	await run("npm", [
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
		const license = await captureBytes("/usr/bin/tar", ["-xOzf", archive, member]);
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
	const goEnv = daemonBuildEnv({ cwd: path.join(repoRoot, "backend") });
	const configDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-npm-"));
	const cleanup = () => rmSync(configDir, { recursive: true, force: true });
	const signals = new Map([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ].map(([signal, code]) => [signal, () => {
		cleanup();
		for (const child of activeChildren) child.kill(signal);
		process.exit(code);
	}]));
	const onExit = () => { cleanup(); for (const child of activeChildren) child.kill("SIGTERM"); };
	process.on("exit", onExit);
	process.on("uncaughtExceptionMonitor", cleanup);
	for (const [signal, handler] of signals) process.on(signal, handler);
	try {
		return await buildWithRegistry(options, registry, await registryBuildEnv(configDir, registry), goEnv, cleanup);
	} finally {
		cleanup();
		process.off("exit", onExit);
		process.off("uncaughtExceptionMonitor", cleanup);
		for (const [signal, handler] of signals) process.off(signal, handler);
	}
}

async function buildWithRegistry(options, registry, npmEnv, goEnv, cleanup) {
	await supportedHost(npmEnv);
	const commit = await capture("git", ["rev-parse", "--verify", `${options.ref}^{commit}`], { cwd: repoRoot });
	const version = stampVersion(options.baseVersion, commit);
	const outputDir = path.resolve(options.output || path.join(defaultOutputRoot, `noetaxis-${commit.slice(0, 7)}`));
	if (isWithin("/Applications", outputDir)) throw new Error("Build output must be outside /Applications");
	if (isWithin(repoRoot, outputDir)) throw new Error("Build output must be outside the AO checkout");
	const outputEntries = await readdir(outputDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
	if (outputEntries.length > 0) throw new Error(`Build output directory is not empty: ${outputDir}`);
	await mkdir(outputDir, { recursive: true });
	const workDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-build-"));
	const sourceWorktree = path.join(workDir, "ao-source");
	let worktreeAdded = false;
	try {
		await run("git", ["worktree", "add", "--detach", sourceWorktree, commit], { cwd: repoRoot });
		worktreeAdded = true;
		const goMod = await readFile(path.join(sourceWorktree, "backend/go.mod"), "utf8");
		const multicaPin = parseMulticaPin(goMod);
		const frontendDir = path.join(sourceWorktree, "frontend");
		const productUiDir = path.join(sourceWorktree, "packages/product-ui");
		const multicaDir = path.join(workDir, "multica");
		for (const directory of [sourceWorktree, frontendDir, productUiDir, path.join(frontendDir, "acp-runtime")]) await prepareRegistry(directory, registry);
		await run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: frontendDir, env: npmEnv });
		await run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: productUiDir, env: npmEnv });
		const licenseDir = await seedAgentBrowserLicenses(workDir, npmEnv, frontendDir);
		await run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://${multicaPin.repository}.git`, multicaDir], { cwd: workDir });
		await run("git", ["-C", multicaDir, "checkout", "--detach", multicaPin.shortRevision]);
		await checkMulticaConfiguration(multicaDir, registry);
		await prepareRegistry(multicaDir, registry, true);
		const pnpmEnv = registry === defaultRegistry ? { ...npmEnv, ...corepackEnv } : npmEnv;
		const pnpmCommand = "corepack";
		await run(pnpmCommand, ["pnpm@10.28.2", "--ignore-pnpmfile", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`], {
			cwd: multicaDir,
			env: pnpmEnv,
		});
		await run(pnpmCommand, ["pnpm@10.28.2", "--config.ignore-pnpmfile=true", "--filter", "@multica/desktop", "exec", "electron-vite", "build"], {
			cwd: multicaDir,
			env: npmEnv,
		});
		const multicaRevision = await capture("git", ["-C", multicaDir, "rev-parse", "HEAD"]);
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
		await run("npm", ["run", "build:daemon"], { cwd: frontendDir, env: buildEnv });
		await updateFrontendVersion(frontendDir, version);
		await run("npm", ["run", "build:tmux"], { cwd: frontendDir, env: buildEnv });
		await run("npm", ["run", "browser-runtime:prepare"], { cwd: frontendDir, env: buildEnv });
		await run("npm", ["run", "build:acp-runtime"], { cwd: frontendDir, env: buildEnv });
		const forgeOut = path.join(frontendDir, "out");
		const forgeBin = path.join(frontendDir, "node_modules/.bin/electron-forge");
		await run(forgeBin, ["package", "--platform=darwin", "--arch=arm64"], { cwd: frontendDir, env: buildEnv });
		cleanup();
		const packagedApp = await findAppBundle(forgeOut);
		if (!packagedApp) throw new Error(`electron-forge did not create ${appName} in ${forgeOut}`);
		const resources = path.join(packagedApp, "Contents/Resources");
		if (!(await readFile(path.join(resources, "ao-updates-disabled")).catch(() => undefined))) {
			throw new Error("Packaged app is missing the updates-disabled marker");
		}
		const infoPlist = path.join(packagedApp, "Contents/Info.plist");
		const databaseSchema = parseDatabaseSchema(sourceWorktree);
		await plistSet(infoPlist, "NoetaxisSourceRevision", commit);
		await plistSet(infoPlist, "NoetaxisBuildRef", commit);
		await plistSet(infoPlist, "NoetaxisDatabaseSchema", String(databaseSchema));
		await plistSet(infoPlist, "NoetaxisMulticaRevision", multicaRevision);
		if (await plistRead(infoPlist, "CFBundleShortVersionString") !== version || await plistRead(infoPlist, "CFBundleVersion") !== version) {
			throw new Error("Packaged app does not contain the requested version stamp");
		}
		const dictationHelper = path.join(resources, "dictation-helper", "ao-dictation");
		await run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", path.join(frontendDir, "native/dictation/entitlements.plist"), dictationHelper]);
		await run("/usr/bin/codesign", ["--force", "--deep", "--preserve-metadata=entitlements", "--sign", "-", "--timestamp=none", packagedApp]);
		await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", packagedApp]);
		await clearQuarantine(packagedApp);
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
			const remove = await commandResult("git", ["worktree", "remove", "--force", sourceWorktree], { cwd: repoRoot, stdio: "ignore" });
			if (remove.status !== 0) {
				await makeTemporaryWritable(sourceWorktree);
				await commandResult("git", ["worktree", "remove", "--force", sourceWorktree], { cwd: repoRoot, stdio: "ignore" });
			}
		}
		await makeTemporaryWritable(workDir);
		await rm(workDir, { recursive: true, force: true });
		if (worktreeAdded) await commandResult("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" });
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
