import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executable, hash, inventory, manifestName, validateManifest, verifyBuild } from "./common.mjs";
import { native, readJson, request, samePath, sameProcess, verifiedDaemon, waitGone } from "./runtime.mjs";
import { verifySource } from "./verify.mjs";

const usage = "Usage: app.mjs <install|update> <build-directory> [--source <full-commit>] [--dry-run] [--health-timeout <seconds>] [--yes]";
export function parseArgs(action, args) {
	if (!["install", "update"].includes(action) || !args[0] || args[0].startsWith("-")) throw new Error(usage);
	const options = { action, directory: path.resolve(args[0]), timeout: 120000 };
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--dry-run") options.dryRun = true;
		else if (args[i] === "--yes") continue;
		else if (args[i] === "--source" && /^[a-f0-9]{40}$/.test(args[i + 1] || "")) options.source = args[++i];
		else if (args[i] === "--health-timeout" && /^\d+$/.test(args[i + 1] || "") && Number(args[i + 1]) >= 10 && Number(args[i + 1]) <= 1800) options.timeout = Number(args[++i]) * 1000;
		else throw new Error(usage);
	}
	return options;
}

export async function noLinks(target) {
	let current = path.resolve(target);
	while (true) {
		const stat = await lstat(current).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
		if (stat?.isSymbolicLink()) throw new Error(`Links/reparse points are not allowed: ${current}`);
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

async function exists(file) { return !!await lstat(file).catch((error) => { if (error.code !== "ENOENT") throw error; return null; }); }
async function json(file, value) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, file);
}

async function stateInventory(data, installationRoot) {
	const files = [];
	for (const name of (await readdir(data)).sort()) {
		const source = path.join(data, name);
		if (source === installationRoot || ["worktrees", "artifacts"].includes(name)) continue;
		await inventoryTree(source);
		if ((await lstat(source)).isDirectory()) files.push(...(await inventory(source)).map((file) => ({ ...file, path: `${name}/${file.path}` })));
		else files.push({ path: name, size: (await lstat(source)).size, sha256: await hash(source) });
	}
	return files;
}

export async function snapshot(data, destination, installationRoot) {
	await mkdir(destination, { recursive: true });
	for (const name of await readdir(data)) {
		const source = path.join(data, name);
		if (source === installationRoot || ["worktrees", "artifacts"].includes(name)) continue;
		await inventoryTree(source);
		await cp(source, path.join(destination, name), { recursive: true, errorOnExist: true, force: false });
	}
}

async function inventoryTree(source) {
	const stat = await lstat(source);
	if (stat.isSymbolicLink()) throw new Error(`Cannot safely snapshot linked state: ${source}`);
	if (stat.isDirectory()) for (const name of await readdir(source)) await inventoryTree(path.join(source, name));
	else if (!stat.isFile()) throw new Error(`Cannot snapshot special state entry: ${source}`);
}

async function restore(data, backup, installationRoot) {
	for (const name of await readdir(data)) if (path.join(data, name) !== installationRoot && !["worktrees", "artifacts"].includes(name)) await rm(path.join(data, name), { recursive: true, force: true });
	for (const name of await readdir(backup)) await cp(path.join(backup, name), path.join(data, name), { recursive: true });
}

const defaults = {
	platform: process.platform, arch: process.arch, home: os.homedir(), env: process.env,
	native, verifiedDaemon, waitGone, request,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	launch: async (file, env) => {
		const child = spawn(file, [], { cwd: path.dirname(file), env, detached: true, stdio: "ignore", windowsHide: false });
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		child.unref();
		return child.pid;
	},
};

