import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute, fakesDir, makeWorld, mutatedScripts, oldVersion, realScriptsDir } from "./noetaxis-macos-update-world.mjs";

const darwin = { skip: process.platform !== "darwin" };
const agentCommand = (id = "s1") => `/Users/test/.local/bin/claude --mcp-config ${JSON.stringify({ mcpServers: { ao: { type: "stdio", command: "<APP>/Contents/Resources/daemon/ao", args: ["mcp"], env: { AO_SESSION_ID: id } } } })}`;
const agentTree = (hostPid = 4004, runtimePid = 4005, agentPid = 4006) => [
	{ pid: runtimePid, ppid: hostPid, session: "s1", command: "<APP>/Contents/Resources/acp-runtime/node/bin/node <APP>/Contents/Resources/acp-runtime/claude-agent-acp/dist/index.js" },
	{ pid: agentPid, ppid: runtimePid, session: "s1", command: agentCommand() },
];
const signals = (calls) => calls.filter((line) => /^kill /.test(line));
const exits = (calls) => calls.filter((line) => /session exit-agent /.test(line));

test("the executable lookup uses isolated system Python and libproc", async () => {
	const source = await readFile(path.join(realScriptsDir, "common.sh"), "utf8");
	assert.match(source, /noetaxis_bounded 5 \/usr\/bin\/python3 -I -S -c/);
	assert.match(source, /ctypes\.CDLL\("\/usr\/lib\/libproc\.dylib"/);
});

function assertBlocked(result, pids) {
	assert.equal(result.status, 21, result.stdout + result.stderr);
	for (const pid of pids) assert.match(result.stderr, new RegExp(`pid ${pid}\\b`));
}

async function setExecutable(world, pid, executable) {
	if (executable.startsWith("/")) await mkdir(path.dirname(executable), { recursive: true });
	const file = path.join(world.sim, "executables");
	const rows = (await readFile(file, "utf8")).split("\n").filter((row) => row && !row.startsWith(`${pid}|`));
	if (executable) rows.push(`${pid}|${executable}`);
	await writeFile(file, `${rows.join("\n")}\n`);
}

async function ownedWorld(t, label, cfg = {}) {
	return makeWorld(t, label, { sessions: [{ id: "s1" }], extraProcs: agentTree(), cfg });
}

test("a production session agent is planned and waited for after exit-agent", darwin, async (t) => {
	const world = await ownedWorld(t, "ancestry-owned", { agents_exit_ticks: "8" });
	const liveRefusal = world.update(["--dry-run"]);
	assert.equal(liveRefusal.status, 51, liveRefusal.stdout + liveRefusal.stderr);
	assert.match(liveRefusal.stdout, /Agent processes of live sessions \(1\)/);
	const plan = world.update(["--dry-run", "--end-sessions"]);
	assert.equal(plan.status, 0, plan.stdout + plan.stderr);
	assert.match(plan.stdout, /Agent processes of live sessions \(1\)/);
	assert.match(plan.stdout, /pid 4006/);
	assert.deepEqual(await world.calls().then(exits), []);
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Waiting for agent processes of live sessions to exit/);
	assert.ok(!(await world.procs()).some(({ pid }) => pid === 4006));
	const calls = await world.calls();
	assert.ok(calls.findIndex((line) => /session exit-agent s1/.test(line)) < calls.findIndex((line) => /^osascript/.test(line)));
	assert.deepEqual(signals(calls), []);
});

test("a surviving agent refuses even with force and is never signalled", darwin, async (t) => {
	const world = await ownedWorld(t, "ancestry-survivor", { agents_survive: true });
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /Agent processes of live sessions are still running/);
	assert.match(result.stderr, /pid 4006/);
	assert.deepEqual(signals(await world.calls()), []);
	assert.equal(world.installedVersion(), oldVersion);
});

test("an empty session column preserves an unassigned descendant in the final wait", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-empty-session", { extraProcs: agentTree(4003, 4004, 4005) });
	const result = world.update(["--yes"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /pid 4005/);
	assert.deepEqual(signals(await world.calls()), []);
});

