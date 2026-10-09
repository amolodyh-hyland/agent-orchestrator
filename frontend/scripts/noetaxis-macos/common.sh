#!/bin/bash
set -euo pipefail

NOETAXIS_APP_NAME="Agent Orchestrator.app"
NOETAXIS_BUNDLE_ID="dev.agent-orchestrator.desktop"
NOETAXIS_LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

noetaxis_error() {
	printf 'Error: %s\n' "$1" >&2
}

noetaxis_user_name() {
	local name="${SUDO_USER:-}"
	if [[ -z "$name" && "$(id -u)" -eq 0 ]]; then
		name="$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true)"
	fi
	if [[ -z "$name" || "$name" == root || "$name" == loginwindow ]]; then
		name="${USER:-}"
	fi
	printf '%s' "$name"
}

noetaxis_user_home() {
	local name home
	name="$(noetaxis_user_name)"
	if [[ -n "$name" && "$(id -u)" -eq 0 ]]; then
		home="$(/usr/bin/dscl . -read "/Users/$name" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}' || true)"
		if [[ -n "$home" ]]; then
			printf '%s' "$home"
			return
		fi
	fi
	printf '%s' "${HOME:-}"
}

# Running as root with no resolvable console user would resolve to /var/root and
# back up nothing of the real user's ~/.ao while still replacing the app.
noetaxis_require_human_user() {
	local name
	name="$(noetaxis_user_name)"
	if [[ "$(id -u)" -eq 0 && ( -z "$name" || "$name" == root ) ]]; then
		noetaxis_error "Running as root without a console user; refusing to install without backing up the human user's ~/.ao. Run it as the signed-in user."
		exit 29
	fi
}

noetaxis_ao_home() {
	if [[ -n "${AO_HOME:-}" ]]; then
		printf '%s' "$AO_HOME"
	else
		printf '%s/.ao' "$(noetaxis_user_home)"
	fi
}

noetaxis_apps_dir() {
	printf '%s' "${APPS_DIR:-/Applications}"
}

noetaxis_handler_plist() {
	if [[ -n "${LS_SERVICES_PLIST:-}" ]]; then
		printf '%s' "$LS_SERVICES_PLIST"
	else
		printf '%s/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist' "$(noetaxis_user_home)"
	fi
}

noetaxis_check_safe_origin() {
	local allow_override="$1" pid parent command_line
	if [[ "$allow_override" == 1 ]]; then
		return 0
	fi
	if /usr/bin/env | /usr/bin/awk -F= '$1 ~ /^AO_/ { found=1 } END { exit !found }'; then
		noetaxis_error "This command inherited Agent Orchestrator environment. Start it from your own Terminal or Finder after closing AO, or pass --allow-ao-session if ending its sessions is intentional."
		return 20
	fi
	if ! command -v ps >/dev/null 2>&1; then
		noetaxis_error "Cannot inspect process ancestry; run this command from your own Terminal or Finder."
		return 20
	fi
	pid="$$"
	# No ordering assumption between pid and ppid (pids wrap); stop at launchd, an
	# unreadable parent, a self-parent, or a depth cap so a cycle cannot loop forever.
	local depth=0 visited=" "
	while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 64 && "$visited" != *" $pid "* ]]; do
		visited="$visited$pid "
		command_line="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
		case "$command_line" in
			*"Agent Orchestrator.app/Contents/"*|*"/Contents/Resources/daemon/ao daemon"*)
				noetaxis_error "This command is running inside Agent Orchestrator. Close AO from its own window or menu, then run this command from your own Terminal or Finder. Quitting AO ends its sessions."
				return 20
				;;
		esac
		parent="$(ps -o ppid= -p "$pid" 2>/dev/null | /usr/bin/tr -d '[:space:]' || true)"
		if [[ ! "$parent" =~ ^[0-9]+$ ]]; then
			break
		fi
		pid="$parent"
		depth=$((depth + 1))
	done
}

noetaxis_app_process_running() {
	local app_path="$1"
	if pgrep -f "$app_path/Contents/" >/dev/null 2>&1; then
		return 0
	fi
	return 1
}

noetaxis_shipit_running() {
	if pgrep -fl ShipIt >/dev/null 2>&1; then
		return 0
	fi
	return 1
}

noetaxis_assert_idle() {
	local app_path="$1"
	if noetaxis_app_process_running "$app_path"; then
		noetaxis_error "Agent Orchestrator or its bundled daemon is still running from $app_path. Quit the app yourself and verify its processes have exited before installing."
		return 21
	fi
	if noetaxis_shipit_running; then
		noetaxis_error "ShipIt is running. Wait for the updater to finish, then rerun this command."
		return 22
	fi
}

