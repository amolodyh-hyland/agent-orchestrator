import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, makeWorld, mutatedScripts, oldVersion, realScriptsDir } from "./noetaxis-macos-update-world.mjs";
import { assertNoFixtureProcesses, cleanupFixtureProcesses, fixtureProcesses, fixtureRoot, fixtureSpawn } from "./noetaxis-macos-fixture-registry.mjs";
import { writeArtifactChecksums, writeInstallerArtifacts } from "./noetaxis-macos/package-artifacts.mjs";

const darwin = { skip: process.platform !== "darwin" };
const sep = "\x1f";
const signals = (calls) => calls.filter((line) => /^kill /.test(line));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function survivorCall(world, code, { scripts = world.scriptsDir, input = "" } = {}) {
	return execute("/bin/bash", ["-c", `set -eu
script_dir="$1"; target_app="$2"; user_home="$HOME"; ao_home="$HOME/.ao"
. "$script_dir/common.sh"
. "$script_dir/update-lib.sh"
. "$script_dir/survivors.sh"
cap_dir="$3"
update_stop_timeout=1
cap_survivors_file="$cap_dir/survivors-before.tsv"
${code}`, "survivor-test", scripts, world.targetApp, world.sim], { env: world.env, input, timeout: 40_000 });
}

const orphan = (pid = 8101, extra = {}) => ({ pid, ppid: 1, command: "/bin/sh <AO>/data/worktrees/project/session/run.sh", executable: "/bin/sh", ...extra });
const branch = [
	{ pid: 8101, ppid: 1, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node index.js" },
	{ pid: 8102, ppid: 8101, command: "/opt/agent --config <APP>/Contents/Resources/daemon/ao", executable: "/opt/agent" },
];

test("tray failure names Automation and Accessibility and explains updating after a manual quit", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-permissions", { cfg: { tray_fail: true } });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 54, result.stdout + result.stderr);
	assert.match(result.stdout, /Automation > <terminal> > System Events/);
	assert.match(result.stdout, /Accessibility > <terminal>/);
	assert.match(result.stdout, /Updating works when the desktop app is already quit/);
	assert.equal(world.installedVersion(), oldVersion);
	const stopped = await makeWorld(t, "teardown-quit-first", { running: false, cfg: { tray_fail: true } });
	assert.equal(stopped.update(["--yes"]).status, 0);
	assert.ok(!(await stopped.calls()).some((line) => /^osascript/.test(line)));
});

test("mutation: omitting System Events permission guidance is caught", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "update-lib.sh", /Automation > <terminal> > System Events/g, "Automation");
	const world = await makeWorld(t, "teardown-permission-mutant", { cfg: { tray_fail: true } });
	const result = world.update(["--yes"], { scriptsDir: scripts });
	assert.doesNotMatch(result.stdout, /Automation > <terminal> > System Events/);
});

test("session exits use a default pool of eight, keep per-session checks and join all jobs", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-pool", { running: false });
	const result = survivorCall(world, `
cap_live_file="$cap_dir/live"; cap_hosts_file="$cap_dir/hosts"; cap_live_count=17
: > "$cap_live_file"; : > "$cap_hosts_file"
for n in {1..17}; do printf 's%s%sproject%sworker%sactive%sworking%sname%screated%sh%sbranch%sissue\\n' "$n" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" "$noetaxis_sep" >> "$cap_live_file"; printf 's%s\\thost\\n' "$n" >> "$cap_hosts_file"; done
noetaxis_update_session_unchanged() { return 0; }
noetaxis_update_verify_daemon() { printf 'verify %s\\n' "$id" >> "$cap_dir/order"; }
noetaxis_update_host_unchanged() { printf 'host %s\\n' "$id" >> "$cap_dir/order"; }
noetaxis_bounded() { printf 'start %s\\n' "$id" >> "$cap_dir/order"; /bin/sleep 0.3; printf 'end %s\\n' "$id" >> "$cap_dir/order"; }
noetaxis_update_wait_agent_processes() { return 0; }
noetaxis_update_no_live_sessions() { return 0; }
unset NOETAXIS_SESSION_WORKERS
noetaxis_update_end_sessions
/bin/cat "$cap_dir/order"
`);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const lines = (await readFile(path.join(world.sim, "order"), "utf8")).trim().split("\n");
	let active = 0; let maximum = 0;
	for (const line of lines) { if (line.startsWith("start ")) maximum = Math.max(maximum, ++active); if (line.startsWith("end ")) active--; }
	assert.equal(maximum, 8, lines.join("\n"));
	assert.equal(active, 0);
	assert.equal(lines.filter((line) => line.startsWith("start ")).length, 17);
	for (let n = 1; n <= 17; n++) {
		assert.deepEqual(lines.filter((line) => line.endsWith(` s${n}`)).map((line) => line.split(" ")[0]), ["verify", "host", "start", "end"]);
	}
	assert.equal((await readFile(path.join(world.sim, "ended-agent-ids.txt"), "utf8")).trim().split("\n").length, 17);
});