export async function runApp(options, injected = {}) {
	const deps = { ...defaults, ...injected };
	if (deps.env.AO_SESSION_ID) throw Object.assign(new Error("Desktop installation/update must run from your own PowerShell outside AO"), { exitCode: 20 });
	if (deps.platform !== "win32" || deps.arch !== "x64") throw new Error("Native Windows x64 is required");
	const manifest = verifySource(await verifyBuild(options.directory), options.source);
	const stateRoot = path.join(deps.home, ".ao");
	const electronProfile = path.join(stateRoot, "electron");
	const installationRoot = path.join(stateRoot, "desktop");
	const target = path.join(installationRoot, "windows-x64");
	const data = deps.env.AO_DATA_DIR?.trim() || (deps.env.AO_RUN_FILE ? path.dirname(deps.env.AO_RUN_FILE) : stateRoot);
	if (!path.isAbsolute(data) || path.resolve(data) === path.parse(path.resolve(data)).root) throw new Error("AO_DATA_DIR must be an absolute dedicated directory, not a filesystem root");
	const rootData = path.relative(stateRoot, data) === "";
	const related = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
	if (related(installationRoot, data) || !rootData && related(data, stateRoot) || related(data, options.directory)) throw new Error("Build/data/install directories must not overlap");
	if (related(electronProfile, data)) throw new Error("AO_DATA_DIR must not be inside the fixed Electron profile");
	const separateProfile = !related(data, electronProfile);
	const runFile = deps.env.AO_RUN_FILE || path.join(data, "running.json");
	if (!path.isAbsolute(runFile) || path.dirname(runFile) !== data) throw new Error("AO_RUN_FILE must live directly in AO_DATA_DIR");
	for (const file of [options.directory, target, data, runFile, electronProfile]) await noLinks(file);
	const receiptFile = path.join(target, "install-receipt.json");
	const installationState = async () => {
		const installed = await exists(target);
		if (options.action === "install" && installed) throw new Error("Existing install found; use app:update");
		if (options.action === "update" && !installed) throw new Error("No managed install found; use app:install");
		const receipt = installed ? await readJson(receiptFile) : null;
		if (installed && (!receipt || receipt.schemaVersion !== 1 || receipt.dataDirectory !== data || receipt.runFile !== runFile)) throw new Error("Unrecognized install or changed data directory; refusing replacement");
		if (installed) {
			const prior = validateManifest(await readJson(path.join(target, manifestName)));
			if (await hash(path.join(target, manifestName)) !== receipt.manifestSHA256 || prior.version !== receipt.version || prior.source.revision !== receipt.source?.revision || prior.databaseSchema !== receipt.databaseSchema) throw new Error("Installed receipt and source manifest differ");
			const expected = prior.files.filter((file) => file.path.startsWith("app/")).map((file) => ({ ...file, path: file.path.slice(4) }));
			if (JSON.stringify(await inventory(path.join(target, "app"))) !== JSON.stringify(expected)) throw new Error("Installed app differs from its source manifest");
		}
		if (receipt && BigInt(manifest.databaseSchema) < BigInt(receipt.databaseSchema)) throw new Error("Database schema downgrade refused");
		return { installed, receipt };
	};
	const app = path.join(target, "app", executable);
	const daemon = path.join(target, "app/resources/daemon/ao.exe");
	const processes = () => deps.native("list", { target: app });
	const daemons = () => deps.native("list", { target: daemon });
	const preflight = async () => {
		const apps = await processes();
		const running = await deps.verifiedDaemon(runFile, daemon);
		if ((await daemons()).length && !running) throw new Error("Unverified daemon process; quit AO manually");
		return { apps, running };
	};
	if (options.dryRun) {
		const { installed } = await installationState();
		const initial = await preflight();
		if (!installed && (initial.apps.length || initial.running)) throw new Error("AO is already running; refusing first install");
		return { target, data, runFile, source: manifest.source, dryRun: true };
	}
	const dataExistedBeforeSetup = await exists(data);
	await mkdir(installationRoot, { recursive: true });
	await deps.native("private", { target: installationRoot });
	const lock = path.join(installationRoot, "windows-x64.lock");
	await mkdir(lock);
	let transaction;
	let journal;
	let previousMoved = false;
	const pending = path.join(installationRoot, "windows-x64-pending.json");
	try {
		await deps.native("private", { target: lock });
		if (await exists(pending)) throw new Error("Interrupted transaction exists; inspect windows-x64-pending.json before recovery");
		const originalInstallation = await installationState();
		const { installed } = originalInstallation;
		const assertInstallation = async () => {
			if (JSON.stringify(await installationState()) !== JSON.stringify(originalInstallation)) throw new Error("Installed receipt changed during transaction; replacement refused");
		};
		const initial = await preflight();
		if (!installed && (initial.apps.length || initial.running)) throw new Error("AO is already running; refusing first install");
		const dataExisted = rootData ? dataExistedBeforeSetup : await exists(data);
		transaction = path.join(installationRoot, "transactions", randomUUID());
		await mkdir(transaction, { recursive: true });
		await deps.native("private", { target: transaction });
		await mkdir(data, { recursive: true });
		if (!dataExisted) await deps.native("private", { target: data });
		const staged = path.join(transaction, "staged");
		await mkdir(staged);
		await cp(path.join(options.directory, "app"), path.join(staged, "app"), { recursive: true });
		const expected = manifest.files.filter((file) => file.path.startsWith("app/")).map((file) => ({ ...file, path: file.path.slice(4) }));
		if (JSON.stringify(await inventory(path.join(staged, "app"))) !== JSON.stringify(expected)) throw new Error("Staged app failed manifest verification");
		const disk = await statfs(data);
		const required = BigInt(manifest.files.reduce((sum, file) => sum + file.size, 0)) + 512n * 1024n * 1024n;
		if (BigInt(disk.bavail) * BigInt(disk.bsize) < required) throw new Error("Insufficient free space for private state backup");
		journal = { schemaVersion: 1, phase: "staged", target, data, runFile, transaction, source: manifest.source };
		await json(pending, journal);
		const stop = async () => {
			const { apps, running } = await preflight();
			for (const identity of apps.filter((item) => item.mainWindow)) {
				if (!sameProcess(identity, await deps.native("inspect", { pid: identity.pid }))) throw new Error("App process changed before graceful close");
				await deps.native("close", { target: identity.executable, pid: identity.pid, processStart: identity.processStart });
			}
			for (const identity of apps) await deps.waitGone(identity);
			if (running && await deps.native("inspect", { pid: running.identity.pid })) {
				const current = await deps.verifiedDaemon(runFile, daemon);
				if (!current || !sameProcess(running.identity, current.identity)) throw new Error("Daemon owner changed before shutdown");
				const response = await deps.request(current.run.port, "/shutdown", { stopAgents: true, appRunId: current.run.appRunId });
				if (response.pid !== current.run.pid || response.service !== "agent-orchestrator-daemon") throw new Error("Unexpected shutdown receipt");
				await deps.waitGone(current.identity);
			}
			if ((await processes()).length || (await daemons()).length) throw new Error("AO processes remain; replacement refused");
			const run = await readJson(runFile);
			if (run && await deps.native("inspect", { pid: run.pid })) throw new Error("A live daemon still owns the run file");
		};
		await assertInstallation();
		await stop();
		const backup = path.join(transaction, "data");
		const originalState = await stateInventory(data, rootData ? installationRoot : "");
		const profileState = async () => {
			await noLinks(electronProfile);
			const existed = await exists(electronProfile);
			return { path: electronProfile, existed, files: existed ? await inventory(electronProfile) : [] };
		};
		const originalProfile = separateProfile ? await profileState() : null;
		const profileBackup = path.join(transaction, "electron-profile");
		const backupDisk = await statfs(transaction);
		const backupFiles = [...originalState, ...(originalProfile?.files || [])];
		if (BigInt(backupDisk.bavail) * BigInt(backupDisk.bsize) < BigInt(backupFiles.reduce((sum, file) => sum + file.size, 0)) + 512n * 1024n * 1024n) throw new Error("Insufficient free space for state snapshot");
		await snapshot(data, backup, rootData ? installationRoot : "");
		const before = await inventory(backup);
		if (JSON.stringify(before) !== JSON.stringify(originalState) || JSON.stringify(originalState) !== JSON.stringify(await stateInventory(data, rootData ? installationRoot : ""))) throw new Error("State snapshot changed during backup; replacement refused");
		if (originalProfile) {
			if (originalProfile.existed) await cp(electronProfile, profileBackup, { recursive: true, errorOnExist: true, force: false });
			else await mkdir(profileBackup);
			if (JSON.stringify(await inventory(profileBackup)) !== JSON.stringify(originalProfile.files) || JSON.stringify(await profileState()) !== JSON.stringify(originalProfile)) throw new Error("Electron profile snapshot changed during backup; replacement refused");
			await json(path.join(transaction, "electron-profile-manifest.json"), originalProfile);
		}
		if ((await processes()).length || (await daemons()).length) throw new Error("AO restarted during backup; replacement refused");
		const afterBackupRun = await readJson(runFile);
		if (afterBackupRun && await deps.native("inspect", { pid: afterBackupRun.pid })) throw new Error("A daemon restarted during backup");
		await json(path.join(transaction, "data-manifest.json"), before);
		journal.electronProfile = originalProfile ? { path: electronProfile, existed: originalProfile.existed, backup: profileBackup } : { path: electronProfile, coveredBy: data };
		journal.phase = "backed-up";
		await json(pending, journal);
		await assertInstallation();
		if (installed) { await rename(target, path.join(transaction, "previous")); previousMoved = true; }
		try {
			await rename(staged, target);
			journal.phase = "starting";
			await json(pending, journal);
			if (originalProfile && !originalProfile.existed) {
				await mkdir(electronProfile, { recursive: true });
				await deps.native("private", { target: electronProfile });
			}
			const launchedAt = Date.now();
			const launchPid = await deps.launch(app, { ...deps.env, AO_DATA_DIR: data, AO_RUN_FILE: runFile });
			const launchIdentity = await deps.native("inspect", { pid: launchPid });
			if (!launchIdentity || !samePath(launchIdentity.executable, app)) throw new Error("App launch process identity is unverified");
			let ready = false;
			const deadline = Date.now() + options.timeout;
			do {
				try {
					const live = await deps.verifiedDaemon(runFile, daemon);
					const records = await readdir(path.join(data, "startup/desktop"));
					for (const file of records.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
						const record = await readJson(path.join(data, "startup/desktop", file));
						if (live && record?.pid === launchPid && record.processStart === launchIdentity.processStart && samePath(record.executable, app) && record.startedAt * 1000 >= launchedAt - 2000 && record.appVersion === manifest.version && record.phase === "ready" && record.daemon?.pid === live.run.pid && record.daemon?.launchId === live.startup.launchId && sameProcess(launchIdentity, await deps.native("inspect", { pid: launchPid }))) ready = true;
					}
				} catch {}
				if (!ready) await deps.sleep(1000);
			} while (!ready && Date.now() < deadline);
			if (!ready) throw new Error("Desktop startup health could not be verified");
			await cp(path.join(options.directory, manifestName), path.join(target, manifestName));
			await json(receiptFile, { schemaVersion: 1, version: manifest.version, source: manifest.source, multica: manifest.multica, databaseSchema: manifest.databaseSchema, manifestSHA256: await hash(path.join(target, manifestName)), dataDirectory: data, runFile });
			journal.phase = "healthy";
			await json(path.join(transaction, "result.json"), journal);
			await rm(pending);
			return { target, data, runFile, source: manifest.source, transaction };
		} catch (error) {
			try { await stop(); }
			catch { throw Object.assign(new Error(`Startup failed; process ownership/exit is ambiguous. New app and backup retained. Inspect ${pending}`), { exitCode: 64 }); }
			if (JSON.stringify(await inventory(backup)) !== JSON.stringify(before)) throw Object.assign(new Error(`Backup changed; manual recovery required: ${pending}`), { exitCode: 64 });
			if (originalProfile && JSON.stringify(await inventory(profileBackup)) !== JSON.stringify(originalProfile.files)) throw Object.assign(new Error(`Electron profile backup changed; manual recovery required: ${pending}`), { exitCode: 64 });
			if (await exists(target)) await rename(target, path.join(transaction, "failed-app"));
			await restore(data, backup, rootData ? installationRoot : "");
			if (originalProfile) {
				await noLinks(electronProfile);
				await rm(electronProfile, { recursive: true, force: true });
				if (originalProfile.existed) {
					await mkdir(electronProfile, { recursive: true });
					await deps.native("private", { target: electronProfile });
					await cp(profileBackup, electronProfile, { recursive: true });
				}
			}
			if (installed) await rename(path.join(transaction, "previous"), target);
			journal.phase = "rolled-back";
			await json(path.join(transaction, "result.json"), journal);
			await rm(pending);
			throw new Error(`${error.message}; ${installed ? "previous app and data restored. Launch the previous app manually" : "original data restored; failed install removed"}. Backup: ${transaction}`);
		}
	} catch (error) {
		if (!previousMoved && ["staged", "backed-up"].includes(journal?.phase)) {
			const current = await readJson(pending);
			if (current?.transaction === transaction) {
				journal.phase = "aborted-before-replacement";
				await json(path.join(transaction, "result.json"), journal);
				await rm(pending);
			}
		}
		throw error;
	} finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { console.log(JSON.stringify(await runApp(parseArgs(process.argv[2], process.argv.slice(3))), null, 2)); }
	catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
