import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
const usage = "Usage: build.mjs [--ref <commit-or-tag>] [--base-version <x.y.z>] [--output <directory>] [--public-registry] [--registry <url>] [--source-patch <binary-patch> --source-patch-sha256 <hash> --source-tree <git-tree>] [--multica-input <manifest.json> --multica-input-sha256 <hash>]\nSource patches are complete base-relative overlays, verified in a fresh worktree. Their version suffix identifies the full source tree, not a clean commit. Snapshot builds require a matched Multica input manifest; no historical module fallback.\nDefault: https://proget.onbase.net/npm/npm (company VPN). --public-registry explicitly selects https://registry.npmjs.org/ without company npm credentials. --registry must match the selected mode; no other endpoints are allowed.";
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
		if (!["--ref", "--output", "--base-version", "--registry", "--source-patch", "--source-patch-sha256", "--source-tree", "--multica-input", "--multica-input-sha256"].includes(name) || !args[index + 1]) {
			throw new Error(usage);
		}
		const key = { "--ref": "ref", "--output": "output", "--base-version": "baseVersion", "--registry": "registry",
			"--source-patch": "sourcePatch", "--source-patch-sha256": "sourcePatchSha256", "--source-tree": "sourceTree",
			"--multica-input": "multicaInput", "--multica-input-sha256": "multicaInputSha256" }[name];
		options[key] = args[index + 1];
		if (key === "registry") explicitRegistry = options[key];
		index += 1;
	}
	if (options.publicRegistry) options.registry = explicitRegistry || publicRegistry;
	validateSourceOptions(options);
	return options;
}

export function validateSourceOptions(options) {
	const snapshot = [options.sourcePatch, options.sourcePatchSha256, options.sourceTree];
	if (snapshot.some(Boolean) && !snapshot.every(Boolean)) throw new Error("Source snapshots require --source-patch, --source-patch-sha256 and --source-tree together");
	if (options.sourceTree && !/^[0-9a-f]{40}$/.test(options.sourceTree)) throw new Error("Source tree must be a full SHA-1 Git tree");
	for (const hash of [options.sourcePatchSha256, options.multicaInputSha256]) {
		if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Input checksums must be full SHA-256 hashes");
	}
	if (Boolean(options.multicaInput) !== Boolean(options.multicaInputSha256)) throw new Error("Matched Multica requires --multica-input and --multica-input-sha256 together");
	if (options.sourcePatch && !options.multicaInput) throw new Error("Source snapshots require explicit matched Multica inputs");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function verifiedBytes(file, expected, label) {
	if (typeof file !== "string" || !path.isAbsolute(file) || !(await lstat(file)).isFile()) throw new Error(`${label} must be an absolute regular file`);
	const bytes = await readFile(file);
	if (!/^[0-9a-f]{64}$/.test(expected) || sha256(bytes) !== expected) throw new Error(`${label} checksum mismatch`);
	return bytes;
}

export async function applySourceSnapshot(sourceWorktree, options, workDir) {
	validateSourceOptions(options);
	if (!options.sourcePatch) return undefined;
	const bytes = await verifiedBytes(path.resolve(options.sourcePatch), options.sourcePatchSha256, "Source patch");
	const patch = path.join(workDir, "source.patch");
	await writeFile(patch, bytes, { mode: 0o600 });
	await run("git", ["apply", "--check", "--index", patch], { cwd: sourceWorktree });
	await run("git", ["apply", "--index", patch], { cwd: sourceWorktree });
	const tree = await capture("git", ["write-tree"], { cwd: sourceWorktree });
	if (tree !== options.sourceTree) throw new Error("Applied source tree does not match the reviewed full tree");
	return { kind: "staged-tree", tree, patchSha256: options.sourcePatchSha256 };
}

// Hash immutable exports with Git's tree format, without creating refs or running filters.
export async function exportedSourceTree(directory) {
	const root = path.resolve(directory);
	if (!(await lstat(root)).isDirectory()) throw new Error("Source export must be a real directory");
	const canonicalRoot = await realpath(root);
	const objectHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest();
	async function tree(dir) {
		const entries = [];
		for (const name of await readdir(dir)) {
			if (name === ".git") throw new Error("Source exports must not contain Git metadata");
			const file = path.join(dir, name);
			const stat = await lstat(file);
			let mode, hash;
			if (stat.isDirectory()) {
				mode = "40000"; hash = await tree(file);
				if (hash.equals(objectHash("tree", Buffer.alloc(0)))) continue;
			}
			else if (stat.isFile()) { mode = stat.mode & 0o111 ? "100755" : "100644"; hash = objectHash("blob", await readFile(file)); }
			else if (stat.isSymbolicLink()) {
				const target = await readlink(file);
				if (path.isAbsolute(target) || !isWithin(root, path.resolve(dir, target))
					|| !isWithin(canonicalRoot, await realpath(file))) throw new Error("Source export symlink escapes its root");
				mode = "120000"; hash = objectHash("blob", Buffer.from(target));
			} else throw new Error("Unsupported file in source export");
			entries.push({ name, mode, hash });
		}
		entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === "40000" ? "/" : "")), Buffer.from(b.name + (b.mode === "40000" ? "/" : ""))));
		return objectHash("tree", Buffer.concat(entries.map(({ name, mode, hash }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), hash]))));
	}
	return (await tree(root)).toString("hex");
}

