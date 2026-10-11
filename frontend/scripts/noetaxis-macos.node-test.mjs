import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyAgentBrowserLicenses } from "./agent-browser-license.mjs";
import { buildDiskImage, buildPackages, writeManifest } from "./noetaxis-macos/package-artifacts.mjs";
import { parseMulticaPin, stampVersion, validateRegistry } from "./noetaxis-macos/build.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const installScript = path.join(scriptDir, "noetaxis-macos/install.sh");
const rollbackScript = path.join(scriptDir, "noetaxis-macos/rollback.sh");
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
	} else {
		root = await mkdtemp(path.join(os.tmpdir(), `${label}-`));
		t.after(async () => {
			await makeWritable(root);
			await rm(root, { recursive: true, force: true });
		});
	}
	return root;
}

async function makeApp(appPath, appVersion, sourceRevision = "") {
	const contents = path.join(appPath, "Contents");
	const resources = path.join(contents, "Resources");
	await mkdir(path.join(resources, "daemon"), { recursive: true });
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
case "$*" in *ShipIt*) exit 1;; *) exit 0;; esac
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
	for (const name of ["kill", "pkill", "killall"]) {
		await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$(dirname "$0")/kill-calls"\nexit 0\n`, { mode: 0o755 });
	}
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
		: `#!/bin/sh
case "$*" in *command=*) printf '%s\\n' 'zsh';; *ppid=*) printf '1\\n';; *) exit 1;; esac
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
	assert.match(daemon.stderr, /interrupts the work of every active session/);
	const chatHost = await attempt("chat-host", ["--dry-run"]);
	assert.equal(chatHost.status, 21, chatHost.stderr);
	assert.match(chatHost.stderr, /chat host processes are still running/);
	assert.match(chatHost.stderr, /survive both .* and "ao stop"/);
	assert.match(chatHost.stderr, /PKG installer has no override/);
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
	assert.ok(desktopCalls.includes(`-f ${escape(`${f.targetApp}/Contents/MacOS/`)}`), desktopCalls.join("\n"));
	assert.ok((await pgrepArgs("daemon")).includes(`-f ${escape(`${cli} daemon`)}`));
	assert.ok((await pgrepArgs("chat-host")).includes(`-f ${escape(`${cli} chat-host`)}`));
	assert.ok((await pgrepArgs("other")).includes(`-f ${escape(`${f.targetApp}/Contents/`)}`));
});

test("process lookup matches a bundle path literally even when it contains regex metacharacters", { skip: process.platform !== "darwin" }, async (t) => {
	const f = await installFixture(t, "noetaxis-regex-test");
	const weirdApps = path.join(f.root, "Apps (v1)+[x]");
	const weirdApp = path.join(weirdApps, "Agent Orchestrator.app");
	await mkdir(weirdApps, { recursive: true });
	await makeApp(weirdApp, "0.13.4");
	const lookalike = path.join(weirdApps, "Agent OrchestratorXapp");
	const spawnRunner = async (appPath) => {
		const runner = path.join(appPath, "Contents/Resources/daemon/runner");
		await mkdir(path.dirname(runner), { recursive: true });
		await writeFile(runner, "#!/bin/sh\n/bin/sleep 30\n", { mode: 0o755 });
		const child = spawn("/bin/sh", [runner, "daemon"], { stdio: "ignore", detached: true });
		t.after(() => { try { process.kill(-child.pid); } catch {} });
		await new Promise((resolve) => setTimeout(resolve, 300));
		return runner;
	};
	// Real pgrep (no fake on PATH). The process's command line contains the bundle path.
	const env = { ...f.env, APPS_DIR: weirdApps, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
	const dryRun = () => execute("/bin/bash", [installScript, "--allow-ao-session", "--dry-run", f.sourceApp], { cwd: repoRoot, env });
	await spawnRunner(lookalike);
	assert.equal(dryRun().status, 0, "a lookalike path must not count as the installed app");
	const runner = await spawnRunner(weirdApp);
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
	const desktopBin = await makeFakeBin(f.root, "desktop");
	const desktop = execute("/bin/bash", [rollbackScript, "--allow-ao-session", "--allow-background-processes"], { cwd: repoRoot, env: { ...f.env, PATH: `${desktopBin}:/usr/bin:/bin:/usr/sbin:/sbin` } });
	assert.equal(desktop.status, 21, desktop.stderr);
	// The PKG preinstall has no flag: a surviving daemon always stops it before anything is backed up.
	const preinstall = path.join(scriptDir, "noetaxis-macos/pkg-scripts/preinstall");
	const packaged = path.join(f.root, "pkg-scripts");
	await mkdir(packaged, { recursive: true });
	await cp(preinstall, path.join(packaged, "preinstall"));
	await cp(path.join(scriptDir, "noetaxis-macos/common.sh"), path.join(packaged, "common.sh"));
	delete env.AO_HOME;
	const pkg = execute("/bin/bash", [path.join(packaged, "preinstall")], { cwd: repoRoot, env });
	assert.equal(pkg.status, 21, pkg.stderr);
	assert.match(pkg.stderr, /Resources\/daemon\/ao" stop/);
	assert.equal(await installedVersion(f.targetApp), "old");
});

test("schema check reads a WAL database that has no -wal/-shm files and never fails", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await testRoot(t, "noetaxis-schema-test");
	const database = path.join(root, "ao.db");
	const setup = execute("/usr/bin/sqlite3", [database, "pragma journal_mode=wal; create table goose_db_version (version_id integer, is_applied integer); insert into goose_db_version values (190,1);"]);
	assert.equal(setup.status, 0, setup.stderr);
	await rm(`${database}-wal`, { force: true });
	await rm(`${database}-shm`, { force: true });
	const check = (target) => execute("/bin/bash", ["-c", 'source "$1"; noetaxis_print_schema_version "$2"', "check", path.join(scriptDir, "noetaxis-macos/common.sh"), target], { env: { ...process.env, TMPDIR: root } });
	const readable = check(database);
	assert.equal(readable.status, 0, readable.stderr);
	assert.match(readable.stdout, /SQLite schema version: 190/);
	assert.deepEqual((await readdir(root)).sort(), ["ao.db"]);
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
		await cp(path.join(scriptDir, "noetaxis-macos", from), path.join(packaged, name));
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
	const install = execute("/bin/bash", [installScript, "--allow-ao-session", f.sourceApp], { cwd: repoRoot, env: f.env });
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
