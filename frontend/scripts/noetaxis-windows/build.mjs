import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, validateRegistry, registryBuildEnv, prepareRegistry, checkMulticaConfiguration, parseMulticaPin, parseDatabaseSchema, packagingSteps, stampVersion } from "../noetaxis-macos/build.mjs";
import { executable, repository, writeManifest } from "./common.mjs";
import { native } from "./runtime.mjs";
import { noLinks } from "./app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const children = new Set();
export async function run(command, args, options = {}) {
	const { capture = false, ...rest } = options;
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", windowsHide: true, ...rest });
		children.add(child);
		const output = [];
		let bytes = 0;
		child.stdout?.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) { child.kill(); reject(new Error("Build command output exceeded limit")); }
			else output.push(chunk);
		});
		child.once("error", (error) => { children.delete(child); reject(error); });
		child.once("close", (code) => {
			children.delete(child);
			if (code !== 0) reject(new Error(`${path.basename(command)} exited ${code}`));
			else resolve(Buffer.concat(output).toString("utf8").trim());
		});
	});
}

export async function npmCli(env = process.env) {
	const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].filter(Boolean);
	for (const candidate of candidates) if ((await stat(candidate).catch(() => null))?.isFile() && candidate.endsWith(".js")) return candidate;
	throw new Error("npm JavaScript entrypoint not found; invoke through npm run app:build (Node 24/npm 11)");
}

async function licenses(work, frontend, npm, env) {
	const archives = path.join(work, "licenses-pack");
	const destination = path.join(work, "licenses");
	await mkdir(archives); await mkdir(destination);
	await run(process.execPath, [npm, "pack", "agent-browser@0.38.1", "--ignore-scripts", "--pack-destination", archives, "--registry", env.npm_config_registry], { cwd: frontend, env });
	const archive = (await readdir(archives)).find((name) => name.endsWith(".tgz"));
	if (!archive) throw new Error("Missing pinned agent-browser notices archive");
	for (const [member, name] of [["package/LICENSE", "LICENSE-agent-browser"], ["package/cli/src/native/a11y/LICENSE-axe-core.txt", "LICENSE-axe-core"], ["package/cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt", "LICENSE-axe-core-THIRD-PARTY"]]) {
		const content = await run("tar.exe", ["-xOzf", path.join(archives, archive), member], { capture: true, env });
		if (!content) throw new Error("Empty agent-browser notice");
		await writeFile(path.join(destination, name), content + "\n");
	}
	return destination;
}

