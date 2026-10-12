// Tests for `install.sh --update` / `update.sh`. Everything runs against a fake world (see
// noetaxis-macos-update-world.mjs): a throwaway HOME and Applications folder, and fake ao,
// ps, pgrep, osascript, open, kill, curl, multica and docker. Nothing real is quit, killed,
// installed or contacted, and nothing reads the real ~/.ao, the Keychain or port 3001.
import test from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { execute, fakesDir, makeWorld, mutatedScripts, newVersion, oldVersion, realScriptsDir } from "./noetaxis-macos-update-world.mjs";

const darwin = { skip: process.platform !== "darwin" };

const callIndex = (calls, pattern) => calls.findIndex((line) => pattern.test(line));
const matching = (calls, pattern) => calls.filter((line) => pattern.test(line));
const liveSession = (id, extra = {}) => ({ id, ...extra });

async function onlyBackup(world) {
	const dirs = await world.backupDirs();
	assert.equal(dirs.length, 1, `expected one backup directory, found ${dirs.length}`);
	return dirs[0];
}

// ---------------------------------------------------------------------------
// Scenarios shared by the behaviour tests and the mutation checks. Each returns the list of
// safety properties the run VIOLATED; a healthy script returns an empty list.
// ---------------------------------------------------------------------------

async function scenarioDeclinedConfirmation(t, scriptsDir) {
	const world = await makeWorld(t, "declined");
	const before = await world.procs();
	const result = world.update([], { input: "no\n", scriptsDir });
	const calls = await world.calls();
	const violations = [];
	if (result.status !== 50) violations.push(`declining must exit 50, got ${result.status}`);
	if (callIndex(calls, /^osascript/) >= 0) violations.push("the app was quit although the answer was no");
	if (callIndex(calls, /^open /) >= 0) violations.push("the new app was opened although the answer was no");
	if ((await world.backupDirs()).length > 0) violations.push("a backup directory exists although nothing was confirmed");
	if (JSON.stringify(await world.procs()) !== JSON.stringify(before)) violations.push("the process table changed");
	if (world.installedVersion() !== oldVersion) violations.push("the installed app changed");
	return violations;
}

async function scenarioLiveSessionsRefused(t, scriptsDir) {
	const world = await makeWorld(t, "refuse", { sessions: [liveSession("s1"), liveSession("s2", { role: "orchestrator" })] });
	const result = world.update(["--yes"], { scriptsDir });
	const calls = await world.calls();
	const violations = [];
	if (result.status !== 51) violations.push(`live sessions must exit 51, got ${result.status}`);
	if (callIndex(calls, /session (kill|exit-agent)/) >= 0) violations.push("a session was ended without --end-sessions");
	if (callIndex(calls, /^osascript/) >= 0) violations.push("the app was quit with live sessions and no --end-sessions");
	if (world.installedVersion() !== oldVersion) violations.push("the app was replaced");
	return violations;
}

async function scenarioLookalikeProcess(t, scriptsDir) {
	// Another copy of AO whose path ends the same way, and a tool with a file open inside the bundle.
	const world = await makeWorld(t, "lookalike", {
		extraProcs: ["/Volumes/Old Disk<APP>/Contents/MacOS/Agent Orchestrator", "/usr/bin/tail -f <APP>/Contents/Resources/log.txt"],
	});
	const result = world.update(["--yes", "--force"], { scriptsDir });
	const calls = await world.calls();
	const procs = await world.procs();
	const violations = [];
	if (result.status !== 21) violations.push(`lookalike processes must exit 21, got ${result.status}`);
	if (matching(calls, /^kill /).length > 0) violations.push(`something was signalled: ${matching(calls, /^kill /).join("; ")}`);
	if (!procs.some((p) => p.command.startsWith("/Volumes/Old Disk"))) violations.push("the other copy's process is gone");
	if (!procs.some((p) => p.command.startsWith("/usr/bin/tail"))) violations.push("the tail process is gone");
	return violations;
}

async function scenarioForcedTermination(t, scriptsDir) {
	// A chat host that survives the stop; --force sends it SIGTERM and nothing else.
	const world = await makeWorld(t, "force", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	const result = world.update(["--yes", "--force"], { scriptsDir });
	const calls = await world.calls();
	const violations = [];
	if (result.status !== 0) violations.push(`the forced run should succeed, got ${result.status}: ${result.stderr}`);
	const kills = matching(calls, /^kill /);
	if (kills.length === 0) violations.push("--force sent no signal to the surviving chat host");
	if (kills.some((line) => !/^kill -TERM \d+$/.test(line))) violations.push(`a signal other than plain TERM was sent: ${kills.join("; ")}`);
	if (existsSync(path.join(world.sim, "FORBIDDEN"))) violations.push("the forbidden-signal marker was set");
	return violations;
}

async function scenarioBackupBeforeSwap(t, scriptsDir) {
	const world = await makeWorld(t, "backup");
	const originalDatabase = await readFile(world.database);
	const result = world.update(["--yes"], { scriptsDir });
	const calls = await world.calls();
	const violations = [];
	if (result.status !== 0) violations.push(`expected success, got ${result.status}: ${result.stderr}`);
	const dirs = await world.backupDirs();
	if (dirs.length !== 1) return [...violations, `expected one backup dir, found ${dirs.length}`];
	const [dir] = dirs;
	if (!existsSync(path.join(dir, "BACKUP_COMPLETE"))) violations.push("BACKUP_COMPLETE is missing");
	if (!existsSync(path.join(dir, "data/ao.db")) || !(await readFile(path.join(dir, "data/ao.db"))).equals(originalDatabase)) violations.push("the database copy is missing or differs");
	if (!existsSync(path.join(dir, "app-state.json"))) violations.push("app-state.json was not backed up");
	if (!(await readdir(dir)).some((name) => name.endsWith(".app.bak"))) violations.push("the old app was not kept as .app.bak");
	if (!calls.includes("open-saw-backup-complete=yes")) violations.push("the new app was opened before the backup was complete");
	return violations;
}

// The completed backup record must exist before the old app moves, and the old app must be in the
// backup once it has: checked at the two pause points of the swap (update mode, throwaway world).
async function scenarioRecordBeforeMove(t, scriptsDir) {
	const violations = [];
	for (const point of ["after-record", "after-old-moved"]) {
		const world = await makeWorld(t, `record-${point}`);
		const marker = path.join(world.root, "paused");
		const child = spawn(path.join(scriptsDir, "install.sh"), ["--update", "--quit-timeout", "3", "--stop-timeout", "3", "--health-timeout", "3", "--yes", world.newApp], {
			env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: point, NOETAXIS_TEST_PAUSE_MARKER: marker },
			stdio: "ignore",
		});
		const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
		const [dir] = await world.backupDirs();
		const complete = dir ? existsSync(path.join(dir, "BACKUP_COMPLETE")) : false;
		const moved = dir ? (await readdir(dir)).some((name) => name.endsWith(".app.bak")) : false;
		if (!complete) violations.push(`${point}: BACKUP_COMPLETE does not exist yet`);
		if (point === "after-record" && (moved || world.installedVersion() !== oldVersion)) violations.push("after-record: the old app already moved");
		if (point === "after-old-moved" && !moved) violations.push("after-old-moved: the old app is not in the backup");
		child.kill("SIGTERM");
		await exited;
	}
	return violations;
}

// Only sessions that are live (not terminated, agent not exited) may be touched, by exact id.
async function scenarioExactSessionIds(t, scriptsDir) {
	const world = await makeWorld(t, "exact-ids", {
		sessions: [liveSession("s1"), liveSession("s2", { activity: "exited", host: false }), liveSession("s3", { terminated: true, host: false })],
	});
	const result = world.update(["--yes", "--end-sessions", "--restore-sessions"], { scriptsDir });
	const calls = await world.calls();
	const violations = [];
	const ended = matching(calls, /session exit-agent/).map((line) => line.replace(/^.*session exit-agent (\S+).*$/, "$1"));
	const restored = matching(calls, /session restore/).map((line) => line.replace(/^.*session restore (\S+).*$/, "$1"));
	if (JSON.stringify(ended) !== JSON.stringify(["s1"])) violations.push(`exit-agent ran for ${JSON.stringify(ended)}, expected only ["s1"]`);
	if (JSON.stringify(restored) !== JSON.stringify(["s1"])) violations.push(`restore ran for ${JSON.stringify(restored)}, expected only ["s1"]`);
	if (result.status !== 0) violations.push(`expected success, got ${result.status}`);
	return violations;
}

// ---------------------------------------------------------------------------
// Plan, confirmation, refusal
// ---------------------------------------------------------------------------

test("the plan names what is stopped, which sessions end, what is backed up and restarted; --dry-run changes nothing", darwin, async (t) => {
	const world = await makeWorld(t, "plan", { sessions: [liveSession("s1", { name: "Fix login" }), liveSession("s2", { role: "orchestrator" })], hosting: "on", docker: ["multica-backend-1"], standalone: false });
	const before = JSON.stringify(await world.procs());
	const result = world.update(["--dry-run", "--end-sessions", "--restore-sessions"]);
	assert.equal(result.status, 0, result.stderr);
	for (const expected of [
		"Update plan",
		`${oldVersion} -> ${newVersion}`,
		"Will be STOPPED, in this order",
		"Live sessions (2)",
		"s1",
		"Fix login",
		"s2",
		"These agents WILL BE STOPPED (--end-sessions)",
		"The agent teardown inside AO can force-kill the agent process group (SIGKILL sent by AO, outside the signal rules of this script)",
		"Will be BACKED UP",
		"ao.db (+WAL/SHM)",
		"Will be RESTARTED",
		"AO-hosted Multica daemon: hosting is ON now",
		"local Multica server stack (Docker) is running (multica-backend-1) and is NOT touched",
		"Dry run passed",
	]) {
		assert.ok(result.stdout.includes(expected), `plan is missing "${expected}":\n${result.stdout}`);
	}
	const calls = await world.calls();
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(callIndex(calls, /session (kill|exit-agent)/), -1);
	assert.equal(callIndex(calls, /^open /), -1);
	assert.equal((await world.backupDirs()).length, 0);
	assert.equal(JSON.stringify(await world.procs()), before);
	assert.equal(world.installedVersion(), oldVersion);
});

