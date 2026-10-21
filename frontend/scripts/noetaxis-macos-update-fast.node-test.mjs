import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeWorld, mutatedScripts, newVersion, oldVersion } from "./noetaxis-macos-update-world.mjs";
import { fixtureRoot } from "./noetaxis-macos-fixture-registry.mjs";
import { writeArtifactChecksums, writeInstallerArtifacts } from "./noetaxis-macos/package-artifacts.mjs";

const darwin = { skip: process.platform !== "darwin" };
const signals = (calls) => calls.filter((line) => /^kill /.test(line));
const output = (result) => result.stdout + result.stderr;

async function assertFastCalls(world) {
	const calls = await world.calls();
	assert.ok(!calls.some((line) => /session (ls|exit-agent|kill|restore|show)/.test(line)), calls.join("\n"));
	assert.ok(!calls.includes("ps-machine-wide"));
	assert.ok(!existsSync(path.join(world.sim, "FORBIDDEN")));
	return calls;
}

test("fast update accepts one yes, backs up selected state and lets AO restore 56 sessions", darwin, async (t) => {
	const world = await makeWorld(t, "fast-happy", {
		sessions: Array.from({ length: 56 }, (_, i) => ({ id: `s${i}` })),
		cfg: { chat_hosts_die_with_daemon: true, sessions_ls_fails: true },
	});
	for (const name of ["update-settings.json", "editor-settings.json"]) await writeFile(path.join(world.home, ".ao", name), `{"file":"${name}"}`);
	const start = Date.now();
	const result = world.run(["--fast", "--health-timeout", "3", world.newApp], { script: "update.sh", input: "yes\n" });
	assert.ok(Date.now() - start < 180_000, "56 sessions stay within the routine update bound");
	assert.equal(result.status, 0, output(result));
	assert.equal(world.installedVersion(), newVersion);
	assert.equal((result.stdout.match(/Type "yes"/g) ?? []).length, 1);
	assert.match(result.stdout, /sessions will be restored by AO on launch/);
	const [backup] = await world.backupDirs();
	assert.ok(existsSync(path.join(backup, "BACKUP_COMPLETE")));
	for (const name of ["data/ao.db", "app-state.json", "update-settings.json", "editor-settings.json"]) assert.ok(existsSync(path.join(backup, name)), name);
	assert.match(await readFile(path.join(backup, "BACKUP_COMPLETE"), "utf8"), /app_backup=.*\.app.bak/);
	const calls = await assertFastCalls(world);
	assert.equal(signals(calls).length, 0);
});

test("fast --yes skips confirmation; --dry-run and decline stop nothing", darwin, async (t) => {
	for (const [flags, input, status] of [[["--yes"], "", 0], [["--dry-run"], "", 0], [[], "no\n", 50]]) {
		const world = await makeWorld(t, "fast-confirm", { cfg: { chat_hosts_die_with_daemon: true } });
		const result = world.update(["--fast", ...flags], { input });
		assert.equal(result.status, status, output(result));
		const calls = await assertFastCalls(world);
		if (flags.includes("--yes")) assert.doesNotMatch(result.stdout, /Type "yes"/);
		else {
			assert.ok(!calls.some((line) => /^(osascript|open|kill) /.test(line)));
			assert.equal(world.installedVersion(), oldVersion);
			assert.equal((await world.backupDirs()).length, 0);
		}
	}
});

test("fast denied tray permission waits for manual quit in the same run", darwin, async (t) => {
	const world = await makeWorld(t, "fast-manual", { cfg: { tray_fail: true, manual_quit_ticks: "2", chat_hosts_die_with_daemon: true } });
	const result = world.update(["--fast", "--yes", "--quit-timeout", "10"]);
	assert.equal(result.status, 0, output(result));
	assert.match(result.stdout, /Click "Quit AO Completely".*waiting up to 10s/);
	assert.equal(world.installedVersion(), newVersion);
	await assertFastCalls(world);
});