test("real session RPCs overlap within the configured pool and keep exact session logging", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-real-pool", { sessions: ["s1", "s2", "s3"].map((id) => ({ id })), cfg: { exit_agent_delay: "4" }, env: { NOETAXIS_SESSION_WORKERS: "2" } });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	let active = 0; let maximum = 0;
	for (const line of await world.calls()) { if (/^exit-start /.test(line)) maximum = Math.max(maximum, ++active); if (/^exit-finish /.test(line)) active--; }
	assert.equal(maximum, 2);
	assert.equal(active, 0);
	for (const id of ["s1", "s2", "s3"]) assert.match(result.stdout, new RegExp(`agent of ${id} \\[demo\\] worker stopped`));
});

test("survivor inventory groups verified descendants, anchored orphans and leaked fixtures; decoys are excluded", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-inventory", { running: false, extraProcs: [...branch, orphan(8201), orphan(8202, { command: "/bin/sh unrelated.sh", cwd: "<AO>/data/worktrees/a" }), { pid: 8301, command: "/bin/sh <TMP>/noetaxis-watchdog-leaked/stubborn.sh", executable: "/bin/sh" }, orphan(8401, { command: "/bin/sh <HOME>/.ao-lookalike/tool.sh" }), orphan(8402, { command: "/bin/sh bare-ao-tool" }), orphan(8403, { command: "/bin/sh /outside/<AO>/tool.sh" }), orphan(8404, { command: "/bin/sh <AO>/../outside/tool.sh" })] });
	const result = survivorCall(world, 'noetaxis_survivor_scan "$target_app" "$cap_survivors_file"; /bin/cat "$cap_survivors_file"; noetaxis_survivor_report "$cap_survivors_file"');
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const rows = result.stdout.trim().split("\n").map((line) => line.split(sep));
	assert.deepEqual(rows.map((row) => `${row[0]}:${row[1]}`).sort(), ["a:8101", "a:8102", "b:8201", "b:8202", "c:8301"]);
	assert.ok(rows.every((row) => row[8] === "1"));
	assert.match(result.stderr, /8102 -> 8101/);
	assert.match(result.stderr, /Bundle descendants/);
	assert.match(result.stderr, /Anchored AO orphans/);
	assert.match(result.stderr, /Leaked installer test fixtures/);
	assert.match(result.stderr, /Verified stop command/);
	assert.match(result.stderr, /noetaxis_survivor_matches/);
});

