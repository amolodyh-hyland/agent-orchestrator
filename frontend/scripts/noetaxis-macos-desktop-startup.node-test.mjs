import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "noetaxis-macos");
const start = "Mon Oct 12 00:00:00 2026";
function fixture(t, values = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "ao-desktop-progress-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const dir of ["startup/desktop", "app/Contents/MacOS", "app/Contents/Resources/daemon"]) mkdirSync(path.join(root, dir), { recursive: true });
	for (const file of ["app/Contents/MacOS/agent-orchestrator", "app/Contents/Resources/daemon/ao"]) writeFileSync(path.join(root, file), "fixture");
	writeFileSync(path.join(root, "clock"), "1000");
	writeFileSync(path.join(root, "startup/desktop/desktop-launch.json"), JSON.stringify({
		version: 1, kind: "desktop", launchId: "desktop-launch", pid: 456, processStart: start,
		executable: path.join(root, "app/Contents/MacOS/agent-orchestrator"), phase: "window-runtime",
		heartbeatAt: 990, stageStartedAt: 800, waitReason: "keychain-access", waitOperation: "cloud-read", powerState: "awake", ...values,
	}));
	return root;
}
function daemon(root, values = {}) {
	writeFileSync(path.join(root, "startup/daemon-launch.json"), JSON.stringify({
		launchId: "daemon-launch", pid: 123, processStart: start, executable: path.join(root, "app/Contents/Resources/daemon/ao"), phase: "migrating", stage: "migration", migrationId: "20261102160814608", heartbeatAt: 990, ...values,
	}));
}
function shell(root, body = 'noetaxis_update_startup_state "$ROOT/app"; printf "%s\\nstate=%s veto=%s\\n" "$update_startup_detail" "$update_startup_state" "$update_startup_veto"') {
	const result = spawnSync("/bin/bash", ["-c", `
 . "$SCRIPTS/common.sh"
 . "$SCRIPTS/update-lib.sh"
 ao_home="$ROOT"; backup_dir="$ROOT"; noetaxis_update_log_file="$ROOT/update-actions.log"
 update_health_timeout=1; NOETAXIS_STARTUP_ATTENTION_SECONDS=2
 date() { if [[ "$1" == '+%s' ]]; then cat "$ROOT/clock"; else command date "$@"; fi; }
 noetaxis_json_get() { /usr/bin/python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [None for k in sys.argv[2].split(".") if not (v := v[k])]; print("null" if v is None else v)' "$1" "$2"; }
 noetaxis_process_start() { printf '${start}'; }
 noetaxis_pid_may_be_alive() { return 0; }
 noetaxis_process_executable_path() { if [[ "$1" == 456 ]]; then printf '%s' "$ROOT/app/Contents/MacOS/agent-orchestrator"; else printf '%s' "$ROOT/app/Contents/Resources/daemon/ao"; fi; }
 noetaxis_update_desktop_started() { return 0; }
 noetaxis_update_daemon_healthy() { return 1; }
 noetaxis_update_sleep() { local n; n="$(cat "$ROOT/clock")"; printf '%s' "$((n+1))" > "$ROOT/clock"; }
 ${body}
 `], { env: { ...process.env, ROOT: root, SCRIPTS: scripts }, encoding: "utf8" });
	assert.ifError(result.error);
	return result;
}

test("an optional Keychain wait is reported independently of a verified migrating daemon", (t) => {
	const root = fixture(t, { daemon: { pid: 123, launchId: "daemon-launch" } });
	daemon(root);
	const result = shell(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /desktop waiting on Keychain approval\/access for cloud-read/);
	assert.match(result.stdout, /phase window-runtime for 200s/);
	assert.match(result.stdout, /linked daemon launch daemon-launch/);
	assert.match(result.stdout, /phase migrating/);
	assert.match(result.stdout, /state=active veto=1/);
});

test("a pre-spawn blocked main thread reports its durable operation and stale heartbeat", (t) => {
	const result = shell(fixture(t, { heartbeatAt: 500, phase: "daemon-discovery" }));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /heartbeat 500s ago \(stalled main thread or sleep/);
	assert.match(result.stdout, /Keychain approval\/access for cloud-read/);
	assert.match(result.stdout, /daemon has not spawned/);
	assert.match(result.stdout, /state=absent veto=0/);
});

for (const [label, values, expected] of [
	["reused PID", { processStart: "previous-start" }, /without an instrumented startup record/],
	["foreign executable", { executable: "/missing" }, /ambiguous or mismatched/],
	["wrong launch ID", { launchId: "other" }, /ambiguous or mismatched/],
	["future heartbeat", { heartbeatAt: 1100 }, /clock change or invalid record/],
	["suspended", { powerState: "suspended", heartbeatAt: 500 }, /last power state suspended/],
]) test(label + " does not fabricate progress", (t) => {
	const result = shell(fixture(t, values));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, expected);
});

test("mismatched daemon correlation is rejected without weakening the migration veto", (t) => {
	const root = fixture(t, { daemon: { pid: 123, launchId: "previous-daemon" } });
	daemon(root);
	const result = shell(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ambiguous or mismatched/);
	assert.match(result.stdout, /state=active veto=1/);
});

test("corrupt records are diagnostic ambiguity, never daemon readiness", (t) => {
	const root = fixture(t);
	writeFileSync(path.join(root, "startup/desktop/desktop-launch.json"), "{corrupt");
	const result = shell(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ambiguous or mismatched/);
	assert.match(result.stdout, /state=absent/);
});

for (const running of [false, true]) test(`legacy desktop ${running ? "running" : "absent"} is explicit`, (t) => {
	const root = fixture(t);
	rmSync(path.join(root, "startup/desktop/desktop-launch.json"));
	const result = shell(root, `noetaxis_update_desktop_started() { return ${running ? 0 : 1}; }; noetaxis_update_startup_state "$ROOT/app"; echo "$update_startup_detail"`);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, running ? /legacy build/ : /desktop absent/);
});

test("periodic and deadline messages explain the credential wait and retain the new app", (t) => {
	const root = fixture(t);
	const result = shell(root, 'noetaxis_update_auto_rollback() { echo forbidden-rollback; }; noetaxis_update_wait_for_health "$ROOT/app"');
	assert.equal(result.status, 64, result.stderr);
	const log = readFileSync(path.join(root, "update-actions.log"), "utf8");
	assert.match(log, /Startup progress after 0s: .*Keychain approval\/access/);
	assert.match(log, /Health deadline reached.*Keychain approval\/access/);
	assert.match(log, /app=new-retained/);
	assert.doesNotMatch(result.stdout, /forbidden/);
});

test("verified daemon health succeeds while the optional desktop credential wait remains visible", (t) => {
	const root = fixture(t, { daemon: { pid: 123, launchId: "daemon-launch" } });
	daemon(root, { phase: "ready", stage: "ready" });
	const result = shell(root, 'noetaxis_update_daemon_healthy() { return 0; }; noetaxis_update_wait_for_health "$ROOT/app"');
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(path.join(root, "update-actions.log"), "utf8"), /Keychain approval\/access.*verified daemon health ready/);
});
