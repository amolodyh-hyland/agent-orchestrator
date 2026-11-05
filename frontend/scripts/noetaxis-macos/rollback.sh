#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
. "$script_dir/common.sh"

allow_ao_session=0
allow_background=0
restore_db=0
fast=0
backup_dir=""
original_args=("$@")

usage() {
	cat <<'EOF'
Usage: rollback.sh [--backup-dir <directory>] [--restore-db] [--allow-ao-session] [--allow-background-processes] [--fast]

Restore the app from the newest complete backup by default. Database files are
restored only when --restore-db is supplied.

The desktop app must be fully quit first ("Quit AO Completely" in the menu-bar
tray; Quit / Cmd+Q only close its window on macOS). The rollback refuses while the
bundled daemon or agent chat hosts run unless --allow-background-processes is
given; it never stops a process for you. --restore-db is refused while the
daemon runs, whatever the flag, because a running daemon holds the database.
--fast uses bundle-only process checks, as in the fast updater's automatic rollback;
it leaves external/unverified processes alone and never stops anything itself.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--fast)
			fast=1
			;;
		--backup-dir)
			[[ $# -ge 2 ]] || { noetaxis_error "--backup-dir requires a path."; exit 2; }
			backup_dir="$2"
			shift
			;;
		--restore-db)
			restore_db=1
			;;
		--allow-ao-session)
			allow_ao_session=1
			;;
		--allow-background-processes)
			allow_background=1
			;;
		-h|--help)
			usage
			exit 0
			;;
		--*)
			noetaxis_error "Unknown option: $1"
			usage >&2
			exit 2
			;;
		*)
			noetaxis_error "Unexpected argument: $1"
			usage >&2
			exit 2
			;;
	esac
	shift
done

apps_dir="$(noetaxis_apps_dir)"
target_app="$apps_dir/$NOETAXIS_APP_NAME"
user_home="$(noetaxis_user_home)"
noetaxis_require_human_user
lock_status=0
noetaxis_acquire_lock "$user_home" || lock_status=$?
if [[ "$lock_status" -ne 0 ]]; then
	exit "$lock_status"
fi
trap noetaxis_release_lock EXIT
ao_home="$(noetaxis_ao_home)"
backup_root="$user_home/ao-backups"
if [[ -z "$backup_dir" ]]; then
	for candidate in "$backup_root"/*; do
		if [[ -d "$candidate" && -f "$candidate/BACKUP_COMPLETE" ]]; then
			backup_dir="$candidate"
		fi
	done
fi
if [[ -z "$backup_dir" || ! -f "$backup_dir/BACKUP_COMPLETE" ]]; then
	noetaxis_error "No complete backup found. Supply --backup-dir with a directory containing BACKUP_COMPLETE."
	exit 40
fi

noetaxis_update_log_file="$backup_dir/update-actions.log"
rollback_finish() {
 local status=$?
 printf '%s ROLLBACK final_exit=%s installed_version=%s journal=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$status" "$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString || true)" "$backup_dir/rollback-journal.json" >> "$noetaxis_update_log_file"
 noetaxis_release_lock
}
trap rollback_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [[ "${NOETAXIS_ROLLBACK_BOUNDED:-0}" != 1 ]]; then
 rollback_status=0
 rollback_output="$(NOETAXIS_ROLLBACK_BOUNDED=1 NOETAXIS_LOCK_HELD_BY="${NOETAXIS_LOCK_HELD_BY:-$$}" noetaxis_bounded "${NOETAXIS_ROLLBACK_TIMEOUT:-300}" "$0" "${original_args[@]}" 2>&1)" || rollback_status=$?
 printf '%s\n' "$rollback_output"
 printf '%s\n' "$rollback_output" >> "$noetaxis_update_log_file"
 if [[ "$rollback_status" -ne 0 ]]; then noetaxis_error "rollback-blocked: exit $rollback_status; inspect rollback-journal.json before retrying; no older app launched"; fi
 exit "$rollback_status"
fi

noetaxis_check_safe_origin "$allow_ao_session"
if [[ "$fast" -eq 1 ]]; then
	noetaxis_assert_fast_idle "$target_app"
else
	noetaxis_assert_idle "$target_app" "$allow_background"
fi
# A live daemon holds ao.db and its -wal/-shm files open; replacing them underneath it
# can corrupt the database, so --allow-background-processes never covers --restore-db.
if [[ "$restore_db" -eq 1 ]] && noetaxis_daemon_running "$target_app"; then
	noetaxis_error "--restore-db cannot run while the AO daemon is running: it holds the database open and replacing its files can corrupt it. Stop the daemon yourself first (after checking you do not need its active sessions; stopping it interrupts them): \"$target_app/Contents/Resources/daemon/ao\" stop    then rerun. This command never stops it for you."
	exit 21
fi
# A daemon left by an earlier flagged install runs from a backup copy and is invisible to the
# process check above; if something listens on the daemon port, treat it as that daemon.
if [[ "$restore_db" -eq 1 ]] && [[ -n "$(noetaxis_port_listener_pids)" ]]; then
	noetaxis_error "--restore-db cannot run while something listens on port ${NOETAXIS_AO_PORT:-3001} (pid $(noetaxis_port_listener_pids)), the default AO daemon port: it may be an AO daemon from an earlier install (running from a backup copy) that holds the database open. Stop it yourself with the stop command of that install's ao CLI (full path), after checking you do not need its active sessions, or free the port, then rerun. This command never stops it for you."
	exit 21
fi

app_backup_name="$(/usr/bin/sed -n 's/^app_backup=//p' "$backup_dir/BACKUP_COMPLETE")"
expected_version="$(/usr/bin/sed -n 's/^app_version=//p' "$backup_dir/BACKUP_COMPLETE")"
if [[ -z "$app_backup_name" || -z "$expected_version" ]]; then
	noetaxis_error "Backup record is incomplete: $backup_dir/BACKUP_COMPLETE"
	exit 40
fi
app_backup="$backup_dir/$app_backup_name"
if [[ "$app_backup_name" == NONE ]]; then
	noetaxis_error "This backup contains no prior app bundle to restore."
	exit 41
fi


if [[ -d "$app_backup" ]]; then
 noetaxis_verify_signature "$app_backup" || { noetaxis_error "Backup app signature verification failed"; exit 42; }
fi
restore_status=0
restore_command=(/usr/bin/python3 -I -S)
if [[ "$(id -u)" -ne 0 && ! -w "$apps_dir" ]]; then
 restore_command=(sudo /usr/bin/python3 -I -S)
fi
restore_output="$(noetaxis_bounded "${NOETAXIS_ROLLBACK_TIMEOUT:-300}" "${restore_command[@]}" "$script_dir/rollback-restore.py" "$backup_dir" "$target_app" "$ao_home/data" "$restore_db" "${NOETAXIS_ROLLBACK_WORK_SECONDS:-280}" 2>&1)" || restore_status=$?
printf '%s\n' "$restore_output"
printf '%s\n' "$restore_output" >> "$noetaxis_update_log_file"
if [[ "$restore_status" -ne 0 ]]; then
 noetaxis_error "rollback-blocked: restore did not complete (exit $restore_status). Do not launch an older app. Inspect $backup_dir/rollback-journal.json; retry this same backup and --restore-db choice after resolving the error."
 exit 61
fi
printf 'Restored app version: %s\nRollback backup: %s\n' "$expected_version" "$backup_dir"
