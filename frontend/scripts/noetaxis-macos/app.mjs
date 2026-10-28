import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function latestBuild(buildRoot) {
	const entries = await readdir(buildRoot, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const builds = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("noetaxis-")) continue;
		const directory = path.join(buildRoot, entry.name);
		const checksums = await stat(path.join(directory, "SHA256SUMS")).catch((error) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (checksums?.isFile()) builds.push({ directory, modified: checksums.mtimeMs });
	}
	builds.sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory));
	if (!builds.length) throw new Error(`No completed build found in ${buildRoot}. Run npm run app:build first, or supply a build directory as the first argument after --.`);
	return builds[0].directory;
}

export async function verifyChecksums(directory, installer) {
	const contents = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
	const verified = new Set();
	for (const line of contents.split(/\r?\n/).filter((entry) => entry.trim())) {
		const match = line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/);
		if (!match) throw new Error("Invalid SHA256SUMS entry");
		const [, expected, name] = match;
		const file = path.resolve(directory, name);
		const relative = path.relative(directory, file);
		if (path.isAbsolute(name) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("SHA256SUMS path is outside the build directory");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(file)) hash.update(chunk);
		if (hash.digest("hex") !== expected.toLowerCase()) throw new Error(`SHA256SUMS verification failed: ${name}`);
		verified.add(relative);
	}
	for (const required of ["MANIFEST.sha256", path.join("installer", installer)]) {
		if (!verified.has(required)) throw new Error(`SHA256SUMS is missing ${required}`);
	}
}

export async function runApp(action, args, { home = os.homedir(), env = process.env, run = spawnSync } = {}) {
	if (!["install", "update"].includes(action)) throw new Error("Usage: app.mjs <install|update> [build-directory] [installer options]");
	if (action === "update" && env.AO_SESSION_ID) {
		const error = new Error("app:update refuses to run inside an AO session (AO_SESSION_ID is set). Run npm run app:update from your own Terminal outside AO.");
		error.exitCode = 20;
		throw error;
	}
	const explicit = args[0] && !args[0].startsWith("-");
	const directory = explicit ? path.resolve(args[0]) : await latestBuild(path.join(home, "ao-builds"));
	const extraArgs = explicit ? args.slice(1) : args;
	const installer = `${action}.sh`;
	await verifyChecksums(directory, installer);
	const app = path.join(directory, "Applications", "Agent Orchestrator.app");
	const result = run("/bin/bash", [path.join(directory, "installer", installer), ...(action === "update" ? ["--fast"] : []), app, ...extraArgs], { cwd: directory, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`Installer interrupted by ${result.signal}`);
	return result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await runApp(process.argv[2], process.argv.slice(3));
	} catch (error) {
		console.error(error.message);
		process.exitCode = error.exitCode || 1;
	}
}
