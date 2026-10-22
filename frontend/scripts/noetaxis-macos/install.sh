#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/update-lib.sh"
. "$script_dir/survivors.sh"

dry_run=0
allow_ao_session=0
allow_background=0
source_app=""
update_mode=0
update_fast=0
update_yes=0
update_end_sessions=0
update_force=0
update_kill_survivors=0
update_survivors_confirmed=0
update_restore_sessions=0
update_restart_multica_daemon=0
update_restart_multica_stack=0
update_rollback_restore_db=0
update_manual_quit=0
update_detached=0
update_quit_timeout=60
update_stop_timeout=45
update_health_timeout=120
update_quit_timeout_given=0
update_stop_timeout_given=0
update_health_timeout_given=0
update_flag_given=""
update_capture_dir=""
update_record_extra=""
update_noop=0
noetaxis_update_new_version=""
original_args=("$@")

usage() {
	cat <<'EOF'
Usage: install.sh [--dry-run] [--allow-ao-session] [--allow-background-processes] <Agent Orchestrator.app>
       install.sh --update [update options] [<Agent Orchestrator.app>]
       update.sh [update options] [<Agent Orchestrator.app>]

Install a verified build into APPS_DIR (default /Applications) and back up the
current app and selected AO state under ~/ao-backups/<stamp>.

Default mode (safe, never stops anything): the desktop app must be fully quit first.
On macOS Quit / Cmd+Q only close its window, so use "Quit AO Completely" in the
menu-bar tray. The install also refuses while the bundled daemon or agent chat hosts
are still running. --allow-background-processes lets it proceed past those (never
past the desktop app or ShipIt); stop the old daemon with
"<app>/Contents/Resources/daemon/ao stop" before opening the new app.

--update (opt-in, one command): capture state, print a PLAN and ask, stop AO in the
safest supported order, back up, install, restart, verify, and roll back
automatically if the new app is not healthy. The app argument defaults to
../Applications/Agent Orchestrator.app next to this script. Update options:
  --fast                     RECOMMENDED for routine updates: quit, back up, swap and
                             relaunch; AO restores sessions on launch. No per-session
                             exits or ancestry scan. Only verified bundle survivors
                             may receive TERM then KILL after quitting.
  --yes                      do not ask for confirmation (required with --detached)
  --end-sessions             stop the agents of live sessions with "ao session exit-agent"
                             (keeps each session, worktree and conversation; "ao session
                             kill" is never used; AO's own agent teardown may still
                             force-kill the agent's process group). Without it live sessions make the run
                             refuse before anything is stopped
  --restore-sessions         afterwards try "ao session restore" once per session that was
                             live (resumes the exited agents)
  --force                    SIGTERM (never SIGKILL) processes of THIS bundle, only those in the confirmed plan, that
                             survive the waits; each one is logged
  --kill-survivors           after quitting AO, list verified bundle descendants and anchored
                             ~/.ao/ orphans; require a separate typed PID confirmation, then
                             TERM, bounded wait, identity recheck, KILL. --yes does not confirm it.
                             Deleted/unverified executables and test fixtures are never included.
  --manual-quit              do not script the tray item; wait for you to click
                             "Quit AO Completely"
  --restart-multica-daemon   restart a standalone multica CLI daemon that was running
  --restart-multica-stack    restart the running local Multica Docker containers
  --rollback-restore-db      on a failed update also restore the database if the
                             schema was migrated and the old app stays unhealthy
  --detached                 re-run in a new session with nohup and a log file (use
                             from inside an AO session; that session ends)
  --quit-timeout N | --stop-timeout N | --health-timeout N   waits in seconds
                             (cautious defaults 60 / 45 / 120; fast 120 / 10 / 60;
                             fast bundle/agent waits capped at 60 / 10)
  --dry-run                  verify, capture and print the plan; change nothing
Update exit codes: 0 ok; 20 inside an AO session (use --detached); 21 other
processes block; 22 ShipIt; 50 cancelled; 51 live sessions; 52 session list
unavailable; 53 a session could not be ended; 54 app did not quit; 55 daemon did
not stop; 56 chat hosts/helpers remain; 57 the daemon on ~/.ao is not this
bundle's; 60 rolled back and healthy; 61 rollback
needs you; 62 healthy but post-install checks warn; 63 healthy but a session did
not come back. Other codes as in the default mode.
EOF
}

noetaxis_require_number() {
	if [[ ! "${2:-}" =~ ^[0-9]+$ || "$2" -lt 1 ]]; then
		noetaxis_error "$1 requires a whole number of seconds (1 or more)."
		exit 2
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)
			dry_run=1
			;;
		--allow-ao-session)
			allow_ao_session=1
			;;
		--allow-background-processes)
			allow_background=1
			;;
		--update)
			update_mode=1
			;;
		--fast|--yes|--end-sessions|--restore-sessions|--force|--kill-survivors|--manual-quit|--restart-multica-daemon|--restart-multica-stack|--rollback-restore-db|--detached)
			case "$1" in
				--fast) update_fast=1 ;;
				--yes) update_yes=1 ;;
				--end-sessions) update_end_sessions=1 ;;
				--restore-sessions) update_restore_sessions=1 ;;
				--force) update_force=1 ;;
				--kill-survivors) update_kill_survivors=1 ;;
				--manual-quit) update_manual_quit=1 ;;
				--restart-multica-daemon) update_restart_multica_daemon=1 ;;
				--restart-multica-stack) update_restart_multica_stack=1 ;;
				--rollback-restore-db) update_rollback_restore_db=1 ;;
				--detached) update_detached=1 ;;
			esac
			update_flag_given="$update_flag_given $1"
			;;
		--quit-timeout|--stop-timeout|--health-timeout)
			noetaxis_require_number "$1" "${2:-}"
			case "$1" in
				--quit-timeout) update_quit_timeout="$2"; update_quit_timeout_given=1 ;;
				--stop-timeout) update_stop_timeout="$2"; update_stop_timeout_given=1 ;;
				--health-timeout) update_health_timeout="$2"; update_health_timeout_given=1 ;;
			esac
			update_flag_given="$update_flag_given $1"
			shift
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
			if [[ -n "$source_app" ]]; then
				noetaxis_error "Only one app bundle may be supplied."
				exit 2
			fi
			source_app="$1"
			;;
	esac
	shift