test("agents from ended sessions are waited for when a later session cannot end", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-partial-end", { sessions: [{ id: "s1" }, { id: "s2" }], extraProcs: agentTree(4004, 4006, 4007), cfg: { agents_exit_ticks: "8", exit_fail_s2: true } });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 53, result.stdout + result.stderr);
	assert.match(result.stdout, /Waiting for agent processes/);
	assert.ok(!(await world.procs()).some(({ pid }) => pid === 4007));
	assert.deepEqual(signals(await world.calls()), []);
});

for (const [name, command] of [["unowned session CLI", agentCommand()], ["argument-only decoy", "/usr/bin/tail -f <APP>/Contents/Resources/log.txt"]]) {
	test(`${name} still blocks without a bundle ancestor`, darwin, async (t) => {
		const world = await makeWorld(t, `ancestry-${name.replaceAll(" ", "-")}`, { running: false, extraProcs: [{ pid: 6101, ppid: 1, command }] });
		assertBlocked(world.update(["--dry-run"]), [6101]);
		assert.deepEqual(signals(await world.calls()), []);
	});
}

test("a forged parent title cannot grant ownership to its child", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-forged-parent", { running: false, extraProcs: [
		{ pid: 6201, ppid: 1, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --forged-title", executable: "/usr/bin/node" },
		{ pid: 6202, ppid: 6201, command: agentCommand() },
	] });
	assertBlocked(world.update(["--dry-run"]), [6201, 6202]);
});

test("an app lookalike and its child remain foreign", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-lookalike", { running: false, extraProcs: [
		{ pid: 6251, ppid: 1, command: "<APP>.bak/Contents/Resources/acp-runtime/node/bin/node --mentions <APP>/Contents/Resources/daemon/ao", executable: "<APP>.bak/Contents/Resources/acp-runtime/node/bin/node" },
		{ pid: 6252, ppid: 6251, command: agentCommand() },
	] });
	assertBlocked(world.update(["--dry-run"]), [6251, 6252]);
});

test("cycles, launchd and deep chains cannot make ancestry unbounded", darwin, async (t) => {
	const cycle = await makeWorld(t, "ancestry-cycle", { running: false, extraProcs: [
		{ pid: 6301, ppid: 6302, command: agentCommand() },
		{ pid: 6302, ppid: 6301, command: "/usr/bin/cycle" },
	] });
	assertBlocked(cycle.update(["--dry-run"]), [6301]);
	const deep = await makeWorld(t, "ancestry-depth", { running: false, extraProcs: [
		{ pid: 7000, ppid: 7001, command: agentCommand() },
		...Array.from({ length: 69 }, (_, index) => ({ pid: 7001 + index, ppid: 7002 + index, command: "/usr/bin/helper" })),
		{ pid: 7070, ppid: 1, command: "<APP>/Contents/Resources/daemon/ao chat-host s1 /tmp/data /tmp/worktrees" },
	] });
	assertBlocked(deep.update(["--dry-run"]), [7000]);
	const launchd = await makeWorld(t, "ancestry-launchd", { running: false, extraProcs: [{ pid: 7100, ppid: 1, command: agentCommand() }] });
	assertBlocked(launchd.update(["--dry-run"]), [7100]);
});