test("orphan anchors normalize paths and reject parent traversal at every argument boundary, including signal rechecks", darwin, async (t) => {
	const excluded = [
		"du -a <AO>/..", "du '<AO>/..'", 'du "<AO>/.."',
		"du --path=<AO>/.. --all", "du <AO>/../outside", "du <AO>//..//outside",
		"sh -c 'du <AO>/..; echo done'", "du <AO>/data/..", "du <AO>/./..",
		"du <AO>/data/../../outside", "du <AO>/data /outside/..", "du <HOME>/.ao-lookalike/file",
	];
	const world = await makeWorld(t, "teardown-traversal", { running: false, extraProcs: [
		...excluded.map((command, n) => orphan(8500 + n, { command })),
		orphan(8600, { command: "du <HOME>//.ao/./data//worktrees/file" }),
	] });
	const scan = 'noetaxis_survivor_scan "$target_app" "$cap_survivors_file"; /bin/cat "$cap_survivors_file"';
	const result = survivorCall(world, scan);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(result.stdout.trim().split("\n").map((line) => line.split(sep)[1]), ["8600"]);
	const recheck = survivorCall(world, `update_kill_survivors=1; update_survivors_confirmed=1
for pid in {8500..8511}; do
 info="$(noetaxis_process_info "$pid")"
 IFS=$'\\t' read -r pid parent started command_line <<< "$info"
 executable="$(noetaxis_process_executable_path "$pid")"
 if noetaxis_survivor_signal TERM b "$pid" "$parent" "$started" "$executable" "$command_line" "$pid -> 1" / 1; then exit 99; fi
done`);
	assert.equal(recheck.status, 0, recheck.stdout + recheck.stderr);
	assert.deepEqual(signals(await world.calls()), []);
	for (const [search, replacement, expected] of [
		['exit 1 if grep { m{(?:^|/)\\.\\.(?:/|$)} } @paths;', '# traversal guard removed', false],
		['$path = normalize($path);', '# normalization removed', true],
	]) {
		const scripts = await mutatedScripts(t, "survivors.sh", search, replacement);
		const broken = survivorCall(world, scan, { scripts });
		assert.equal(broken.status, 0, broken.stdout + broken.stderr);
		const ids = broken.stdout.trim().split("\n").map((line) => line.split(sep)[1]);
		assert.equal(ids.includes("8500"), !expected, "the exclusion assertion catches a missing traversal guard");
		assert.equal(ids.includes("8600"), !expected, "the inclusion assertion catches missing normalization");
	}
});

test("survivors require exact typed PID confirmation; --yes and wrong answers never signal", darwin, async (t) => {
	for (const input of ["", "yes\n", "kill survivors 9999\n"]) {
		const world = await makeWorld(t, "teardown-confirm", { running: false, extraProcs: [orphan()] });
		const result = survivorCall(world, 'update_yes=1; update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input });
		assert.equal(result.status, 50, result.stdout + result.stderr);
		assert.deepEqual(signals(await world.calls()), []);
	}
});

test("typed teardown sends TERM then KILL children first and final scan must be empty", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-signals", { running: false, extraProcs: branch, cfg: { stubborn: "8101\n8102\n" } });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8102 8101\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8102", "kill -TERM 8101", "kill -KILL 8102", "kill -KILL 8101"]);
	assert.deepEqual(await world.procs(), []);
});

test("signal order uses PPID relationships even when the displayed ancestry chains are capped", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-order-cap", { running: false });
	const file = path.join(world.sim, "order-input");
	await writeFile(file, [
		["a", "9002", "1", "start", "/bin/sh", "parent", "capped", "/", "1"],
		["a", "8001", "9002", "start", "/bin/sh", "child", "capped", "/", "1"],
		["a", "7001", "8001", "start", "/bin/sh", "grandchild", "capped", "/", "1"],
	].map((row) => row.join(sep)).join("\n") + "\n");
	const result = survivorCall(world, 'noetaxis_survivor_order "$cap_dir/order-input" "$cap_dir/order-output"; /bin/cat "$cap_dir/order-output"');
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(result.stdout.trim().split("\n").map((line) => line.split(sep)[1]), ["7001", "8001", "9002"]);
	const scripts = await mutatedScripts(t, "survivors.sh", '!done[p] && children[p] == 0', '!done[p]');
	const broken = survivorCall(world, 'noetaxis_survivor_order "$cap_dir/order-input" "$cap_dir/order-output"; /bin/cat "$cap_dir/order-output"', { scripts });
	assert.equal(broken.status, 0, broken.stdout + broken.stderr);
	assert.notDeepEqual(broken.stdout.trim().split("\n").map((line) => line.split(sep)[1]), ["7001", "8001", "9002"], "the order assertion catches ignoring child relationships");
});

test("a cyclic survivor inventory refuses before any signal", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-order-cycle", { running: false });
	await writeFile(path.join(world.sim, "order-input"), [
		["a", "8101", "8102", "start", "/bin/sh", "one", "cycle", "/", "1"],
		["a", "8102", "8101", "start", "/bin/sh", "two", "cycle", "/", "1"],
	].map((row) => row.join(sep)).join("\n") + "\n");
	const result = survivorCall(world, 'noetaxis_survivor_order "$cap_dir/order-input" "$cap_dir/order-output"');
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /cycle or invalid inventory/);
	assert.deepEqual(signals(await world.calls()), []);
});

