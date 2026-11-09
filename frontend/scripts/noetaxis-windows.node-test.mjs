import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { entrypoint } from "./noetaxis.mjs";
import { executable, hash, manifestName, repository, safeRelative, verifyBuild, writeManifest } from "./noetaxis-windows/common.mjs";
import { parseArgs, runApp } from "./noetaxis-windows/app.mjs";
import { native, sameProcess, verifiedDaemon, verifyProbe, waitGone } from "./noetaxis-windows/runtime.mjs";
import { verifySource } from "./noetaxis-windows/verify.mjs";
import { registryBuildEnv } from "./noetaxis-macos/build.mjs";

const revision = "70436c5e948e287f8a99f152ff0205098b9e8d2c";
const metadata = { version: "0.13.4-noetaxis.70436c5", source: { repository, revision, tree: "277c12b18291a1f64e7cd01efa15771f386bccfa" }, multica: { repository: "https://github.com/amolodyh-hyland/multica", revision: "4b32bc7710753a6d97277c3833a4d7d19e48b2f7" }, databaseSchema: "20261020093039000", registry: "https://registry.npmjs.org/" };
const binaries = [executable, "resources/daemon/ao.exe", "resources/multica-cli/multica.exe", "resources/dictation-helper/ao-dictation.exe", "resources/acp-runtime/node/node.exe", "resources/agent-browser/agent-browser.exe"];
const assets = ["resources/app.asar", "resources/ao-updates-disabled", "resources/multica-desktop/renderer/index.html", "resources/multica-desktop/preload/index.cjs", "resources/multica-cli/LICENSE", "resources/multica-cli/NOTICE", "resources/agent-browser/LICENSE-agent-browser", "resources/agent-browser/LICENSE-axe-core", "resources/agent-browser/LICENSE-axe-core-THIRD-PARTY", "resources/browser-extension/manifest.json", "resources/browser-extension/background.js", "resources/browser-extension/content.js"];
async function put(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
async function fixture(t) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ao Windows 空間 ")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const output = path.join(root, "build 空間");
	for (const file of binaries) {
		const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
		await put(path.join(output, "app", file), pe);
	}
	for (const file of assets) await put(path.join(output, "app", file), file.endsWith("ao-updates-disabled") ? "" : "resource");
	await put(path.join(output, "app/resources/multica-cli/multica.sha256"), `${await hash(path.join(output, "app/resources/multica-cli/multica.exe"))}  multica.exe\n`);
	await put(path.join(output, "installers/Setup.exe"), "installer");
	await writeManifest(output, metadata);
	return { root, output, home: path.join(root, "home 空間") };
}

test("dispatch preserves Mac implementation and selects native Windows", () => {
	assert.match(entrypoint("build", "darwin"), /noetaxis-macos[/\\]build.mjs$/);
	assert.match(entrypoint("update", "win32"), /noetaxis-windows[/\\]app.mjs$/);
	assert.throws(() => entrypoint("install", "linux"), /support/);
});

test("manifest verifies full fork provenance and files on paths with spaces and Unicode", async (t) => {
	const { output } = await fixture(t);
	assert.equal((await verifyBuild(output)).source.revision, revision);
	assert.throws(() => verifySource(metadata, "a".repeat(40)), /revision/);
	assert.throws(() => verifySource(metadata, "70436c5"), /revision/);
	await put(path.join(output, "app/extra.dll"), "unlisted");
	await assert.rejects(verifyBuild(output), /differ/);
});

test("manifest rejects tampering, wrong architecture, missing completion and foreign source", async (t) => {
	for (const change of ["tamper", "arch", "checksum", "source"]) {
		const { output } = await fixture(t);
		if (change === "tamper") await put(path.join(output, "app", executable), "broken");
		if (change === "checksum") await rm(path.join(output, "SHA256SUMS"));
		if (change === "arch") {
			const file = path.join(output, "app", executable); const pe = await readFile(file); pe.writeUInt16LE(0xaa64, 68); await writeFile(file, pe);
			await rm(path.join(output, manifestName)); await rm(path.join(output, "SHA256SUMS")); await assert.rejects(writeManifest(output, metadata), /Windows x64/); continue;
		}
		if (change === "source") {
			await rm(path.join(output, manifestName)); await rm(path.join(output, "SHA256SUMS"));
			await assert.rejects(writeManifest(output, { ...metadata, source: { ...metadata.source, repository: "https://github.com/aoagents/agent-orchestrator" } }), /provenance/); continue;
		}
		await assert.rejects(verifyBuild(output));
	}
});