test("fast slow external agent CLI does not block the swap or receive a signal", darwin, async (t) => {
	const world = await makeWorld(t, "fast-slow-agent", {
		sessions: [{ id: "s1" }],
		cfg: { chat_hosts_die_with_daemon: true, agents_survive: true },
		extraProcs: [{ pid: 8101, ppid: 4004, command: "/opt/codex --resume s1", executable: "/opt/codex", session: "s1" }],
	});
	const result = world.update(["--fast", "--yes", "--stop-timeout", "1"]);
	assert.equal(result.status, 0, output(result));
	assert.match(result.stdout, /informational only; untouched/);
	assert.match(result.stdout, /codex --resume s1/);
	assert.ok((await world.procs()).some((proc) => proc.pid === 8101));
	const calls = await assertFastCalls(world);
	const probes = calls.filter((line) => /^agent-probe /.test(line)).map((line) => Number(line.slice("agent-probe ".length)));
	assert.ok(probes.length >= 2, "the CLI wait and final informational probe both run");
	assert.ok(Math.max(...probes) - Math.min(...probes) <= 10, "external CLI wait stays within 10 seconds");
	assert.deepEqual(signals(calls), []);
});

test("fast bundle survivor escalates TERM then KILL without another prompt", darwin, async (t) => {
	const world = await makeWorld(t, "fast-survivor", { sessions: [{ id: "s1" }], cfg: { stubborn: "4004" } });
	const result = world.update(["--fast", "--yes", "--stop-timeout", "1"]);
	assert.equal(result.status, 0, output(result));
	assert.deepEqual(signals(await assertFastCalls(world)), ["kill -TERM 4004", "kill -KILL 4004"]);
	assert.match(result.stdout, /identity rechecked/);
});

test("fast rechecks executable and start identity after TERM before any KILL", darwin, async (t) => {
	for (const change of ["exec", "reuse"]) {
		const world = await makeWorld(t, `fast-recheck-${change}`, {
			sessions: [{ id: "s1" }],
			cfg: { stubborn: "4004\n8102" },
			extraProcs: [{ pid: 8102, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node index.js" }],
		});
		await world.setCfg(`survivor_${change}_after_term_4004`, change === "exec" ? "/bin/bash" : true);
		const result = world.update(["--fast", "--yes", "--stop-timeout", "1"]);
		assert.equal(result.status, change === "exec" ? 0 : 56, output(result));
		assert.deepEqual(signals(await assertFastCalls(world)), ["kill -TERM 4004", "kill -TERM 8102", "kill -KILL 8102"]);
	}
});

test("fast leaves unverified, deleted, argv-spoofed, foreign and other-app processes untouched", darwin, async (t) => {
	const world = await makeWorld(t, "fast-foreign", {
		cfg: { chat_hosts_die_with_daemon: true },
		extraProcs: [
			{ pid: 8101, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node index.js", executable: "!DENIED" },
			{ pid: 8102, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node deleted.js", executable: "!ENOENT" },
			{ pid: 8103, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node spoof.js", executable: "/bin/bash" },
			{ pid: 8104, command: "<TMP>/Other/Agent Orchestrator.app/Contents/MacOS/Agent Orchestrator", executable: "<TMP>/Other/Agent Orchestrator.app/Contents/MacOS/Agent Orchestrator" },
			{ pid: 8105, command: "/opt/editor <APP>/Contents/Info.plist", executable: "/opt/editor" },
		],
	});
	const result = world.update(["--fast", "--yes"]);
	assert.equal(result.status, 0, output(result));
	for (const pid of [8101, 8102, 8103, 8104, 8105]) assert.ok((await world.procs()).some((proc) => proc.pid === pid), `${pid} remains`);
	assert.deepEqual(signals(await assertFastCalls(world)), []);
});

test("fast rolls back an unhealthy new app without session calls or an ancestry scan", darwin, async (t) => {
	const world = await makeWorld(t, "fast-rollback", { cfg: { chat_hosts_die_with_daemon: true, unhealthy_versions: newVersion } });
	const result = world.update(["--fast", "--yes"]);
	assert.equal(result.status, 60, output(result));
	assert.equal(world.installedVersion(), oldVersion);
	await assertFastCalls(world);
});

test("fast rolls back verification failure after swapping", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "install.sh", 'noetaxis_clear_quarantine "$target_app"', "exit 31");
	const world = await makeWorld(t, "fast-post-swap-failure", { cfg: { chat_hosts_die_with_daemon: true } });
	const result = world.update(["--fast", "--yes"], { scriptsDir: scripts });
	assert.equal(result.status, 60, output(result));
	assert.equal(world.installedVersion(), oldVersion);
	await assertFastCalls(world);
});

test("fast verifies SHA256SUMS before quitting", darwin, async (t) => {
	const world = await makeWorld(t, "fast-checksum");
	await writeFile(path.join(world.artifactDir, "MANIFEST.sha256"), "corrupt\n");
	const result = world.update(["--fast", "--yes"]);
	assert.equal(result.status, 24, output(result));
	assert.ok(!(await assertFastCalls(world)).some((line) => /^osascript/.test(line)));
});

test("fast --restore-sessions is an explicit best-effort pass and never exits an agent", darwin, async (t) => {
	const world = await makeWorld(t, "fast-restore", { sessions: [{ id: "s1" }], cfg: { chat_hosts_die_with_daemon: true } });
	const result = world.update(["--fast", "--yes", "--restore-sessions"]);
	assert.equal(result.status, 0, output(result));
	const calls = await world.calls();
	assert.ok(calls.some((line) => /session ls/.test(line)));
	assert.ok(!calls.some((line) => /session (exit-agent|kill)/.test(line)));
	assert.ok(!calls.includes("ps-machine-wide"));
});

test("fast stops a lingering daemon only after checking its identity", darwin, async (t) => {
	const world = await makeWorld(t, "fast-daemon", { cfg: { daemon_stays: true, chat_hosts_die_with_daemon: true } });
	const result = world.update(["--fast", "--yes", "--stop-timeout", "1"]);
	assert.equal(result.status, 0, output(result));
	const calls = await assertFastCalls(world);
	const stop = calls.findIndex((line) => /\] stop --timeout/.test(line));
	assert.ok(stop >= 0);
	assert.match(calls[stop - 1], /\] status --json/);
	assert.deepEqual(signals(calls), []);
});

test("fast refuses a foreign daemon before quitting anything", darwin, async (t) => {
	const world = await makeWorld(t, "fast-foreign-daemon", { cfg: { foreign_status_versions: oldVersion, foreign_status_pid: "8500", foreign_status_exe: "/other/ao" } });
	const result = world.update(["--fast", "--yes"]);
	assert.equal(result.status, 57, output(result));
	const calls = await assertFastCalls(world);
	assert.ok(!calls.some((line) => /^(osascript|open|kill) |\] stop /.test(line)));
	assert.equal(world.installedVersion(), oldVersion);
});

