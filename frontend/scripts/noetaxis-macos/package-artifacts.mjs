import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appName = "Agent Orchestrator.app";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${path.basename(command)} failed with status ${result.status ?? result.signal}${details ? `: ${details}` : ""}`);
	}
}

async function regularFiles(directory, relative = "") {
	const files = [];
	for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
		const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
		if (entry.isDirectory()) files.push(...(await regularFiles(directory, child.split(path.posix.sep).join(path.sep))));
		else if (entry.isFile()) files.push(child.split(path.sep).join(path.posix.sep));
	}
	return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export async function writeManifest(appPath, manifestPath) {
	const files = await regularFiles(appPath);
	const lines = [];
	for (const relative of files) {
		const bytes = await readFile(path.join(appPath, relative.split(path.posix.sep).join(path.sep)));
		lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ./${relative}`);
	}
	await writeFile(manifestPath, `${lines.join("\n")}\n`, "utf8");
	return files.length;
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

export async function buildDiskImage({ appPath, outputDir, version }) {
	appPath = path.resolve(appPath);
	outputDir = path.resolve(outputDir);
	const dmgPath = path.join(outputDir, `Agent-Orchestrator-${version}-arm64.dmg`);
	if (await lstat(dmgPath).catch(() => undefined)) throw new Error(`Disk image output already exists: ${dmgPath}`);
	const workDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-dmg-"));
	try {
		const dmgRoot = path.join(workDir, "dmg-root");
		await mkdir(dmgRoot, { recursive: true });
		await cp(appPath, path.join(dmgRoot, appName), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		await symlink("/Applications", path.join(dmgRoot, "Applications"));
		await cp(path.join(scriptDir, "DMG-README.txt"), path.join(dmgRoot, "Read Me.txt"));
		run("/usr/bin/hdiutil", ["create", "-ov", "-format", "UDZO", "-volname", "Agent Orchestrator", "-srcfolder", dmgRoot, dmgPath]);
		run("/usr/bin/hdiutil", ["verify", dmgPath]);
		return dmgPath;
	} finally {
		await makeTemporaryWritable(workDir);
		await rm(workDir, { recursive: true, force: true });
	}
}

export async function buildPackages({ appPath, outputDir, version, revision, createDiskImage = true }) {
	appPath = path.resolve(appPath);
	outputDir = path.resolve(outputDir);
	if (path.basename(appPath) !== appName) throw new Error(`Expected ${appName}: ${appPath}`);
	if (!/^\d+\.\d+\.\d+-noetaxis\.[0-9a-f]{7}$/.test(version)) throw new Error(`Invalid Noetaxis app version: ${version}`);
	if (!/^[0-9a-f]{40}$/.test(revision) || !version.endsWith(revision.slice(0, 7))) throw new Error("App version and full source revision do not match");
	const appStat = await lstat(appPath);
	if (!appStat.isDirectory()) throw new Error(`App bundle is not a directory: ${appPath}`);
	if (!(await lstat(path.join(appPath, "Contents/Resources/ao-updates-disabled")).catch(() => undefined))) {
		throw new Error("App is missing Contents/Resources/ao-updates-disabled");
	}
	await mkdir(outputDir, { recursive: true });
	const manifestPath = path.join(outputDir, "MANIFEST.sha256");
	const packageName = `Agent-Orchestrator-${version}-arm64`;
	const pkgPath = path.join(outputDir, `${packageName}.pkg`);
	const dmgPath = path.join(outputDir, `${packageName}.dmg`);
	if (await lstat(pkgPath).catch(() => undefined) || (createDiskImage && await lstat(dmgPath).catch(() => undefined))) {
		throw new Error(`Package output already exists in ${outputDir}`);
	}
	const fileCount = await writeManifest(appPath, manifestPath);
	const workDir = await mkdtemp(path.join(os.tmpdir(), "noetaxis-package-"));
	try {
		const pkgRoot = path.join(workDir, "root");
		const pkgScripts = path.join(workDir, "scripts");
		const componentPkg = path.join(workDir, "component.pkg");
		await mkdir(pkgRoot, { recursive: true });
		await mkdir(pkgScripts, { recursive: true });
		await cp(appPath, path.join(pkgRoot, appName), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		for (const name of ["preinstall", "postinstall", "common.sh"]) {
			const source = name === "common.sh" ? path.join(scriptDir, "common.sh") : path.join(scriptDir, "pkg-scripts", name);
			const destination = path.join(pkgScripts, name);
			await cp(source, destination);
			if (name !== "common.sh") await chmod(destination, 0o755);
		}
		const componentPlist = path.join(workDir, "component.plist");
		run("/usr/bin/pkgbuild", ["--analyze", "--root", pkgRoot, componentPlist]);
		// pkgbuild already marks the bundle non-relocatable with an upgrade overwrite action.
		// Installer skips a bundle whose CFBundleVersion it considers not newer, before any
		// script runs; builds are '<version>-noetaxis.<sha>', so turn the version check off.
		run("/usr/bin/plutil", ["-replace", "0.BundleIsVersionChecked", "-bool", "false", componentPlist]);
		run("/usr/bin/pkgbuild", [
			"--component-plist", componentPlist,
			"--root", pkgRoot,
			"--identifier", "dev.agent-orchestrator.desktop",
			"--version", version,
			"--install-location", "/Applications",
			"--scripts", pkgScripts,
			componentPkg,
		]);
		run("/usr/bin/productbuild", [
			"--package", componentPkg,
			"--identifier", "dev.agent-orchestrator.desktop",
			"--version", version,
			pkgPath,
		]);
		const result = { appPath, manifestPath, pkgPath, dmgPath: "", fileCount };
		if (createDiskImage) result.dmgPath = await buildDiskImage({ appPath, outputDir, version });
		return result;
	} finally {
		await makeTemporaryWritable(workDir);
		await rm(workDir, { recursive: true, force: true });
	}
}

function parseArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index];
		if (!["--app", "--output", "--version", "--revision"].includes(name) || !args[index + 1]) {
			throw new Error("Usage: package-artifacts.mjs --app <app> --output <directory> --version <version> --revision <sha>");
		}
		options[name.slice(2)] = args[index + 1];
		index += 1;
	}
	for (const key of ["app", "output", "version", "revision"]) if (!options[key]) throw new Error(`Missing --${key}`);
	return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await buildPackages(parseArgs(process.argv.slice(2)));
		console.log(`Manifest: ${result.manifestPath} (${result.fileCount} files)`);
		console.log(`PKG: ${result.pkgPath}`);
		console.log(`DMG: ${result.dmgPath}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
