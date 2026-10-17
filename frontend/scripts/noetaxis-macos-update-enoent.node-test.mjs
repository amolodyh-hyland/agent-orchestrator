import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute, makeWorld, mutatedScripts, oldVersion, realScriptsDir } from "./noetaxis-macos-update-world.mjs";

const darwin = { skip: process.platform !== "darwin" };
const command = "/opt/homebrew/bin/claude --mcp-config <APP>/Contents/Resources/daemon/ao";
const tree = (id = "s1", host = 4004, runtime = 8001, agent = 8002) => [
	{ pid: runtime, ppid: host, session: id, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node <APP>/Contents/Resources/acp-runtime/claude-agent-acp/dist/index.js" },
	{ pid: agent, ppid: runtime, session: id, command, executable: "!ENOENT" },
];
const signals = (calls) => calls.filter((line) => /^kill /.test(line));
const exits = (calls) => calls.filter((line) => /session exit-agent /.test(line));
const owned = (t, label, cfg = {}) => makeWorld(t, label, { sessions: [{ id: "s1" }], extraProcs: tree(), cfg });

test("ENOENT is distinct from all other executable lookup failures", async () => {
	const source = await readFile(path.join(realScriptsDir, "common.sh"), "utf8");
	assert.match(source, /sys\.exit\(44 if ctypes\.get_errno\(\) == errno\.ENOENT else 1\)/);
	assert.match(source, /except Exception:\n    sys\.exit\(1\)/);
});

test("a deleted executable requires confirmed session teardown and is waited for", darwin, async (t) => {
	const world = await owned(t, "enoent-covered", { agents_exit_ticks: "8" });
	const refused = world.update(["--dry-run", "--force"]);
	assert.equal(refused.status, 51, refused.stdout + refused.stderr);
	assert.match(refused.stdout, /deleted executable; identity unproven; session s1/);
	assert.doesNotMatch(refused.stderr, /Processes that mention|<unverified executable path>/);
	assert.match(refused.stderr, /--end-sessions/);
	assert.deepEqual(exits(await world.calls()), []);
	const plan = world.update(["--dry-run", "--end-sessions"]);
	assert.equal(plan.status, 0, plan.stdout + plan.stderr);
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Waiting for agent processes of live sessions to exit/);
	assert.ok(!(await world.procs()).some(({ pid }) => pid === 8002));
	assert.equal(exits(await world.calls()).length, 1);
	assert.deepEqual(signals(await world.calls()), []);
});