done

if [[ "$update_mode" -eq 0 && -n "$update_flag_given" ]]; then
	noetaxis_error "Options${update_flag_given} only apply with --update."
	exit 2
fi
if [[ "$update_mode" -eq 1 ]]; then
	if [[ "$update_fast" -eq 1 ]]; then
		if [[ "$update_end_sessions" -eq 1 || "$update_force" -eq 1 || "$update_kill_survivors" -eq 1 || "$update_restart_multica_daemon" -eq 1 || "$update_restart_multica_stack" -eq 1 ]]; then
			noetaxis_error '--fast cannot be combined with --end-sessions, --force, --kill-survivors or --restart-multica-*; use the cautious update for those options.'
			exit 2
		fi
		[[ "$update_quit_timeout_given" -eq 1 ]] || update_quit_timeout=120
		[[ "$update_stop_timeout_given" -eq 1 ]] || update_stop_timeout=10
		[[ "$update_health_timeout_given" -eq 1 ]] || update_health_timeout=60
	fi
	if [[ "$update_kill_survivors" -eq 1 && "$update_detached" -eq 1 ]]; then
		noetaxis_error '--kill-survivors requires an interactive typed PID confirmation; it cannot be combined with --detached.'
		exit 2
	fi
	if [[ "$allow_background" -eq 1 ]]; then
		noetaxis_error "--update stops the background processes itself; --allow-background-processes does not apply."
		exit 2
	fi
	if [[ "$allow_ao_session" -eq 1 && "$dry_run" -eq 0 ]]; then
		noetaxis_error "--update cannot run inside an AO session with --allow-ao-session: the session would end mid-install. Use --detached."
		exit 2
	fi
	if [[ "$update_detached" -eq 1 && "$update_yes" -eq 0 && "$dry_run" -eq 0 ]]; then
		noetaxis_error "--detached has no terminal to ask on; add --yes."
		exit 2
	fi
	if [[ -z "$source_app" ]]; then
		source_app="$script_dir/../Applications/$NOETAXIS_APP_NAME"
		[[ -d "$source_app" ]] || { noetaxis_error "No app bundle given and none found at $source_app."; usage >&2; exit 2; }
	fi
fi
if [[ -z "$source_app" ]]; then
	usage >&2
	exit 2
fi