noetaxis_plist_value() {
	/usr/bin/plutil -extract "$2" raw -o - "$1"
}

noetaxis_verify_build_metadata() {
	local app_path="$1" plist bundle_id version build_version revision short_revision
	plist="$app_path/Contents/Info.plist"
	[[ -f "$plist" ]] || { noetaxis_error "Missing app Info.plist: $plist"; return 23; }
	bundle_id="$(noetaxis_plist_value "$plist" CFBundleIdentifier)"
	version="$(noetaxis_plist_value "$plist" CFBundleShortVersionString)"
	build_version="$(noetaxis_plist_value "$plist" CFBundleVersion)"
	revision="$(noetaxis_plist_value "$plist" NoetaxisSourceRevision)"
	short_revision="${version##*.}"
	if [[ "$bundle_id" != "$NOETAXIS_BUNDLE_ID" || "$build_version" != "$version" || ! "$version" =~ -noetaxis\.[0-9a-f]{7}$ || "$revision" != "$short_revision"* ]]; then
		noetaxis_error "App version/revision metadata is inconsistent: bundle=$bundle_id version=$version build=$build_version revision=$revision."
		return 23
	fi
}

noetaxis_verify_manifest() {
	local app_path="$1" manifest_path="$2"
	[[ -d "$app_path" ]] || { noetaxis_error "App bundle not found: $app_path"; return 24; }
	[[ -f "$manifest_path" ]] || { noetaxis_error "Manifest not found: $manifest_path"; return 24; }
	if (cd "$app_path" && /usr/bin/shasum -a 256 -c "$manifest_path" >/dev/null 2>&1) \
		&& [[ "$(cd "$app_path" && /usr/bin/find . -type f | LC_ALL=C /usr/bin/sort)" == "$(/usr/bin/sed 's/^[0-9a-f]*  //' "$manifest_path" | LC_ALL=C /usr/bin/sort)" ]]; then
		return 0
	fi
	noetaxis_error "App bundle does not match manifest $manifest_path. Mismatches or files missing from the manifest follow."
	(cd "$app_path" && /usr/bin/shasum -a 256 -c "$manifest_path" 2>&1 | /usr/bin/grep -v ': OK$' || true) >&2
	/usr/bin/comm -23 <(cd "$app_path" && /usr/bin/find . -type f | LC_ALL=C /usr/bin/sort) <(/usr/bin/sed 's/^[0-9a-f]*  //' "$manifest_path" | LC_ALL=C /usr/bin/sort) | /usr/bin/sed 's/^/Not in manifest: /' >&2 || true
	return 24
}

noetaxis_verify_signature() {
	local app_path="$1"
	if ! /usr/bin/codesign --verify --deep --strict "$app_path" >/dev/null 2>&1; then
		noetaxis_error "Code signature verification failed for $app_path (expected a valid ad-hoc signature)."
		return 26
	fi
}

# Inert unless NOETAXIS_TEST_PAUSE_AT names this point: lets tests deliver a signal
# at an exact step of the swap (marker file, then a wait that a signal interrupts).
noetaxis_test_pause() {
	[[ -n "${NOETAXIS_TEST_PAUSE_AT:-}" && "$NOETAXIS_TEST_PAUSE_AT" == "$1" ]] || return 0
	/usr/bin/touch "${NOETAXIS_TEST_PAUSE_MARKER:?}"
	/bin/sleep 20 &
	wait $! || true
}

# A SIGKILL or power loss skips the install trap and leaves the staged copy behind.
# Remove only this script's own staging directories whose owning pid is gone.
noetaxis_remove_stale_staging() {
	local apps_dir="$1" candidate name owner
	for candidate in "$apps_dir"/.Agent-Orchestrator-installing-*.app; do
		[[ -d "$candidate" && ! -L "$candidate" ]] || continue
		name="${candidate##*/}"
		owner="${name%.app}"
		owner="${owner##*-}"
		if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
			noetaxis_run_privileged /bin/rm -rf "$candidate" || true
		fi
	done
}

# Put the previous app back when an interrupted install left /Applications without one.
noetaxis_restore_previous_app() {
	local target_app="$1" old_app="$2"
	if [[ -n "$old_app" && -d "$old_app" && ! -e "$target_app" ]]; then
		noetaxis_run_privileged /bin/mv "$old_app" "$target_app" || true
	fi
}