test("fast retains opt-in database rollback without an ancestry scan", darwin, async (t) => {
	const world = await makeWorld(t, "fast-schema-rollback", { cfg: {
		chat_hosts_die_with_daemon: true,
		unhealthy_versions: newVersion,
		[`migrate_${newVersion}`]: "191",
		[`max_schema_${oldVersion}`]: "190",
	} });
	const result = world.update(["--fast", "--yes", "--rollback-restore-db"]);
	assert.equal(result.status, 60, output(result));
	assert.equal(world.installedVersion(), oldVersion);
	assert.equal(world.schema(), "190");
	await assertFastCalls(world);
});

test("packaged HUMAN-INSTALL template recommends fast mode and is checksummed", async (t) => {
	const root = await fixtureRoot(t, "noetaxis-fast-guide-");
	await writeInstallerArtifacts(root);
	await writeArtifactChecksums(root);
	const guide = await readFile(path.join(root, "HUMAN-INSTALL.md"), "utf8");
	assert.match(guide, /--fast.*RECOMMENDED/);
	assert.match(guide, /installer\/update\.sh" --fast/);
	assert.match(await readFile(path.join(root, "SHA256SUMS"), "utf8"), /  HUMAN-INSTALL\.md\n/);
});

test("fast timing stays bounded with 56 surviving session hosts and no per-session calls", darwin, async (t) => {
	const world = await makeWorld(t, "fast-many-survivors", { sessions: Array.from({ length: 56 }, (_, i) => ({ id: `s${i}` })) });
	const start = Date.now();
	const result = world.update(["--fast", "--yes", "--stop-timeout", "1"], { timeout: 180_000 });
	assert.equal(result.status, 0, output(result));
	assert.ok(Date.now() - start < 180_000, "surviving hosts do not introduce per-session waits");
	const calls = await assertFastCalls(world);
	assert.equal(signals(calls).filter((line) => /^kill -TERM /.test(line)).length, 56);
	assert.ok(!signals(calls).some((line) => /^kill -KILL /.test(line)));
});
