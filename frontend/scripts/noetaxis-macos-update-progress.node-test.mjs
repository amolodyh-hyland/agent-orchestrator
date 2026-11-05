import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseSchema } from "./noetaxis-macos/build.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "noetaxis-macos");
function fixture(t) {
 const root = mkdtempSync(path.join(os.tmpdir(), "ao-progress-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(path.join(root, "startup"));
 mkdirSync(path.join(root, "app/Contents/Resources/daemon"), { recursive: true });
 writeFileSync(path.join(root, "app/Contents/Resources/daemon/ao"), "fixture");
 writeFileSync(path.join(root, "clock"), "0");
 return root;
}
function shell(root, body) {
 const result = spawnSync("/bin/bash", ["-c", `
 . "$SCRIPTS/common.sh"
 . "$SCRIPTS/update-lib.sh"
 script_dir="$SCRIPTS"
 ao_home="$ROOT"
 backup_dir="$ROOT"
 noetaxis_update_log_file="$ROOT/update-actions.log"
 update_health_timeout=300
 update_quit_timeout=1
 update_rollback_restore_db=0
 date() { if [[ "$1" == '+%s' ]]; then cat "$ROOT/clock"; else command date "$@"; fi; }
 noetaxis_update_sleep() { local tick; tick="$(cat "$ROOT/clock")"; printf '%s' "$((tick + 100))" > "$ROOT/clock"; }
 noetaxis_update_daemon_healthy() { [[ "$(cat "$ROOT/clock")" -ge 600 ]]; }
 noetaxis_json_get() { /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
 noetaxis_process_start() { printf 'Mon Oct 12 00:00:00 2026'; }
 noetaxis_pid_may_be_alive() { return 0; }
 noetaxis_process_executable_is_in_bundle() { return 0; }
 noetaxis_process_executable_path() { printf '%s' "$ROOT/app/Contents/Resources/daemon/ao"; }
 ${body}
 `], { env: { ...process.env, ROOT: root, SCRIPTS: scripts }, encoding: "utf8" });
 assert.ifError(result.error);
 return result;
}
function record(root, values = {}) {
 writeFileSync(path.join(root, `startup/${values.launchId ?? "launch"}.json`), JSON.stringify({ launchId: "launch", pid: 123, processStart: "Mon Oct 12 00:00:00 2026", executable: path.join(root, "app/Contents/Resources/daemon/ao"), phase: "migrating", stage: "migration", migrationId: "20261102160814608", heartbeatAt: 0, ...values }));
}

test("fresh migration heartbeats cross the health deadline without rollback", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 noetaxis_update_startup_state() { update_startup_state=active; update_startup_detail='migrating 20261102160814608'; }
 noetaxis_update_auto_rollback() { echo forbidden-rollback; return 99; }
 noetaxis_update_wait_for_health "$ROOT/app"
 `);
 assert.equal(result.status, 0, result.stderr);
 assert.match(readFileSync(path.join(root, "update-actions.log"), "utf8"), /Health deadline reached/);
 assert.doesNotMatch(result.stdout, /forbidden/);
});

for (const [label, values, expected] of [
 ["fresh exact migration", { heartbeatAt: 990 }, "active"],
 ["stale heartbeat", { heartbeatAt: 800 }, "stale"],
 ["PID reuse", { processStart: "Mon Oct 11 00:00:00 2026", heartbeatAt: 990 }, "ambiguous"],
 ["future heartbeat", { heartbeatAt: 1100 }, "stale"],
]) test(label + " is classified safely", (t) => {
 const root = fixture(t);
 record(root, values);
 writeFileSync(path.join(root, "clock"), "1000");
 const result = shell(root, 'noetaxis_update_startup_state "$ROOT/app"; printf "state=%s\\n" "$update_startup_state"');
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, new RegExp("state=" + expected));
});

for (const state of ["stale", "ambiguous"]) test(state + " startup retains new app and logs instructions", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 noetaxis_update_startup_state() { update_startup_state=${state}; update_startup_detail='test'; }
 noetaxis_update_wait_for_health "$ROOT/app"
 `);
 assert.equal(result.status, 64, result.stderr);
 const log = readFileSync(path.join(root, "update-actions.log"), "utf8");
 assert.match(log, /needs-attention/);
 assert.match(log, /Do not interrupt a migration/);
 assert.match(log, /app=new-retained/);
});

test("a live migration that exceeds the escalation window is retained", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 NOETAXIS_STARTUP_ATTENTION_SECONDS=400
 noetaxis_update_daemon_healthy() { return 1; }
 noetaxis_update_startup_state() { update_startup_state=active; update_startup_detail=migrating; }
 noetaxis_update_wait_for_health "$ROOT/app"
 `);
 assert.equal(result.status, 64, result.stderr);
 assert.match(result.stderr, /startup remains live/);
});

for (const mode of ["absent-tray", "failed-quit", "migration"]) test(mode + " cannot start rollback restoration", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 noetaxis_update_startup_state() { update_startup_state=${mode === "migration" ? "active" : "ambiguous"}; update_startup_detail=migrating; }
 noetaxis_none_running_of_kind() { return 1; }
 noetaxis_request_supervisor_shutdown() { return 1; }
 noetaxis_tray_quit() { echo forbidden-tray; return 99; }
 noetaxis_bounded() { echo forbidden-restore; return 99; }
 noetaxis_update_rollback_swap "$ROOT/app" 0
 `);
 assert.equal(result.status, 61, result.stderr);
 assert.doesNotMatch(result.stdout, /forbidden/);
 assert.match(result.stderr, /rollback-blocked/);
});