test("Windows path parser rejects escapes, streams, devices, trailing dots and control characters", () => {
	for (const name of ["../x", "C:/x", "//server/x", "a\\b", "a:stream", "NUL.txt", "COM1", "x./b", "x /b", "a\n"]) assert.throws(() => safeRelative(name));
	assert.equal(safeRelative("app/日本語 library.dll"), "app/日本語 library.dll");
});

test("manifest refuses symbolic links", { skip: process.platform === "win32" }, async (t) => {
	const { output, root } = await fixture(t);
	await symlink(root, path.join(output, "app/link"));
	await assert.rejects(verifyBuild(output), /Links/);
});

test("Windows public registry environment removes company credentials and custom npm settings", async (t) => {
	const { root } = await fixture(t);
	const config = path.join(root, "config"); await mkdir(config);
	const env = await registryBuildEnv(config, "https://registry.npmjs.org/", { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\空間", npm_config_registry: "https://proget.onbase.net/npm/npm", NPM_TOKEN: "private", NODE_AUTH_TOKEN: "private", COREPACK_NPM_TOKEN: "private", NPM_CONFIG_USERCONFIG: "C:\\private.npmrc" });
	assert.equal(env.SystemRoot, "C:\\Windows"); assert.equal(env.NPM_TOKEN, undefined); assert.equal(env.COREPACK_NPM_TOKEN, undefined);
	assert.doesNotMatch(await readFile(env.npm_config_userconfig, "utf8"), /private|proget/);
});

const identity = { pid: 101, executable: "C:\\AO\\resources\\daemon\\ao.exe", processStart: "windows-filetime:133700000000000000", ownerSid: "S-1-5-21-42" };
const run = { pid: 101, port: 3001, owner: "app", appRunId: "desktop-launch" };
const probe = { pid: 101, service: "agent-orchestrator-daemon", status: "ok", executablePath: identity.executable };
test("daemon ownership rejects foreign executable, PID, service, owner and creation time", () => {
	verifyProbe(run, probe, identity, identity.executable);
	for (const bad of [{ ...probe, pid: 999 }, { ...probe, service: "other" }, { ...probe, executablePath: "C:\\other\\ao.exe" }]) assert.throws(() => verifyProbe(run, bad, identity, identity.executable));
	assert.throws(() => verifyProbe({ ...run, owner: "persistent" }, probe, identity, identity.executable));
	assert.equal(sameProcess(identity, { ...identity, processStart: "windows-filetime:133700000000000001" }), false);
});

test("verified daemon requires native identity twice and the ready startup record", async (t) => {
	const { root } = await fixture(t); const file = path.join(root, "state/running.json");
	await put(file, JSON.stringify(run));
	await put(path.join(root, "state/startup", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), JSON.stringify({ pid: identity.pid, executable: identity.executable, processStart: identity.processStart, phase: "ready", launchId: "ready-launch" }));
	let calls = 0;
	assert.equal((await verifiedDaemon(file, identity.executable, { inspect: async () => identity, probe: async () => probe, listener: async () => {} })).startup.launchId, "ready-launch");
	await assert.rejects(verifiedDaemon(file, identity.executable, { inspect: async () => ++calls === 1 ? identity : { ...identity, processStart: "windows-filetime:133700000000000001" }, probe: async () => probe, listener: async () => {} }), /identity changed/);
	await assert.rejects(verifiedDaemon(file, identity.executable, { inspect: async () => identity, probe: async () => probe, listener: async () => { throw new Error("foreign listener"); } }), /foreign listener/);
});

test("graceful wait refuses PID reuse and never kills on timeout", async () => {
	await waitGone(identity, { inspect: async () => null });
	await assert.rejects(waitGone(identity, { inspect: async () => ({ ...identity, processStart: "reused" }) }), /reused/);
	await assert.rejects(waitGone(identity, { inspect: async () => identity, timeout: 0, sleep: async () => {} }), /timed out/);
});

async function installer(t, { customData = false } = {}) {
	const result = await fixture(t);
	const stateRoot = path.join(result.home, ".ao");
	const data = customData ? path.join(result.root, "external daemon 空間") : stateRoot;
	const target = path.join(stateRoot, "desktop/windows-x64");
	await mkdir(target, { recursive: true });
	await cp(path.join(result.output, "app"), path.join(target, "app"), { recursive: true });
	await cp(path.join(result.output, manifestName), path.join(target, manifestName));
	await put(path.join(target, "install-receipt.json"), JSON.stringify({ schemaVersion: 1, version: metadata.version, source: metadata.source, manifestSHA256: await hash(path.join(target, manifestName)), dataDirectory: data, runFile: path.join(data, "running.json"), databaseSchema: metadata.databaseSchema }));
	await put(path.join(data, "ao.db"), "original database");
	await put(path.join(data, "worktrees/user.txt"), "user worktree");
	let live = false;
	const appIdentity = { ...identity, pid: 202, executable: path.join(target, "app", executable), mainWindow: true };
	const deps = { platform: "win32", arch: "x64", home: result.home, env: customData ? { AO_DATA_DIR: data } : {}, native: async (operation, args) => {
		if (operation === "private") return null;
		if (operation === "inspect") return live && args.pid === 202 ? appIdentity : null;
		if (operation === "list") return live && args.target === appIdentity.executable ? [appIdentity] : [];
		if (operation === "close") { live = false; return null; }
		throw new Error("Unexpected native operation");
	}, verifiedDaemon: async () => null, waitGone: async () => {}, sleep: async () => {}, launch: async () => { live = true; await put(path.join(data, "ao.db"), "migrated database"); await put(path.join(data, "new-state.json"), "new"); return 202; } };
	return { ...result, target, data, stateRoot, electronProfile: path.join(stateRoot, "electron"), deps, appIdentity, setLive: (value) => { live = value; } };
}

function successfulStartup(f) {
	let launched = false;
	const original = f.deps.launch;
	f.deps.launch = async (...args) => {
		const pid = await original(...args); launched = true;
		await put(path.join(f.data, "startup/desktop/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), JSON.stringify({ pid, processStart: f.appIdentity.processStart, executable: f.appIdentity.executable, startedAt: Math.floor(Date.now() / 1000), appVersion: metadata.version, phase: "ready", daemon: { pid: 101, launchId: "daemon-launch" } }));
		return pid;
	};
	f.deps.verifiedDaemon = async () => launched ? { run, identity, startup: { launchId: "daemon-launch" } } : null;
}

function pausedBeforeLock(f) {
	let resume;
	let entered;
	const gate = new Promise((resolve) => { resume = resolve; });
	const paused = new Promise((resolve) => { entered = resolve; });
	let closes = 0;
	const deps = { ...f.deps, native: async (operation, args) => {
		if (operation === "private" && args.target === path.join(f.stateRoot, "desktop")) { entered(); await gate; }
		if (operation === "close") closes++;
		return f.deps.native(operation, args);
	} };
	return { deps, paused, resume: () => resume(), closes: () => closes };
}

test("dry run verifies provenance and does not create a transaction or stop processes", async (t) => {
	const f = await installer(t);
	const before = await readdir(path.join(f.data, "desktop"));
	assert.equal((await runApp({ action: "update", directory: f.output, dryRun: true, source: revision }, f.deps)).dryRun, true);
	assert.deepEqual(await readdir(path.join(f.data, "desktop")), before);
});

test("verified successful update writes exact source receipt and retains original private backup", async (t) => {
	const f = await installer(t);
	successfulStartup(f);
	const result = await runApp({ action: "update", directory: f.output, source: revision, timeout: 0 }, f.deps);
	const receipt = JSON.parse(await readFile(path.join(f.target, "install-receipt.json"), "utf8"));
	assert.equal(receipt.source.revision, revision); assert.equal(receipt.manifestSHA256, await hash(path.join(f.target, manifestName)));
	assert.equal(await readFile(path.join(result.transaction, "data/ao.db"), "utf8"), "original database");
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "migrated database");
	await assert.rejects(readFile(path.join(f.data, "desktop/windows-x64-pending.json")), /ENOENT/);
});

test("draft-close refusal and foreign daemon refuse replacement without changing private state", async (t) => {
	const f = await installer(t); f.setLive(true);
	const original = f.deps.native;
	f.deps.native = async (op, args) => { if (op === "close") throw new Error("draft still open"); return original(op, args); };
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), /draft still open/);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
	assert.ok(await readFile(path.join(f.target, "install-receipt.json")));
	await assert.rejects(readFile(path.join(f.data, "desktop/windows-x64-pending.json")), /ENOENT/);
	f.deps.verifiedDaemon = async () => { throw new Error("foreign daemon executable"); };
	await assert.rejects(runApp({ action: "update", directory: f.output }, f.deps), /foreign daemon/);
});

test("schema downgrade refuses even with a valid prior manifest/receipt", async (t) => {
	const f = await installer(t);
	const manifestFile = path.join(f.target, manifestName);
	const prior = JSON.parse(await readFile(manifestFile, "utf8")); prior.databaseSchema = "99999999999999999"; await writeFile(manifestFile, JSON.stringify(prior));
	const receiptFile = path.join(f.target, "install-receipt.json");
	const receipt = JSON.parse(await readFile(receiptFile, "utf8")); receipt.databaseSchema = prior.databaseSchema; receipt.manifestSHA256 = await hash(manifestFile); await writeFile(receiptFile, JSON.stringify(receipt));
	await assert.rejects(runApp({ action: "update", directory: f.output }, f.deps), /downgrade/);
});

test("startup failure restores old app/database and retains user worktrees plus backup evidence", async (t) => {
	const f = await installer(t);
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), /previous app and data restored/);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
	assert.equal(await readFile(path.join(f.data, "worktrees/user.txt"), "utf8"), "user worktree");
	await assert.rejects(readFile(path.join(f.data, "new-state.json")), /ENOENT/);
	assert.equal((await readFile(path.join(f.target, "install-receipt.json"), "utf8")).includes("dataDirectory"), true);
	const entries = await readdir(path.join(f.data, "desktop/transactions"));
	assert.equal(JSON.parse(await readFile(path.join(f.data, "desktop/transactions", entries[0], "result.json"), "utf8")).phase, "rolled-back");
});