export async function build(options) {
	if (process.platform !== "win32" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) < 24) throw new Error("Build on native Windows x64 with Node 24+, npm 11+, Go, Corepack, C++ Build Tools and .NET SDK");
	const registry = validateRegistry(options.registry, options.publicRegistry);
	const npm = await npmCli();
	if (Number((await run(process.execPath, [npm, "--version"], { capture: true })).split(".")[0]) < 11) throw new Error("npm 11+ is required");
	const commit = await run("git", ["rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`], { cwd: repoRoot, capture: true });
	const tree = await run("git", ["rev-parse", `${commit}^{tree}`], { cwd: repoRoot, capture: true });
	const version = stampVersion(options.baseVersion, commit);
	const output = path.resolve(options.output || path.join(os.homedir(), "ao-builds", `noetaxis-${commit.slice(0, 7)}-win32-x64`));
	for (const forbidden of [repoRoot, path.join(os.homedir(), ".ao")]) {
		const relative = path.relative(forbidden, output);
		if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("Build output must be outside source and AO private state");
	}
	await noLinks(output);
	if ((await readdir(output).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).length) throw new Error("Output directory must be empty");
	await mkdir(output, { recursive: true });
	const work = await mkdtemp(path.join(os.tmpdir(), "ao-win-"));
	await native("private", { target: work });
	const config = path.join(work, "npm-config");
	const source = path.join(work, "source");
	let added = false;
	const handlers = new Map();
	const cleanupCredentials = () => rm(config, { recursive: true, force: true });
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
		const handler = async () => { await cleanupCredentials(); for (const child of children) child.kill(); process.exit(code); };
		handlers.set(signal, handler); process.on(signal, handler);
	}
	try {
		await mkdir(config);
		const env = await registryBuildEnv(config, registry);
		await run("git", ["worktree", "add", "--detach", source, commit], { cwd: repoRoot });
		added = true;
		const frontend = path.join(source, "frontend");
		const product = path.join(source, "packages/product-ui");
		for (const dir of [source, frontend, product, path.join(frontend, "acp-runtime")]) await prepareRegistry(dir, registry);
		for (const dir of [frontend, product]) await run(process.execPath, [npm, "ci", "--ignore-scripts", "--registry", registry, "--replace-registry-host", "npmjs"], { cwd: dir, env });
		const licenseDir = await licenses(work, frontend, npm, env);
		const multica = path.join(work, "multica");
		const pin = parseMulticaPin(await readFile(path.join(source, "backend/go.mod"), "utf8"));
		if (pin.repository !== "github.com/amolodyh-hyland/multica") throw new Error("Integrated Multica must use the configured fork");
		await run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://${pin.repository}.git`, multica]);
		const multicaRevision = await run("git", ["rev-parse", "--verify", `${pin.shortRevision}^{commit}`], { cwd: multica, capture: true });
		if (!/^[a-f0-9]{40}$/.test(multicaRevision) || !multicaRevision.startsWith(pin.shortRevision)) throw new Error("Multica source pin mismatch");
		await run("git", ["checkout", "--detach", multicaRevision], { cwd: multica });
		await checkMulticaConfiguration(multica, registry);
		await prepareRegistry(multica, registry, true);
		const globalModules = await run(process.execPath, [npm, "root", "--global"], { cwd: config, env, capture: true });
		const corepack = path.join(globalModules, "corepack/dist/corepack.js");
		if (!(await stat(corepack).catch(() => null))?.isFile()) throw new Error("Install Corepack before building; global corepack JavaScript entrypoint missing");
		await run(process.execPath, [corepack, "pnpm@10.28.2", "--ignore-pnpmfile", "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@multica/desktop...", `--registry=${registry}`], { cwd: multica, env: registry.includes("proget.onbase.net") ? { ...env, COREPACK_INTEGRITY_KEYS: "0" } : env });
		await run(process.execPath, [corepack, "pnpm@10.28.2", "--config.ignore-pnpmfile=true", "--filter", "@multica/desktop", "exec", "electron-vite", "build"], { cwd: multica, env });
		const cli = path.join(work, "multica.exe");
		await run("go", ["build", "-ldflags", `-X main.buildCommit=${multicaRevision} -X main.commit=${multicaRevision.slice(0, 12)}`, "-o", cli, "./cmd/multica"], { cwd: path.join(multica, "server"), env: { ...env, GOOS: "windows", GOARCH: "amd64" } });
		const pkgFile = path.join(frontend, "package.json");
		const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
		const steps = packagingSteps(pkg);
		pkg.version = version;
		await writeFile(pkgFile, JSON.stringify(pkg, null, "\t") + "\n");
		const buildEnv = { ...env, AO_RELEASE_REPO: "amolodyh-hyland/agent-orchestrator", AO_MULTICA_DESKTOP_OUT: path.join(multica, "apps/desktop/out"), AO_MULTICA_CLI_BIN: cli, AO_MULTICA_NOTICE_DIR: multica, AO_AGENT_BROWSER_LICENSE_DIR: licenseDir };
		for (const step of steps) await run(process.execPath, [npm, "--ignore-scripts", "run", step], { cwd: frontend, env: buildEnv });
		const forge = path.join(frontend, "node_modules/@electron-forge/cli/dist/electron-forge.js");
		await run(process.execPath, [forge, "make", "--platform=win32", "--arch=x64"], { cwd: frontend, env: buildEnv });
		await cleanupCredentials();
		const out = path.join(frontend, "out");
		const apps = (await readdir(out)).filter((name) => name.endsWith("-win32-x64"));
		if (apps.length !== 1) throw new Error("Expected exactly one native Windows app output");
		await cp(path.join(out, apps[0]), path.join(output, "app"), { recursive: true });
		await cp(path.join(out, "make"), path.join(output, "installers"), { recursive: true });
		await stat(path.join(output, "app", executable));
		const metadata = { version, source: { repository, revision: commit, tree }, multica: { repository: `https://${pin.repository}`, revision: multicaRevision }, databaseSchema: parseDatabaseSchema(source), registry, builtAt: new Date().toISOString(), signing: "See Authenticode signatures; unsigned unless existing Windows signing options were explicitly configured" };
		await writeFile(path.join(output, "BUILD-INFO.txt"), `${JSON.stringify(metadata, null, 2)}\n`);
		await writeManifest(output, metadata);
		return { outputDirectory: output, ...metadata };
	} finally {
		await cleanupCredentials();
		for (const [signal, handler] of handlers) process.off(signal, handler);
		if (added) await run("git", ["worktree", "remove", "--force", source], { cwd: repoRoot });
		await rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) console.log("Windows x64 build: [--ref <full-commit>] [--output <empty-directory>] [--base-version <x.y.z>] [--public-registry]");
		else console.log(JSON.stringify(await build(options), null, 2));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