async function mappingWorld(t, label, owned) {
	return makeWorld(t, label, { running: false, extraProcs: [
		{ pid: 6401, ppid: 1, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --stdio", executable: owned ? "<APP>/Contents/Resources/acp-runtime/node/bin/node" : "/usr/bin/node", mappings: owned ? ["/usr/lib/libffi.dylib", "<APP>/Contents/Resources/acp-runtime/node/bin/node"] : ["<APP>/Contents/Resources/acp-runtime/node/bin/node", "/usr/lib/libffi.dylib"] },
		...(!owned ? [{ pid: 6402, ppid: 6401, command: agentCommand(), mappings: ["/usr/bin/claude"] }] : []),
	] });
}

test("lsof txt mapping order does not establish executable ownership", darwin, async (t) => {
	const foreign = await mappingWorld(t, "ancestry-mapped-bundle-first", false);
	assertBlocked(foreign.update(["--dry-run"]), [6401, 6402]);
	const owned = await mappingWorld(t, "ancestry-mapped-outside-first", true);
	const result = owned.update(["--dry-run"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("executable lookup fails closed for error text, EPERM, a gone process and a missing helper", darwin, async (t) => {
	for (const [label, executable] of [["error-text", "region info error: Operation not permitted"], ["EPERM", "!EPERM"], ["gone", ""]]) {
		const world = await makeWorld(t, `ancestry-path-${label}`, { running: false, extraProcs: [{ pid: 6501, ppid: 1, command: agentCommand() }] });
		await setExecutable(world, 6501, executable);
		assertBlocked(world.update(["--dry-run"], { cwd: path.join(world.targetApp, "Contents") }), [6501]);
	}
	const scripts = await mutatedScripts(t, "common.sh", path.join(fakesDir, "proc-pidpath"), path.join(fakesDir, "missing-proc-pidpath"));
	const world = await makeWorld(t, "ancestry-helper-missing", { running: false, extraProcs: [{ pid: 6502, command: agentCommand() }] });
	assertBlocked(world.update(["--dry-run"], { scriptsDir: scripts }), [6502]);
});

test("force never signals a planned bundle process after its executable changes", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-exec-after-plan", { extraProcs: [{ pid: 6601, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --stdio" }] });
	const executable = path.join(world.root, "foreign/node");
	await mkdir(path.dirname(executable), { recursive: true });
	await world.setCfg("exec_after_quit", `6601|${executable}`);
	const before = (await world.procs()).find(({ pid }) => pid === 6601);
	const result = world.update(["--yes", "--force"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.deepEqual(signals(await world.calls()), []);
	assert.deepEqual((await world.procs()).find(({ pid }) => pid === 6601), before);
});

test("own-bundle enumeration rejects a forged command and its executable-check mutation is caught", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-enumeration", { running: false, extraProcs: [{ pid: 6651, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --forged", executable: "/usr/bin/node" }] });
	const enumerate = (scripts) => execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; noetaxis_own_bundle_processes "$2"', "enumerate", scripts, world.targetApp], { env: world.env });
	assert.equal(enumerate(world.scriptsDir).stdout, "");
	const mutant = await mutatedScripts(t, "update-lib.sh", 'noetaxis_process_executable_is_in_bundle "$app_path" "$pid" || continue', ":");
	assert.match(enumerate(mutant).stdout, /^6651\t/);
});