test("changed executable or start time after TERM is never KILLed and stops the run", darwin, async (t) => {
	for (const change of [{ survivor_exec_after_term_8101: "/bin/other" }, { survivor_reuse_after_term_8101: true }]) {
		const world = await makeWorld(t, "teardown-identity", { running: false, extraProcs: [orphan()], cfg: { stubborn: "8101\n", ...change } });
		const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" });
		assert.equal(result.status, 56, result.stdout + result.stderr);
		assert.deepEqual(signals(await world.calls()), ["kill -TERM 8101"]);
		assert.match(result.stdout, /SIGTERM sent to verified survivor pid 8101/);
		assert.doesNotMatch(result.stdout, /SIGKILL sent to verified survivor/);
		assert.match(result.stderr, /Final survivor scan is not empty/);
	}
});

test("a cwd-only orphan that leaves the AO anchor is not KILLed", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-cwd-change", { running: false, extraProcs: [orphan(8101, { command: "/bin/sh shell-task", cwd: "<AO>/data/worktrees/project" })], cfg: { stubborn: "8101\n", survivor_cwd_after_term_8101: "/" } });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" });
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8101"]);
	assert.ok((await world.procs()).some(({ pid }) => pid === 8101), "a process now outside the anchor is untouched");
});

test("unverified and deleted-executable survivors and test fixtures are never automatically signalled", darwin, async (t) => {
	for (const executable of ["!ENOENT", "!EPERM", "invalid"]) {
		const world = await makeWorld(t, "teardown-unverified", { running: false, extraProcs: [orphan(8101, { executable })] });
		const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" });
		assert.equal(result.status, 56, result.stdout + result.stderr);
		assert.deepEqual(signals(await world.calls()), []);
		assert.match(result.stderr, /never signal this PID/);
	}
	const world = await makeWorld(t, "teardown-leaked", { running: false, extraProcs: [orphan(8101, { command: "/bin/sh <TMP>/noetaxis-watchdog-leaked/stubborn.sh" })] });
	assert.equal(survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" }).status, 56);
	assert.deepEqual(signals(await world.calls()), []);
});

test("kill-survivors never defers a deleted session executable, including tabbed arguments", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-deleted-covered", { sessions: [{ id: "s1" }], extraProcs: [
		{ ...branch[0], ppid: 4004 },
		{ ...branch[1], session: "s1", command: branch[1].command + "\t--diagnostic", executable: "!ENOENT" },
	], cfg: { agents_survive: true } });
	const result = world.update(["--yes", "--end-sessions", "--force", "--kill-survivors"], { input: "kill survivors 8102 8101\n" });
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /identity unproven/);
	assert.deepEqual(signals(await world.calls()), []);
	assert.ok(!(await world.calls()).some((line) => /^osascript/.test(line)));
});

test("kill-survivors is update-only and cannot be detached", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-usage", { running: false });
	assert.equal(world.run(["--kill-survivors", world.newApp]).status, 2);
	const detached = world.update(["--yes", "--detached", "--kill-survivors"]);
	assert.equal(detached.status, 2);
	assert.match(detached.stderr, /typed PID confirmation/);
	assert.deepEqual(signals(await world.calls()), []);
});

function transitionToFixture(world, scripts) {
	return survivorCall(world, `
noetaxis_survivor_scan "$target_app" "$cap_survivors_file"
/usr/bin/awk -F '|' -v command="/bin/sh $TMPDIR/noetaxis-watchdog-leaked/stubborn.sh" '$1 == 8102 { print $1 "|" command; next } { print }' "$NOETAXIS_SIM/procs" > "$cap_dir/procs.new"
/bin/mv "$cap_dir/procs.new" "$NOETAXIS_SIM/procs"
/usr/bin/awk -F '|' '$1 == 8102 { print $1 "|/bin/sh"; next } { print }' "$NOETAXIS_SIM/executables" > "$cap_dir/exe.new"
/bin/mv "$cap_dir/exe.new" "$NOETAXIS_SIM/executables"
update_kill_survivors=1
noetaxis_update_survivors "$target_app"`, { scripts, input: "kill survivors 8102 8101\n" });
}