export function verifyMatchedModfile(source, override) {
	const withoutBinding = (text) => text.replace(/^replace github\.com\/multica-ai\/multica\/server => .+$/gm, "").replace(/\s+/g, " ").trim();
	if (withoutBinding(source) !== withoutBinding(override)) throw new Error("Matched backend modfile changes dependencies outside the Multica binding");
}

export async function stageMatchedMultica(manifestPath, expectedHash, workDir, sourceGoMod) {
	const bytes = await verifiedBytes(path.resolve(manifestPath), expectedHash, "Multica input manifest");
	const input = JSON.parse(bytes.toString("utf8"));
	if (!input || input.version !== 1 || !/^[0-9a-f]{40}$/.test(input.source?.baseRevision)) throw new Error("Unsupported Multica provenance manifest");
	for (const name of ["source", "server", "desktop", "notices"]) {
		const entry = input[name];
		if (!entry || typeof entry.directory !== "string" || !path.isAbsolute(entry.directory) || !/^[0-9a-f]{40}$/.test(entry.tree)
			|| await exportedSourceTree(entry.directory) !== entry.tree) throw new Error(`Multica ${name} tree mismatch`);
	}
	if (await exportedSourceTree(path.join(input.source.directory, "server")) !== input.server.tree) throw new Error("Multica server export does not match the full source");
	await verifiedBytes(input.source.overlay?.file, input.source.overlay?.sha256, "Multica source overlay");
	const mod = await verifiedBytes(input.modfile?.file, input.modfile?.sha256, "Backend modfile");
	const sum = await verifiedBytes(input.sumfile?.file, input.sumfile?.sha256, "Backend sumfile");
	const cli = await verifiedBytes(input.cli?.file, input.cli?.sha256, "Multica CLI");
	if (!cli.length || !((await lstat(input.cli.file)).mode & 0o111)) throw new Error("Multica CLI must be a nonempty executable");
	const moduleText = mod.toString("utf8");
	const expectedReplace = `replace ${multicaModule} => ${input.server.directory}`;
	const replacements = moduleText.split(/\r?\n/).filter((line) => /^\s*replace\b/.test(line));
	if (!/^module github\.com\/aoagents\/agent-orchestrator\/backend\s*$/m.test(moduleText)
		|| replacements.length !== 1 || replacements[0].trim() !== expectedReplace) throw new Error("Backend modfile must bind only the exact verified Multica server export");
	if (sourceGoMod !== undefined) verifyMatchedModfile(sourceGoMod, moduleText);
	if (/\s/.test(input.server.directory) || /\s/.test(workDir)) throw new Error("Matched Go module staging requires paths without whitespace");
	for (const name of ["LICENSE", "NOTICE"]) {
		const file = path.join(input.notices.directory, name);
		if (!(await lstat(file)).isFile() || !(await readFile(file)).length) throw new Error(`Multica ${name} must be a nonempty regular file`);
	}
	const serverMod = await readFile(path.join(input.server.directory, "go.mod"), "utf8");
	if (!new RegExp(`^module ${multicaModule.replaceAll(".", "\\.")}\\s*$`, "m").test(serverMod)) throw new Error("Multica server module identity mismatch");
	const staged = {};
	for (const name of ["server", "desktop", "notices"]) {
		staged[name] = path.join(workDir, `matched-${name}`);
		await cp(input[name].directory, staged[name], { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		if (await exportedSourceTree(staged[name]) !== input[name].tree) throw new Error(`Multica ${name} changed while staging`);
	}
	if (await exportedSourceTree(input.source.directory) !== input.source.tree) throw new Error("Multica full source changed while staging");
	staged.cli = path.join(workDir, "matched-multica");
	await writeFile(staged.cli, cli, { mode: 0o755 });
	staged.modfile = path.join(workDir, "matched.mod");
	const stagedModule = moduleText.replace(expectedReplace, `replace ${multicaModule} => ${staged.server}`);
	await writeFile(staged.modfile, stagedModule, { mode: 0o600 });
	await writeFile(path.join(workDir, "matched.sum"), sum, { mode: 0o600 });
	return { ...staged, provenance: { ...input, manifestSha256: expectedHash, stagedModfileSha256: sha256(stagedModule) } };
}

export function matchedBuildEnv(matched, inherited) {
	return {
		...inherited, GOWORK: "off", GOFLAGS: `-modfile=${matched.modfile} -mod=readonly`,
		AO_MULTICA_DESKTOP_OUT: matched.desktop, AO_MULTICA_CLI_BIN: matched.cli, AO_MULTICA_NOTICE_DIR: matched.notices,
	};
}

export function signingIdentity(env = process.env) {
	const identity = env.NOETAXIS_SIGN_IDENTITY?.trim() || "-";
	if (/[\r\n\u0000]/.test(identity)) throw new Error("NOETAXIS_SIGN_IDENTITY must be a certificate name or fingerprint");
	return identity;
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
		npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true",
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

export function parseDatabaseSchema(root) {
	const migrationDir = path.join(root, "backend/internal/storage/sqlite/migrations");
	const names = readdirSync(migrationDir);
	const versions = names.map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1]).filter(Boolean).map(BigInt);
	if (versions.length === 0) throw new Error(`No SQLite migrations found in ${migrationDir}`);
	return versions.reduce((highest, version) => version > highest ? version : highest, 0n).toString();
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

export function packagingSteps(packageJson) {
	const prepackage = packageJson.scripts?.prepackage;
	if (typeof prepackage !== "string" || !prepackage.trim()) throw new Error("Missing frontend prepackage prerequisites");
	return prepackage.split("&&").map((step) => {
		const match = /^npm run ([A-Za-z0-9][A-Za-z0-9:_-]*)$/.exec(step.trim());
		if (!match || typeof packageJson.scripts[match[1]] !== "string") {
			throw new Error("Unsupported frontend prepackage prerequisite; expected npm run <script> with no shell options");
		}
		return match[1];
	});
}

export async function verifyBrowserResources(directory) {
	for (const file of ["browser-extension/manifest.json", "browser-extension/background.js", "browser-extension/content.js", "cloudflared/cloudflared", "cloudflared/LICENSE-cloudflared"]) {
		const stat = await lstat(path.join(directory, file)).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing or empty packaging resource: ${file}`);
	}
}

export async function buildNoetaxis(options) {
	validateSourceOptions(options);
	const identity = signingIdentity();
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
		return await buildWithRegistry(options, registry, await registryBuildEnv(configDir, registry), goEnv, cleanup, identity);
	} finally {
		cleanup();
		process.off("exit", onExit);
		process.off("uncaughtExceptionMonitor", cleanup);
		for (const [signal, handler] of signals) process.off(signal, handler);
	}
}

async function buildWithRegistry(options, registry, npmEnv, goEnv, cleanup, identity) {
	await supportedHost(npmEnv);
	const commit = await capture("git", ["rev-parse", "--verify", `${options.ref}^{commit}`], { cwd: repoRoot });
	const sourceRevision = options.sourceTree || commit;
	const version = stampVersion(options.baseVersion, sourceRevision);
	const outputDir = path.resolve(options.output || path.join(defaultOutputRoot, `noetaxis-${sourceRevision.slice(0, 7)}`));
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
		const snapshot = await applySourceSnapshot(sourceWorktree, options, workDir);
		const goMod = await readFile(path.join(sourceWorktree, "backend/go.mod"), "utf8");
		const matched = options.multicaInput ? await stageMatchedMultica(options.multicaInput, options.multicaInputSha256, workDir, goMod) : undefined;
		const multicaPin = matched ? undefined : parseMulticaPin(goMod);
		const frontendDir = path.join(sourceWorktree, "frontend");
		const prerequisites = packagingSteps(JSON.parse(await readFile(path.join(frontendDir, "package.json"), "utf8")));
		const productUiDir = path.join(sourceWorktree, "packages/product-ui");
		const multicaDir = path.join(workDir, "multica");
		for (const directory of [sourceWorktree, frontendDir, productUiDir, path.join(frontendDir, "acp-runtime")]) await prepareRegistry(directory, registry);
		await run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: frontendDir, env: npmEnv });
		await run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", npmEnv.npm_config_replace_registry_host], { cwd: productUiDir, env: npmEnv });
		const licenseDir = await seedAgentBrowserLicenses(workDir, npmEnv, frontendDir);
		let multicaRevision, multicaOut;
		if (matched) {
			multicaRevision = matched.provenance.source.tree;
			multicaOut = matched.desktop;
		} else {
			await run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://${multicaPin.repository}.git`, multicaDir], { cwd: workDir });
			await run("git", ["-C", multicaDir, "checkout", "--detach", multicaPin.shortRevision]);
			await checkMulticaConfiguration(multicaDir, registry);
			await prepareRegistry(multicaDir, registry, true);
			const pnpmEnv = registry === defaultRegistry ? { ...npmEnv, ...corepackEnv } : npmEnv;
			await run("corepack", ["pnpm@10.28.2", "--ignore-pnpmfile", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`], { cwd: multicaDir, env: pnpmEnv });
			await run("corepack", ["pnpm@10.28.2", "--config.ignore-pnpmfile=true", "--filter", "@multica/desktop", "exec", "electron-vite", "build"], { cwd: multicaDir, env: npmEnv });
			multicaRevision = await capture("git", ["-C", multicaDir, "rev-parse", "HEAD"]);
			if (!multicaRevision.startsWith(multicaPin.shortRevision)) throw new Error("Multica checkout does not match backend/go.mod pin");
			multicaOut = path.join(multicaDir, "apps/desktop/out");
		}
		const buildEnv = {
			...(matched ? matchedBuildEnv(matched, npmEnv) : npmEnv),
			CGO_ENABLED: goEnv.CGO_ENABLED,
			AO_MULTICA_DESKTOP_OUT: multicaOut,
			AO_BUILD_SOURCE_REVISION: snapshot ? `tree-${sourceRevision}` : undefined,
			AO_RELEASE_REPO: "amolodyh-hyland/agent-orchestrator",
			AO_SCRATCH_SWIFT_CACHE: path.join(workDir, "swift-cache"),
			AO_AGENT_BROWSER_LICENSE_DIR: licenseDir,
		};
		await updateFrontendVersion(frontendDir, version);
		for (const step of prerequisites) {
			await run("npm", ["--ignore-scripts", "run", step], { cwd: frontendDir, env: buildEnv });
		}
		await verifyBrowserResources(frontendDir);
		const forgeOut = path.join(frontendDir, "out");
		const forgeBin = path.join(frontendDir, "node_modules/.bin/electron-forge");
		await run(forgeBin, ["package", "--platform=darwin", "--arch=arm64"], { cwd: frontendDir, env: buildEnv });
		cleanup();
		if (matched) {
			await verifiedBytes(matched.modfile, matched.provenance.stagedModfileSha256, "Staged backend modfile");
			await verifiedBytes(path.join(workDir, "matched.sum"), matched.provenance.sumfile.sha256, "Staged backend sumfile");
			await verifiedBytes(matched.cli, matched.provenance.cli.sha256, "Staged Multica CLI");
			for (const name of ["server", "desktop", "notices"]) {
				if (await exportedSourceTree(matched[name]) !== matched.provenance[name].tree) throw new Error(`Staged Multica ${name} changed during the build`);
			}
		}
		const packagedApp = await findAppBundle(forgeOut);
		if (!packagedApp) throw new Error(`electron-forge did not create ${appName} in ${forgeOut}`);
		const resources = path.join(packagedApp, "Contents/Resources");
		await verifyBrowserResources(resources);
		if (!(await readFile(path.join(resources, "ao-updates-disabled")).catch(() => undefined))) {
			throw new Error("Packaged app is missing the updates-disabled marker");
		}
		const infoPlist = path.join(packagedApp, "Contents/Info.plist");
		const databaseSchema = parseDatabaseSchema(sourceWorktree);
		await plistSet(infoPlist, "NoetaxisSourceRevision", sourceRevision);
		await plistSet(infoPlist, "NoetaxisBuildRef", commit);
		if (snapshot) {
			await plistSet(infoPlist, "NoetaxisSourceKind", snapshot.kind);
			await plistSet(infoPlist, "NoetaxisSourceTree", snapshot.tree);
			await plistSet(infoPlist, "NoetaxisSourcePatchSHA256", snapshot.patchSha256);
		}
		await plistSet(infoPlist, "NoetaxisDatabaseSchema", String(databaseSchema));
		await plistSet(infoPlist, "NoetaxisMulticaRevision", multicaRevision);
		if (await plistRead(infoPlist, "CFBundleShortVersionString") !== version || await plistRead(infoPlist, "CFBundleVersion") !== version) {
			throw new Error("Packaged app does not contain the requested version stamp");
		}
		const dictationBundle = path.join(resources, "dictation-helper", "Orchestrator.app");
		const dictationHelper = path.join(dictationBundle, "Contents", "MacOS", "Orchestrator");
		if (!(await lstat(dictationHelper)).isFile()) throw new Error("Packaged dictation helper app executable is missing");
		const dictationEntitlements = path.join(frontendDir, "native/dictation/entitlements.plist");
		await run("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp=none", "--entitlements", dictationEntitlements, dictationBundle]);
		await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", dictationBundle]);
		await run("/usr/bin/codesign", ["--force", "--deep", "--preserve-metadata=entitlements", "--sign", identity, "--timestamp=none", packagedApp]);
		await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", packagedApp]);
		await clearQuarantine(packagedApp);
		const outputApp = path.join(outputDir, "Applications", "Agent Orchestrator.app");
		await mkdir(path.dirname(outputApp), { recursive: true });
		await cp(packagedApp, outputApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		const packaged = await buildPackages({ appPath: outputApp, outputDir, version, revision: sourceRevision });
		const provenance = { ao: { baseRevision: commit, revision: sourceRevision, ...(snapshot || { kind: "commit" }) }, multica: matched?.provenance || { kind: "commit", revision: multicaRevision } };
		await writeFile(path.join(outputDir, "SOURCE-PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
		const buildInfo = [
			`Version: ${version}`,
			`AO source revision: ${sourceRevision}${snapshot ? " (staged Git tree, not a commit)" : ""}`,
			`AO base revision: ${commit}`,
			...(snapshot ? [`AO source tree: ${snapshot.tree}`, `AO overlay SHA-256: ${snapshot.patchSha256}`] : []),
			`Multica source revision: ${multicaRevision}${matched ? " (exported source tree)" : ""}`,
			`Database schema: ${databaseSchema}`,
			`Registry: ${new URL(registry).host}`,
			`Signature: ${identity === "-" ? "ad-hoc" : identity}; not notarized`,
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
		console.log(`AO revision: ${sourceRevision}${snapshot ? " (staged tree)" : ""}; base: ${commit}`);
		console.log(`Multica revision: ${multicaRevision}`);
		return { outputDir, appPath: outputApp, version, commit, sourceRevision, multicaRevision };
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