async function signalTransition(t, scriptsDir, label) {
	const world = await makeWorld(t, label, { running: false, extraProcs: [{ pid: 6701, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --stdio" }] });
	const scripts = scriptsDir ?? world.scriptsDir;
	const approved = path.join(world.sim, "approved.tsv");
	const snapshot = execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; noetaxis_update_snapshot_processes "$2" > "$3"', "snapshot", scripts, world.targetApp, approved], { env: world.env });
	assert.equal(snapshot.status, 0, snapshot.stderr);
	await setExecutable(world, 6701, path.join(world.root, "foreign/node"));
	const result = execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; update_approved_file="$3"; noetaxis_signal_own_pid "$2" 6701 transition', "signal", scripts, world.targetApp, approved], { env: world.env });
	return { world, result };
}

test("the last executable check prevents a signal and its removal is caught", darwin, async (t) => {
	const safe = await signalTransition(t, undefined, "ancestry-signal-safe");
	assert.equal(safe.result.status, 1, safe.result.stdout + safe.result.stderr);
	assert.deepEqual(signals(await safe.world.calls()), []);
	const mutant = await mutatedScripts(t, "update-lib.sh", 'if ! noetaxis_process_executable_is_in_bundle "$app_path" "$pid"; then', "if false; then");
	const unsafe = await signalTransition(t, mutant, "ancestry-signal-mutant");
	assert.equal(unsafe.result.status, 0, unsafe.result.stderr);
	assert.deepEqual(signals(await unsafe.world.calls()), ["kill -TERM 6701"]);
});

test("exit-agent is skipped when the confirmed host execs during daemon verification", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-host-exec", { sessions: [{ id: "s1" }], cfg: { exec_host_after_session_lists: "s1" } });
	await mkdir(path.join(world.sim, "foreign"), { recursive: true });
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 51, result.stdout + result.stderr);
	assert.match(result.stdout, /host replaced during the daemon check/);
	assert.deepEqual(exits(await world.calls()), []);
});

test("classic install and PKG preinstall classify descendants without permitting foreign blockers", darwin, async (t) => {
	const world = await makeWorld(t, "ancestry-classic", { running: false, extraProcs: [
		{ pid: 4004, command: "<APP>/Contents/Resources/daemon/ao chat-host s1 /tmp/data /tmp/worktrees" },
		...agentTree(),
	] });
	const classic = world.run(["--dry-run", world.newApp]);
	assert.equal(classic.status, 21, classic.stderr);
	assert.match(classic.stderr, /Agent processes of live sessions \(1\)/);
	const allowed = world.run(["--dry-run", "--allow-background-processes", world.newApp]);
	assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
	const pkgDir = path.join(world.root, "pkg");
	await mkdir(pkgDir, { recursive: true });
	for (const [source, destination] of [["pkg-scripts/preinstall", "preinstall"], ["common.sh", "common.sh"]]) await writeFile(path.join(pkgDir, destination), await readFile(path.join(world.scriptsDir, source)));
	const pkg = execute("/bin/bash", [path.join(pkgDir, "preinstall")], { env: world.env });
	assert.equal(pkg.status, 21, pkg.stdout + pkg.stderr);
	const foreign = await makeWorld(t, "ancestry-classic-foreign", { running: false, extraProcs: [{ pid: 6801, command: agentCommand() }] });
	const refused = foreign.run(["--dry-run", "--allow-background-processes", foreign.newApp]);
	assert.equal(refused.status, 21, refused.stdout + refused.stderr);
});

test("mutation: returning to command substring ownership is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", /noetaxis_process_executable_path\(\) \{[\s\S]*?\n\}/, `noetaxis_process_executable_path() {
	local command_line
	command_line="$(ps -ww -o command= -p "$1")"
	printf '%s/Contents/Resources/acp-runtime/node/bin/node' "\${command_line%%/Contents/*}"
}`);
	const world = await makeWorld(t, "ancestry-substring-mutant", { running: false, extraProcs: [
		{ pid: 6901, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --forged", executable: "/usr/bin/node" },
		{ pid: 6902, ppid: 6901, command: agentCommand() },
	] });
	const result = world.update(["--dry-run"], { scriptsDir: mutant });
	assert.notEqual(result.status, 21, "the mutation incorrectly trusts the forged parent");
});

test("mutation: skipping the ancestor walk is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", /noetaxis_process_has_bundle_ancestor\(\) \{[\s\S]*?\n\}/, "noetaxis_process_has_bundle_ancestor() {\n\treturn 1\n}");
	const world = await ownedWorld(t, "ancestry-no-walk-mutant");
	assert.equal(world.update(["--dry-run", "--end-sessions"], { scriptsDir: mutant }).status, 21);
});

test("mutation: treating every session CLI as owned is caught", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", 'if noetaxis_executable_path_is_in_bundle "$app_path" "$executable" || noetaxis_process_has_bundle_ancestor "$app_path" "$pid"; then continue; fi', 'if [[ "$command_line" == *"/claude "* ]] || noetaxis_executable_path_is_in_bundle "$app_path" "$executable" || noetaxis_process_has_bundle_ancestor "$app_path" "$pid"; then continue; fi');
	const world = await makeWorld(t, "ancestry-every-cli-mutant", { running: false, extraProcs: [{ pid: 6951, command: agentCommand() }] });
	assert.notEqual(world.update(["--dry-run"], { scriptsDir: mutant }).status, 21);
});

test("mutation: trusting the first txt mapping is caught in both orders", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", /noetaxis_process_executable_path\(\) \{[\s\S]*?\n\}/, `noetaxis_process_executable_path() {
	"\${NOETAXIS_LSOF}" -p "$1" -d txt -Fn | /usr/bin/awk '/^n/ { print substr($0, 2); exit }'
}`);
	const foreign = await mappingWorld(t, "ancestry-txt-foreign-mutant", false);
	assert.notEqual(foreign.update(["--dry-run"], { scriptsDir: mutant }).status, 21);
	const owned = await mappingWorld(t, "ancestry-txt-owned-mutant", true);
	assert.equal(owned.update(["--dry-run"], { scriptsDir: mutant }).status, 21);
});