test("restore timeout never claims rollback completed or launches old app", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 noetaxis_update_startup_state() { update_startup_state=quiescent; update_startup_detail=stopped; }
 noetaxis_none_running_of_kind() { return 0; }
 noetaxis_wait_until() { return 0; }
 noetaxis_bounded() { echo 'restore timed out'; return 142; }
 result=0
 noetaxis_update_rollback_swap "$ROOT/app" 0 || result=$?
 printf 'result=%s completed=%s\\n' "$result" "$update_rolled_back"
 `);
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, /result=61 completed=0/);
 assert.match(readFileSync(path.join(root, "update-actions.log"), "utf8"), /restore_completed=0 exit=142/);
});

test("build schema metadata preserves 17-digit IDs exactly", (t) => {
 const root = fixture(t);
 const migrations = path.join(root, "backend/internal/storage/sqlite/migrations");
 mkdirSync(migrations, { recursive: true });
 for (const version of ["0234", "20261102160814608", "20261102160814609"]) writeFileSync(path.join(migrations, version + "_migration.sql"), "");
 assert.equal(parseDatabaseSchema(root), "20261102160814609");
});

test("health needs-attention cannot trigger the installer cleanup rollback fallback", (t) => {
 const root = fixture(t);
 const installer = readFileSync(path.join(scripts, "install.sh"), "utf8");
 const cleanup = installer.slice(installer.indexOf("noetaxis_install_cleanup() {"), installer.indexOf("\ntrap noetaxis_install_cleanup EXIT"));
 const result = shell(root, `
 ${cleanup}
 update_mode=1; update_fast=1; install_complete=1; old_moved=0; staged_app="$ROOT/staged"; target_app="$ROOT/app"; old_app_path="";
 noetaxis_update_join_session_jobs() { :; }
 noetaxis_update_auto_rollback() { echo forbidden-rollback; return 61; }
 noetaxis_update_exit_handler() { echo report:$1; }
 noetaxis_release_lock() { :; }
 noetaxis_test_pause() { :; }
 (exit 64) || noetaxis_install_cleanup
 `);
 assert.equal(result.status, 64, result.stderr);
 assert.match(result.stdout, /report:64/);
 assert.doesNotMatch(result.stdout, /forbidden/);
});

test("authenticated quit can complete rollback without a tray", (t) => {
 const root = fixture(t);
 const result = shell(root, `
 noetaxis_update_startup_state() { update_startup_state=quiescent; update_startup_detail=ready; }
 noetaxis_none_running_of_kind() { [[ "$2" == daemon ]]; }
 noetaxis_request_supervisor_shutdown() { echo authenticated-quit; return 0; }
 noetaxis_wait_until() { return 0; }
 noetaxis_bounded() { echo restore-completed; return 0; }
 noetaxis_tray_quit() { echo forbidden-tray; return 99; }
 noetaxis_update_rollback_swap "$ROOT/app" 0
 printf 'completed=%s\\n' "$update_rolled_back"
 `);
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, /completed=1/);
 assert.doesNotMatch(result.stdout, /forbidden/);
});

for (const phases of [["migrating", "waiting-for-lock"], ["waiting-for-lock", "migrating"], ["migrating", "ready"]]) {
 test(`multiple verified launches (${phases.join(", ")}) veto every stop and signal path`, (t) => {
  const root = fixture(t);
  record(root, { launchId: "first", pid: 123, phase: phases[0], heartbeatAt: 990 });
  record(root, { launchId: "second", pid: 456, phase: phases[1], heartbeatAt: 990 });
  writeFileSync(path.join(root, "clock"), "1000");
  writeFileSync(path.join(root, "signal-sink"), '#!/bin/sh\necho forbidden-signal >> "$ROOT/signals"\n', { mode: 0o755 });
  const result = shell(root, `
   update_fast=1; update_stop_timeout_given=1; update_stop_timeout=1; cap_dir="$ROOT"
   NOETAXIS_KILL="$ROOT/signal-sink"
   noetaxis_shipit_running() { return 1; }
   noetaxis_process_info() { printf '%s\\t0\\tstart\\tfixture' "$1"; }
   noetaxis_own_main_pid() { echo 123; }
   noetaxis_none_running_of_kind() { return 1; }
   noetaxis_tray_quit() { echo forbidden-tray; }
   noetaxis_bounded() { echo forbidden-stop; }
   noetaxis_wait_until() { return 1; }
   noetaxis_fast_bundle_snapshot() { printf '%s\\t%s\\n' "$ROOT/app/Contents/Resources/daemon/ao" "$(noetaxis_process_info 123)"; }
   noetaxis_update_startup_state "$ROOT/app"
   printf 'state=%s veto=%s\\n' "$update_startup_state" "$update_startup_veto"
   for action in noetaxis_fast_quit noetaxis_update_quit_app noetaxis_update_stop_daemon; do
    result=0; "$action" "$ROOT/app" || result=$?; printf '%s=%s\\n' "$action" "$result"
   done
   noetaxis_signal_own_pid "$ROOT/app" 123 test && exit 98
   for signal in TERM KILL; do
    noetaxis_fast_signal "$ROOT/app" "$signal" "$ROOT/app/Contents/Resources/daemon/ao" "$(noetaxis_process_info 123)" && exit 98
   done
   result=0; noetaxis_fast_stop_bundle "$ROOT/app" || result=$?
   [[ "$result" -eq 56 && ! -e "$ROOT/signals" ]]
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state=ambiguous veto=1/);
  for (const [action, status] of [["noetaxis_fast_quit", 54], ["noetaxis_update_quit_app", 54], ["noetaxis_update_stop_daemon", 55]]) {
   assert.match(result.stdout, new RegExp(`${action}=${status}`));
  }
  assert.doesNotMatch(result.stdout, /forbidden/);
 });
}

