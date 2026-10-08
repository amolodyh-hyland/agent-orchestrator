import { cp, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackages } from "./package-artifacts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const defaultRegistry = "https://proget.onbase.net/npm/npm";
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

function parseArgs(args) {
	const options = { ref: "HEAD", baseVersion: defaultBaseVersion, registry: process.env.NOETAXIS_NPM_REGISTRY || defaultRegistry };
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index];
		if (name === "-h" || name === "--help") {
			options.help = true;
			continue;
		}
		if (!["--ref", "--output", "--base-version", "--registry"].includes(name) || !args[index + 1]) {
			throw new Error("Usage: build.mjs [--ref <commit-or-tag>] [--base-version <x.y.z>] [--output <directory>] [--registry <internal-proget-url>]");
		}
		const key = { "--ref": "ref", "--output": "output", "--base-version": "baseVersion", "--registry": "registry" }[name];
		options[key] = args[index + 1];
		index += 1;
	}
	return options;
}

export function parseMulticaPin(goMod) {
	const line = goMod.split(/\r?\n/).find((entry) => entry.trim().startsWith(`replace ${multicaModule} => `));
	const match = line?.trim().match(/^replace\s+github\.com\/multica-ai\/multica\/server\s+=>\s+(github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/server\s+(v0\.0\.0-\d{14}-([0-9a-f]{12}))$/);
	if (!match) throw new Error(`Could not read the pinned Multica server revision from backend/go.mod: ${line || "replace directive missing"}`);
	return { repository: match[1], version: match[2], shortRevision: match[3] };
}

export function validateRegistry(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Registry must be the internal ProGet npm endpoint https://proget.onbase.net/npm/npm");
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "proget.onbase.net" || parsed.pathname.replace(/\/$/, "") !== "/npm/npm" || parsed.username || parsed.password || parsed.search || parsed.hash) {
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

function supportedHost() {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The custom desktop build requires an Apple Silicon Mac and macOS");
	const npmVersion = capture("npm", ["--version"]);
	const npmMajor = Number(npmVersion.split(".")[0]);
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor < 24 || npmMajor < 11) throw new Error(`Node 24 and npm 11 are required; found Node ${process.versions.node} and npm ${npmVersion}`);
	if (!capture("uname", ["-m"]).includes("arm64")) throw new Error("The build host must run natively as arm64");
}

function lockfiles(root) {
	return ["package-lock.json", "pnpm-lock.yaml"].map((name) => path.join(root, name));
}

async function routeLockfilesToInternalRegistry(root, registry) {
	for (const file of lockfiles(root)) {
		let contents;
		try {
			contents = await readFile(file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		const routed = contents
			.replaceAll("https://registry.npmjs.org", registry)
			.replaceAll("http://registry.npmjs.org", registry)
			.replaceAll("https://registry.npmjs.com", registry)
			.replaceAll("https://registry.yarnpkg.com", registry);
		if (/https?:\/\/(?:registry\.npmjs\.org|registry\.npmjs\.com|registry\.yarnpkg\.com)\//i.test(routed)) {
			throw new Error(`A public npm registry URL remains in ${file}; refusing to install dependencies`);
		}
		if (routed !== contents) await writeFile(file, routed, "utf8");
	}
}

function plistSet(plistPath, key, value) {
	const add = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], { stdio: "ignore" });
	if (add.status !== 0) run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

function plistRead(plistPath, key) {
	return capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
}

function clearQuarantine(appPath) {
	const attributes = spawnSync("/usr/bin/xattr", ["-lr", appPath], { encoding: "utf8" });
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

async function internalRegistryEnv(registry) {
	return {
		...process.env,
		npm_config_registry: registry,
		NPM_CONFIG_REGISTRY: registry,
		npm_config_replace_registry_host: "npmjs",
		NPM_CONFIG_REPLACE_REGISTRY_HOST: "npmjs",
		npm_config_loglevel: "error",
		NPM_CONFIG_LOGLEVEL: "error",
		COREPACK_NPM_REGISTRY: registry,
	};
}

async function seedAgentBrowserLicenses(workDir, env, frontendDir) {
	const archiveDir = path.join(workDir, "agent-browser-package");
	const licenseDir = path.join(workDir, "agent-browser-licenses");
	await mkdir(archiveDir, { recursive: true });
	await mkdir(licenseDir, { recursive: true });
	run("npm", [
		"pack", `agent-browser@${agentBrowserVersion}`, "--ignore-scripts",
		"--pack-destination", archiveDir, "--registry", env.npm_config_registry,
		"--replace-registry-host", "npmjs",
	], { cwd: frontendDir, env });
	const archive = path.join(archiveDir, (await readdir(archiveDir)).find((name) => name.endsWith(".tgz")) || "");
	if (!archive.endsWith(".tgz")) throw new Error("Internal registry did not provide the pinned agent-browser package");
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
	const registry = validateRegistry(options.registry);
	supportedHost();
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
		const npmEnv = await internalRegistryEnv(registry);
		run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", "npmjs"], { cwd: frontendDir, env: npmEnv });
		run("npm", ["ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", "npmjs"], { cwd: productUiDir, env: npmEnv });
		const licenseDir = await seedAgentBrowserLicenses(workDir, npmEnv, frontendDir);
		run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://${multicaPin.repository}.git`, multicaDir], { cwd: workDir });
		run("git", ["-C", multicaDir, "checkout", "--detach", multicaPin.shortRevision]);
		await routeLockfilesToInternalRegistry(multicaDir, registry);
		const pnpmCommand = "corepack";
		run(pnpmCommand, ["pnpm@10.28.2", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`], {
			cwd: multicaDir,
			env: { ...npmEnv, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry, COREPACK_NPM_REGISTRY: registry },
		});
		run(pnpmCommand, ["pnpm@10.28.2", "--filter", "@multica/desktop", "exec", "electron-vite", "build"], {
			cwd: multicaDir,
			env: { ...npmEnv, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry, COREPACK_NPM_REGISTRY: registry },
		});
		const multicaRevision = capture("git", ["-C", multicaDir, "rev-parse", "HEAD"]);
		if (!multicaRevision.startsWith(multicaPin.shortRevision)) throw new Error("Multica checkout does not match backend/go.mod pin");
		const multicaOut = path.join(multicaDir, "apps/desktop/out");
		const buildEnv = {
			...npmEnv,
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
		const forgeOut = path.join(workDir, "forge-out");
		const forgeBin = path.join(frontendDir, "node_modules/.bin/electron-forge");
		run(forgeBin, ["package", "--platform=darwin", "--arch=arm64", `--out-dir=${forgeOut}`], { cwd: frontendDir, env: buildEnv });
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
		run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", packagedApp]);
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
			"",
		].join("\n");
		await writeFile(path.join(outputDir, "BUILD-INFO.txt"), buildInfo, "utf8");
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
			console.log("Usage: build.mjs [--ref <commit-or-tag>] [--base-version <x.y.z>] [--output <directory>] [--registry <internal-ProGet-url>]");
		} else {
			await buildNoetaxis(options);
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