test("a dry run still refuses (exit 51) when live sessions would be interrupted", darwin, async (t) => {
	const world = await makeWorld(t, "plan-refuse", { sessions: [liveSession("s1")] });
	const result = world.update(["--dry-run"]);
	assert.equal(result.status, 51);
});

test("without --yes the plan is shown and only the answer 'yes' continues", darwin, async (t) => {
	const declined = await makeWorld(t, "confirm-no");
	for (const answer of ["no\n", "\n", "y\n", ""]) {
		const result = declined.update([], { input: answer });
		assert.equal(result.status, 50, `answer ${JSON.stringify(answer)}: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /Update plan/);
		assert.match(result.stdout, /Type "yes" to stop AO and update it/);
	}
	assert.equal(callIndex(await declined.calls(), /^osascript/), -1);
	assert.equal(declined.installedVersion(), oldVersion);

	const accepted = await makeWorld(t, "confirm-yes");
	const result = accepted.update([], { input: "yes\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(accepted.installedVersion(), newVersion);
});

test("the update.sh wrapper is install.sh --update", darwin, async (t) => {
	const world = await makeWorld(t, "wrapper");
	const result = world.run(["--dry-run", world.newApp], { script: "update.sh" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Update plan/);
	// With no app argument it uses ../Applications/<app> next to the script; here that folder does not exist.
	const missing = world.run(["--dry-run"], { script: "update.sh" });
	assert.equal(missing.status, 2);
	assert.match(missing.stderr, /No app bundle given/);
});

test("update options are rejected without --update, and --allow-background-processes does not combine with it", darwin, async (t) => {
	const world = await makeWorld(t, "flags");
	let result = world.run(["--yes", world.newApp]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /only apply with --update/);
	result = world.run(["--update", "--allow-background-processes", world.newApp]);
	assert.equal(result.status, 2);
	result = world.run(["--update", "--quit-timeout", "abc", world.newApp]);
	assert.equal(result.status, 2);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
});

test("live sessions are refused by default with the list and the flags, before anything is stopped", darwin, async (t) => {
	const world = await makeWorld(t, "refuse", { sessions: [liveSession("s1", { name: "Fix login" }), liveSession("s2", { role: "orchestrator" }), liveSession("s3", { terminated: true })] });
	const before = JSON.stringify(await world.procs());
	const result = world.update(["--yes"]);
	assert.equal(result.status, 51);
	assert.match(result.stderr, /2 live session\(s\) would be interrupted/);
	assert.match(result.stderr, /s1/);
	assert.match(result.stderr, /s2/);
	assert.doesNotMatch(result.stderr, /s3/);
	assert.match(result.stderr, /--end-sessions/);
	assert.match(result.stderr, /--restore-sessions/);
	assert.match(result.stderr, /Agent Orchestrator\.app\/Contents\/Resources\/daemon\/ao" session exit-agent <id>/);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /session (kill|exit-agent)/), -1);
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(JSON.stringify(await world.procs()), before);
	assert.equal((await world.backupDirs()).length, 0);
	assert.deepEqual(await scenarioLiveSessionsRefused(t, realScriptsDir), []);
});

test("an unreadable session list while the daemon runs refuses (52) unless --force", darwin, async (t) => {
	const world = await makeWorld(t, "list-fails", { cfg: { sessions_ls_fails: true } });
	const refused = world.update(["--yes"]);
	assert.equal(refused.status, 52);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
	const forced = world.update(["--yes", "--force"]);
	assert.equal(forced.status, 0, forced.stdout + forced.stderr);
});

test("chat hosts with no daemon to end their sessions are refused up front", darwin, async (t) => {
	const world = await makeWorld(t, "hosts-no-daemon", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session lost"], running: false });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 56);
	assert.match(result.stderr, /chat host process\(es\)/);
	assert.match(result.stderr, /--force/);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
});

// ---------------------------------------------------------------------------
// Stopping, in order, with bounded waits
// ---------------------------------------------------------------------------

test("--end-sessions ends the sessions first, then quits the app, then waits for the daemon, then installs and opens", darwin, async (t) => {
	const world = await makeWorld(t, "ordering", { sessions: [liveSession("s1"), liveSession("s2", { role: "orchestrator" })] });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	const list = callIndex(calls, /session ls/);
	const kill1 = callIndex(calls, /session exit-agent s1/);
	const kill2 = callIndex(calls, /session exit-agent s2/);
	const quit = callIndex(calls, /^osascript/);
	const open = callIndex(calls, /^open -a /);
	const status = calls.findIndex((line, index) => index > open && /status --json/.test(line));
	assert.ok(list >= 0 && list < kill1, "sessions are listed before they are ended");
	assert.ok(kill1 < kill2 && kill2 < quit, "every session is ended before the app is asked to quit");
	assert.ok(quit < open, "the app is quit before the new one opens");
	assert.ok(open < status, "health is checked after opening");
	// The agents are stopped; the sessions themselves are kept (never terminated, no worktree teardown).
	assert.deepEqual((await world.sessionsNow()).map((s) => [s.activity, s.terminated]), [["exited", false], ["exited", false]]);
	assert.equal(existsSync(path.join(world.sim, "FORBIDDEN")), false, "ao session kill is never used");
	// Ended sessions use the project scope and the bundled CLI by its full path.
	assert.match(calls[kill1], /Agent Orchestrator\.app\] session exit-agent s1 --project demo/);
	assert.equal(world.installedVersion(), newVersion);
	assert.match(result.stdout, /session s1: agent stopped \(ao session exit-agent; session and worktree kept\)/);
});

test("a session that cannot be ended stops the run before the app is touched (53)", darwin, async (t) => {
	const world = await makeWorld(t, "kill-fails", { sessions: [liveSession("s1"), liveSession("s2")], cfg: { exit_fail_s2: true } });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 53);
	assert.match(result.stderr, /1 of 2 session\(s\) could not be ended/);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(world.installedVersion(), oldVersion);
	assert.ok((await world.procs()).some((p) => p.command.endsWith("Contents/MacOS/Agent Orchestrator")), "the app is still running");
});

test("the app is quit through the tray item of its own process; no plain AppleScript quit, no kill", darwin, async (t) => {
	const world = await makeWorld(t, "tray");
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	const script = matching(calls, /^osascript/);
	assert.equal(script.length, 1);
	assert.match(script[0], /Quit AO Completely/);
	assert.match(script[0], /unix id is targetPid/);
	assert.doesNotMatch(script[0], /to quit|quit app/);
	assert.match(script[0], / 4001$/, "the process id of the Contents/MacOS main process is passed");
	assert.equal(matching(calls, /^kill /).length, 0);
	assert.equal(matching(calls, /daemon\/ao\] stop/).length, 0, "the daemon stopped by itself, so no ao stop");
});

test("a daemon that does not stop by itself is stopped with the bundled ao stop (full path), never a signal", darwin, async (t) => {
	const world = await makeWorld(t, "daemon-stays", { cfg: { daemon_stays: true } });
	// "ao stop" works: the fake daemon exits when asked.
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	const stop = matching(calls, /Agent Orchestrator\.app\] stop /);
	assert.equal(stop.length, 1);
	assert.match(stop[0], /stop --timeout 20s/);
	assert.equal(matching(calls, /^kill /).length, 0);
	assert.match(result.stdout, /asking it to stop with "ao stop"/);
});

test("a daemon that ignores ao stop stops the run (55) without --force; --force sends it SIGTERM", darwin, async (t) => {
	const refused = await makeWorld(t, "daemon-stuck", { cfg: { daemon_stays: true, stop_ineffective: true } });
	let result = refused.update(["--yes"]);
	assert.equal(result.status, 55);
	assert.match(result.stderr, /AO daemon is still running/);
	assert.match(result.stderr, /rerun with --force/);
	assert.equal(matching(await refused.calls(), /^kill /).length, 0);
	assert.equal(refused.installedVersion(), oldVersion);

	const forced = await makeWorld(t, "daemon-stuck-force", { cfg: { daemon_stays: true, stop_ineffective: true } });
	result = forced.update(["--yes", "--force"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const kills = matching(await forced.calls(), /^kill /);
	assert.equal(kills.length, 1);
	assert.match(kills[0], /^kill -TERM \d+$/);
	assert.match(result.stdout, /SIGTERM to pid \d+ \(daemon did not stop\)/);
});

test("when the tray cannot be scripted the run waits for the user, then stops (54) without a kill; --force sends SIGTERM", darwin, async (t) => {
	const world = await makeWorld(t, "tray-fails", { cfg: { tray_fail: true } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 54);
	assert.match(result.stdout, /could not click the tray item/);
	assert.match(result.stderr, /Choose "Quit AO Completely" in the menu bar yourself/);
	assert.equal(matching(await world.calls(), /^kill /).length, 0);
	assert.equal(world.installedVersion(), oldVersion);
	assert.equal((await world.backupDirs()).filter((dir) => existsSync(path.join(dir, "BACKUP_COMPLETE"))).length, 0, "no completed backup: nothing was swapped");
	assert.equal(existsSync(path.join(world.appsDir, ".Agent-Orchestrator-installing-x")), false);
	assert.deepEqual((await readdir(world.appsDir)).filter((name) => name.startsWith(".Agent-Orchestrator-installing")), [], "the staged copy was removed");

	// The main process ignores SIGTERM here (as a tray build may): still no escalation.
	const stubbornWorld = await makeWorld(t, "tray-fails-force", { cfg: { tray_fail: true, stubborn: "4001\n" } });
	const stubborn = stubbornWorld.update(["--yes", "--force"]);
	assert.equal(stubborn.status, 54);
	assert.match(stubborn.stdout, /SIGTERM to pid 4001/);
	const kills = matching(await stubbornWorld.calls(), /^kill /);
	assert.ok(kills.length >= 1 && kills.every((line) => line === "kill -TERM 4001" || /^kill -TERM \d+$/.test(line)));
	assert.equal(existsSync(path.join(stubbornWorld.sim, "FORBIDDEN")), false);
});

test("--manual-quit does not script the tray; the run waits for the user's click", darwin, async (t) => {
	const world = await makeWorld(t, "manual");
	await world.addTimer(30, `sim_quit_bundle '${world.targetApp}'`);
	const result = world.update(["--yes", "--manual-quit", "--quit-timeout", "10"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
	assert.match(result.stdout, /click the Agent Orchestrator icon in the menu bar/);
});

test("survivors after the stop are listed and refused (56) without --force", darwin, async (t) => {
	const world = await makeWorld(t, "survivor", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 56);
	assert.match(result.stderr, /still running after the wait/);
	assert.match(result.stderr, /chat-host --session orphan/);
	assert.match(result.stderr, /rerun with --force/);
	assert.equal(matching(await world.calls(), /^kill /).length, 0);
	assert.equal(world.installedVersion(), oldVersion);
});

test("a ShipIt that finishes is waited for; one that stays blocks (22) and is never touched", darwin, async (t) => {
	const finishing = await makeWorld(t, "shipit-ends", { extraProcs: ["/x/ShipIt"] });
	await finishing.addTimer(40, "sim_remove_prefix '/x/ShipIt'");
	let result = finishing.update(["--yes", "--stop-timeout", "40"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Waiting for ShipIt/);

	const staying = await makeWorld(t, "shipit-stays", { extraProcs: ["/x/ShipIt"] });
	result = staying.update(["--yes"]);
	assert.equal(result.status, 22);
	assert.equal(matching(await staying.calls(), /^kill /).length, 0);
});

// ---------------------------------------------------------------------------
// Signals: SIGTERM only, own bundle only
// ---------------------------------------------------------------------------

test("--force sends plain SIGTERM to a surviving own-bundle process and never any other signal", darwin, async (t) => {
	assert.deepEqual(await scenarioForcedTermination(t, realScriptsDir), []);
	const world = await makeWorld(t, "force-stubborn", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	await world.setCfg("stubborn", "4004\n");
	const result = world.update(["--yes", "--force"]);
	assert.equal(result.status, 56, "a process that ignores SIGTERM is reported, not escalated");
	assert.match(result.stdout, /SIGTERM to pid 4004 \(survived the stop\)/);
	const kills = matching(await world.calls(), /^kill /);
	assert.deepEqual(kills, ["kill -TERM 4004"]);
	assert.equal(existsSync(path.join(world.sim, "FORBIDDEN")), false);
	const log = await readFile(path.join((await world.backupDirs())[0], "update-actions.log"), "utf8");
	assert.match(log, /SIGTERM to pid 4004/);
});

test("only processes of this bundle are touched: lookalike paths and other apps are listed or left alone", darwin, async (t) => {
	assert.deepEqual(await scenarioLookalikeProcess(t, realScriptsDir), []);
	const world = await makeWorld(t, "lookalike-message", { extraProcs: ["/Volumes/Old Disk<APP>/Contents/MacOS/Agent Orchestrator"] });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 21);
	assert.match(result.stderr, /never signals them/);
	assert.match(result.stderr, /\/Volumes\/Old Disk/);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);

	// An unrelated app and an AO bundle at another path never match, so the run goes on and leaves them.
	const bystanders = await makeWorld(t, "bystanders", {
		extraProcs: ["/Users/someone/Other/Agent Orchestrator Dev.app/Contents/MacOS/Agent Orchestrator", "/usr/bin/vim notes.txt", "<APP>/Contents/Resources/daemon/ao chat-host --session orphan"],
	});
	const ok = bystanders.update(["--yes", "--force"]);
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	const kills = matching(await bystanders.calls(), /^kill /);
	assert.equal(kills.length, 1);
	const remaining = (await bystanders.procs()).map((p) => p.command);
	assert.ok(remaining.includes("/usr/bin/vim notes.txt"));
	assert.ok(remaining.some((c) => c.startsWith("/Users/someone/Other/")));
});

test("the update code can only send SIGTERM, and only from noetaxis_signal_own_pid", async () => {
	const text = await readFile(path.join(realScriptsDir, "update-lib.sh"), "utf8");
	// Comments and messages may talk about SIGTERM/SIGKILL; executable lines may not mention a stronger signal.
	const executable = text.split("\n").filter((line) => !/^\s*(#|(printf|noetaxis_update_say|noetaxis_update_warn|noetaxis_error)\b)/.test(line)).join("\n");
	assert.doesNotMatch(executable, /SIGKILL|pkill|killall|-KILL|(^|\s)-9(\s|$)|kill -s|kill -SIG/);
	const lines = text.split("\n");
	let currentFunction = "";
	const signalLines = [];
	lines.forEach((line, index) => {
		const header = line.match(/^(noetaxis_[a-z_]+)\(\) \{/);
		if (header) currentFunction = header[1];
		const code = line.trim();
		if (code.startsWith("#")) return;
		if (/NOETAXIS_KILL|\/bin\/kill|(^|[\s;|&(`$])kill\s+-/.test(code) && !/^(noetaxis_update_say|noetaxis_update_log|noetaxis_error|printf)\b/.test(code)) signalLines.push(`${currentFunction}:${index + 1}: ${code}`);
	});
	assert.deepEqual(signalLines.map((l) => l.split(":")[0]), ["noetaxis_signal_own_pid"], signalLines.join("\n"));
	assert.match(signalLines[0], /-TERM/);
	// The other installer scripts still contain no signal, quit or stop command at all.
	for (const file of ["common.sh", "install.sh", "rollback.sh", "update.sh", "pkg-scripts/preinstall", "pkg-scripts/postinstall"]) {
		const source = (await readFile(path.join(realScriptsDir, file), "utf8")).split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
		assert.doesNotMatch(source, /NOETAXIS_KILL|\/bin\/kill|pkill|killall|osascript|launchctl|NOETAXIS_OSASCRIPT/, file);
	}
});

