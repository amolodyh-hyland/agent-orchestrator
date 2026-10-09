import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
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
	const pgrep = pgrepMode === "busy"
		? `#!/bin/sh
case "$*" in *ShipIt*) exit 1;; *) exit 0;; esac
`
		: "#!/bin/sh\nexit 1\n";
	await writeFile(path.join(bin, "pgrep"), pgrep, { mode: 0o755 });
	const ps = psMode === "ao-ancestor"
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
	const bin = await makeFakeBin(root, "idle", "ao-ancestor");
	const env = installEnv({ home, appsDir, aoHome, handlerPlist, bin });
	const session = execute("/bin/bash", [installScript, "--dry-run", appPath], {
		cwd: repoRoot,
		env: { ...env, AO_SESSION_ID: "fixture-session" },
	});
	assert.equal(session.status, 20, session.stderr);
	const ancestry = execute("/bin/bash", [installScript, "--dry-run", appPath], { cwd: repoRoot, env });
	assert.equal(ancestry.status, 20, ancestry.stderr);
	assert.equal(await readdir(appsDir).then((entries) => entries.length), 0);
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
	assert.equal(execute("/usr/bin/sqlite3", [path.join(backupDir, "rollback-current-data/ao.db"), "select max(version_id) from goose_db_version where is_applied=1;"]).stdout.trim(), "888");
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