test("failed startup restores daemon data and the actual Electron profile for default and external layouts", async (t) => {
	for (const customData of [false, true]) {
		const f = await installer(t, { customData });
		await put(path.join(f.electronProfile, "Default/Cookies"), "original cookies");
		await put(path.join(f.electronProfile, "Local Storage/state"), "original encrypted profile");
		await put(path.join(f.electronProfile, "artifacts/profile-state"), "original profile artifact");
		const original = f.deps.launch;
		const privateTargets = [];
		const originalNative = f.deps.native;
		f.deps.native = async (operation, args) => { if (operation === "private") privateTargets.push(args.target); return originalNative(operation, args); };
		f.deps.launch = async (...args) => {
			await put(path.join(f.electronProfile, "Default/Cookies"), "changed cookies");
			await put(path.join(f.electronProfile, "Local Storage/state"), "changed encrypted profile");
			await put(path.join(f.electronProfile, "artifacts/profile-state"), "changed profile artifact");
			await put(path.join(f.electronProfile, "new-chromium-state"), "new profile file");
			return original(...args);
		};
		await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), /previous app and data restored/);
		assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
		assert.equal(await readFile(path.join(f.electronProfile, "Default/Cookies"), "utf8"), "original cookies");
		assert.equal(await readFile(path.join(f.electronProfile, "Local Storage/state"), "utf8"), "original encrypted profile");
		assert.equal(await readFile(path.join(f.electronProfile, "artifacts/profile-state"), "utf8"), "original profile artifact");
		await assert.rejects(readFile(path.join(f.electronProfile, "new-chromium-state")), /ENOENT/);
		const [id] = await readdir(path.join(f.stateRoot, "desktop/transactions"));
		const transaction = path.join(f.stateRoot, "desktop/transactions", id);
		const result = JSON.parse(await readFile(path.join(transaction, "result.json"), "utf8"));
		if (customData) {
			assert.equal(result.electronProfile.path, f.electronProfile);
			assert.equal(await readFile(path.join(transaction, "electron-profile/Default/Cookies"), "utf8"), "original cookies");
			assert.ok(privateTargets.includes(transaction));
			assert.ok(privateTargets.includes(f.electronProfile));
		} else {
			assert.equal(result.electronProfile.coveredBy, f.data);
			assert.equal(await readFile(path.join(transaction, "data/electron/Default/Cookies"), "utf8"), "original cookies");
			await assert.rejects(readdir(path.join(transaction, "electron-profile")), /ENOENT/);
		}
	}
});