noetaxis_report_handler() {
	local app_path="$1" handler_plist
	handler_plist="$(noetaxis_handler_plist)"
	if [[ -f "$handler_plist" ]] && /usr/bin/plutil -p "$handler_plist" 2>/dev/null | /usr/bin/awk '
		/^[[:space:]]*[0-9]+ => \{/ { scheme=0; role=0 }
		/"LSHandlerURLScheme" => "ao-app"/ { scheme=1 }
		/"LSHandlerRoleAll" => "dev.agent-orchestrator.desktop"/ { role=1 }
		/^[[:space:]]*\}/ { if (scheme && role) found=1; scheme=0; role=0 }
		END { exit !found }
	'; then
		printf 'ao-app:// handler: registered for %s\n' "$NOETAXIS_BUNDLE_ID"
	else
		printf 'ao-app:// handler: not confirmed for this user. If needed, run:\n  %s -f "%s"\n' "$NOETAXIS_LSREGISTER" "$app_path"
	fi
}

noetaxis_path_size_kb() {
	/usr/bin/du -sk "$1" | /usr/bin/awk '{print $1}'
}

noetaxis_free_space_kb() {
	/bin/df -Pk "$1" | /usr/bin/awk 'END {print $4}'
}

noetaxis_check_space() {
	local app_path="$1" ao_home="$2" user_home="$3" apps_dir="$4" app_kb app_free
	app_kb="$(noetaxis_path_size_kb "$app_path")"
	app_free="$(noetaxis_free_space_kb "$apps_dir")"
	if [[ "$app_free" -lt "$((app_kb + 1024))" ]]; then
		noetaxis_error "Insufficient free space on the app volume: need at least $((app_kb + 1024)) KB, have $app_free KB."
		return 25
	fi
	noetaxis_check_backup_space "$ao_home" "$user_home" "$apps_dir"
}

noetaxis_check_backup_space() {
	local ao_home="$1" user_home="$2" apps_dir="$3" data_kb backup_free old_kb old_device backup_device backup_needed file
	data_kb=0
	for file in "$ao_home/data/ao.db" "$ao_home/data/ao.db-wal" "$ao_home/data/ao.db-shm" "$ao_home/app-state.json" "$ao_home/update-settings.json" "$ao_home/editor-settings.json"; do
		if [[ -f "$file" ]]; then
			data_kb="$((data_kb + $(noetaxis_path_size_kb "$file")))"
		fi
	done
	backup_free="$(noetaxis_free_space_kb "$user_home")"
	backup_needed="$((data_kb + 1024))"
	if [[ -d "$apps_dir/$NOETAXIS_APP_NAME" ]]; then
		old_kb="$(noetaxis_path_size_kb "$apps_dir/$NOETAXIS_APP_NAME")"
		old_device="$(/usr/bin/stat -f '%d' "$apps_dir/$NOETAXIS_APP_NAME")"
		backup_device="$(/usr/bin/stat -f '%d' "$user_home")"
		if [[ "$old_device" != "$backup_device" ]]; then
			backup_needed="$((backup_needed + old_kb))"
		fi
	fi
	if [[ "$backup_free" -lt "$backup_needed" ]]; then
		noetaxis_error "Insufficient free space for the data/app backup: need at least $backup_needed KB, have $backup_free KB."
		return 25
	fi
}

noetaxis_new_backup_dir() {
	local user_home="$1" backup_root stamp backup_dir user_name user_id group_id
	backup_root="$user_home/ao-backups"
	stamp="$(date '+%Y%m%d-%H%M%S')"
	backup_dir="$backup_root/$stamp"
	if [[ -e "$backup_dir" ]]; then
		backup_dir="$backup_root/$stamp-$$"
	fi
	/bin/mkdir -p "$backup_dir"
	if [[ "$(id -u)" -eq 0 ]]; then
		user_name="$(noetaxis_user_name)"
		if [[ -n "$user_name" && "$user_name" != root ]]; then
			user_id="$(id -u "$user_name")"
			group_id="$(id -g "$user_name")"
			/usr/sbin/chown "$user_id:$group_id" "$backup_root" "$backup_dir"
		fi
	fi
	printf '%s' "$backup_dir"
}

noetaxis_copy_state_backup() {
	local ao_home="$1" backup_dir="$2" relative source destination
	for relative in data/ao.db data/ao.db-wal data/ao.db-shm app-state.json update-settings.json editor-settings.json; do
		source="$ao_home/$relative"
		destination="$backup_dir/$relative"
		if [[ -f "$source" ]]; then
			/bin/mkdir -p "$(/usr/bin/dirname "$destination")"
			/bin/cp -c -p "$source" "$destination"
			if ! /usr/bin/cmp -s "$source" "$destination"; then
				noetaxis_error "Backup verification failed for $source."
				return 26
			fi
			printf '%s\n' "$relative" >> "$backup_dir/BACKUP_FILES.txt"
		else
			printf '%s (absent)\n' "$relative" >> "$backup_dir/BACKUP_FILES.txt"
		fi
	done
}