source_app="$(cd "$(/usr/bin/dirname "$source_app")" && pwd)/$(/usr/bin/basename "$source_app")"
artifact_dir="$(/usr/bin/dirname "$(/usr/bin/dirname "$source_app")")"
manifest="$artifact_dir/MANIFEST.sha256"
apps_dir="$(noetaxis_apps_dir)"
target_app="$apps_dir/$NOETAXIS_APP_NAME"
user_home="$(noetaxis_user_home)"
ao_home="$(noetaxis_ao_home)"

if [[ "$update_mode" -eq 1 ]]; then
	if [[ "$update_detached" -eq 1 && -z "${NOETAXIS_DETACHED_CHILD:-}" ]]; then
		child_args=()
		for argument in ${original_args[@]+"${original_args[@]}"}; do
			[[ "$argument" == --detached ]] || child_args+=("$argument")
		done
		noetaxis_update_detach "$script_dir/install.sh" "$user_home/ao-backups/update-$(date '+%Y%m%d-%H%M%S')-$$.log" ${child_args[@]+"${child_args[@]}"}
		exit 0
	fi
	trap 'noetaxis_update_exit_handler $?' EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	trap 'exit 129' HUP
	# The detached child was started by the parent that already accepted this; the marker is internal.
	if [[ -z "${NOETAXIS_DETACHED_CHILD:-}" ]]; then
		guard_override=0
		if [[ "$dry_run" -eq 1 && "$allow_ao_session" -eq 1 ]]; then
			guard_override=1
		fi
		if ! noetaxis_update_origin_ok "$guard_override"; then
			noetaxis_error "This update was started inside Agent Orchestrator (${noetaxis_update_origin_detail}). It would stop AO and end this session mid-install. Run it from your own Terminal, or add --detached (with --yes) to re-run it in a new session with a log file; the AO session that starts it will end."
			exit 20
		fi
	fi
else
	noetaxis_check_safe_origin "$allow_ao_session"
	noetaxis_assert_idle "$target_app" "$allow_background"
fi
if [[ "$update_fast" -eq 1 ]]; then
	noetaxis_fast_verify_checksums "$artifact_dir"
	noetaxis_verify_signature "$source_app"
fi
noetaxis_verify_manifest "$source_app" "$manifest"
noetaxis_verify_build_metadata "$source_app"
[[ -d "$apps_dir" ]] || { noetaxis_error "Applications directory does not exist: $apps_dir"; exit 29; }
[[ -n "$user_home" && -d "$user_home" ]] || { noetaxis_error "Could not resolve the human user's home directory."; exit 29; }
noetaxis_require_human_user
if [[ -d "$target_app" ]] && noetaxis_verify_manifest "$target_app" "$manifest" >/dev/null 2>&1 && noetaxis_verify_build_metadata "$target_app" >/dev/null 2>&1; then
	printf 'Already installed: %s\n' "$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
	if [[ "$update_mode" -eq 1 ]]; then
		printf 'Nothing was stopped, backed up or changed. If AO is not running, open it with: open -a "%s"\n' "$target_app"
		update_noop=1
	fi
	noetaxis_report_handler "$target_app"
	noetaxis_print_post_install_checks "$target_app" "$ao_home"
	exit 0
fi

noetaxis_check_space "$source_app" "$ao_home" "$user_home" "$apps_dir"

# A dry run changes nothing, so it does not take the lock.
if [[ "$dry_run" -eq 0 ]]; then
	lock_status=0
	noetaxis_acquire_lock "$user_home" || lock_status=$?
	if [[ "$lock_status" -ne 0 ]]; then
		exit "$lock_status"
	fi
	export NOETAXIS_LOCK_HELD_BY="$$"
	if [[ "$update_mode" -eq 0 ]]; then
		trap noetaxis_release_lock EXIT
	fi
fi

