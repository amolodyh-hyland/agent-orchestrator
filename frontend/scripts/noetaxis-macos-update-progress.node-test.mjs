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
 noetaxis_process_executable_is_in_bundle() { return 0; }
 noetaxis_process_executable_path() { printf '%s' "$ROOT/app/Contents/Resources/daemon/ao"; }
 ${body}
 `], { env: { ...process.env, ROOT: root, SCRIPTS: scripts }, encoding: "utf8" });
 assert.ifError(result.error);
 return result;
}
function record(root, values = {}) {
 writeFileSync(path.join(root, "startup/launch.json"), JSON.stringify({ launchId: "launch", pid: 123, processStart: "Mon Oct 12 00:00:00 2026", executable: path.join(root, "app/Contents/Resources/daemon/ao"), phase: "migrating", stage: "migration", migrationId: "20261102160814608", heartbeatAt: 0, ...values }));
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