test("deleted orchestrator agents from multiple projects are included by --all and ended by exact id", darwin, async (t) => {
	const world = await makeWorld(t, "enoent-orchestrators", {
		sessions: [{ id: "noetaxis-orch", project: "noetaxis", role: "orchestrator" }, { id: "hxp-orch", project: "hxp", role: "orchestrator" }],
		extraProcs: [...tree("noetaxis-orch", 4004), ...tree("hxp-orch", 4005, 8101, 8102)],
	});
	const plan = world.update(["--dry-run", "--end-sessions"]);
	assert.equal(plan.status, 0, plan.stdout + plan.stderr);
	assert.match(plan.stdout, /Agent processes of live sessions \(2\)/);
	assert.match(plan.stdout, /session noetaxis-orch/);
	assert.match(plan.stdout, /session hxp-orch/);
	assert.match(plan.stdout, /orchestrator/);
	const result = world.update(["--yes", "--end-sessions"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const calls = await world.calls();
	assert.ok(exits(calls).some((line) => /exit-agent noetaxis-orch --project noetaxis/.test(line)));
	assert.ok(exits(calls).some((line) => /exit-agent hxp-orch --project hxp/.test(line)));
	assert.deepEqual(signals(calls), []);
});

test("a surviving deleted executable stops before desktop quit even with force", darwin, async (t) => {
	const world = await owned(t, "enoent-survivor", { agents_survive: true });
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /identity unproven/);
	assert.match(result.stderr, /exit-agent/);
	assert.ok((await world.procs()).some(({ pid }) => pid === 8002));
	assert.equal(world.installedVersion(), oldVersion);
	const calls = await world.calls();
	assert.deepEqual(signals(calls), []);
	assert.ok(!calls.some((line) => /^osascript/.test(line)));
});

test("deleted descendants without live-session coverage cannot be bypassed with force", darwin, async (t) => {
	const extraProcs = tree("unknown", 4003);
	extraProcs[1].command += "\t--diagnostic";
	const world = await makeWorld(t, "enoent-uncovered", { extraProcs });
	const result = world.update(["--yes", "--end-sessions", "--force"]);
	assert.equal(result.status, 56, result.stdout + result.stderr);
	assert.match(result.stderr, /no confirmed live-session coverage/);
	assert.match(result.stderr, /pid 8002.*session unknown/);
	assert.deepEqual(exits(await world.calls()), []);
	assert.deepEqual(signals(await world.calls()), []);
	assert.ok(!(await world.calls()).some((line) => /^osascript/.test(line)));
});

test("EPERM and malformed executable paths remain foreign despite a bundle parent", darwin, async (t) => {
	for (const executable of ["!EPERM", "region info error: Operation not permitted", ""]) {
		const extraProcs = tree();
		extraProcs[1].executable = executable;
		const world = await makeWorld(t, "enoent-other-failure", { sessions: [{ id: "s1" }], extraProcs });
		if (!executable) {
			const file = path.join(world.sim, "executables");
			await writeFile(file, (await readFile(file, "utf8")).replace(/^8002\|.*\n/m, ""));
		}
		const result = world.update(["--dry-run", "--end-sessions", "--force"]);
		assert.equal(result.status, 21, result.stdout + result.stderr);
		assert.match(result.stderr, /pid 8002.*unverified executable path/);
	}
});

test("an orphan MCP tool and an ENOENT process without a bundle ancestor remain foreign", darwin, async (t) => {
	for (const executable of ["!ENOENT", "/usr/bin/npm"]) {
		const world = await makeWorld(t, "enoent-orphan", { running: false, extraProcs: [{ pid: 8201, ppid: 1, executable, command: "npm exec @playwright/mcp@latest --config <APP>/Contents/Resources/mcp.json" }] });
		const result = world.update(["--dry-run", "--end-sessions", "--force"]);
		assert.equal(result.status, 21, result.stdout + result.stderr);
		assert.match(result.stderr, /pid 8201/);
	}
});

test("an ancestry gap or unverifiable intermediate ancestor does not grant the ENOENT exception", darwin, async (t) => {
	for (const variant of ["gap", "EPERM", "forged", "cycle"]) {
		const extraProcs = tree();
		if (variant === "gap") extraProcs[1].ppid = 9999;
		if (variant === "EPERM") extraProcs[0].executable = "!EPERM";
		if (variant === "forged") { extraProcs[0].ppid = 1; extraProcs[0].executable = "/usr/bin/node"; }
		if (variant === "cycle") extraProcs[0].ppid = 8002;
		const world = await makeWorld(t, `enoent-ancestor-${variant}`, { sessions: [{ id: "s1" }], extraProcs });
		const result = world.update(["--dry-run", "--end-sessions"]);
		assert.equal(result.status, 21, result.stdout + result.stderr);
		assert.match(result.stderr, /pid 8002/);
	}
});

test("a changed ancestor start time invalidates the deleted-process chain", darwin, async (t) => {
	const world = await owned(t, "enoent-ancestor-start");
	await world.setCfg("proc_path_start_transition_8001", "Tue Oct 13 00:00:00 2026");
	const result = execute("/bin/bash", ["-c", 'source "$1/common.sh"; noetaxis_deleted_process_bundle_session "$2" 8002', "chain", world.scriptsDir, world.targetApp], { env: world.env });
	assert.equal(result.status, 1, result.stdout + result.stderr);
});

test("a deep deleted-executable chain is bounded and remains foreign", darwin, async (t) => {
	const world = await makeWorld(t, "enoent-depth", { sessions: [{ id: "s1" }], extraProcs: [
		{ pid: 9000, ppid: 9001, command, executable: "!ENOENT" },
		...Array.from({ length: 70 }, (_, index) => ({ pid: 9001 + index, ppid: index === 69 ? 4004 : 9002 + index, command: "/usr/bin/helper" })),
	] });
	const result = world.update(["--dry-run", "--end-sessions"]);
	assert.equal(result.status, 21, result.stdout + result.stderr);
	assert.match(result.stderr, /pid 9000/);
});

test("an approved bundled PID that becomes ENOENT is excluded from enumeration and final signalling", darwin, async (t) => {
	const world = await makeWorld(t, "enoent-signal", { running: false, extraProcs: [{ pid: 8401, command: "<APP>/Contents/Resources/acp-runtime/node/bin/node --stdio" }] });
	const approved = path.join(world.sim, "approved.tsv");
	const snapshot = execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; noetaxis_update_snapshot_processes "$2" > "$3"', "snapshot", world.scriptsDir, world.targetApp, approved], { env: world.env });
	assert.equal(snapshot.status, 0, snapshot.stderr);
	const file = path.join(world.sim, "executables");
	await writeFile(file, (await readFile(file, "utf8")).replace(/^8401\|.*$/m, "8401|!ENOENT"));
	const own = execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; noetaxis_own_bundle_processes "$2"', "own", world.scriptsDir, world.targetApp], { env: world.env });
	assert.equal(own.stdout, "");
	const signal = execute("/bin/bash", ["-c", 'source "$1/common.sh"; source "$1/update-lib.sh"; update_approved_file="$3"; noetaxis_signal_own_pid "$2" 8401 transition', "signal", world.scriptsDir, world.targetApp, approved], { env: world.env });
	assert.equal(signal.status, 1, signal.stdout + signal.stderr);
	assert.deepEqual(signals(await world.calls()), []);
});

test("classic install and PKG refuse deleted descendants even with the background override", darwin, async (t) => {
	const world = await owned(t, "enoent-classic");
	const result = world.run(["--dry-run", "--allow-background-processes", world.newApp]);
	assert.equal(result.status, 21, result.stdout + result.stderr);
	assert.match(result.stderr, /identity unproven/);
	const pkg = path.join(world.root, "pkg");
	await mkdir(pkg);
	for (const [source, destination] of [["pkg-scripts/preinstall", "preinstall"], ["common.sh", "common.sh"]]) await writeFile(path.join(pkg, destination), await readFile(path.join(world.scriptsDir, source)));
	const preinstall = execute("/bin/bash", [path.join(pkg, "preinstall")], { env: world.env });
	assert.equal(preinstall.status, 21, preinstall.stdout + preinstall.stderr);
	assert.match(preinstall.stderr, /identity unproven/);
	assert.deepEqual(signals(await world.calls()), []);
});

test("mutation: collapsing ENOENT into a generic failure loses the descendant", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", '[[ "$status" -eq 44 ]] && return 44;', ':;');
	const world = await owned(t, "enoent-generic-mutant");
	assert.equal(world.update(["--dry-run", "--end-sessions"], { scriptsDir: mutant }).status, 21);
});