test("fixture exclusion wins over recorded bundle ancestry after an exec transition", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-fixture-transition", { running: false, extraProcs: branch });
	const result = transitionToFixture(world);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), []);
	assert.match(result.stderr, /Leaked installer test fixtures/);
});

test("mutation: stale bundle history cannot override the fixture exclusion", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "survivors.sh", 'FILENAME == ARGV[1] { if (rank[$2] > rank[kind[$1]]) kind[$1] = $2; next }', 'FILENAME == ARGV[1] { kind[$1] = $2; next }');
	const world = await makeWorld(t, "teardown-fixture-priority-mutant", { running: false, extraProcs: branch });
	const result = transitionToFixture(world, scripts);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.ok(signals(await world.calls()).includes("kill -TERM 8102"), "the fixture exclusion assertion rejects the mutation");
});

test("a fixture child mentioning the app also keeps the fixture exclusion", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-fixture-child", { running: false, extraProcs: [
		orphan(8101, { command: "/bin/sh <TMP>/noetaxis-watchdog-leaked/stubborn.sh" }),
		{ ...branch[0], pid: 8102, ppid: 8101 },
	] });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8102 8101\n" });
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), []);
	assert.match(result.stderr.split("Leaked installer test fixtures")[1], /pid 8102/);
});

test("unreadable identity of a still-present orphan blocks instead of disappearing from the scan", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-unreadable-orphan", { running: false, extraProcs: [orphan()], cfg: { info_fails_8101: true } });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" });
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /Cannot verify survivor pid 8101/);
	assert.deepEqual(signals(await world.calls()), []);
});

test("an anchored orphan parent does not hide its independently verified bundle child", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-orphan-owned-child", { running: false, extraProcs: [
		orphan(8601),
		{ ...branch[0], pid: 8602, ppid: 8601 },
	] });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8602 8601\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8602", "kill -TERM 8601"]);
});

test("respawn after KILL is reported and final rescan refuses", darwin, async (t) => {
	const world = await makeWorld(t, "teardown-respawn", { running: false, extraProcs: [orphan()], cfg: { stubborn: "8101\n" } });
	await world.setCfg("respawn_on_kill", `/bin/sh ${world.home}/.ao/data/worktrees/respawner.sh`);
	await writeFile(path.join(world.sim, "respawners"), "- 0 dev.agent-orchestrator.desktop\n");
	const launchAgents = path.join(world.home, "Library/LaunchAgents");
	await mkdir(launchAgents, { recursive: true });
	await writeFile(path.join(launchAgents, "relaunch.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>${world.targetApp}/Contents/MacOS/Agent Orchestrator</string></array></dict></plist>`);
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { input: "kill survivors 8101\n" });
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /dev.agent-orchestrator.desktop/);
	assert.match(result.stderr, /LaunchAgents\/relaunch.plist/);
	assert.match(result.stderr, /Final survivor scan is not empty/);
	assert.equal(signals(await world.calls()).length, 2);
});

test("orphan cleanup integrates before swapping and is opt-in even with --force", darwin, async (t) => {
	const refused = await makeWorld(t, "teardown-orphan-default", { running: false, extraProcs: [orphan()] });
	assert.equal(refused.update(["--yes", "--force"]).status, 56);
	assert.equal(refused.installedVersion(), oldVersion);
	assert.deepEqual(signals(await refused.calls()), []);
	const world = await makeWorld(t, "teardown-orphan-update", { running: false, extraProcs: [orphan()] });
	const result = world.update(["--yes", "--kill-survivors"], { input: "kill survivors 8101\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8101"]);
	assert.notEqual(world.installedVersion(), oldVersion);
});