if [[ "$update_mode" -eq 1 ]]; then
	# Everything up to the confirmation only reads: nothing has been stopped yet.
	noetaxis_update_new_version="$(noetaxis_plist_value "$source_app/Contents/Info.plist" CFBundleShortVersionString)"
	if [[ "$update_fast" -eq 0 ]]; then noetaxis_verify_signature "$source_app"; fi
	if [[ "$update_fast" -eq 1 ]]; then
		update_capture_dir="$(/usr/bin/mktemp -d "$user_home/.noetaxis-update.XXXXXX")"
	else
		update_capture_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/noetaxis-update.XXXXXX")"
	fi
	noetaxis_update_log_file="$update_capture_dir/update-actions.log"
	if [[ "$update_fast" -eq 1 ]]; then
		noetaxis_fast_capture "$target_app" "$update_capture_dir"
		noetaxis_fast_print_plan "$target_app"
	else
		noetaxis_update_step "Capturing the current state (read only)"
		noetaxis_update_capture_state "$target_app" "$update_capture_dir"
		noetaxis_update_print_plan "$target_app" "$noetaxis_update_new_version" "$user_home/ao-backups"
		refusal_status=0
		noetaxis_update_preflight_refusals "$target_app" || refusal_status=$?
		if [[ "$refusal_status" -ne 0 ]]; then
			exit "$refusal_status"
		fi
	fi
	if [[ "$dry_run" -eq 1 ]]; then
		printf 'Dry run passed. Nothing was stopped, backed up or installed; rerun without --dry-run to update.\n'
		update_dry_run=1
		exit 0
	fi
	confirm_status=0
	noetaxis_update_confirm || confirm_status=$?
	if [[ "$confirm_status" -ne 0 ]]; then
		exit "$confirm_status"
	fi
	privilege_status=0
	noetaxis_update_prepare_privilege || privilege_status=$?
	if [[ "$privilege_status" -ne 0 ]]; then
		exit "$privilege_status"
	fi
fi

stamp="$(date '+%Y%m%d-%H%M%S')-$$"
staged_app="$apps_dir/.Agent-Orchestrator-installing-$stamp.app"
if [[ -e "$staged_app" ]]; then
	noetaxis_error "Install staging path already exists: $staged_app"
	exit 30
fi

if [[ "$dry_run" -eq 1 && "$update_mode" -eq 0 ]]; then
	printf 'Dry run passed. Would stage %s into %s, back up AO state under %s/ao-backups, rename the current app to .app.bak, then install the new app.\n' "$source_app" "$apps_dir" "$user_home"
	exit 0
fi

# Until the new app is in place, an interruption (INT/TERM/HUP, or any failing
# command) removes the staged copy and puts the previous app back if it was moved.
# The backup record is marked aborted so rollback never mistakes this backup for a
# completed install (its app was put back in place and the earlier backup stays the
# newest real one). State copies in the directory are kept.
install_complete=0
old_app_path=""
old_moved=0
backup_dir=""
noetaxis_install_cleanup() {
	local exit_status=$?
	if [[ "$update_mode" -eq 1 ]]; then noetaxis_update_join_session_jobs; fi
	# Complete once the new app is in place, even if the signal landed before the flag was set.
	if [[ "$old_moved" -eq 1 && ! -e "$staged_app" && -d "$target_app" ]]; then
		install_complete=1
	fi
	if [[ "$install_complete" -eq 0 ]]; then
		noetaxis_run_privileged /bin/rm -rf "$staged_app" || true
		noetaxis_restore_previous_app "$target_app" "$old_app_path"
		if [[ -n "$backup_dir" && -f "$backup_dir/BACKUP_COMPLETE" ]]; then
			/bin/mv "$backup_dir/BACKUP_COMPLETE" "$backup_dir/BACKUP_ABORTED" || true
		fi
	fi
	if [[ "$update_mode" -eq 1 ]]; then
		if [[ "$update_fast" -eq 1 && "$install_complete" -eq 1 && "$update_rolled_back" -eq 0 && "$exit_status" -ne 0 && "$exit_status" -ne 62 && "$exit_status" -ne 63 ]]; then
			rollback_status=0
			noetaxis_update_auto_rollback "update failed with exit $exit_status" "$target_app" || rollback_status=$?
			exit_status="$rollback_status"
		fi
		# The update stopped AO and then failed before the new app was in place: the previous app is
		# back on disk (above), so reopen it instead of leaving AO closed.
		if [[ "$install_complete" -eq 0 && "$exit_status" -ne 0 ]]; then
			noetaxis_update_reopen_previous "$target_app"
		fi
		noetaxis_update_exit_handler "$exit_status"
	else
		noetaxis_test_pause cleanup-end
	fi
	# Released last, after the staged copy and the previous app have been dealt with.
	noetaxis_release_lock
	if [[ "$update_fast" -eq 1 ]]; then exit "$exit_status"; fi
}
trap noetaxis_install_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

noetaxis_remove_stale_staging "$apps_dir"
noetaxis_run_privileged /usr/bin/ditto "$source_app" "$staged_app"
if ! noetaxis_verify_manifest "$staged_app" "$manifest" || ! noetaxis_verify_signature "$staged_app"; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	exit 31
fi
noetaxis_test_pause after-staged