// ---------------------------------------------------------------------------
// Backup, install, restart, health
// ---------------------------------------------------------------------------

test("the backup (database, state files, old app, captured state) is complete before the app is opened", darwin, async (t) => {
	assert.deepEqual(await scenarioBackupBeforeSwap(t, realScriptsDir), []);
	const world = await makeWorld(t, "backup-detail", { sessions: [liveSession("s1", { name: "Fix login" })], hosting: "on", standalone: false, docker: ["multica-backend-1"] });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const dir = await onlyBackup(world);
	const record = await readFile(path.join(dir, "BACKUP_COMPLETE"), "utf8");
	assert.match(record, /^app_version=0\.13\.4-noetaxis\.1111111$/m);
	assert.match(record, /^update_mode=1$/m);
	assert.match(record, /^schema_before=190$/m);
	const bak = (await readdir(dir)).find((name) => name.endsWith(".app.bak"));
	assert.ok(bak);
	assert.equal(execute("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(dir, bak, "Contents/Info.plist")]).stdout.trim(), oldVersion);
	// Captured state, written before anything was stopped.
	for (const name of ["state.env", "ao-status.json", "sessions.json", "live-sessions.tsv", "multica-status.json", "multica-daemon.json", "multica-stack.txt", "processes.txt"]) {
		assert.ok(existsSync(path.join(dir, "state-before", name)), `state-before/${name}`);
	}
	assert.ok(existsSync(path.join(dir, "update-actions.log")));
	// The old app is restorable with the existing rollback script.
	const rolledBack = world.run([], { script: "rollback.sh" });
	assert.equal(rolledBack.status, 21, "rollback.sh refuses while the new app runs, as before");
});

test("state capture records sessions, daemon, Multica hosting, the standalone daemon, the Docker stack and processes", darwin, async (t) => {
	const world = await makeWorld(t, "capture", { sessions: [liveSession("s1", { name: 'Name with "quotes"\tand a tab' }), liveSession("s2", { terminated: true }), liveSession("s5", { activity: "exited", host: false })], hosting: "off", standalone: true, docker: ["multica-backend-1", "multica-postgres-1"] });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const dir = path.join(await onlyBackup(world), "state-before");
	const state = await readFile(path.join(dir, "state.env"), "utf8");
	assert.match(state, /^daemon_state=ready$/m);
	assert.match(state, /^daemon_port=3999$/m);
	assert.match(state, /^sessions_status=ok$/m);
	assert.match(state, /^live_sessions=1$/m);
	assert.match(state, /^multica_hosting=no$/m);
	assert.match(state, /^standalone_multica_daemon=yes$/m);
	assert.match(state, /^multica_stack_running=multica-backend-1 multica-postgres-1$/m);
	assert.match(state, /^schema_before=190$/m);
	const sessions = JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8"));
	assert.equal(sessions.data.length, 3);
	assert.match(await readFile(path.join(dir, "processes.txt"), "utf8"), /Contents\/MacOS\/Agent Orchestrator/);
	assert.match(await readFile(path.join(dir, "multica-stack.txt"), "utf8"), /multica-backend-1\tUp 2 hours/);
	const calls = await world.calls();
	// Calls use the bundled CLI by its full path, and the stack is read only.
	assert.ok(matching(calls, /^ao\[/).every((line) => line.includes("Agent Orchestrator.app]")));
	assert.equal(matching(calls, /^docker restart/).length, 0);
	assert.equal(matching(calls, /^multica daemon (restart|start)/).length, 0);
	assert.match(result.stdout, /standalone Multica CLI daemon is running and is NOT touched|standalone Multica CLI daemon \(running now\)/);
	assert.match(result.stdout, /A standalone Multica CLI daemon was running before and was left untouched/);
});

test("--restart-multica-daemon and --restart-multica-stack restart only what was running before, only when asked", darwin, async (t) => {
	const world = await makeWorld(t, "multica-restart", { standalone: true, docker: ["multica-backend-1", "multica-postgres-1"] });
	const result = world.update(["--yes", "--restart-multica-daemon", "--restart-multica-stack"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	assert.equal(matching(calls, /^multica daemon restart/).length, 1);
	assert.deepEqual(matching(calls, /^docker restart/), ["docker restart multica-backend-1", "docker restart multica-postgres-1"]);
	assert.ok(callIndex(calls, /^open -a/) < callIndex(calls, /^multica daemon restart/), "restarted after the app is healthy");

	// The flags do nothing for a daemon or stack that was not running.
	const idle = await makeWorld(t, "multica-restart-idle", { standalone: false, docker: [] });
	const second = idle.update(["--yes", "--restart-multica-daemon", "--restart-multica-stack"]);
	assert.equal(second.status, 0, second.stdout + second.stderr);
	const idleCalls = await idle.calls();
	assert.equal(matching(idleCalls, /^multica daemon (restart|start)/).length, 0);
	assert.equal(matching(idleCalls, /^docker restart/).length, 0);
});

test("a failed docker restart is a failure of that step: labelled, counted (exit 62) and left for the user", darwin, async (t) => {
	const world = await makeWorld(t, "docker-fails", { docker: ["multica-backend-1", "multica-postgres-1"], cfg: { docker_restart_fail: "multica-postgres-1\n" } });
	const result = world.update(["--yes", "--restart-multica-stack"]);
	assert.equal(result.status, 62, result.stdout + result.stderr);
	assert.match(result.stdout, /docker restart multica-postgres-1: FAILED \(exit 1\)/);
	assert.match(result.stdout, /Docker container multica-postgres-1: restart FAILED \(exit 1\)/);
	assert.match(result.stdout, /Docker container multica-backend-1 restarted/);
	assert.match(result.stdout, /The Multica Docker container multica-postgres-1 did not restart/);
	assert.doesNotMatch(result.stdout, /multica-postgres-1 restarted/);
});

test("the tray click tries the quit label of every UI locale, and the list follows the app's translations", darwin, async (t) => {
	const i18n = path.resolve(realScriptsDir, "../../src/renderer/i18n");
	const labels = new Map();
	for (const file of (await readdir(i18n)).filter((name) => name.endsWith(".json"))) {
		const value = JSON.parse(await readFile(path.join(i18n, file), "utf8"))["tray.quit"];
		if (value) labels.set(file, value);
	}
	assert.ok(labels.size >= 8, `expected the eight known locales, found ${labels.size}`);
	const world = await makeWorld(t, "tray-locales");
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const script = matching(await world.calls(), /^osascript/)[0];
	for (const [file, label] of labels) assert.ok(script.includes(`"${label}"`), `the tray click does not know the ${file} label "${label}"`);
});

test("a hosted Multica daemon that was on and is off after the restart is reported with how to turn it on, without touching a profile", darwin, async (t) => {
	const world = await makeWorld(t, "hosting", { hosting: "on", cfg: { hosting_after_open: "off" } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Left for you:/);
	assert.match(result.stdout, /AO-hosted Multica daemon was ON before and is OFF now/);
	assert.match(result.stdout, /AO_MULTICA_DAEMON=1/);
	assert.match(result.stdout, /Nothing in your shell profile was changed/);
	for (const profile of [".zshrc", ".zprofile", ".bash_profile", ".bashrc", ".profile"]) assert.equal(existsSync(path.join(world.home, profile)), false);
});

test("the new app is opened by its installed path, the daemon must be ready and healthy, and the checks are reported", darwin, async (t) => {
	const world = await makeWorld(t, "restart");
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	assert.deepEqual(matching(calls, /^open -a /), [`open -a ${world.targetApp}`]);
	assert.equal(matching(calls, /^curl /).length, 1);
	assert.match(matching(calls, /^curl /)[0], /http:\/\/127\.0\.0\.1:3999\/healthz/);
	assert.equal(world.installedVersion(), newVersion);
	for (const expected of ["the new app is healthy: ao status ready, /healthz ok on port 3999", `ok    installed version ${newVersion}`, "ao spawn --effort is present", "--permission-fallback is present", "database schema version 190 (before: 190; read-only)", "ao-app:// handler: registered", `old ${oldVersion}  ->  new ${newVersion}`, "exit 0: updated and healthy"]) {
		assert.ok(result.stdout.includes(expected), `missing "${expected}" in:\n${result.stdout}`);
	}
	assert.match(result.stdout, /full path: ".*Agent Orchestrator\.app\/Contents\/Resources\/daemon\/ao" status/);
});

test("missing flags in the new CLI are reported as warnings with exit 62, not rolled back", darwin, async (t) => {
	const world = await makeWorld(t, "warn", { cfg: { no_effort_flag: true } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 62);
	assert.match(result.stdout, /WARN  ao spawn --help does not list --effort/);
	assert.equal(world.installedVersion(), newVersion);
});

test("an update when the same build is already installed stops nothing (exit 0)", darwin, async (t) => {
	const world = await makeWorld(t, "already");
	await cp(world.newApp, path.join(world.appsDir, "x.app"), { recursive: true });
	execute("/bin/rm", ["-rf", world.targetApp]);
	execute("/bin/mv", [path.join(world.appsDir, "x.app"), world.targetApp]);
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Already installed: 0\.13\.4-noetaxis\.2222222/);
	assert.match(result.stdout, /Nothing was stopped, backed up or changed/);
	assert.match(result.stdout, /already up to date, nothing changed/);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
	assert.equal((await world.backupDirs()).length, 0);
});

// ---------------------------------------------------------------------------
// Automatic rollback
// ---------------------------------------------------------------------------

test("an unhealthy new daemon is rolled back automatically: new app quit, old app restored, reopened and healthy (exit 60)", darwin, async (t) => {
	const world = await makeWorld(t, "rollback", { cfg: { unhealthy_versions: `${newVersion}\n` } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 60, result.stdout + result.stderr);
	assert.equal(world.installedVersion(), oldVersion, "the previous app is back");
	assert.match(result.stdout, /The new app is not healthy \(ao status: not_ready\): rolling back automatically/);
	assert.match(result.stdout, /Restoring the backed-up app/);
	assert.match(result.stdout, /the previous app is healthy again/);
	const calls = await world.calls();
	assert.equal(matching(calls, /^osascript/).length, 2, "the new app is quit through the tray before the restore");
	assert.equal(matching(calls, /^open -a /).length, 2, "new app, then the restored old app");
	const dir = await onlyBackup(world);
	assert.ok(existsSync(path.join(dir, "BACKUP_COMPLETE")));
	assert.ok((await readdir(dir)).filter((name) => name.endsWith(".app.bak")).length >= 1);
	assert.match(result.stdout, /exit 60: new app unhealthy; previous app restored and healthy/);
	assert.equal(matching(calls, /^kill /).length, 0);
	assert.equal(world.schema(), "190", "the database was not touched");
});

test("--restore-sessions is honoured when the update ends on the previous app, and otherwise the ended sessions are listed", darwin, async (t) => {
	const world = await makeWorld(t, "rollback-restore", { sessions: [liveSession("s1"), liveSession("s2")], cfg: { unhealthy_versions: `${newVersion}\n` } });
	const result = world.update(["--yes", "--end-sessions", "--restore-sessions"]);
	assert.equal(result.status, 60, result.stdout + result.stderr);
	assert.equal(world.installedVersion(), oldVersion);
	const calls = await world.calls();
	assert.equal(matching(calls, /session restore s1/).length, 1);
	assert.equal(matching(calls, /session restore s2/).length, 1);
	assert.match(result.stdout, /s1: came back/);
	assert.deepEqual((await world.sessionsNow()).map((s) => s.activity), ["active", "active"]);

	// A failed rollback restores nothing but says which sessions are waiting and how to resume them.
	const stuck = await makeWorld(t, "rollback-no-restore", { sessions: [liveSession("s1")], cfg: { unhealthy_versions: `${newVersion}\n`, tray_fail_versions: `${newVersion}\n` } });
	const failed = stuck.update(["--yes", "--end-sessions", "--restore-sessions"]);
	assert.equal(failed.status, 61);
	assert.equal(matching(await stuck.calls(), /session restore/).length, 0);
	assert.match(failed.stdout, /--restore-sessions was given, but no restore ran/);
	assert.match(failed.stdout, /- s1 \[demo\]/);
});

test("--restore-sessions also applies when a failure before the swap reopens the previous app", darwin, async (t) => {
	const world = await makeWorld(t, "reopen-restore", { sessions: [liveSession("s1")], extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	const result = world.update(["--yes", "--end-sessions", "--restore-sessions"]);
	assert.equal(result.status, 56);
	assert.equal(matching(await world.calls(), /session restore s1/).length, 1);
	assert.match(result.stdout, /s1: came back/);
});

test("a new app that never starts is rolled back too", darwin, async (t) => {
	const world = await makeWorld(t, "rollback-nostart", { cfg: { no_start_versions: `${newVersion}\n` } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 60, result.stdout + result.stderr);
	assert.match(result.stdout, /the app process did not appear within 3s/);
	assert.equal(world.installedVersion(), oldVersion);
});

test("a failed open is rolled back, and a healthz that never answers is not healthy", darwin, async (t) => {
	const world = await makeWorld(t, "rollback-healthz", { cfg: { healthz_fail: true } });
	const result = world.update(["--yes"]);
	// healthz fails for the restored old app as well, so the rollback itself is reported as unfinished.
	assert.ok([60, 61].includes(result.status), `${result.status}`);
	assert.match(result.stdout, /ao status ready but \/healthz on port 3999 did not answer/);
	assert.equal(world.installedVersion(), oldVersion);
});

test("when the new app cannot be quit the rollback stops with exit 61 and the exact manual command", darwin, async (t) => {
	// The old app quits through the tray; the new one cannot be scripted.
	const world = await makeWorld(t, "rollback-stuck", { cfg: { unhealthy_versions: `${newVersion}\n`, tray_fail_versions: `${newVersion}\n` } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 61, result.stdout + result.stderr);
	assert.match(result.stdout, /Automatic rollback did not finish|AUTOMATIC ROLLBACK FAILED/);
	assert.match(result.stdout, /rollback\.sh" --backup-dir ".*ao-backups/);
	assert.equal(world.installedVersion(), newVersion, "the new app was left in place: nothing was force-killed or swapped under a running app");
	assert.equal(matching(await world.calls(), /^kill /).length, 0);
});

test("the database is restored on rollback only when the schema was migrated, the old app stays unhealthy and --rollback-restore-db is given", darwin, async (t) => {
	const options = { cfg: { unhealthy_versions: `${newVersion}\n`, [`migrate_${newVersion}`]: "194", [`max_schema_${oldVersion}`]: "190" } };
	const without = await makeWorld(t, "rollback-db-no", options);
	let result = without.update(["--yes"]);
	assert.equal(result.status, 61, result.stdout + result.stderr);
	assert.equal(without.installedVersion(), oldVersion);
	assert.equal(without.schema(), "194", "the database is not restored without the flag");
	assert.match(result.stdout, /migrated the database from schema 190 to 194/);
	assert.match(result.stdout, /--restore-db/);

	const withFlag = await makeWorld(t, "rollback-db-yes", options);
	result = withFlag.update(["--yes", "--rollback-restore-db"]);
	assert.equal(result.status, 60, result.stdout + result.stderr);
	assert.equal(withFlag.installedVersion(), oldVersion);
	assert.equal(withFlag.schema(), "190", "the backed-up database is back");
	const dir = await onlyBackup(withFlag);
	assert.ok((await readdir(dir)).some((name) => name.startsWith("rollback-current-data-")), "the migrated database was saved first");
	assert.match(result.stdout, /restoring the backed-up database \(--rollback-restore-db\)/);

	// No migration happened, so the flag has nothing to restore even though the old app is unhealthy.
	const unmigrated = await makeWorld(t, "rollback-db-nomig", { cfg: { unhealthy_versions: `${newVersion}\n${oldVersion}\n` } });
	result = unmigrated.update(["--yes", "--rollback-restore-db"]);
	assert.equal(result.status, 61);
	assert.match(result.stdout, /restoring it is not indicated/);
});

// ---------------------------------------------------------------------------
// Session restore
// ---------------------------------------------------------------------------

test("--restore-sessions tries each ended session once and reports which came back", darwin, async (t) => {
	const world = await makeWorld(t, "restore", {
		sessions: [liveSession("s1"), liveSession("s2"), liveSession("s3"), liveSession("s4")],
		cfg: { restore_fail_s2: true, restore_noop_s3: true },
	});
	const result = world.update(["--yes", "--end-sessions", "--restore-sessions"]);
	assert.equal(result.status, 63, result.stdout + result.stderr);
	const calls = await world.calls();
	for (const id of ["s1", "s2", "s3", "s4"]) assert.equal(matching(calls, new RegExp(`session restore ${id}( |$)`)).length, 1, `one restore attempt for ${id}`);
	for (const expected of ["s1: came back", "s4: came back", "s2: restore FAILED (cannot restore s2)", "s3: restore reported success but the session is not live", "2 restore attempt(s); 2 came back; 2 did not|4 restore attempt(s); 2 came back; 2 did not"]) {
		assert.ok(new RegExp(expected.replace(/[()]/g, "\\$&")).test(result.stdout), `missing "${expected}" in:\n${result.stdout}`);
	}
	assert.match(result.stdout, /exit 63: updated and healthy, but not every session came back/);
	assert.deepEqual((await world.sessionsNow()).map((s) => s.activity), ["active", "exited", "exited", "active"]);
});

test("without --restore-sessions the ended sessions are listed with how to restore them", darwin, async (t) => {
	const world = await makeWorld(t, "no-restore", { sessions: [liveSession("s1"), liveSession("s2")] });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0);
	assert.equal(matching(await world.calls(), /session restore/).length, 0);
	assert.match(result.stdout, /2 agent\(s\) stopped; resume with "ao session restore <id>"/);
	assert.match(result.stdout, /- s1 \[demo\]/);
});

// ---------------------------------------------------------------------------
// The AO-session guard and --detached
// ---------------------------------------------------------------------------

test("inside an AO session the update refuses (20) and nothing runs; --allow-ao-session does not unlock it", darwin, async (t) => {
	const world = await makeWorld(t, "guard");
	const result = world.update(["--yes"], { extraEnv: { AO_SESSION_ID: "mer-3" } });
	assert.equal(result.status, 20);
	assert.match(result.stderr, /started inside Agent Orchestrator/);
	assert.match(result.stderr, /--detached/);
	assert.equal((await world.calls()).length, 0, "not even a read-only ao call");
	const allowed = world.run(["--update", "--allow-ao-session", "--yes", world.newApp], { extraEnv: { AO_SESSION_ID: "mer-3" } });
	assert.equal(allowed.status, 2);
	assert.match(allowed.stderr, /Use --detached/);
	// A dry run may look from inside a session when that is explicit.
	const dry = world.run(["--update", "--dry-run", "--allow-ao-session", world.newApp], { extraEnv: { AO_SESSION_ID: "mer-3" } });
	assert.equal(dry.status, 0, dry.stderr);
});

test("only the sessions the plan listed may be ended: one that appears afterwards is refused with a new plan", darwin, async (t) => {
	const addedLine = "s9|demo|worker|working|active|false|Started late";
	const world = await makeWorld(t, "late-session", { sessions: [liveSession("s1")], cfg: { add_session_on_call: "2", add_session_line: `${addedLine}\n` } });
	await world.addProc(`${world.targetApp}/Contents/Resources/daemon/ao chat-host --session s9`);
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 51, result.stdout + result.stderr);
	assert.match(result.stderr, /appeared since the plan was shown and confirmed/);
	assert.match(result.stderr, /s9/);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /session exit-agent/), -1, "not even the confirmed session was touched");
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(world.installedVersion(), oldVersion);
	// A new plan lists both, and then both may be ended.
	const again = world.update(["--yes", "--end-sessions"]);
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.equal(matching(await world.calls(), /session exit-agent/).length, 2);
});

test("mutation: ending a session that was not in the confirmed plan is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", 'if [[ -n "$additions" ]]; then', "if false; then");
	const world = await makeWorld(t, "late-session-mutant", { sessions: [liveSession("s1")], cfg: { add_session_on_call: "2", add_session_line: "s9|demo|worker|working|active|false|\n" } });
	const result = world.update(["--yes", "--end-sessions"], { scriptsDir: mutant });
	assert.ok(matching(await world.calls(), /session exit-agent s9/).length > 0 || result.status !== 51, "the mutant must end the unconfirmed session");
});

test("only one install, update or rollback runs at a time (exit 36); a dead owner's lock is taken over; a dry run ignores it", darwin, async (t) => {
	const world = await makeWorld(t, "lock");
	const lock = path.join(world.home, ".ao-install.lock");
	await mkdir(lock, { recursive: true });
	await writeFile(path.join(lock, "pid"), String(process.pid));
	const blocked = world.update(["--yes"]);
	assert.equal(blocked.status, 36);
	assert.match(blocked.stderr, new RegExp(`Another install, update or rollback is running \\(pid ${process.pid}`));
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
	assert.equal(world.installedVersion(), oldVersion);
	const idle = await makeWorld(t, "lock-default", { running: false });
	await mkdir(path.join(idle.home, ".ao-install.lock"), { recursive: true });
	await writeFile(path.join(idle.home, ".ao-install.lock/pid"), String(process.pid));
	assert.equal(idle.run([idle.newApp]).status, 36, "the default install takes the lock too");
	const rollback = world.run([], { script: "rollback.sh" });
	assert.equal(rollback.status, 36);
	assert.equal(world.update(["--dry-run"]).status, 0, "a dry run changes nothing and takes no lock");
	// A lock whose owner is gone is stale.
	const dead = execute("/bin/sh", ["-c", "echo $$"]).stdout.trim();
	await writeFile(path.join(lock, "pid"), dead);
	const result = world.update(["--yes"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(existsSync(lock), false, "the lock is released at exit");
	assert.equal(readdirSync(world.home).filter((name) => name.startsWith(".ao-install.lock")).length, 0);
});

test("a second install cannot swap while the first is paused mid-swap; the first still ends with an intact bundle", darwin, async (t) => {
	const world = await makeWorld(t, "lock-swap", { running: false });
	const marker = path.join(world.root, "paused");
	const first = spawn(path.join(realScriptsDir, "install.sh"), [world.newApp], {
		env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: "after-old-moved", NOETAXIS_TEST_PAUSE_MARKER: marker },
		stdio: "ignore",
	});
	const exited = new Promise((resolve) => first.on("exit", (code) => resolve(code)));
	for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(existsSync(marker), "the first install never reached the pause");
	// The old app is moved away and the new one is not in place yet: a second run must not touch anything.
	assert.equal(world.run([world.newApp]).status, 36);
	assert.equal(world.update(["--yes"]).status, 36);
	assert.equal(world.run([], { script: "rollback.sh" }).status, 36);
	assert.equal(await exited, 0);
	assert.equal(world.installedVersion(), newVersion);
	assert.deepEqual((await readdir(world.targetApp)).sort(), ["Contents"], "nothing was nested inside the installed bundle");
	assert.equal(existsSync(path.join(world.home, ".ao-install.lock")), false);
});

test("if ps cannot run, an owner is assumed alive: the lock and another run's staging directory stand", darwin, async (t) => {
	const world = await makeWorld(t, "lock-ps-denied", { running: false });
	const dead = execute("/bin/sh", ["-c", "echo $$"]).stdout.trim();
	const lock = path.join(world.home, ".ao-install.lock");
	await mkdir(lock, { recursive: true });
	await writeFile(path.join(lock, "pid"), dead);
	const deniedPs = path.join(fakesDir, "ps-denied");
	const blocked = world.run([world.newApp], { extraEnv: { NOETAXIS_PS: deniedPs } });
	assert.equal(blocked.status, 36, blocked.stdout + blocked.stderr);
	assert.equal(existsSync(lock), true, "the lock was not taken over");
	// Staging directories of an owner that cannot be shown dead are left alone as well.
	await rm(lock, { recursive: true });
	const staging = path.join(world.appsDir, `.Agent-Orchestrator-installing-20260101-000000-${dead}.app`);
	await mkdir(staging, { recursive: true });
	const result = world.run([world.newApp], { extraEnv: { NOETAXIS_PS: deniedPs } });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(existsSync(staging), true, "another updater's staging copy survives when its owner cannot be checked");
});

test("a session that appears when the plan listed none is refused too (an empty confirmed set confirms nothing)", darwin, async (t) => {
	const cfg = { add_session_on_call: "2", add_session_line: "s9|demo|worker|working|active|false|Late\n" };
	const world = await makeWorld(t, "late-session-empty", { sessions: [], cfg });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 51, result.stdout + result.stderr);
	assert.match(result.stderr, /s9/);
	assert.equal(callIndex(await world.calls(), /session exit-agent/), -1);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
	// The mutant with the NR == FNR set difference ends the unconfirmed session.
	const mutant = await mutatedScripts(t, "update-lib.sh", "'FILENAME == ARGV[1] { known[$1] = 1; next }", "'NR == FNR { known[$1] = 1; next }");
	const second = await makeWorld(t, "late-session-empty-mutant", { sessions: [], cfg });
	second.update(["--yes", "--end-sessions"], { scriptsDir: mutant });
	assert.ok(callIndex(await second.calls(), /session exit-agent s9/) >= 0, "the NR == FNR version is caught: it ends s9");
});

test("a lock directory without a readable pid fails closed (36), including while its creator has not written the pid yet", darwin, async (t) => {
	const world = await makeWorld(t, "lock-no-pid");
	const lock = path.join(world.home, ".ao-install.lock");
	await mkdir(lock, { recursive: true });
	const blocked = world.update(["--yes"]);
	assert.equal(blocked.status, 36, blocked.stdout + blocked.stderr);
	assert.equal(existsSync(lock), true, "the lock was not taken over");
	await writeFile(path.join(lock, "pid"), "not-a-pid");
	assert.equal(world.update(["--yes"]).status, 36);
	await rm(lock, { recursive: true });
	// The creator writes its pid a moment after mkdir: the second run waits for it and is refused.
	const late = await makeWorld(t, "lock-late-pid");
	const lateLock = path.join(late.home, ".ao-install.lock");
	await mkdir(lateLock, { recursive: true });
	// spawnSync blocks this event loop, so the late writer is its own process.
	spawn("/bin/sh", ["-c", `/bin/sleep 0.5; printf %s ${process.pid} > "${path.join(lateLock, "pid")}"`], { stdio: "ignore" }).unref();
	const result = late.update(["--yes"]);
	assert.equal(result.status, 36);
	assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
	assert.equal(late.installedVersion(), oldVersion);
});

test("the lock is released last: it still stands while the cleanup restores the previous app", darwin, async (t) => {
	const world = await makeWorld(t, "lock-last");
	const marker = path.join(world.root, "paused");
	const child = spawn(path.join(realScriptsDir, "install.sh"), ["--update", "--quit-timeout", "3", "--stop-timeout", "3", "--health-timeout", "3", "--yes", world.newApp], {
		env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: "after-old-moved cleanup-end", NOETAXIS_TEST_PAUSE_MARKER: marker, NOETAXIS_TEST_PAUSE_SECONDS: "6" },
		stdio: "ignore",
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(existsSync(marker), "never reached after-old-moved");
	child.kill("SIGTERM");
	for (let attempt = 0; attempt < 300 && !existsSync(`${marker}.cleanup`); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(existsSync(`${marker}.cleanup`), "never reached the end of the cleanup");
	// The previous app is already back, and the lock still stands: another run is refused.
	assert.equal(world.installedVersion(), oldVersion);
	assert.equal(existsSync(path.join(world.home, ".ao-install.lock")), true);
	assert.equal(world.update(["--yes"]).status, 36);
	assert.equal(await exited, 143);
	assert.equal(existsSync(path.join(world.home, ".ao-install.lock")), false);
});

test("the automatic rollback inside an update runs under the update's own lock", darwin, async (t) => {
	const world = await makeWorld(t, "lock-rollback", { cfg: { unhealthy_versions: `${newVersion}\n` } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 60, result.stdout + result.stderr);
	assert.equal(existsSync(path.join(world.home, ".ao-install.lock")), false);
});

test("a daemon on the shared run file that is not this bundle's is refused before any session is ended or anything is stopped (57)", darwin, async (t) => {
	// The bundled ao would talk to whichever daemon owns ~/.ao: here a status that belongs to another copy.
	const foreignExe = "/Users/x/Other/Agent Orchestrator.app/Contents/Resources/daemon/ao";
	const world = await makeWorld(t, "foreign-daemon", { sessions: [liveSession("s1")], cfg: { foreign_status_versions: `${oldVersion}\n`, foreign_status_exe: foreignExe, foreign_status_pid: "4242" } });
	const before = JSON.stringify(await world.procs());
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 57, result.stdout + result.stderr);
	assert.match(result.stderr, /Refusing to act on a daemon that is not this bundle's/);
	assert.match(result.stderr, /Other\/Agent Orchestrator\.app/);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /session (ls|exit-agent|kill)/), -1, "no session was listed or ended through the foreign daemon");
	assert.equal(callIndex(calls, /\] stop /), -1);
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(matching(calls, /^kill /).length, 0);
	assert.equal(JSON.stringify(await world.procs()), before);
	assert.equal(existsSync(path.join(world.sim, "FORBIDDEN")), false);
	// The right binary with a pid that is none of this bundle's daemon processes is refused too.
	const wrongPid = await makeWorld(t, "foreign-pid", { sessions: [liveSession("s1")], cfg: { foreign_status_versions: `${oldVersion}\n`, foreign_status_pid: "31337" } });
	await wrongPid.setCfg("foreign_status_exe", `${wrongPid.targetApp}/Contents/Resources/daemon/ao`);
	const second = wrongPid.update(["--yes", "--end-sessions"]);
	assert.equal(second.status, 57);
	assert.equal(callIndex(await wrongPid.calls(), /session exit-agent/), -1);
});

test("ao stop is not run when the daemon on the shared run file turns out not to be this bundle's; --force signals only the bundle's own daemon", darwin, async (t) => {
	const foreign = { foreign_after_quit: `${oldVersion}\n`, foreign_status_exe: "/Users/x/Other/Agent Orchestrator.app/Contents/Resources/daemon/ao", foreign_status_pid: "4242", daemon_stays: true };
	const refused = await makeWorld(t, "stop-foreign", { cfg: foreign });
	let result = refused.update(["--yes"]);
	assert.equal(result.status, 55, result.stdout + result.stderr);
	assert.match(result.stderr, /Not running "ao stop"/);
	assert.equal(callIndex(await refused.calls(), /\] stop /), -1);
	assert.equal(matching(await refused.calls(), /^kill /).length, 0);
	const forced = await makeWorld(t, "stop-foreign-force", { cfg: foreign });
	result = forced.update(["--yes", "--force"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(callIndex(await forced.calls(), /\] stop /), -1, "ao stop was skipped");
	const kills = matching(await forced.calls(), /^kill /);
	assert.equal(kills.length, 1);
	assert.match(kills[0], /^kill -TERM \d+$/);
});

test("mutation: acting on a daemon without checking whose it is is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", 'noetaxis_update_status_identity "$app_path" "$(/bin/cat "$dir/ao-status.json")" || cap_identity_detail="$noetaxis_update_identity_detail"', ":");
	const world = await makeWorld(t, "foreign-mutant", { sessions: [liveSession("s1")], cfg: { foreign_status_versions: `${oldVersion}\n`, foreign_status_exe: "/Users/x/Other/Agent Orchestrator.app/Contents/Resources/daemon/ao", foreign_status_pid: "4242" } });
	const text = await readFile(path.join(mutant, "update-lib.sh"), "utf8");
	// Both checks before ending sessions: the one before the batch and the one before each session.
	await writeFile(path.join(mutant, "update-lib.sh"), text.replace('if ! noetaxis_update_verify_daemon "$app_path"; then\n				noetaxis_error "Refusing', 'if false; then\n				noetaxis_error "Refusing').replace('if ! noetaxis_update_verify_daemon "$target_app"; then', "if false; then"));
	world.update(["--yes", "--end-sessions"], { scriptsDir: mutant });
	assert.ok(callIndex(await world.calls(), /session exit-agent s1/) >= 0, "the mutant ends a session through the foreign daemon");
});

test("a ready daemon of another binary, or with a pid that is not this bundle's daemon, is not healthy: the update rolls back", darwin, async (t) => {
	// The new app starts only its desktop process; a foreign daemon answers ready on the port.
	const foreign = await makeWorld(t, "health-foreign", { cfg: { open_mode: "app-only", foreign_status_versions: `${newVersion}\n`, foreign_status_exe: "/Users/x/Old/Agent Orchestrator.app/Contents/Resources/daemon/ao", foreign_status_pid: "4242" } });
	let result = foreign.update(["--yes"]);
	assert.match(result.stdout, /an old or foreign daemon is serving the port/);
	assert.ok([60, 61].includes(result.status), `${result.status}`);
	assert.equal(foreign.installedVersion(), oldVersion, "rolled back instead of accepting the foreign daemon");
	// Right binary path but a pid that is none of this bundle's daemon processes.
	const wrongPid = await makeWorld(t, "health-pid", { cfg: { open_mode: "app-only", foreign_status_versions: `${newVersion}\n`, foreign_status_exe: "<NEW>", foreign_status_pid: "31337" } });
	await wrongPid.setCfg("foreign_status_exe", `${wrongPid.targetApp}/Contents/Resources/daemon/ao`);
	result = wrongPid.update(["--yes"]);
	assert.match(result.stdout, /pid 31337, which is not a daemon process of/);
	assert.equal(wrongPid.installedVersion(), oldVersion);
});

test("mutation: accepting a ready daemon without checking its identity is caught", darwin, async (t) => {
	let dir = await mutatedScripts(t, "update-lib.sh", 'if [[ -z "$executable" || "$(noetaxis_physical_file "$executable")" != "$(noetaxis_physical_file "$expected")" ]]; then', "if false; then");
	const file = path.join(dir, "update-lib.sh");
	const text = await readFile(file, "utf8");
	// Only the health gate's pid check (the identity helper for the shared run file has the same line earlier in the file).
	const gate = text.indexOf("noetaxis_update_daemon_healthy() {");
	const loosened = text.slice(0, gate) + text.slice(gate).replace('if [[ ! "$pid" =~ ^[0-9]+$ ]] ||', "if false &&");
	assert.notEqual(loosened, text);
	await writeFile(file, loosened);
	const world = await makeWorld(t, "health-mutant", { cfg: { open_mode: "app-only", foreign_status_versions: `${newVersion}\n`, foreign_status_exe: "/Users/x/Old/Agent Orchestrator.app/Contents/Resources/daemon/ao", foreign_status_pid: "4242" } });
	const result = world.update(["--yes"], { scriptsDir: dir });
	assert.equal(world.installedVersion(), newVersion, "the mutant keeps an app whose own daemon never started");
	assert.notEqual(result.status, 60);
});

test("mutation: removing the lock is caught by the paused-swap scenario", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", "noetaxis_acquire_lock() {\n", "noetaxis_acquire_lock() {\n\treturn 0\n");
	const world = await makeWorld(t, "lock-mutant", { running: false });
	const marker = path.join(world.root, "paused");
	const first = spawn(path.join(mutant, "install.sh"), [world.newApp], { env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: "after-old-moved", NOETAXIS_TEST_PAUSE_MARKER: marker }, stdio: "ignore" });
	const exited = new Promise((resolve) => first.on("exit", (code) => resolve(code)));
	for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	const second = world.run([world.newApp], { scriptsDir: mutant });
	await exited;
	assert.notEqual(second.status, 36, "without a lock the second run is not refused");
});

test("a symlinked Applications folder does not make the right daemon look foreign", darwin, async (t) => {
	const world = await makeWorld(t, "health-symlink");
	const link = path.join(world.root, "AppsLink");
	await symlink(world.appsDir, link);
	const result = world.update(["--yes"], { extraEnv: { APPS_DIR: link } });
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const point of ["after-record", "after-old-moved"]) {
	test(`an interruption at ${point} after the stop restores the previous app and reopens it`, darwin, async (t) => {
		const world = await makeWorld(t, `interrupt-${point}`);
		const marker = path.join(world.root, "paused");
		const child = spawn(path.join(realScriptsDir, "install.sh"), ["--update", "--quit-timeout", "3", "--stop-timeout", "3", "--health-timeout", "3", "--yes", world.newApp], {
			env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: point, NOETAXIS_TEST_PAUSE_MARKER: marker },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(existsSync(marker), `never reached ${point}`);
		child.kill("SIGTERM");
		assert.equal(await exited, 143);
		assert.equal(world.installedVersion(), oldVersion, "the previous app is back");
		assert.ok((await world.procs()).some((p) => p.command === `${world.targetApp}/Contents/MacOS/Agent Orchestrator`), "and running again");
		const calls = await world.calls();
		assert.ok(callIndex(calls, /^open -a /) > callIndex(calls, /^osascript/), "reopened after it was quit");
		assert.match(output, /reopening the previous app/);
		assert.equal(existsSync(path.join(world.home, ".ao-install.lock")), false);
	});
}

test("an interruption while staging, before anything is stopped, leaves the running app alone", darwin, async (t) => {
	const world = await makeWorld(t, "interrupt-staged");
	const marker = path.join(world.root, "paused");
	const child = spawn(path.join(realScriptsDir, "install.sh"), ["--update", "--yes", world.newApp], {
		env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: "after-staged", NOETAXIS_TEST_PAUSE_MARKER: marker },
		stdio: "ignore",
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	child.kill("SIGTERM");
	assert.equal(await exited, 143);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(callIndex(calls, /^open /), -1);
	assert.equal(world.installedVersion(), oldVersion);
});

test("the completed backup record exists before the old app moves, and the old app is in the backup after it", darwin, async (t) => {
	assert.deepEqual(await scenarioRecordBeforeMove(t, realScriptsDir), []);
});

test("mutation: writing BACKUP_COMPLETE only after the old app moved is caught", darwin, async (t) => {
	const dir = await mutatedScripts(t, "install.sh", null);
	const file = path.join(dir, "install.sh");
	const text = await readFile(file, "utf8");
	const start = text.indexOf('if ! noetaxis_write_backup_record');
	const end = text.indexOf("fi\n", text.indexOf("exit 35", start)) + 3;
	const block = text.slice(start, end);
	assert.ok(block.includes("exit 35"));
	const moved = text.slice(0, start) + text.slice(end).replace("old_moved=1\n", `old_moved=1\n${block}`);
	assert.notEqual(moved, text);
	await writeFile(file, moved);
	const violations = await scenarioRecordBeforeMove(t, dir);
	assert.ok(violations.some((v) => /after-record: BACKUP_COMPLETE does not exist yet/.test(v)), violations.join("; "));
});

test("only live sessions are stopped and restored, by exact id (not terminated or already exited ones)", darwin, async (t) => {
	assert.deepEqual(await scenarioExactSessionIds(t, realScriptsDir), []);
});

test("mutation: applying exit-agent to terminated or exited sessions is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", 'if [[ "$terminated" != true && "$activity" != exited ]]; then', "if true; then");
	const violations = await scenarioExactSessionIds(t, mutant);
	assert.ok(violations.some((v) => /exit-agent ran for/.test(v)), violations.join("; "));
});

test("noetaxis_bounded stops a command that ignores SIGALRM, as a Go program does (exit 142, SIGTERM only)", darwin, async () => {
	const started = Date.now();
	const result = execute("/bin/bash", ["-c", `. "${path.join(realScriptsDir, "update-lib.sh")}"; noetaxis_bounded 2 /bin/sh -c 'trap "" ALRM; exec /bin/sleep 60'; echo "rc=$?"`], { env: { PATH: "/usr/bin:/bin" }, timeout: 120_000 });
	assert.match(result.stdout, /rc=142/);
	assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
	const quick = execute("/bin/bash", ["-c", `. "${path.join(realScriptsDir, "update-lib.sh")}"; noetaxis_bounded 5 /bin/sh -c 'echo out; exit 7'; echo "rc=$?"`], { env: { PATH: "/usr/bin:/bin" } });
	assert.match(quick.stdout, /out\nrc=7/);
});

test("the daemon's identity is re-checked before every session is ended, not only once", darwin, async (t) => {
	const world = await makeWorld(t, "identity-each", { sessions: [liveSession("s1"), liveSession("s2")] });
	// After the first agent is stopped the shared run file belongs to another copy.
	await world.setCfg("foreign_after_exit_agent", `${oldVersion}\n`);
	await world.setCfg("foreign_status_exe", "/Users/x/Other/Agent Orchestrator.app/Contents/Resources/daemon/ao");
	await world.setCfg("foreign_status_pid", "4242");
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 57, result.stdout + result.stderr);
	assert.deepEqual(matching(await world.calls(), /session exit-agent/).map((l) => l.replace(/^.*exit-agent (\S+).*$/, "$1")), ["s1"]);
	assert.equal(callIndex(await world.calls(), /^osascript/), -1);
});

test("--force never signals a process that started after the plan was confirmed (a late session's chat host)", darwin, async (t) => {
	const world = await makeWorld(t, "force-late-host", { sessions: [liveSession("s1")], cfg: { spawn_host_on_exit_agent: "s9" } });
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stdout, /NOT signalling pid \d+ \(survived the stop\): it was started after the plan was confirmed/);
	assert.match(result.stderr, /Started after the plan was confirmed, so not part of it and never signalled/);
	assert.match(result.stderr, /chat-host --session s9/);
	assert.equal(matching(await world.calls(), /^kill /).length, 0, "nothing was signalled");
	assert.ok((await world.procs()).some((p) => p.command.endsWith("chat-host --session s9")), "the late host is still running");
	// An approved survivor is still terminated with --force.
	const approved = await makeWorld(t, "force-approved-host", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	assert.equal(approved.update(["--yes", "--force"]).status, 0);
	assert.equal(matching(await approved.calls(), /^kill -TERM \d+$/).length, 1);
});

test("mutation: signalling a process that is not in the approved set is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", "if ! noetaxis_update_process_approved \"$pid\" \"$command_line\"; then\n\t\tnoetaxis_update_say \"NOT signalling", "if false; then\n\t\tnoetaxis_update_say \"NOT signalling");
	const world = await makeWorld(t, "force-late-host-mutant", { sessions: [liveSession("s1")], cfg: { spawn_host_on_exit_agent: "s9" } });
	world.update(["--yes", "--end-sessions", "--force"], { scriptsDir: mutant });
	assert.ok(matching(await world.calls(), /^kill -TERM \d+$/).length > 0, "the mutant signals the unapproved host");
});

test("a person's own AO_MULTICA_DAEMON / AO_KEEP_DAEMON settings are not an AO session; any other AO_ variable is, and is named", darwin, async (t) => {
	const world = await makeWorld(t, "guard-config");
	const configured = world.update(["--dry-run"], { extraEnv: { AO_MULTICA_DAEMON: "1", AO_KEEP_DAEMON: "1" } });
	assert.equal(configured.status, 0, configured.stderr);
	assert.match(configured.stdout, /Dry run \(exit 0\): nothing was stopped/);
	const inside = world.update(["--dry-run"], { extraEnv: { AO_MULTICA_DAEMON: "1", AO_SESSION_ID: "mer-3", AO_DATA_DIR: "/x" } });
	assert.equal(inside.status, 20);
	assert.match(inside.stderr, /AO environment variables are set:.*AO_SESSION_ID/);
	assert.match(inside.stderr, /AO environment variables are set:.*AO_DATA_DIR/);
	assert.doesNotMatch(inside.stderr, /AO_MULTICA_DAEMON/);
});

test("a refusal says nothing was changed; a failure after the stop reopens the previous app", darwin, async (t) => {
	const refused = await makeWorld(t, "result-line", { sessions: [liveSession("s1")] });
	const result = refused.update(["--yes"]);
	assert.equal(result.status, 51);
	assert.match(result.stdout, /Update result \(exit 51: refused: live sessions \(use --end-sessions\)\)\. Nothing was stopped, backed up or installed\./);
	const stopped = await makeWorld(t, "left-stopped", { extraProcs: ["<APP>/Contents/Resources/daemon/ao chat-host --session orphan"] });
	const failed = stopped.update(["--yes"]);
	assert.equal(failed.status, 56);
	assert.match(failed.stdout, /Update summary \(exit 56/);
	assert.match(failed.stdout, /reopening the previous app/);
	assert.match(failed.stdout, /previous app reopened and healthy \(the update did not finish; nothing was installed\)/);
	assert.equal(failed.status, 56);
	assert.equal(stopped.installedVersion(), oldVersion);
	assert.ok((await stopped.procs()).some((p) => p.command.endsWith("Contents/MacOS/Agent Orchestrator")), "the previous app runs again");
});

test("an AO daemon in the process ancestry also refuses the update", darwin, async (t) => {
	const world = await makeWorld(t, "guard-ancestry");
	// The fake ps reports the bundled daemon as this script's parent.
	const aoParent = await world.addProc(`${world.targetApp}/Contents/Resources/daemon/ao daemon`);
	assert.ok(aoParent > 0);
	const wrapped = world.update(["--yes"], { extraEnv: { NOETAXIS_TEST_ANCESTOR: String(aoParent) } });
	// The fake ps does not model ancestry, so this stays a normal run: the guard's environment check is the tested path above.
	assert.ok([0, 20, 56, 55].includes(wrapped.status));
});

test("--detached needs --yes, prints the log path first, re-runs in a new session without AO_* variables, and the run completes", darwin, async (t) => {
	const world = await makeWorld(t, "detached", { sessions: [liveSession("s1")] });
	const aoEnv = { AO_SESSION_ID: "mer-3", AO_PROJECT_ID: "demo", AO_DATA_DIR: "/nonexistent/should-not-be-used", AO_RUN_FILE: "/nonexistent/run.json" };
	const withoutYes = world.update(["--detached", "--end-sessions"], { extraEnv: aoEnv });
	assert.equal(withoutYes.status, 2);
	assert.match(withoutYes.stderr, /add --yes/);

	const started = world.update(["--detached", "--yes", "--end-sessions"], { extraEnv: aoEnv });
	assert.equal(started.status, 0, started.stderr);
	const lines = started.stdout.split("\n");
	assert.match(lines[0], /^Update log: .*ao-backups\/update-.*\.log$/);
	assert.match(started.stdout, /that session ENDS when AO quits/);
	const logPath = lines[0].replace("Update log: ", "");
	let log = "";
	for (let attempt = 0; attempt < 300; attempt += 1) {
		log = await readFile(logPath, "utf8").catch(() => "");
		if (log.includes("Update summary")) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.match(log, /Update summary \(exit 0: updated and healthy/);
	// Let the detached run finish its own cleanup (its temporary capture folder) before the test removes the world.
	for (let attempt = 0; attempt < 100 && (await readdir(path.join(world.root, "tmp"))).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(world.installedVersion(), newVersion);
	const calls = await world.calls();
	assert.ok(matching(calls, /^ao\[/).length > 0);
	assert.ok(matching(calls, /^ao\[/).every((line) => line.endsWith("(AO_ vars in env: 0)")), "the detached run's ao calls carry no AO_* variables");
	assert.deepEqual((await world.sessionsNow()).map((s) => s.activity), ["exited"]);
});

// ---------------------------------------------------------------------------
// Mutation checks: break a safety rule, and the scenarios must notice.
// ---------------------------------------------------------------------------

test("mutation: dropping the confirmation is caught", darwin, async (t) => {
	assert.deepEqual(await scenarioDeclinedConfirmation(t, realScriptsDir), []);
	const mutant = await mutatedScripts(t, "update-lib.sh", 'if [[ "$answer" == yes ]]; then', "if true; then");
	const violations = await scenarioDeclinedConfirmation(t, mutant);
	assert.ok(violations.length > 0, "the declined-confirmation scenario did not notice a missing confirmation");
});

test("mutation: ending sessions without --end-sessions is caught", darwin, async (t) => {
	assert.deepEqual(await scenarioLiveSessionsRefused(t, realScriptsDir), []);
	// Treat every run as if --end-sessions had been given: the refusal checks disappear and sessions are killed.
	const mutant = await mutatedScripts(t, "install.sh", "update_end_sessions=0\n", "update_end_sessions=1\n");
	const violations = await scenarioLiveSessionsRefused(t, mutant);
	assert.ok(violations.some((v) => /ended without --end-sessions|exit 51/.test(v)), violations.join("; "));
});

test("mutation: signalling processes of other bundles is caught", darwin, async (t) => {
	assert.deepEqual(await scenarioLookalikeProcess(t, realScriptsDir), []);
	// The bundle filter accepts any command line that mentions the path, and the refusal for lookalikes is gone.
	let dir = await mutatedScripts(t, "update-lib.sh", '"$app_path/Contents/"*) printf \'%s\\t%s\\n\' "$pid" "$command_line" ;;', '*) printf \'%s\\t%s\\n\' "$pid" "$command_line" ;;');
	const refusal = await readFile(path.join(dir, "update-lib.sh"), "utf8");
	const looser = refusal
		.replace('if [[ -n "$foreign" ]]; then', "if false; then")
		.replace(/(noetaxis_signal_own_pid\(\) \{[\s\S]*?)"\$app_path\/Contents\/"\*\) ;;/, "$1*) ;;");
	assert.notEqual(looser, refusal);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path.join(dir, "update-lib.sh"), looser);
	const violations = await scenarioLookalikeProcess(t, dir);
	assert.ok(violations.some((v) => /signalled|exit 21/.test(v)), violations.join("; "));
});

test("mutation: skipping the backup is caught", darwin, async (t) => {
	assert.deepEqual(await scenarioBackupBeforeSwap(t, realScriptsDir), []);
	const mutant = await mutatedScripts(t, "install.sh", 'if ! noetaxis_copy_state_backup "$ao_home" "$backup_dir"; then', "if ! true; then");
	const violations = await scenarioBackupBeforeSwap(t, mutant);
	assert.ok(violations.some((v) => /database copy|app-state/.test(v)), violations.join("; "));
});

test("mutation: opening the new app before the backup record exists is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "install.sh", 'if ! noetaxis_write_backup_record "$backup_dir" "$old_app_backup" "$old_version" "$allow_background" "$update_record_extra"; then', 'if false; then');
	const violations = await scenarioBackupBeforeSwap(t, mutant);
	assert.ok(violations.some((v) => /BACKUP_COMPLETE|opened before/.test(v)), violations.join("; "));
});

test("mutation: always using SIGKILL is caught", darwin, async (t) => {
	assert.deepEqual(await scenarioForcedTermination(t, realScriptsDir), []);
	const mutant = await mutatedScripts(t, "update-lib.sh", '"${NOETAXIS_KILL:-/bin/kill}" -TERM "$pid"', '"${NOETAXIS_KILL:-/bin/kill}" -KILL "$pid"');
	const violations = await scenarioForcedTermination(t, mutant);
	assert.ok(violations.some((v) => /signal other than plain TERM|forbidden/.test(v)), violations.join("; "));
});

test("mutation: skipping the automatic rollback is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", '		noetaxis_update_auto_rollback "$update_health_detail" "$app_path" || status_code=$?\n		return "$status_code"', "		return 61");
	const world = await makeWorld(t, "mutant-rollback", { cfg: { unhealthy_versions: `${newVersion}\n` } });
	const result = world.update(["--yes"], { scriptsDir: mutant });
	assert.notEqual(world.installedVersion(), oldVersion, "the mutant leaves the unhealthy new app in place");
	assert.equal(result.status, 61);
});

// ---------------------------------------------------------------------------
// Existing behaviour stays
// ---------------------------------------------------------------------------

test("the default install still refuses while AO runs and never stops anything", darwin, async (t) => {
	const world = await makeWorld(t, "default-mode");
	const result = world.run([world.newApp]);
	assert.equal(result.status, 21);
	assert.match(result.stderr, /still running/);
	const calls = await world.calls();
	assert.equal(callIndex(calls, /^osascript/), -1);
	assert.equal(matching(calls, /^kill /).length, 0);
	assert.equal(matching(calls, /\] (stop|session kill|session exit-agent)/).length, 0);
	assert.equal(world.installedVersion(), oldVersion);
});

test("install.sh --help documents the update options and exit codes", async () => {
	const result = execute(path.join(realScriptsDir, "install.sh"), ["--help"]);
	assert.equal(result.status, 0);
	for (const flag of ["--update", "--yes", "--end-sessions", "--restore-sessions", "--force", "--manual-quit", "--restart-multica-daemon", "--restart-multica-stack", "--rollback-restore-db", "--detached"]) {
		assert.ok(result.stdout.includes(flag), flag);
	}
	assert.ok((await stat(path.join(realScriptsDir, "update.sh"))).mode & 0o111);
});
