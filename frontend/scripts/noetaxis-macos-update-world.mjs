// Fake AO world for the update-mode tests: a throwaway HOME and Applications directory, a
// synthetic old and new app, and fake ao/ps/pgrep/osascript/open/kill/curl/multica/docker
// binaries that read and write a text "process table". Nothing here can reach a real
// process, daemon, app, port, Keychain or URL handler.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeManifest } from "./noetaxis-macos/package-artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const realScriptsDir = path.join(here, "noetaxis-macos");
export const fakesDir = path.join(here, "noetaxis-macos-test-fakes");
export const oldVersion = "0.13.4-noetaxis.1111111";
export const newVersion = "0.13.4-noetaxis.2222222";
const newRevision = "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const appName = "Agent Orchestrator.app";

export function execute(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) {
		// A timeout loses nothing: show what the command printed before it was stopped.
		result.error.message += `\nstdout so far:\n${result.stdout ?? ""}\nstderr so far:\n${result.stderr ?? ""}`;
		throw result.error;
	}
	return result;
}

export async function makeWritable(directory) {
	const details = await lstat(directory).catch(() => undefined);
	if (!details || details.isSymbolicLink()) return;
	await chmod(directory, details.isDirectory() ? 0o755 : 0o644).catch(() => {});
	if (details.isDirectory()) {
		// A detached run may still be removing its own temporary files while the test cleans up.
		for (const name of await readdir(directory).catch(() => [])) await makeWritable(path.join(directory, name));
	}
}