test("the final scan immediately before swapping catches a late orphan; removing it is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "install.sh", 'if [[ -s "$cap_dir/survivors-final.tsv" ]]; then', 'if false; then');
	for (const [label, scripts, expected] of [["real", null, 56], ["mutant", mutant, 0]]) {
		const world = await makeWorld(t, `teardown-late-${label}`, { running: false });
		const marker = path.join(world.root, "after-record");
		const child = fixtureSpawn(path.join(scripts ?? world.scriptsDir, "install.sh"), ["--update", "--yes", "--health-timeout", "3", world.newApp], { env: { ...world.env, NOETAXIS_TEST_PAUSE_AT: "after-record", NOETAXIS_TEST_PAUSE_MARKER: marker, NOETAXIS_TEST_PAUSE_SECONDS: "3" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		const exited = new Promise((resolve) => child.on("close", resolve));
		let reached = false;
		for (let n = 0; n < 300; n++) { if (await stat(marker).catch(() => false)) { reached = true; break; } await pause(50); }
		assert.ok(reached, stdout + stderr);
		await world.addProc(`/bin/sh ${world.home}/.ao/data/worktrees/late.sh`, 1, "/bin/sh");
		assert.equal(await exited, expected, stdout + stderr);
		assert.deepEqual(signals(await world.calls()), []);
		assert.equal(world.installedVersion() === oldVersion, label === "real");
		if (label === "real") assert.match(stderr, /no newly appeared PID is adopted or signalled/);
	}
});

test("fixture cleanup detects survivors and reaps an escaped TERM-ignoring fixture before removing its root", darwin, async (t) => {
	const root = await fixtureRoot(t, "noetaxis-watchdog-registry-");
	const script = path.join(root, "stubborn.sh");
	await writeFile(script, '#!/bin/sh\ntrap "" TERM\necho $$ > "$NOETAXIS_FIXTURE_ROOT/escapee.pid"\nwhile [ -f "$NOETAXIS_FIXTURE_ROOT/.fixture-alive" ]; do sleep 0.05; done\n');
	await chmod(script, 0o755);
	const child = fixtureSpawn(script, [], { env: { ...process.env, TMPDIR: root }, detached: true, stdio: "ignore" });
	for (let n = 0; n < 50 && !fixtureProcesses(root).length; n++) await pause(20);
	assert.ok(child.pid > 0);
	assert.throws(() => assertNoFixtureProcesses(root), /Fixture processes survived cleanup/);
	await cleanupFixtureProcesses(root);
	assertNoFixtureProcesses(root);
});

test("fixture cleanup also runs after failed assertions and timed-out test bodies", darwin, async (t) => {
	const root = await fixtureRoot(t, "noetaxis-watchdog-failure-cleanup-");
	const registry = fileURLToPath(new URL("./noetaxis-macos-fixture-registry.mjs", import.meta.url));
	for (const mode of ["failure", "timeout"]) {
		const file = path.join(root, `${mode}.node-test.mjs`);
		await writeFile(file, `import test from 'node:test';
import {writeFile, chmod} from 'node:fs/promises';
import path from 'node:path';
import {fixtureRoot, fixtureSpawn} from ${JSON.stringify(registry)};
test('cleanup on ${mode}', {timeout: 500}, async (t) => {
 const root = await fixtureRoot(t, 'noetaxis-watchdog-${mode}-');
 const file = path.join(root, 'stubborn.sh');
 await writeFile(file, '#!/bin/sh\\ntrap "" TERM\\nwhile [ -f "$NOETAXIS_FIXTURE_ROOT/.fixture-alive" ]; do sleep 0.05; done\\n');
 await chmod(file, 0o755);
 const child = fixtureSpawn(file, [], {env: {...process.env, TMPDIR: root}, detached:true, stdio:'ignore'});
 console.log('FIXTURE_PID=' + child.pid);
 ${mode === "failure" ? "throw new Error('expected assertion failure');" : "await new Promise(() => {});"}
});`);
		const env = { ...process.env, TMPDIR: root };
		delete env.NODE_TEST_CONTEXT;
		const result = execute(process.execPath, ["--test", file], { timeout: 20_000, env });
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.doesNotMatch(result.stdout + result.stderr, /Fixture processes survived cleanup/);
		const pid = Number(result.stdout.match(/FIXTURE_PID=(\d+)/)?.[1]);
		assert.ok(pid > 0, result.stdout + result.stderr);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	}
});

test("fixture cleanup escalates to registered detached grandchildren that ignore TERM and the lease", darwin, async (t) => {
	const root = await fixtureRoot(t, "noetaxis-watchdog-grandchild-");
	const marker = path.join(root, "grandchild.pid");
	const parent = fixtureSpawn("/usr/bin/perl", ["-e", `use POSIX ();
my $child = fork(); die $! unless defined $child;
if (!$child) {
 POSIX::setsid(); $SIG{TERM} = "IGNORE";
 open(my $f, ">", $ARGV[0]) or die $!; print $f "$$\\n"; close($f);
 for (1 .. 3000) { select(undef, undef, undef, 0.1); }
 exit 1;
}
waitpid($child, 0);`, marker], { env: { ...process.env, TMPDIR: root }, stdio: "ignore" });
	for (let n = 0; n < 100 && !(await stat(marker).catch(() => false)); n++) await pause(20);
	const grandchild = Number((await readFile(marker, "utf8")).trim());
	assert.notEqual(grandchild, parent.pid);
	assert.ok(fixtureProcesses(root).includes(grandchild));
	assert.throws(() => assertNoFixtureProcesses(root), /Fixture processes survived cleanup/);
	await cleanupFixtureProcesses(root);
	assertNoFixtureProcesses(root);
	assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
});

test("broken-watchdog fake ao grandchildren honor the lease; removing that check is caught and escalated", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "common.sh", '\t\t\tkill "KILL", -$pgid;\n', "");
	for (const mutant of [false, true]) {
		const world = await makeWorld(t, `teardown-hang-lease-${mutant}`, { cfg: { ao_hang: "session ls" }, env: { NOETAXIS_HELPER_TIMEOUT_MAX: "1" } });
		if (mutant) {
			const file = path.join(world.targetApp, "Contents/Resources/daemon/ao");
			const source = await readFile(file, "utf8");
			const changed = source.replace('[[ -f "${NOETAXIS_FIXTURE_ROOT:?}/.fixture-alive" ]] || break', ': # lease check removed');
			assert.notEqual(changed, source);
			await writeFile(file, changed);
		}
		const result = world.update(["--yes"], { scriptsDir: scripts });
		assert.equal(result.status, 52, result.stdout + result.stderr);
		const pid = Number((await readFile(path.join(world.sim, "hung.pid"), "utf8")).trim());
		assert.ok(fixtureProcesses(world.root).includes(pid), "the broken watchdog leaves a registered grandchild");
		await rm(path.join(world.root, ".fixture-alive"));
		for (let n = 0; n < 15 && fixtureProcesses(world.root).includes(pid); n++) await pause(100);
		assert.equal(fixtureProcesses(world.root).includes(pid), mutant, "the lease-exit assertion catches a fake that ignores its lease");
		await cleanupFixtureProcesses(world.root);
		assertNoFixtureProcesses(world.root);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		assert.deepEqual(signals(await world.calls()), [], "fixture cleanup never uses the product signal inventory");
	}
});