test("custom-data rollback restores the original absence of the fixed Electron profile", async (t) => {
	const f = await installer(t, { customData: true });
	const original = f.deps.launch;
	f.deps.launch = async (...args) => { await put(path.join(f.electronProfile, "Default/Cookies"), "new cookies"); return original(...args); };
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), /previous app and data restored/);
	await assert.rejects(readdir(f.electronProfile), /ENOENT/);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
});

test("damaged separate profile backup refuses restoration of either live state root", async (t) => {
	const f = await installer(t, { customData: true });
	await put(path.join(f.electronProfile, "Default/Cookies"), "original cookies");
	const original = f.deps.launch;
	f.deps.launch = async (...args) => {
		await put(path.join(f.electronProfile, "Default/Cookies"), "changed cookies");
		const [id] = await readdir(path.join(f.stateRoot, "desktop/transactions"));
		await put(path.join(f.stateRoot, "desktop/transactions", id, "electron-profile/Default/Cookies"), "corrupt backup");
		return original(...args);
	};
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), (error) => error.exitCode === 64 && /profile backup changed/.test(error.message));
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "migrated database");
	assert.equal(await readFile(path.join(f.electronProfile, "Default/Cookies"), "utf8"), "changed cookies");
});

test("daemon data nested in the fixed Electron profile is refused before lifecycle changes", async (t) => {
	const f = await installer(t);
	for (const data of [f.electronProfile, path.join(f.electronProfile, "daemon")]) {
		await assert.rejects(runApp({ action: "update", directory: f.output }, { ...f.deps, env: { AO_DATA_DIR: data } }), /fixed Electron profile/);
	}
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
});