async function makeAppWithFakeCli(appPath, appVersion, sourceRevision = "") {
	const contents = path.join(appPath, "Contents");
	const resources = path.join(contents, "Resources");
	await mkdir(path.join(resources, "daemon"), { recursive: true });
	const revisionProperty = sourceRevision ? `<key>NoetaxisSourceRevision</key><string>${sourceRevision}</string>` : "";
	await writeFile(
		path.join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.agent-orchestrator.desktop</string><key>CFBundleShortVersionString</key><string>${appVersion}</string><key>CFBundleVersion</key><string>${appVersion}</string><key>CFBundlePackageType</key><string>APPL</string>${revisionProperty}</dict></plist>`,
	);
	await writeFile(path.join(resources, "ao-updates-disabled"), "");
	const cliPath = path.join(resources, "daemon/ao");
	await cp(path.join(fakesDir, "ao"), cliPath);
	await chmod(cliPath, 0o755);
	if (sourceRevision) {
		const signed = execute("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
		assert.equal(signed.status, 0, signed.stderr);
	}
}

const defaultSessions = [];

/**
 * options:
 *   sessions   [{ id, project, role, status, activity, terminated, name, host }]   (host: chat-host process, default true when live)
 *   hosting    "on" | "off"   AO-hosted Multica daemon state before the update
 *   standalone true when a standalone multica daemon is running before
 *   docker     container names the stack filter finds
 *   running    false to start with AO not running at all
 *   cfg        { name: true | "value" }   simulation switches (see test-fakes)
 *   extraProcs commands added to the process table
 */
export async function makeWorld(t, label, options = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), `noetaxis-update-${label}-`));
	t.after(async () => {
		await makeWritable(root);
		await rm(root, { recursive: true, force: true });
	});
	const home = path.join(root, "home");
	const appsDir = path.join(root, "Applications");
	const sim = path.join(root, "sim");
	const bin = path.join(root, "bin");
	const tmp = path.join(root, "tmp");
	const artifactDir = path.join(root, "build");
	for (const directory of [home, appsDir, path.join(sim, "cfg"), bin, tmp, path.join(artifactDir, "Applications"), path.join(home, ".ao/data")]) {
		await mkdir(directory, { recursive: true });
	}
	const targetApp = path.join(appsDir, appName);
	const newApp = path.join(artifactDir, "Applications", appName);
	await makeAppWithFakeCli(targetApp, oldVersion);
	await makeAppWithFakeCli(newApp, newVersion, newRevision);
	await writeManifest(newApp, path.join(artifactDir, "MANIFEST.sha256"));
	await symlink(path.join(fakesDir, "pgrep"), path.join(bin, "pgrep"));
	await symlink(path.join(fakesDir, "ps"), path.join(bin, "ps"));

	// A tiny AO database at schema 190, plus the other state files the backup copies.
	const database = path.join(home, ".ao/data/ao.db");
	const created = execute("/usr/bin/sqlite3", [database, "create table goose_db_version(id integer primary key, version_id integer, is_applied integer); insert into goose_db_version(version_id, is_applied) values (190, 1);"]);
	assert.equal(created.status, 0, created.stderr);
	await writeFile(path.join(home, ".ao/app-state.json"), '{"window":"old"}');
	await writeFile(path.join(home, "launch-services.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LSHandlers</key><array><dict><key>LSHandlerURLScheme</key><string>ao-app</string><key>LSHandlerRoleAll</key><string>dev.agent-orchestrator.desktop</string></dict></array></dict></plist>`);

	const sessions = (options.sessions ?? defaultSessions).map((session) => ({ project: "demo", role: "worker", status: "working", activity: "active", terminated: false, name: "", host: true, ...session }));
	await writeFile(
		path.join(sim, "sessions"),
		sessions.map((s) => [s.id, s.project, s.role, s.status, s.activity, s.terminated ? "true" : "false", s.name].join("|")).join("\n") + (sessions.length ? "\n" : ""),
	);
	await writeFile(path.join(sim, "hosting"), options.hosting ?? "off");
	await writeFile(path.join(sim, "standalone"), options.standalone ? "running" : "stopped");
	await writeFile(path.join(sim, "docker_containers"), (options.docker ?? []).join("\n") + (options.docker?.length ? "\n" : ""));
	await writeFile(path.join(sim, "nextpid"), "5000");
	const procs = [];
	const running = options.running !== false;
	if (running) {
		procs.push(`${targetApp}/Contents/MacOS/Agent Orchestrator`);
		procs.push(`${targetApp}/Contents/Frameworks/Agent Orchestrator Helper.app/Contents/MacOS/Agent Orchestrator Helper --type=gpu-process`);
		procs.push(`${targetApp}/Contents/Resources/daemon/ao daemon`);
		for (const session of sessions) if (!session.terminated && session.host) procs.push(`${targetApp}/Contents/Resources/daemon/ao chat-host --session ${session.id}`);
	}
	procs.push(...(options.extraProcs ?? []).map((command) => command.replaceAll("<APP>", targetApp)));
	await writeFile(path.join(sim, "procs"), procs.map((command, index) => `${4001 + index}|${command}`).join("\n") + (procs.length ? "\n" : ""));
	await writeFile(path.join(sim, "calls.log"), "");
	for (const [name, value] of Object.entries(options.cfg ?? {})) {
		await writeFile(path.join(sim, "cfg", name), value === true ? "" : String(value));
	}

	const env = {
		HOME: home,
		APPS_DIR: appsDir,
		TMPDIR: tmp,
		LS_SERVICES_PLIST: path.join(home, "launch-services.plist"),
		PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		NOETAXIS_SIM: sim,
		NOETAXIS_FAKES: fakesDir,
		NOETAXIS_POLL_INTERVAL: "0.05",
		NOETAXIS_LSOF: path.join(fakesDir, "no-lsof"),
		NOETAXIS_KILL: path.join(fakesDir, "kill"),
		NOETAXIS_OSASCRIPT: path.join(fakesDir, "osascript"),
		NOETAXIS_OPEN: path.join(fakesDir, "open"),
		NOETAXIS_CURL: path.join(fakesDir, "curl"),
		NOETAXIS_MULTICA: path.join(fakesDir, "multica"),
		NOETAXIS_DOCKER: path.join(fakesDir, "docker"),
		...(options.env ?? {}),
	};

	const world = {
		root,
		home,
		appsDir,
		sim,
		bin,
		artifactDir,
		targetApp,
		newApp,
		env,
		sessions,
		database,
		run(args, { input = "", scriptsDir = realScriptsDir, script = "install.sh", extraEnv = {}, timeout = 300_000 } = {}) {
			return execute(path.join(scriptsDir, script), args, { input, env: { ...env, ...extraEnv }, timeout });
		},
		// The update command line most tests use: short waits so failures return quickly.
		update(extra = [], runOptions = {}) {
			return world.run(["--update", "--quit-timeout", "3", "--stop-timeout", "3", "--health-timeout", "3", ...extra, newApp], runOptions);
		},
		async calls() {
			return (await readFile(path.join(sim, "calls.log"), "utf8")).split("\n").filter(Boolean);
		},
		async procs() {
			return (await readFile(path.join(sim, "procs"), "utf8")).split("\n").filter(Boolean).map((line) => {
				const index = line.indexOf("|");
				return { pid: Number(line.slice(0, index)), command: line.slice(index + 1) };
			});
		},
		async setCfg(name, value = true) {
			await writeFile(path.join(sim, "cfg", name), value === true ? "" : String(value));
		},
		async addTimer(ticks, action) {
			await mkdir(path.join(sim, "timers"), { recursive: true });
			await writeFile(path.join(sim, "timers", `t${Math.random().toString(36).slice(2)}`), `${ticks}|${action}\n`);
		},
		async addProc(command) {
			const procsFile = path.join(sim, "procs");
			const existing = await readFile(procsFile, "utf8");
			const pid = 9000 + existing.split("\n").filter(Boolean).length;
			await writeFile(procsFile, `${existing}${pid}|${command}\n`);
			return pid;
		},
		async sessionsNow() {
			return (await readFile(path.join(sim, "sessions"), "utf8")).split("\n").filter(Boolean).map((line) => {
				const [id, project, role, status, activity, terminated] = line.split("|");
				return { id, project, role, status, activity, terminated: terminated === "true" };
			});
		},
		async backupDirs() {
			const root = path.join(home, "ao-backups");
			if (!existsSync(root)) return [];
			return (await readdir(root)).map((name) => path.join(root, name));
		},
		schema() {
			return execute("/usr/bin/sqlite3", [database, "select max(version_id) from goose_db_version where is_applied=1;"]).stdout.trim();
		},
		installedVersion() {
			return execute("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(targetApp, "Contents/Info.plist")]).stdout.trim();
		},
	};
	return world;
}

// A copy of the installer scripts with one text replacement, for the mutation checks.
export async function mutatedScripts(t, file, search, replacement) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "noetaxis-mutant-"));
	t.after(async () => {
		await makeWritable(directory);
		await rm(directory, { recursive: true, force: true });
	});
	for (const name of await readdir(realScriptsDir)) {
		if (/\.(sh)$/.test(name)) await cp(path.join(realScriptsDir, name), path.join(directory, name));
	}
	await mkdir(path.join(directory, "pkg-scripts"), { recursive: true });
	// search === null: just a copy, for mutations the caller applies itself.
	if (search === null) {
		for (const name of ["install.sh", "update.sh", "rollback.sh"]) await chmod(path.join(directory, name), 0o755);
		return directory;
	}
	const target = path.join(directory, file);
	const original = await readFile(target, "utf8");
	const mutated = typeof search === "string" ? original.replace(search, replacement) : original.replace(search, replacement);
	assert.notEqual(mutated, original, `mutation did not apply to ${file}: ${search}`);
	await writeFile(target, mutated);
	for (const name of ["install.sh", "update.sh", "rollback.sh"]) await chmod(path.join(directory, name), 0o755);
	return directory;
}