test("packaging copies the installer beside artifacts and writes verifiable SHA256SUMS", async (t) => {
	const root = await fixtureRoot(t, "noetaxis-artifact-output-");
	const output = path.join(root, "output");
	await mkdir(output);
	await writeFile(path.join(output, "app.pkg"), "package");
	const installer = await writeInstallerArtifacts(output);
	const checksums = await writeArtifactChecksums(output);
	for (const name of ["install.sh", "update.sh", "common.sh", "update-lib.sh", "survivors.sh", "rollback.sh", "README.md"]) {
		assert.deepEqual(await readFile(path.join(installer, name)), await readFile(path.join(realScriptsDir, name)));
		if (name.endsWith(".sh")) assert.equal((await stat(path.join(installer, name))).mode & 0o777, 0o755);
	}
	assert.ok((await readdir(path.join(installer, "pkg-scripts"))).includes("preinstall"));
	assert.deepEqual(await readFile(path.join(installer, "pkg-scripts/common.sh")), await readFile(path.join(realScriptsDir, "common.sh")));
	const verify = async () => {
		for (const line of (await readFile(checksums, "utf8")).trim().split("\n")) {
			const [hash, name] = line.split("  ");
			assert.equal(createHash("sha256").update(await readFile(path.join(output, name))).digest("hex"), hash, name);
		}
	};
	await verify();
	assert.match(await readFile(checksums, "utf8"), /installer\/survivors.sh/);
	assert.match(await readFile(checksums, "utf8"), /app.pkg/);
	await writeFile(path.join(installer, "update.sh"), "changed");
	await assert.rejects(verify, /installer\/update.sh/);
});