test("a paused second fresh installer reloads state under lock and preserves the completed first install", async (t) => {
	const f = await installer(t); await rm(f.target, { recursive: true });
	successfulStartup(f);
	const second = pausedBeforeLock(f);
	const secondResult = runApp({ action: "install", directory: f.output, timeout: 0 }, second.deps).then((value) => ({ value }), (error) => ({ error }));
	await second.paused;
	try { await runApp({ action: "install", directory: f.output, timeout: 0 }, f.deps); }
	finally { second.resume(); }
	const { error } = await secondResult;
	assert.match(error?.message || "", /Existing install found; use app:update/);
	assert.equal(second.closes(), 0);
	assert.equal(JSON.parse(await readFile(path.join(f.target, "install-receipt.json"), "utf8")).source.revision, revision);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "migrated database");
});

test("a paused update reloads the completed newer receipt/schema under lock and refuses downgrade", async (t) => {
	const f = await installer(t);
	successfulStartup(f);
	const next = path.join(f.root, "newer schema build");
	await cp(f.output, next, { recursive: true });
	await rm(path.join(next, manifestName)); await rm(path.join(next, "SHA256SUMS"));
	const schema = (BigInt(metadata.databaseSchema) + 1n).toString();
	await writeManifest(next, { ...metadata, databaseSchema: schema });
	const second = pausedBeforeLock(f);
	const secondResult = runApp({ action: "update", directory: f.output, timeout: 0 }, second.deps).then((value) => ({ value }), (error) => ({ error }));
	await second.paused;
	try { await runApp({ action: "update", directory: next, timeout: 0 }, f.deps); }
	finally { second.resume(); }
	const { error } = await secondResult;
	assert.match(error?.message || "", /schema downgrade refused/);
	assert.equal(second.closes(), 0);
	assert.equal(JSON.parse(await readFile(path.join(f.target, "install-receipt.json"), "utf8")).databaseSchema, schema);
});

