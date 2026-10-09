#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
. "$script_dir/common.sh"

allow_ao_session=0
restore_db=0
backup_dir=""

usage() {
	cat <<'EOF'
Usage: rollback.sh [--backup-dir <directory>] [--restore-db] [--allow-ao-session]

Restore the app from the newest complete backup by default. Database files are
restored only when --restore-db is supplied.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
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

noetaxis_check_safe_origin "$allow_ao_session"
noetaxis_assert_idle "$target_app"

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
	backup_bundle_id="$(noetaxis_plist_value "$app_backup/Contents/Info.plist" CFBundleIdentifier)"
	backup_version="$(noetaxis_plist_value "$app_backup/Contents/Info.plist" CFBundleShortVersionString)"
	if [[ "$backup_bundle_id" != "$NOETAXIS_BUNDLE_ID" || "$backup_version" != "$expected_version" ]]; then
		noetaxis_error "Backup app metadata does not match its record: bundle=$backup_bundle_id version=$backup_version expected=$expected_version."
		exit 42
	fi
	current_backup_name="$(noetaxis_old_app_backup_name "$target_app")"
	if [[ -d "$target_app" ]]; then
		noetaxis_run_privileged /bin/mv "$target_app" "$backup_dir/$current_backup_name"
	fi
	if ! noetaxis_run_privileged /bin/mv "$app_backup" "$target_app"; then
		if [[ -d "$backup_dir/$current_backup_name" && ! -e "$target_app" ]]; then
			noetaxis_run_privileged /bin/mv "$backup_dir/$current_backup_name" "$target_app" || true
		fi
		noetaxis_error "Could not restore the app. Backups remain in $backup_dir"
		exit 43
	fi
else
	current_version=""
	if [[ -f "$target_app/Contents/Info.plist" ]]; then
		current_version="$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
	fi
	if [[ "$current_version" != "$expected_version" ]]; then
		noetaxis_error "Backup app is missing and the installed version is not already restored."
		exit 44
	fi
	printf 'App already restored: %s\n' "$current_version"
fi

if [[ "$restore_db" -eq 1 ]]; then
	database_backup="$backup_dir/data"
	database_dir="$ao_home/data"
	current_database_backup="$backup_dir/rollback-current-data-$(date '+%Y%m%d-%H%M%S')-$$"
	[[ -f "$database_backup/ao.db" ]] || { noetaxis_error "Database backup is missing: $database_backup/ao.db"; exit 45; }
	/bin/mkdir -p "$current_database_backup" "$database_dir"
	for name in ao.db ao.db-wal ao.db-shm; do
		if [[ -f "$database_dir/$name" ]]; then
			/bin/cp -c -p "$database_dir/$name" "$current_database_backup/$name"
			/usr/bin/cmp -s "$database_dir/$name" "$current_database_backup/$name" || { noetaxis_error "Could not verify current database backup for $name."; exit 46; }
		fi
	done
	: > "$current_database_backup/BACKUP_COMPLETE"
	staging="$database_dir/.ao-rollback-$$"
	/bin/mkdir -p "$staging"
	for name in ao.db ao.db-wal ao.db-shm; do
		if [[ -f "$database_backup/$name" ]]; then
			/bin/cp -c -p "$database_backup/$name" "$staging/$name"
		fi
	done
	for name in ao.db ao.db-wal ao.db-shm; do
		if [[ -f "$staging/$name" ]]; then
			/bin/mv "$staging/$name" "$database_dir/$name"
		else
			/bin/rm -f "$database_dir/$name"
		fi
	done
	/bin/rm -rf "$staging"
	printf 'Database files restored from %s/data; current database backup: %s\n' "$backup_dir" "$current_database_backup"
fi

noetaxis_verify_restored="$(noetaxis_plist_value "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
if [[ "$noetaxis_verify_restored" != "$expected_version" ]]; then
	noetaxis_error "Restored app version mismatch: expected $expected_version, found $noetaxis_verify_restored."
	exit 47
fi
printf 'Restored app version: %s\n' "$noetaxis_verify_restored"
noetaxis_report_handler "$target_app"
printf 'Rollback backup: %s\n' "$backup_dir"