test("mutation: promoting EPERM to ENOENT incorrectly permits session teardown", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", '[[ "$status" -eq 44 ]] && return 44; return 1;', 'return 44;');
	const extraProcs = tree();
	extraProcs[1].executable = "!EPERM";
	const world = await makeWorld(t, "enoent-eperm-mutant", { sessions: [{ id: "s1" }], extraProcs });
	assert.equal(world.update(["--dry-run", "--end-sessions"], { scriptsDir: mutant }).status, 0);
});

test("mutation: granting the ENOENT exception without ancestry lets an orphan pass", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "common.sh", /noetaxis_deleted_process_bundle_session\(\) \{[\s\S]*?\n\}/, 'noetaxis_deleted_process_bundle_session() {\n\tprintf s1\n}');
	const world = await makeWorld(t, "enoent-no-walk-mutant", { sessions: [{ id: "s1" }], extraProcs: [{ pid: 8301, ppid: 1, session: "s1", command, executable: "!ENOENT" }] });
	assert.equal(world.update(["--dry-run", "--end-sessions"], { scriptsDir: mutant }).status, 0);
});

test("mutation: omitting --all leaves orchestrator descendants uncovered", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", 'session ls --all --include-terminated --json', 'session ls --include-terminated --json');
	const world = await makeWorld(t, "enoent-no-all-mutant", { sessions: [{ id: "s1", role: "orchestrator" }], extraProcs: tree() });
	assert.equal(world.update(["--dry-run", "--end-sessions"], { scriptsDir: mutant }).status, 56);
});

test("mutation: bypassing deleted-descendant coverage incorrectly approves an unassigned process", darwin, async (t) => {
	const mutant = await mutatedScripts(t, "update-lib.sh", 'if [[ "$cap_sessions_status" != ok || -n "$uncovered" ]]; then', 'if false; then');
	const world = await makeWorld(t, "enoent-coverage-mutant", { extraProcs: tree("unknown", 4003) });
	assert.equal(world.update(["--dry-run", "--end-sessions", "--force"], { scriptsDir: mutant }).status, 0);
});