test("receipt changes after locking are revalidated before stopping the installed app", async (t) => {
	const f = await installer(t); f.setLive(true);
	const original = f.deps.native;
	let closes = 0;
	f.deps.native = async (operation, args) => {
		if (operation === "private" && path.dirname(args.target) === path.join(f.stateRoot, "desktop/transactions")) {
			const receiptFile = path.join(f.target, "install-receipt.json");
			const receipt = JSON.parse(await readFile(receiptFile, "utf8")); receipt.concurrentChange = true; await writeFile(receiptFile, JSON.stringify(receipt));
		}
		if (operation === "close") closes++;
		return original(operation, args);
	};
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), /receipt changed during transaction/);
	assert.equal(closes, 0);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
});

test("ambiguous failed-start process retains new app/data and recovery journal with exit64", async (t) => {
	const f = await installer(t);
	const original = f.deps.native;
	f.deps.native = async (op, args) => { if (op === "close") throw new Error("cannot prove ownership"); return original(op, args); };
	await assert.rejects(runApp({ action: "update", directory: f.output, timeout: 0 }, f.deps), (error) => error.exitCode === 64);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "migrated database");
	assert.equal(JSON.parse(await readFile(path.join(f.data, "desktop/windows-x64-pending.json"), "utf8")).phase, "starting");
});

test("failed first installation restores pre-existing data without inventing an old install", async (t) => {
	const f = await installer(t); await rm(f.target, { recursive: true });
	await assert.rejects(runApp({ action: "install", directory: f.output, timeout: 0 }, f.deps), /original data restored; failed install removed/);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
	await assert.rejects(readFile(path.join(f.target, "install-receipt.json")), /ENOENT/);
});

test("session guard, source mismatch, schema downgrade and existing lock refuse before replacement", async (t) => {
	const f = await installer(t);
	await assert.rejects(runApp({ action: "update", directory: f.output }, { ...f.deps, env: { AO_SESSION_ID: "parent" } }), (error) => error.exitCode === 20);
	await assert.rejects(runApp({ action: "update", directory: f.output, source: "a".repeat(40) }, f.deps), /revision/);
	await mkdir(path.join(f.data, "desktop/windows-x64.lock"));
	await assert.rejects(runApp({ action: "update", directory: f.output }, f.deps), /EEXIST/);
	assert.equal(await readFile(path.join(f.data, "ao.db"), "utf8"), "original database");
});

test("installer parses explicit source and bounded health timeout without shell options", () => {
	assert.equal(parseArgs("update", ["C:\\build 空間", "--source", revision, "--health-timeout", "900"]).timeout, 900000);
	assert.throws(() => parseArgs("update", ["x", "--health-timeout", "0"]));
	assert.throws(() => parseArgs("update", ["x", "--force"]));
});

test("native Windows bridge inspects exact live PID and rejects another creation time", { skip: process.platform !== "win32" }, async (t) => {
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore", windowsHide: true });
	t.after(() => { child.kill(); });
	await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
	const found = await native("inspect", { pid: child.pid });
	assert.equal(found.pid, child.pid); assert.match(found.processStart, /^windows-filetime:/); assert.ok(found.ownerSid);
	await assert.rejects(native("close", { pid: child.pid, target: found.executable, processStart: "windows-filetime:1" }), /identity changed/);
});

test("native Windows private directory removes inherited broad access", { skip: process.platform !== "win32" }, async (t) => {
	const { root } = await fixture(t);
	const acl = await native("private", { target: root });
	assert.equal(acl.protected, true); assert.ok(acl.ownerSid);
	assert.deepEqual(new Set(acl.allowedSids), new Set([acl.ownerSid, "S-1-5-18"]));
});