if [[ "$update_mode" -eq 1 ]]; then
	# The new build is staged and verified; now stop AO. The backup directory exists from here
	# on so the captured state is kept even if a stop step fails.
	backup_dir="$(noetaxis_new_backup_dir "$user_home")"
	/bin/mkdir -p "$backup_dir/state-before"
	/bin/cp -R "$update_capture_dir/." "$backup_dir/state-before/" 2>/dev/null || true
	stop_status=0
	if [[ "$update_fast" -eq 1 ]]; then
		noetaxis_fast_stop_all "$target_app" || stop_status=$?
	else
		noetaxis_update_stop_all "$target_app" || stop_status=$?
	fi
	if [[ "$stop_status" -ne 0 ]]; then
		noetaxis_run_privileged /bin/rm -rf "$staged_app"
		exit "$stop_status"
	fi
	update_record_extra="update_mode=1
schema_before=$cap_schema_before"
fi

idle_status=0
if [[ "$update_fast" -eq 1 ]]; then
	noetaxis_assert_fast_idle "$target_app" || idle_status=$?
else
	noetaxis_assert_idle "$target_app" "$allow_background" || idle_status=$?
fi
if [[ "$idle_status" -ne 0 ]]; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	exit "$idle_status"
fi

if [[ -z "$backup_dir" ]]; then
	backup_dir="$(noetaxis_new_backup_dir "$user_home")"
fi
if ! noetaxis_copy_state_backup "$ao_home" "$backup_dir"; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	noetaxis_error "State backup did not complete. The installed app was left in place. Partial backup: $backup_dir"
	exit 32
fi

old_app_backup="NONE"
old_version="NONE"
if [[ -d "$target_app" ]]; then
	old_version="$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || printf 'unknown')"
	old_app_backup="$(noetaxis_old_app_backup_name "$target_app")"
fi
# The record is written before the old app moves so an interruption after the move
# still leaves a complete backup that rollback.sh can restore from.
if ! noetaxis_write_backup_record "$backup_dir" "$old_app_backup" "$old_version" "$allow_background" "$update_record_extra"; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	noetaxis_error "Could not write the backup record. The installed app was left in place; backup data remains at $backup_dir"
	exit 35
fi
noetaxis_test_pause after-record
if [[ "$update_mode" -eq 1 && "$update_fast" -eq 0 ]]; then
	noetaxis_survivor_scan "$target_app" "$cap_dir/survivors-final.tsv" || exit 56
	if [[ -s "$cap_dir/survivors-final.tsv" ]]; then
		noetaxis_survivor_report "$cap_dir/survivors-final.tsv"
		noetaxis_error 'Final survivor scan is not empty. The app was not swapped; no newly appeared PID is adopted or signalled.'
		exit 56
	fi
fi
if [[ "$update_fast" -eq 1 ]]; then noetaxis_assert_fast_idle "$target_app"; fi
old_app_path="$backup_dir/$old_app_backup"
if [[ "$old_app_backup" != NONE ]] && ! noetaxis_run_privileged /bin/mv "$target_app" "$backup_dir/$old_app_backup"; then
	/bin/rm -f "$backup_dir/BACKUP_COMPLETE"
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	noetaxis_error "The old app could not be backed up. It remains in place; partial backup: $backup_dir"
	exit 33
fi
old_moved=1
noetaxis_test_pause after-old-moved

if ! noetaxis_run_privileged /bin/mv "$staged_app" "$target_app"; then
	if [[ "$old_app_backup" != NONE && -d "$backup_dir/$old_app_backup" && ! -e "$target_app" ]]; then
		noetaxis_run_privileged /bin/mv "$backup_dir/$old_app_backup" "$target_app" || true
	fi
	noetaxis_error "The new app could not be placed in $apps_dir. Backup retained at $backup_dir"
	exit 34
fi
noetaxis_test_pause after-swap
install_complete=1
noetaxis_test_pause after-installed

noetaxis_clear_quarantine "$target_app"
noetaxis_verify_manifest "$target_app" "$manifest"
noetaxis_verify_signature "$target_app"
noetaxis_verify_build_metadata "$target_app"
noetaxis_report_handler "$target_app"
printf 'Backup: %s\n' "$backup_dir"
if [[ "$update_mode" -eq 1 ]]; then
	finish_status=0
	noetaxis_update_finish "$target_app" "$noetaxis_update_new_version" || finish_status=$?
	exit "$finish_status"
fi
noetaxis_print_post_install_checks "$target_app" "$ao_home"