for (const [values, alive, expected] of [
 [{ heartbeatAt: 990, phase: "ready" }, true, "quiescent"],
 [{ heartbeatAt: 990, phase: "unknown" }, true, "ambiguous"],
 [{ heartbeatAt: 990, processStart: "previous-owner" }, true, "ambiguous"],
 [{ heartbeatAt: 990 }, false, "absent"],
]) test(`shutdown distinguishes ${expected} telemetry (${JSON.stringify(values)})`, (t) => {
 const root = fixture(t);
 record(root, values);
 writeFileSync(path.join(root, "clock"), "1000");
 const result = shell(root, `
  noetaxis_pid_may_be_alive() { return ${alive ? 0 : 1}; }
  result=0; noetaxis_update_startup_interlock "$ROOT/app" || result=$?
  printf 'state=%s result=%s\\n' "$update_startup_state" "$result"
 `);
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, new RegExp(`state=${expected} result=${expected === "ambiguous" ? 1 : 0}`));
});

test("a migration appearing during the exit wait vetoes ao stop", (t) => {
 const root = fixture(t);
 record(root, { heartbeatAt: 990 });
 writeFileSync(path.join(root, "clock"), "1000");
 const result = shell(root, `
  update_stop_timeout=1
  mv "$ROOT/startup/launch.json" "$ROOT/pending.json"
  noetaxis_none_running_of_kind() { return 1; }
  noetaxis_wait_until() { cp "$ROOT/pending.json" "$ROOT/startup/launch.json"; return 1; }
  noetaxis_update_verify_daemon() { return 0; }
  noetaxis_bounded() { echo forbidden-stop; return 99; }
  noetaxis_update_stop_daemon "$ROOT/app"
 `);
 assert.equal(result.status, 55, result.stderr);
 assert.doesNotMatch(result.stdout, /forbidden-stop/);
});

for (const fast of [0, 1]) for (const manual of [0, 1]) for (const owner of ["absent", "dead", "reused", "live", "unverifiable"]) {
 test(`${fast ? "fast" : "cautious"} ${manual ? "manual" : "tray"} legacy quit handles ${owner} supervisor metadata`, (t) => {
  const root = fixture(t);
  if (owner !== "absent") writeFileSync(path.join(root, "update-control.json"), JSON.stringify({
   pid: 123, processStart: owner === "reused" ? "previous-owner" : "Mon Oct 12 00:00:00 2026",
   executable: path.join(root, "app/Contents/Resources/daemon/ao"), socketPath: path.join(root, "old.sock"),
   token: "old-token", launchId: "old-launch",
  }));
  const blocked = ["live", "unverifiable"].includes(owner);
  const result = shell(root, `
   update_fast=${fast}; update_manual_quit=${manual}
   noetaxis_pid_may_be_alive() { return ${owner === "dead" ? 1 : 0}; }
   ${owner === "unverifiable" ? 'noetaxis_process_start() { :; }' : ""}
   noetaxis_own_main_pid() { echo 123; }
   noetaxis_own_pids_of_kind() { :; }
   noetaxis_none_running_of_kind() { return 1; }
   noetaxis_fast_main_gone() { return 1; }
   noetaxis_tray_quit() { echo legacy-tray >> "$ROOT/legacy"; }
   noetaxis_wait_until() { echo legacy-wait >> "$ROOT/legacy"; return 0; }
   noetaxis_update_quit_app "$ROOT/app"
  `);
  assert.equal(result.status, blocked ? 54 : 0, result.stderr);
  if (blocked) assert.equal(spawnSync("/bin/test", ["-e", path.join(root, "legacy")]).status, 1);
  else assert.equal(readFileSync(path.join(root, "legacy"), "utf8"), manual ? "legacy-wait\n" : "legacy-tray\nlegacy-wait\n");
 });
}
