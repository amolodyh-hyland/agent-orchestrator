#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
. "$script_dir/common.sh"

dry_run=0
allow_ao_session=0
source_app=""

usage() {
	cat <<'EOF'
Usage: install.sh [--dry-run] [--allow-ao-session] <Agent Orchestrator.app>

Install a verified build into APPS_DIR (default /Applications) and back up the
current app and selected AO state under ~/ao-backups/<stamp>.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)
			dry_run=1
			;;
		--allow-ao-session)
			allow_ao_session=1
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

noetaxis_check_safe_origin "$allow_ao_session"
noetaxis_assert_idle "$target_app"
noetaxis_verify_manifest "$source_app" "$manifest"
noetaxis_verify_build_metadata "$source_app"
[[ -d "$apps_dir" ]] || { noetaxis_error "Applications directory does not exist: $apps_dir"; exit 29; }
[[ -n "$user_home" && -d "$user_home" ]] || { noetaxis_error "Could not resolve the human user's home directory."; exit 29; }
noetaxis_require_human_user
if [[ -d "$target_app" ]] && noetaxis_verify_manifest "$target_app" "$manifest" >/dev/null 2>&1 && noetaxis_verify_build_metadata "$target_app" >/dev/null 2>&1; then
	printf 'Already installed: %s\n' "$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
	noetaxis_report_handler "$target_app"
	noetaxis_print_post_install_checks "$target_app" "$ao_home"
	exit 0
fi

noetaxis_check_space "$source_app" "$ao_home" "$user_home" "$apps_dir"

stamp="$(date '+%Y%m%d-%H%M%S')-$$"
staged_app="$apps_dir/.Agent-Orchestrator-installing-$stamp.app"
if [[ -e "$staged_app" ]]; then
	noetaxis_error "Install staging path already exists: $staged_app"
	exit 30
fi

if [[ "$dry_run" -eq 1 ]]; then
	printf 'Dry run passed. Would stage %s into %s, back up AO state under %s/ao-backups, rename the current app to .app.bak, then install the new app.\n' "$source_app" "$apps_dir" "$user_home"
	exit 0
fi

# Until the new app is in place, an interruption (INT/TERM/HUP, or any failing
# command) removes the staged copy and puts the previous app back if it was moved.
install_complete=0
old_app_path=""
noetaxis_install_cleanup() {
	if [[ "$install_complete" -eq 0 ]]; then
		noetaxis_run_privileged /bin/rm -rf "$staged_app" || true
		noetaxis_restore_previous_app "$target_app" "$old_app_path"
	fi
}
trap noetaxis_install_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

noetaxis_run_privileged /usr/bin/ditto "$source_app" "$staged_app"
if ! noetaxis_verify_manifest "$staged_app" "$manifest" || ! noetaxis_verify_signature "$staged_app"; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	exit 31
fi

idle_status=0
noetaxis_assert_idle "$target_app" || idle_status=$?
if [[ "$idle_status" -ne 0 ]]; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	exit "$idle_status"
fi

backup_dir="$(noetaxis_new_backup_dir "$user_home")"
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
if ! noetaxis_write_backup_record "$backup_dir" "$old_app_backup" "$old_version"; then
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	noetaxis_error "Could not write the backup record. The installed app was left in place; backup data remains at $backup_dir"
	exit 35
fi
old_app_path="$backup_dir/$old_app_backup"
if [[ "$old_app_backup" != NONE ]] && ! noetaxis_run_privileged /bin/mv "$target_app" "$backup_dir/$old_app_backup"; then
	/bin/rm -f "$backup_dir/BACKUP_COMPLETE"
	noetaxis_run_privileged /bin/rm -rf "$staged_app"
	noetaxis_error "The old app could not be backed up. It remains in place; partial backup: $backup_dir"
	exit 33
fi

if ! noetaxis_run_privileged /bin/mv "$staged_app" "$target_app"; then
	if [[ "$old_app_backup" != NONE && -d "$backup_dir/$old_app_backup" && ! -e "$target_app" ]]; then
		noetaxis_run_privileged /bin/mv "$backup_dir/$old_app_backup" "$target_app" || true
		noetaxis_write_backup_record "$backup_dir" "NONE" "NONE" || true
	fi
	noetaxis_error "The new app could not be placed in $apps_dir. Backup retained at $backup_dir"
	exit 34
fi
install_complete=1

noetaxis_clear_quarantine "$target_app"
noetaxis_verify_manifest "$target_app" "$manifest"
noetaxis_verify_signature "$target_app"
noetaxis_verify_build_metadata "$target_app"
noetaxis_report_handler "$target_app"
printf 'Backup: %s\n' "$backup_dir"
noetaxis_print_post_install_checks "$target_app" "$ao_home"