test("mutations: sequential or unbounded session exit pools are caught", darwin, async (t) => {
	for (const [label, search, replacement, expected] of [
		["serial", '${NOETAXIS_SESSION_WORKERS:-8}', '${NOETAXIS_SESSION_WORKERS:-1}', 1],
		["unbounded", 'if [[ "${#update_session_jobs[@]}" -ge "$workers" ]]; then', 'if false; then', 17],
	]) {
		const scripts = await mutatedScripts(t, "update-lib.sh", search, replacement);
		const world = await makeWorld(t, `teardown-pool-${label}`, { running: false });
		const result = survivorCall(world, `
cap_live_count=17; cap_live_file="$cap_dir/live"; cap_hosts_file="$cap_dir/hosts"
for n in {1..17}; do printf 's%s%sproject%sworker\\n' "$n" "$noetaxis_sep" "$noetaxis_sep"; done > "$cap_live_file"
for n in {1..17}; do printf 's%s\\thost\\n' "$n"; done > "$cap_hosts_file"
noetaxis_update_session_unchanged() { return 0; }
noetaxis_update_verify_daemon() { return 0; }
noetaxis_update_host_unchanged() { return 0; }
noetaxis_update_wait_agent_processes() { return 0; }
noetaxis_update_no_live_sessions() { return 0; }
noetaxis_bounded() { printf 'start\\n' >> "$cap_dir/order"; /bin/sleep 0.5; printf 'end\\n' >> "$cap_dir/order"; }
unset NOETAXIS_SESSION_WORKERS
noetaxis_update_end_sessions`, { scripts });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		let active = 0; let maximum = 0;
		for (const line of (await readFile(path.join(world.sim, "order"), "utf8")).trim().split("\n")) { if (line === "start") maximum = Math.max(maximum, ++active); else active--; }
		assert.equal(maximum, expected);
		assert.notEqual(maximum, 8, "the production pool-size assertion rejects the mutation");
	}
});

test("mutation: skipping the signal identity check is caught by an exec transition after TERM", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "survivors.sh", 'noetaxis_survivor_matches "$@" || return 1', ':');
	const world = await makeWorld(t, "teardown-exec-mutant", { running: false, extraProcs: [orphan()], cfg: { stubborn: "8101\n", survivor_exec_after_term_8101: "/bin/other" } });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { scripts, input: "kill survivors 8101\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8101", "kill -KILL 8101"], "the changed executable was incorrectly KILLed");
});

test("mutation: bypassing typed confirmation is caught", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "survivors.sh", '[[ "$answer" == "$expected" ]] ||', 'true ||');
	const world = await makeWorld(t, "teardown-confirm-mutant", { running: false, extraProcs: [orphan()] });
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { scripts, input: "yes\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), ["kill -TERM 8101"]);
});

test("mutation: an unanchored ao substring cannot silently become an approved orphan", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "survivors.sh", 'noetaxis_ao_marker() {', 'noetaxis_ao_marker() { return 0;');
	const world = await makeWorld(t, "teardown-anchor-mutant", { running: false, extraProcs: [orphan(8101, { command: "/bin/sh totally-unrelated-ao-tool.sh" })] });
	const result = survivorCall(world, 'noetaxis_survivor_scan "$target_app" "$cap_survivors_file"; /bin/cat "$cap_survivors_file"', { scripts });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /8101/);
});

test("mutation: skipping the final survivor scan admits a respawner", darwin, async (t) => {
	const scripts = await mutatedScripts(t, "survivors.sh", 'update_survivors_confirmed=0\n\tnoetaxis_survivor_scan "$app_path" "$file" || return 56', 'update_survivors_confirmed=0\n\t: > "$file"');
	const world = await makeWorld(t, "teardown-rescan-mutant", { running: false, extraProcs: [orphan()], cfg: { stubborn: "8101\n" } });
	await world.setCfg("respawn_on_kill", `/bin/sh ${world.home}/.ao/data/worktrees/respawner.sh`);
	const result = survivorCall(world, 'update_kill_survivors=1; noetaxis_update_survivors "$target_app"', { scripts, input: "kill survivors 8101\n" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal((await world.procs()).length, 1, "the production final-empty assertion would reject the respawn");
});