noetaxis_old_app_backup_name() {
	local app_path="$1" version safe_version stamp
	version="unknown"
	if [[ -f "$app_path/Contents/Info.plist" ]]; then
		version="$(noetaxis_plist_value "$app_path/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || printf 'unknown')"
	fi
	safe_version="$(printf '%s' "$version" | /usr/bin/sed 's/[^A-Za-z0-9._-]/_/g')"
	stamp="$(date '+%Y%m%d-%H%M%S')"
	printf 'Agent Orchestrator-%s-%s-%s.app.bak' "$safe_version" "$stamp" "$$"
}

noetaxis_run_privileged() {
	local apps_dir
	apps_dir="$(noetaxis_apps_dir)"
	if [[ "$(id -u)" -eq 0 || -w "$apps_dir" ]]; then
		"$@"
	else
		command -v sudo >/dev/null 2>&1 || { noetaxis_error "This operation needs administrator permission; rerun from your own Terminal with sudo available."; return 27; }
		sudo "$@"
	fi
}

noetaxis_clear_quarantine() {
	local output
	if output="$(noetaxis_run_privileged /usr/bin/xattr -dr com.apple.quarantine "$1" 2>&1)"; then
		return 0
	fi
	if [[ "$output" == *"No such xattr"* ]]; then
		return 0
	fi
	noetaxis_error "Could not clear quarantine from $1: $output"
	return 1
}

noetaxis_write_backup_record() {
	local backup_dir="$1" app_backup="$2" app_version="$3" temporary_record
	temporary_record="$backup_dir/.BACKUP_COMPLETE-$$"
	if ! {
		printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		printf 'app_backup=%s\n' "$app_backup"
		printf 'app_version=%s\n' "$app_version"
	} > "$temporary_record"; then
		/bin/rm -f "$temporary_record"
		return 1
	fi
	if ! /bin/mv "$temporary_record" "$backup_dir/BACKUP_COMPLETE"; then
		/bin/rm -f "$temporary_record"
		return 1
	fi
}

noetaxis_schema_query() {
	/usr/bin/sqlite3 "${@:2}" "$1" 'select max(version_id) from goose_db_version where is_applied=1;'
}

# A WAL-mode database with no -wal/-shm files (the daemon is not running) cannot
# be opened with -readonly: SQLite would need to create the -shm file. Read a
# temporary copy in that case so the real data directory is never written.
# The check is informational and never fails the install.
noetaxis_print_schema_version() {
	local database="$1" version copy_dir
	if version="$(noetaxis_schema_query "$database" -readonly 2>/dev/null)"; then
		printf 'SQLite schema version: %s\n' "$version"
		return 0
	fi
	copy_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/noetaxis-schema.XXXXXX")" || copy_dir=""
	if [[ -n "$copy_dir" ]]; then
		/bin/cp "$database" "$copy_dir/ao.db" 2>/dev/null || true
		[[ -f "$database-wal" ]] && { /bin/cp "$database-wal" "$copy_dir/ao.db-wal" 2>/dev/null || true; }
		version="$(noetaxis_schema_query "$copy_dir/ao.db" 2>/dev/null)" || version=""
		/bin/rm -rf "$copy_dir"
		if [[ -n "$version" ]]; then
			printf 'SQLite schema version: %s (read from a temporary copy; the daemon is not running)\n' "$version"
			return 0
		fi
	fi
	printf 'SQLite schema version: could not be read from %s (non-fatal check; run the sqlite3 command from the README after opening the app).\n' "$database"
}

noetaxis_print_post_install_checks() {
	local app_path="$1" ao_home="$2" cli database
	cli="$app_path/Contents/Resources/daemon/ao"
	database="$ao_home/data/ao.db"
	if [[ ! -x "$cli" ]]; then
		noetaxis_error "Bundled ao CLI is missing or not executable: $cli"
		return 28
	fi
	printf '\nOffline CLI checks:\n'
	"$cli" version
	"$cli" spawn --help | /usr/bin/grep -- --effort
	"$cli" project set-config --help | /usr/bin/grep -- --permission-fallback
	if [[ -f "$database" ]]; then
		noetaxis_print_schema_version "$database"
	else
		printf 'SQLite schema check skipped until the app has created %s.\n' "$database"
	fi
	printf '\nAfter opening the app from Finder, run:\n  "%s" status\n' "$cli"
}
