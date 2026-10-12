#!/bin/bash
# Update mode for install.sh (sourced after common.sh): one command that captures the
# current state, stops AO in the safest supported order, installs, restarts, verifies and
# rolls back automatically when the new app does not come up healthy.
#
# Safety rules this file enforces (each one has a test):
#   - It only ever sends SIGTERM, only through noetaxis_signal_own_pid, only with --force,
#     and only to a process whose command line STARTS with this bundle's path
#     (<app>/Contents/). A lookalike path (another copy of AO, an editor with a file open
#     inside the bundle) is listed and refused, never signalled.
#   - Sessions are never ended without --end-sessions, and by default live sessions make the
#     run refuse before anything is stopped.
#   - Nothing is stopped before the plan is shown and confirmed (--yes skips the question).
#   - The Docker stack of a local Multica server is only read, unless --restart-multica-stack.
#   - Nothing here edits a shell profile.
#
# Functions never rely on `set -e` for their own control flow: callers use `f || status=$?`,
# which disables errexit inside f, so every command that can fail is checked explicitly.

# Session records use the unit separator: unlike a tab it is not IFS whitespace, so an empty
# field (a session with no name or status) does not shift the columns.
noetaxis_sep="$(printf '\037')"
noetaxis_update_log_file=""
noetaxis_update_started_at="$(date '+%s')"
noetaxis_update_notes_user=""
noetaxis_update_summary_stopped=""
noetaxis_update_summary_checks=""
noetaxis_update_summary_restore=""
noetaxis_update_summary_extra=""

# Capture results, filled by noetaxis_update_capture_state.
cap_dir=""
cap_cli=""
cap_old_version="none"
cap_daemon_state="none"
cap_daemon_port=""
cap_daemon_pid=""
cap_sessions_status="skipped"
cap_live_file=""
cap_live_count=0
cap_hosted="unknown"
cap_hosted_state=""
cap_standalone="unknown"
cap_stack_running=""
cap_schema_before=""
cap_processes_file=""

update_actual_new_version=""
update_health_detail=""
update_health_executable=""
update_health_port=""
update_schema_after=""
update_post_warnings=0
update_restore_failed=0
update_rolled_back=0
update_report_done=0
update_app_started=0
update_dry_run=0

noetaxis_update_log() {
	[[ -n "$noetaxis_update_log_file" ]] || return 0
	printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$noetaxis_update_log_file" 2>/dev/null || true
}

noetaxis_update_step() {
	printf '\n==> %s\n' "$*"
	noetaxis_update_log "STEP $*"
}

noetaxis_update_say() {
	printf '    %s\n' "$*"
	noetaxis_update_log "$*"
}

noetaxis_update_warn() {
	printf 'Warning: %s\n' "$*" >&2
	noetaxis_update_log "WARNING $*"
}

noetaxis_update_note_user() {
	noetaxis_update_notes_user="${noetaxis_update_notes_user}${noetaxis_update_notes_user:+
}$1"
}

noetaxis_update_append() {
	# noetaxis_update_append <variable name> <line>
	local name="$1" line="$2" current
	current="${!name}"
	printf -v "$name" '%s' "${current}${current:+
}$line"
}

# Run a command with a hard time limit. The kernel delivers SIGALRM to the command
# (perl exec keeps the alarm), so this never uses a kill call. Exit status 142 means timeout.
noetaxis_bounded() {
	local seconds="$1"
	shift
	/usr/bin/perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$seconds" "$@"
}

noetaxis_json_get() {
	# noetaxis_json_get <file> <key path>: raw value or a non-zero status.
	/usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

noetaxis_update_sleep() {
	/bin/sleep "${NOETAXIS_POLL_INTERVAL:-1}"
}

# Poll a predicate until it succeeds or the time runs out. Prints a progress line about
# every five seconds so a long wait never looks hung.
# noetaxis_wait_until <label> <timeout seconds> <predicate> [args...]
noetaxis_wait_until() {
	local label="$1" timeout="$2" now deadline next_note
	shift 2
	now="$(date '+%s')"
	deadline=$((now + timeout))
	next_note=$((now + 5))
	while :; do
		if "$@"; then
			return 0
		fi
		now="$(date '+%s')"
		if [[ "$now" -ge "$deadline" ]]; then
			return 1
		fi
		if [[ "$now" -ge "$next_note" ]]; then
			noetaxis_update_say "still waiting for $label ($((deadline - now))s left)"
			next_note=$((now + 5))
		fi
		noetaxis_update_sleep
	done
}

# ---------------------------------------------------------------------------
# Processes of exactly this bundle
# ---------------------------------------------------------------------------

# "pid<TAB>command" for each process whose command line starts with <app>/Contents/.
noetaxis_own_bundle_processes() {
	local app_path="$1" pid command_line
	for pid in $(pgrep -f "$(noetaxis_regex_escape "$app_path/Contents/")" 2>/dev/null || true); do
		[[ "$pid" =~ ^[0-9]+$ ]] || continue
		[[ "$pid" -ne "$$" ]] || continue
		command_line="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
		case "$command_line" in
			"$app_path/Contents/"*) printf '%s\t%s\n' "$pid" "$command_line" ;;
		esac
	done
}

# "pid<TAB>command" for processes that mention the bundle path but do not start with it:
# another copy of AO whose path ends the same way, or a tool holding a file open inside it.
noetaxis_foreign_bundle_processes() {
	local app_path="$1" pid command_line
	for pid in $(pgrep -f "$(noetaxis_regex_escape "$app_path/Contents/")" 2>/dev/null || true); do
		[[ "$pid" =~ ^[0-9]+$ ]] || continue
		[[ "$pid" -ne "$$" ]] || continue
		command_line="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
		case "$command_line" in
			"$app_path/Contents/"*) ;;
			*) printf '%s\t%s\n' "$pid" "$command_line" ;;
		esac
	done
}

noetaxis_process_kind() {
	local app_path="$1" command_line="$2"
	case "$command_line" in
		"$app_path/Contents/Resources/daemon/ao daemon"*) printf 'daemon' ;;
		"$app_path/Contents/Resources/daemon/ao chat-host"*) printf 'chat-host' ;;
		"$app_path/Contents/MacOS/"*|"$app_path/Contents/Frameworks/"*) printf 'desktop' ;;
		*) printf 'helper' ;;
	esac
}

# Own processes of one kind (desktop, daemon, chat-host, helper) or "any", as "pid<TAB>command".
noetaxis_own_pids_of_kind() {
	local app_path="$1" kind="$2" pid command_line
	while IFS=$'\t' read -r pid command_line; do
		[[ -n "$pid" ]] || continue
		if [[ "$kind" == any || "$(noetaxis_process_kind "$app_path" "$command_line")" == "$kind" ]]; then
			printf '%s\t%s\n' "$pid" "$command_line"
		fi
	done < <(noetaxis_own_bundle_processes "$app_path")
}

noetaxis_none_running_of_kind() {
	[[ -z "$(noetaxis_own_pids_of_kind "$1" "$2")" ]]
}

# The Electron main process of the bundle (Contents/MacOS/<name> with no arguments).
noetaxis_own_main_pid() {
	local app_path="$1" pid command_line
	while IFS=$'\t' read -r pid command_line; do
		case "$command_line" in
			"$app_path/Contents/MacOS/"*) printf '%s' "$pid"; return 0 ;;
		esac
	done < <(noetaxis_own_bundle_processes "$app_path")
	return 1
}

noetaxis_describe_processes() {
	# Indent "pid<TAB>command" lines for a message. The bundle path is shortened to <app> so the
	# part that tells the processes apart stays visible; long command lines are cut.
	/usr/bin/awk -F '\t' -v app="${target_app:-}" 'NF >= 2 { c = $2; if (app != "" && index(c, app) == 1) c = "<app>" substr(c, length(app) + 1); if (length(c) > 150) c = substr(c, 1, 147) "..."; printf "      pid %s  %s\n", $1, c }'
}

# The only place that signals a process: SIGTERM, only to a process that is still one of
# this bundle's own at the moment of the signal. Every call is logged.
noetaxis_signal_own_pid() {
	local app_path="$1" pid="$2" reason="$3" command_line
	command_line="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
	case "$command_line" in
		"$app_path/Contents/"*) ;;
		*)
			noetaxis_update_log "skipped pid $pid ($reason): no longer a process of $app_path"
			return 1
			;;
	esac
	noetaxis_update_say "SIGTERM to pid $pid ($reason): $command_line"
	"${NOETAXIS_KILL:-/bin/kill}" -TERM "$pid" || return 1
}

# ---------------------------------------------------------------------------
# State capture (read only)
# ---------------------------------------------------------------------------

noetaxis_update_list_sessions_json() {
	# noetaxis_update_list_sessions_json <output file>
	noetaxis_bounded 30 "$cap_cli" session ls --all --include-terminated --json > "$1" 2>"$1.err"
}

# Parse a sessions JSON file into a tab separated list of the live (not terminated) sessions.
# Returns 1 when the file is not the expected document.
noetaxis_update_parse_live_sessions() {
	local file="$1" out="$2" count index terminated id project role status activity name
	# A session is live when it is not terminated and its agent has not exited: only then does
	# an agent process (a chat host or terminal runtime) stand to be interrupted.
	: > "$out"
	if ! count="$(noetaxis_json_get "$file" data)"; then
		# A null/absent list is an empty list only when the document itself is valid JSON.
		noetaxis_json_get "$file" meta >/dev/null || return 1
		return 0
	fi
	[[ "$count" =~ ^[0-9]+$ ]] || return 1
	index=0
	while [[ "$index" -lt "$count" ]]; do
		terminated="$(noetaxis_json_get "$file" "data.$index.isTerminated" || printf 'false')"
		activity="$(noetaxis_json_get "$file" "data.$index.activity" || true)"
		if [[ "$terminated" != true && "$activity" != exited ]]; then
			id="$(noetaxis_json_get "$file" "data.$index.id" || true)"
			project="$(noetaxis_json_get "$file" "data.$index.projectId" || true)"
			role="$(noetaxis_json_get "$file" "data.$index.role" || true)"
			status="$(noetaxis_json_get "$file" "data.$index.status" || true)"
			name="$(noetaxis_json_get "$file" "data.$index.displayName" || true)"
			if [[ -n "$id" ]]; then
				# One line per session: tabs and control characters in a name must not break it.
				name="$(printf '%s' "$name" | /usr/bin/tr -d '\000-\037')"
				printf '%s%s%s%s%s%s%s%s%s%s%s\n' "$id" "$noetaxis_sep" "$project" "$noetaxis_sep" "$role" "$noetaxis_sep" "$status" "$noetaxis_sep" "$activity" "$noetaxis_sep" "$name" >> "$out"
			fi
		fi
		index=$((index + 1))
	done
}

noetaxis_update_capture_sessions() {
	# Fills cap_sessions_status (ok|failed) and the live list file.
	if noetaxis_update_list_sessions_json "$cap_dir/sessions.json" && noetaxis_update_parse_live_sessions "$cap_dir/sessions.json" "$cap_live_file"; then
		cap_sessions_status="ok"
		cap_live_count="$(/usr/bin/awk 'END { print NR }' "$cap_live_file")"
		return 0
	fi
	cap_sessions_status="failed"
	cap_live_count=0
	return 1
}

# Everything here only reads. The daemon has to be up to list sessions; when it is not,
# the session list is skipped and the process list says what is still alive.
noetaxis_update_capture_state() {
	local app_path="$1" dir="$2" standalone_json standalone_status stack_filter
	cap_dir="$dir"
	cap_live_file="$dir/live-sessions.tsv"
	cap_processes_file="$dir/processes.txt"
	: > "$cap_live_file"
	cap_cli="$app_path/Contents/Resources/daemon/ao"
	cap_old_version="none"
	if [[ -f "$app_path/Contents/Info.plist" ]]; then
		cap_old_version="$(noetaxis_plist_value "$app_path/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || printf 'unknown')"
	fi
	noetaxis_own_bundle_processes "$app_path" > "$cap_processes_file" || true

	cap_daemon_state="none"
	if [[ -x "$cap_cli" ]]; then
		if noetaxis_bounded 20 "$cap_cli" status --json > "$dir/ao-status.json" 2>"$dir/ao-status.err"; then
			cap_daemon_state="$(noetaxis_json_get "$dir/ao-status.json" state || printf 'unknown')"
			cap_daemon_port="$(noetaxis_json_get "$dir/ao-status.json" port || true)"
			cap_daemon_pid="$(noetaxis_json_get "$dir/ao-status.json" pid || true)"
		else
			cap_daemon_state="unknown"
		fi
	fi

	cap_sessions_status="skipped"
	cap_live_count=0
	case "$cap_daemon_state" in
		ready|unhealthy|not_ready|unknown)
			noetaxis_update_capture_sessions || true
			;;
	esac

	cap_hosted="unknown"
	cap_hosted_state=""
	if [[ "$cap_daemon_state" == ready ]] && noetaxis_bounded 20 "$cap_cli" multica status --json > "$dir/multica-status.json" 2>"$dir/multica-status.err"; then
		cap_hosted_state="$(noetaxis_json_get "$dir/multica-status.json" state || true)"
		case "$(noetaxis_json_get "$dir/multica-status.json" enabled || true)" in
			true) cap_hosted="yes" ;;
			false) cap_hosted="no" ;;
		esac
	fi

	# A standalone multica CLI daemon is one AO does not host. When AO hosts a running daemon
	# itself, `multica daemon status` reports that one, which is not standalone.
	cap_standalone="unknown"
	if command -v "${NOETAXIS_MULTICA:-multica}" >/dev/null 2>&1; then
		standalone_status=0
		standalone_json="$(noetaxis_bounded 20 "${NOETAXIS_MULTICA:-multica}" daemon status --output json 2>"$dir/multica-daemon.err")" || standalone_status=$?
		printf '%s\n' "$standalone_json" > "$dir/multica-daemon.json"
		if [[ "$standalone_status" -eq 0 ]]; then
			case "$(printf '%s' "$standalone_json" | /usr/bin/plutil -extract status raw -o - - 2>/dev/null || true)" in
				running|starting)
					cap_standalone="yes"
					if [[ "$cap_hosted" == yes && ( "$cap_hosted_state" == running || "$cap_hosted_state" == starting ) ]]; then
						cap_standalone="no"
					fi
					;;
				stopped) cap_standalone="no" ;;
			esac
		fi
	else
		cap_standalone="absent"
	fi

	# Information only: the local Multica server stack is never stopped by default.
	cap_stack_running=""
	if command -v "${NOETAXIS_DOCKER:-docker}" >/dev/null 2>&1; then
		stack_filter="${NOETAXIS_MULTICA_STACK_FILTER:-name=multica}"
		cap_stack_running="$(noetaxis_bounded 20 "${NOETAXIS_DOCKER:-docker}" ps --filter "$stack_filter" --format '{{.Names}}' 2>/dev/null || true)"
		{
			printf 'filter: %s\n' "$stack_filter"
			noetaxis_bounded 20 "${NOETAXIS_DOCKER:-docker}" ps --filter "$stack_filter" --format '{{.Names}}	{{.Status}}' 2>&1 || true
		} > "$dir/multica-stack.txt"
	else
		printf 'docker not found\n' > "$dir/multica-stack.txt"
	fi

	cap_schema_before=""
	if [[ -f "$ao_home/data/ao.db" ]]; then
		cap_schema_before="$(noetaxis_read_schema_version "$ao_home/data/ao.db" || true)"
	fi

	{
		printf 'captured_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		printf 'app=%s\n' "$app_path"
		printf 'app_version=%s\n' "$cap_old_version"
		printf 'daemon_state=%s\n' "$cap_daemon_state"
		printf 'daemon_pid=%s\n' "$cap_daemon_pid"
		printf 'daemon_port=%s\n' "$cap_daemon_port"
		printf 'sessions_status=%s\n' "$cap_sessions_status"
		printf 'live_sessions=%s\n' "$cap_live_count"
		printf 'multica_hosting=%s\n' "$cap_hosted"
		printf 'multica_hosted_state=%s\n' "$cap_hosted_state"
		printf 'standalone_multica_daemon=%s\n' "$cap_standalone"
		printf 'multica_stack_running=%s\n' "$(printf '%s' "$cap_stack_running" | /usr/bin/tr '\n' ' ')"
		printf 'schema_before=%s\n' "$cap_schema_before"
	} > "$dir/state.env"
}

# ---------------------------------------------------------------------------
# Plan, refusals, confirmation
# ---------------------------------------------------------------------------

noetaxis_update_print_live_sessions() {
	/usr/bin/awk -F "$noetaxis_sep" '{ printf "      %s  [%s]  %s  %s/%s  %s\n", $1, $2, $3, $4, $5, $6 }' "$cap_live_file"
}

noetaxis_update_print_plan() {
	local app_path="$1" new_version="$2" backup_root="$3" desktop_count daemon_count host_count other_count
	desktop_count="$(noetaxis_own_pids_of_kind "$app_path" desktop | /usr/bin/awk 'END { print NR }')"
	daemon_count="$(noetaxis_own_pids_of_kind "$app_path" daemon | /usr/bin/awk 'END { print NR }')"
	host_count="$(noetaxis_own_pids_of_kind "$app_path" chat-host | /usr/bin/awk 'END { print NR }')"
	other_count="$(noetaxis_own_pids_of_kind "$app_path" helper | /usr/bin/awk 'END { print NR }')"
	printf '\nUpdate plan\n'
	printf '  Install:   %s -> %s\n             in %s\n' "$cap_old_version" "$new_version" "$app_path"
	printf '\n  Will be STOPPED, in this order:\n'
	if [[ "$update_end_sessions" -eq 1 && "$cap_live_count" -gt 0 ]]; then
		printf '    1. %s live session(s): each agent is stopped with "ao session exit-agent" (listed below; the session, worktree and conversation are kept)\n' "$cap_live_count"
	else
		printf '    1. live sessions: %s found; none are ended by this run\n' "$cap_live_count"
	fi
	if [[ "$desktop_count" -gt 0 ]]; then
		if [[ "$update_manual_quit" -eq 1 ]]; then
			printf '    2. the desktop app (%s process(es)): you click "Quit AO Completely" in the menu bar; this script waits up to %ss\n' "$desktop_count" "$update_quit_timeout"
		else
			printf '    2. the desktop app (%s process(es)): this script clicks "Quit AO Completely" in the menu bar tray (needs Accessibility permission; if it cannot, it waits up to %ss for you to click it)\n' "$desktop_count" "$update_quit_timeout"
		fi
	else
		printf '    2. the desktop app: not running\n'
	fi
	if [[ "$daemon_count" -gt 0 ]]; then
		printf '    3. the AO daemon (%s process(es), port %s): stops itself about 5 s after the app quits; "ao stop" if it does not\n' "$daemon_count" "${cap_daemon_port:-unknown}"
	else
		printf '    3. the AO daemon: not running\n'
	fi
	printf '    4. then it waits up to %ss for agent chat hosts (%s) and helper processes (%s) and for ShipIt to exit\n' "$update_stop_timeout" "$host_count" "$other_count"
	if [[ "$update_force" -eq 1 ]]; then
		printf '       --force: processes of THIS bundle that are still alive after the wait get SIGTERM (never SIGKILL), each one logged\n'
	else
		printf '       without --force nothing is signalled: a survivor stops the run with a list\n'
	fi
	if [[ "$cap_live_count" -gt 0 ]]; then
		printf '\n  Live sessions (%s):\n' "$cap_live_count"
		noetaxis_update_print_live_sessions
		if [[ "$update_end_sessions" -eq 1 ]]; then
			printf '    These agents WILL BE STOPPED (--end-sessions): running turns and terminals end; each session, worktree and conversation stays.\n'
			if [[ "$update_restore_sessions" -eq 1 ]]; then
				printf '    --restore-sessions: one "ao session restore" attempt each afterwards (best effort, restore has been unreliable).\n'
			fi
		else
			printf '    The run will refuse while these are live (see --end-sessions).\n'
		fi
	elif [[ "$cap_sessions_status" == skipped ]]; then
		printf '\n  Live sessions: the daemon is not running (%s), so none could be listed.\n' "$cap_daemon_state"
	elif [[ "$cap_sessions_status" == failed ]]; then
		printf '\n  Live sessions: the session list could not be read.\n'
	fi
	printf '\n  Will be BACKED UP in a new directory under %s/:\n' "$backup_root"
	printf '    ao.db (+WAL/SHM), app-state.json, update-settings.json, editor-settings.json, the old app as *.app.bak,\n'
	printf '    and the state captured now (sessions, daemon, Multica, processes) under state-before/. BACKUP_COMPLETE is written before the old app moves.\n'
	printf '\n  Will be RESTARTED:\n'
	printf '    the new app (open -a "%s"), then wait up to %ss for the daemon to be healthy; checks: version, schema, ao-app:// handler, --effort, --permission-fallback.\n' "$app_path" "$update_health_timeout"
	if [[ "$cap_standalone" == yes ]]; then
		if [[ "$update_restart_multica_daemon" -eq 1 ]]; then
			printf '    the standalone Multica CLI daemon (running now): "multica daemon restart" (--restart-multica-daemon)\n'
		else
			printf '    the standalone Multica CLI daemon is running and is NOT touched (add --restart-multica-daemon to restart it)\n'
		fi
	else
		printf '    standalone Multica CLI daemon: %s, not touched\n' "$cap_standalone"
	fi
	case "$cap_hosted" in
		yes) printf '    AO-hosted Multica daemon: hosting is ON now. It stops with AO; it only comes back if the app starts with AO_MULTICA_DAEMON=1 (you get instructions at the end).\n' ;;
		no) printf '    AO-hosted Multica daemon: hosting is off\n' ;;
		*) printf '    AO-hosted Multica daemon: state unknown\n' ;;
	esac
	if [[ -n "$cap_stack_running" ]]; then
		if [[ "$update_restart_multica_stack" -eq 1 ]]; then
			printf '    local Multica server stack (Docker): running containers restarted with "docker restart" (--restart-multica-stack)\n'
		else
			printf '    local Multica server stack (Docker) is running (%s) and is NOT touched (add --restart-multica-stack to restart it)\n' "$(printf '%s' "$cap_stack_running" | /usr/bin/tr '\n' ' ')"
		fi
	else
		printf '    local Multica server stack (Docker): no running containers found by the filter "%s", not touched\n' "${NOETAXIS_MULTICA_STACK_FILTER:-name=multica}"
	fi
	printf '\n  If the new app does not start or the daemon is not healthy within %ss: the new app is quit and the backed-up app is restored automatically.\n' "$update_health_timeout"
	if [[ "$update_rollback_restore_db" -eq 1 ]]; then
		printf '  The database is restored too only if the old app then stays unhealthy and the schema was migrated (--rollback-restore-db).\n'
	else
		printf '  The database is not restored automatically (add --rollback-restore-db).\n'
	fi
	printf '\n'
}

# Refusals that happen before anything is stopped. Prints the reason and returns the exit code.
noetaxis_update_preflight_refusals() {
	local app_path="$1" foreign host_count
	foreign="$(noetaxis_foreign_bundle_processes "$app_path")"
	if [[ -n "$foreign" ]]; then
		noetaxis_error "Processes that mention $app_path/Contents/ but are not part of this bundle are running (another copy of AO whose path ends the same way, or a tool with a file open inside the app). Update mode never signals them, and they would block the install. Quit them yourself and rerun:"
		printf '%s\n' "$foreign" | noetaxis_describe_processes >&2
		return 21
	fi
	if [[ "$cap_sessions_status" == failed && "$update_force" -ne 1 ]]; then
		noetaxis_error "The AO daemon is running (state: $cap_daemon_state) but its session list could not be read (see $cap_dir/sessions.json.err), so live sessions cannot be identified. Nothing was stopped. Fix the daemon or rerun with --force to continue without the list (--force may SIGTERM chat hosts of this bundle afterwards)."
		return 52
	fi
	if [[ "$cap_live_count" -gt 0 && "$update_end_sessions" -ne 1 ]]; then
		noetaxis_error "$cap_live_count live session(s) would be interrupted. Nothing was stopped. Live sessions:"
		noetaxis_update_print_live_sessions >&2
		printf 'Options:\n  --end-sessions   stop their agents with "ao session exit-agent" first (keeps each session, worktree and conversation; add --restore-sessions to resume them afterwards)\n  or finish/hand off the work, stop them yourself with: "%s" session exit-agent <id>\n  and rerun.\n' "$cap_cli" >&2
		return 51
	fi
	host_count="$(noetaxis_own_pids_of_kind "$app_path" chat-host | /usr/bin/awk 'END { print NR }')"
	if [[ "$cap_sessions_status" != ok && "$host_count" -gt 0 && "$update_force" -ne 1 ]]; then
		noetaxis_error "$host_count agent chat host process(es) of this bundle are running but the daemon is not available to list or end their sessions, so they would survive the stop. Nothing was stopped. Reopen AO (open -a \"$app_path\"), rerun this command so it can end the sessions (--end-sessions), or rerun with --force to SIGTERM those chat hosts (their agent conversations end):"
		noetaxis_own_pids_of_kind "$app_path" chat-host | noetaxis_describe_processes >&2
		return 56
	fi
	return 0
}

# Returns 0 to continue, 50 when the answer is not "yes".
noetaxis_update_confirm() {
	local answer=""
	if [[ "$update_yes" -eq 1 ]]; then
		noetaxis_update_say "--yes given: continuing without asking"
		return 0
	fi
	printf 'Type "yes" to stop AO and update it, anything else cancels: '
	IFS= read -r answer || answer=""
	printf '\n'
	if [[ "$answer" == yes ]]; then
		return 0
	fi
	noetaxis_error "Cancelled. Nothing was stopped, backed up or installed."
	return 50
}

# ---------------------------------------------------------------------------
# Stop
# ---------------------------------------------------------------------------

noetaxis_update_no_live_sessions() {
	noetaxis_update_list_sessions_json "$cap_dir/sessions-recheck.json" && noetaxis_update_parse_live_sessions "$cap_dir/sessions-recheck.json" "$cap_dir/live-recheck.tsv" && [[ ! -s "$cap_dir/live-recheck.tsv" ]]
}

# End every live session through AO's own command while the daemon can still answer.
noetaxis_update_end_sessions() {
	local id project role status activity name output status_code failed=0 total=0 ended=0
	noetaxis_update_step "Ending $cap_live_count live session(s)"
	while IFS="$noetaxis_sep" read -r id project role status activity name; do
		[[ -n "$id" ]] || continue
		total=$((total + 1))
		status_code=0
		output="$(noetaxis_bounded 90 "$cap_cli" session exit-agent "$id" ${project:+--project "$project"} 2>&1)" || status_code=$?
		if [[ "$status_code" -eq 0 ]]; then
			ended=$((ended + 1))
			noetaxis_update_say "agent of $id [$project] $role stopped: $output"
			noetaxis_update_append noetaxis_update_summary_stopped "session $id: agent stopped (ao session exit-agent; session and worktree kept)"
		else
			failed=$((failed + 1))
			noetaxis_update_say "FAILED to end $id [$project]: ${output:-exit $status_code}"
		fi
	done < "$cap_live_file"
	if [[ "$failed" -gt 0 ]]; then
		noetaxis_error "$failed of $total session(s) could not be ended (their agents were not stopped). The app and daemon were not touched."
		return 53
	fi
	if ! noetaxis_wait_until "the daemon to report no live sessions" "$update_stop_timeout" noetaxis_update_no_live_sessions; then
		noetaxis_error "Agents were stopped but the daemon still lists live sessions (see $cap_dir/live-recheck.tsv). The app and daemon were not touched."
		return 53
	fi
}

# Ask the app to quit completely by clicking the tray item that upstream ships for it.
# Upstream (frontend/src/main/desktop-quit.ts) deliberately turns Cmd+Q, the Dock quit, an
# AppleScript `quit` and a SIGTERM into "close the window"; only the tray item
# "Quit AO Completely" (and a system shutdown) exits the app, and there is no CLI, daemon
# API or URL for it. So the supported action is driven through the accessibility API, for
# one specific process id (never by bundle id, which another copy shares).
noetaxis_tray_quit() {
	local pid="$1"
	noetaxis_bounded 20 "${NOETAXIS_OSASCRIPT:-/usr/bin/osascript}" \
		-e 'on run argv' \
		-e 'set targetPid to (item 1 of argv) as integer' \
		-e 'tell application "System Events"' \
		-e 'set targetProcess to first application process whose unix id is targetPid' \
		-e 'repeat with theBar in menu bars of targetProcess' \
		-e 'repeat with theItem in menu bar items of theBar' \
		-e 'try' \
		-e 'click (first menu item of menu 1 of theItem whose name starts with "Quit AO Completely")' \
		-e 'return "clicked"' \
		-e 'end try' \
		-e 'end repeat' \
		-e 'end repeat' \
		-e 'end tell' \
		-e 'error "the Quit AO Completely tray item was not found"' \
		-e 'end run' \
		"$pid"
}

noetaxis_update_quit_app() {
	local app_path="$1" main_pid pid command_line output status_code=0
	if noetaxis_none_running_of_kind "$app_path" desktop; then
		noetaxis_update_say "the desktop app is not running"
		return 0
	fi
	noetaxis_update_step "Quitting the desktop app completely"
	noetaxis_own_pids_of_kind "$app_path" desktop | noetaxis_describe_processes
	if [[ "$update_manual_quit" -ne 1 ]]; then
		if main_pid="$(noetaxis_own_main_pid "$app_path")"; then
			output="$(noetaxis_tray_quit "$main_pid" 2>&1)" || status_code=$?
			if [[ "$status_code" -eq 0 ]]; then
				noetaxis_update_say "clicked \"Quit AO Completely\" for pid $main_pid"
			else
				noetaxis_update_say "could not click the tray item (${output:-exit $status_code}). Click the Agent Orchestrator icon in the menu bar and choose \"Quit AO Completely\" yourself. Scripting it needs Accessibility/Automation permission for your terminal."
			fi
		fi
	else
		noetaxis_update_say "click the Agent Orchestrator icon in the menu bar and choose \"Quit AO Completely\""
	fi
	if noetaxis_wait_until "the desktop app to exit" "$update_quit_timeout" noetaxis_none_running_of_kind "$app_path" desktop; then
		noetaxis_update_append noetaxis_update_summary_stopped "desktop app quit"
		return 0
	fi
	if [[ "$update_force" -eq 1 ]]; then
		noetaxis_update_say "--force: sending SIGTERM to the desktop processes of this bundle (a tray build may treat it as a window close)"
		while IFS=$'\t' read -r pid command_line; do
			[[ -n "$pid" ]] || continue
			noetaxis_signal_own_pid "$app_path" "$pid" "desktop app did not quit" || true
		done < <(noetaxis_own_pids_of_kind "$app_path" desktop)
		if noetaxis_wait_until "the desktop app to exit after SIGTERM" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" desktop; then
			noetaxis_update_append noetaxis_update_summary_stopped "desktop app terminated (SIGTERM, --force)"
			return 0
		fi
	fi
	noetaxis_error "The desktop app is still running after ${update_quit_timeout}s:"
	noetaxis_own_pids_of_kind "$app_path" desktop | noetaxis_describe_processes >&2
	printf 'Nothing was installed. Choose "Quit AO Completely" in the menu bar yourself and rerun%s. No process was force-killed.\n' "$([[ "$update_force" -eq 1 ]] && printf '' || printf ', or rerun with --force to send SIGTERM')" >&2
	return 54
}

noetaxis_update_stop_daemon() {
	local app_path="$1" cli pid command_line output status_code=0
	cli="$app_path/Contents/Resources/daemon/ao"
	if noetaxis_none_running_of_kind "$app_path" daemon; then
		return 0
	fi
	noetaxis_update_step "Waiting for the AO daemon to stop"
	noetaxis_update_say "the app-owned daemon stops itself about 5 s after the app quits"
	if noetaxis_wait_until "the daemon to stop on its own" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" daemon; then
		noetaxis_update_append noetaxis_update_summary_stopped "AO daemon stopped itself after the app quit"
		return 0
	fi
	noetaxis_update_say "the daemon is still running; asking it to stop with \"ao stop\""
	output="$(noetaxis_bounded 40 "$cli" stop --timeout 20s 2>&1)" || status_code=$?
	noetaxis_update_say "ao stop: ${output:-exit $status_code}"
	if noetaxis_wait_until "the daemon to exit after ao stop" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" daemon; then
		noetaxis_update_append noetaxis_update_summary_stopped "AO daemon stopped (ao stop)"
		return 0
	fi
	if [[ "$update_force" -eq 1 ]]; then
		while IFS=$'\t' read -r pid command_line; do
			[[ -n "$pid" ]] || continue
			noetaxis_signal_own_pid "$app_path" "$pid" "daemon did not stop" || true
		done < <(noetaxis_own_pids_of_kind "$app_path" daemon)
		if noetaxis_wait_until "the daemon to exit after SIGTERM" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" daemon; then
			noetaxis_update_append noetaxis_update_summary_stopped "AO daemon terminated (SIGTERM, --force)"
			return 0
		fi
	fi
	noetaxis_error "The AO daemon is still running:"
	noetaxis_own_pids_of_kind "$app_path" daemon | noetaxis_describe_processes >&2
	printf 'Nothing was installed. Stop it yourself ("%s" stop) and rerun%s. No process was force-killed.\n' "$cli" "$([[ "$update_force" -eq 1 ]] && printf '' || printf ', or rerun with --force to send SIGTERM')" >&2
	return 55
}

noetaxis_update_stop_helpers() {
	local app_path="$1" cli pid command_line
	cli="$app_path/Contents/Resources/daemon/ao"
	if noetaxis_none_running_of_kind "$app_path" any; then
		return 0
	fi
	noetaxis_update_step "Waiting for chat hosts and helper processes to exit"
	if noetaxis_wait_until "helper processes to exit" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" any; then
		noetaxis_update_append noetaxis_update_summary_stopped "chat hosts and helper processes exited"
		return 0
	fi
	if [[ "$update_force" -eq 1 ]]; then
		noetaxis_update_say "--force: sending SIGTERM to the remaining processes of this bundle"
		while IFS=$'\t' read -r pid command_line; do
			[[ -n "$pid" ]] || continue
			noetaxis_signal_own_pid "$app_path" "$pid" "survived the stop" || true
		done < <(noetaxis_own_pids_of_kind "$app_path" any)
		if noetaxis_wait_until "the remaining processes to exit after SIGTERM" "$update_stop_timeout" noetaxis_none_running_of_kind "$app_path" any; then
			noetaxis_update_append noetaxis_update_summary_stopped "remaining chat hosts/helpers terminated (SIGTERM, --force)"
			return 0
		fi
	fi
	noetaxis_error "Processes of this bundle are still running after the wait. They keep agent conversations or terminals alive:"
	noetaxis_own_pids_of_kind "$app_path" any | noetaxis_describe_processes >&2
	printf 'Nothing was installed and AO is stopped. Reopen it (open -a "%s"), end the sessions (--end-sessions with the daemon up), or rerun with --force to SIGTERM these processes (their conversations end). No process was force-killed.\n' "$app_path" >&2
	return 56
}

noetaxis_update_shipit_gone() {
	! noetaxis_shipit_running
}

noetaxis_update_stop_all() {
	local app_path="$1"
	if [[ "$update_end_sessions" -eq 1 ]]; then
		# Sessions can only be ended while the daemon answers, so they go first; take a fresh
		# list so one started since the plan is ended too.
		if [[ "$cap_sessions_status" == ok ]]; then
			noetaxis_update_capture_sessions || { noetaxis_error "The session list could not be read again; nothing was stopped."; return 52; }
		fi
		if [[ "$cap_live_count" -gt 0 ]]; then
			noetaxis_update_end_sessions || return $?
		fi
	elif [[ "$cap_sessions_status" == ok ]]; then
		noetaxis_update_capture_sessions || { noetaxis_error "The session list could not be read again; nothing was stopped."; return 52; }
		if [[ "$cap_live_count" -gt 0 ]]; then
			noetaxis_error "$cap_live_count live session(s) appeared since the plan was shown. Nothing was stopped:"
			noetaxis_update_print_live_sessions >&2
			return 51
		fi
	fi
	noetaxis_update_quit_app "$app_path" || return $?
	noetaxis_update_stop_daemon "$app_path" || return $?
	noetaxis_update_stop_helpers "$app_path" || return $?
	if noetaxis_shipit_running; then
		noetaxis_update_step "Waiting for ShipIt (the updater) to finish"
		if ! noetaxis_wait_until "ShipIt to exit" "$update_stop_timeout" noetaxis_update_shipit_gone; then
			noetaxis_error "ShipIt is still running. It is never stopped by this command. Wait for it to finish and rerun."
			return 22
		fi
	fi
	return 0
}

# ---------------------------------------------------------------------------
# Restart and verification
# ---------------------------------------------------------------------------

# Sets update_health_detail. 0 only when the daemon reports ready and answers healthz.
noetaxis_update_daemon_healthy() {
	local app_path="$1" cli json state port executable health
	cli="$app_path/Contents/Resources/daemon/ao"
	update_health_detail="daemon not reachable"
	json="$(noetaxis_bounded 15 "$cli" status --json 2>/dev/null)" || return 1
	state="$(printf '%s' "$json" | /usr/bin/plutil -extract state raw -o - - 2>/dev/null || true)"
	update_health_detail="ao status: ${state:-unknown}"
	[[ "$state" == ready ]] || return 1
	port="$(printf '%s' "$json" | /usr/bin/plutil -extract port raw -o - - 2>/dev/null || true)"
	executable="$(printf '%s' "$json" | /usr/bin/plutil -extract executablePath raw -o - - 2>/dev/null || true)"
	update_health_executable="$executable"
	update_health_port="$port"
	if [[ "$port" =~ ^[0-9]+$ ]] && command -v "${NOETAXIS_CURL:-/usr/bin/curl}" >/dev/null 2>&1; then
		health="$("${NOETAXIS_CURL:-/usr/bin/curl}" -fsS --max-time 5 "http://127.0.0.1:$port/healthz" 2>/dev/null)" || { update_health_detail="ao status ready but /healthz on port $port did not answer"; return 1; }
		if [[ "$(printf '%s' "$health" | /usr/bin/plutil -extract status raw -o - - 2>/dev/null || true)" != ok ]]; then
			update_health_detail="/healthz on port $port did not report ok"
			return 1
		fi
	fi
	update_health_detail="ao status ready${port:+, /healthz ok on port $port}"
	return 0
}

noetaxis_update_desktop_started() {
	! noetaxis_none_running_of_kind "$1" desktop
}

noetaxis_update_daemon_healthy_quiet() {
	noetaxis_update_daemon_healthy "$1"
}

# Open the app and wait for its process and a healthy daemon. Sets update_health_detail.
noetaxis_update_start_and_wait() {
	local app_path="$1" label="$2" status_code=0
	update_health_detail=""
	update_health_executable=""
	update_health_port=""
	noetaxis_update_step "Starting $label"
	"${NOETAXIS_OPEN:-/usr/bin/open}" -a "$app_path" || status_code=$?
	if [[ "$status_code" -ne 0 ]]; then
		update_health_detail="open -a exited with status $status_code"
		return 1
	fi
	if ! noetaxis_wait_until "the app process to appear" "$update_health_timeout" noetaxis_update_desktop_started "$app_path"; then
		update_health_detail="the app process did not appear within ${update_health_timeout}s"
		return 1
	fi
	if ! noetaxis_wait_until "the daemon to be healthy" "$update_health_timeout" noetaxis_update_daemon_healthy_quiet "$app_path"; then
		return 1
	fi
	update_app_started=1
	return 0
}

noetaxis_update_post_check() {
	# noetaxis_update_post_check <ok|warn|info> <message>
	case "$1" in
		warn) update_post_warnings=$((update_post_warnings + 1)); noetaxis_update_say "WARN  $2" ;;
		*) noetaxis_update_say "ok    $2" ;;
	esac
	noetaxis_update_append noetaxis_update_summary_checks "$1: $2"
}

noetaxis_update_post_checks() {
	local app_path="$1" expected_version="$2" cli version_line output schema schema_status=0
	cli="$app_path/Contents/Resources/daemon/ao"
	noetaxis_update_step "Post-install checks"
	update_actual_new_version="$(noetaxis_plist_value "$app_path/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || printf 'unknown')"
	if [[ "$update_actual_new_version" == "$expected_version" ]]; then
		noetaxis_update_post_check ok "installed version $update_actual_new_version"
	else
		noetaxis_update_post_check warn "installed version is $update_actual_new_version, expected $expected_version"
	fi
	if version_line="$(noetaxis_bounded 20 "$cli" version 2>&1)"; then
		noetaxis_update_post_check ok "ao version: $version_line (the daemon build prints dev; the app version above is the real stamp)"
	else
		noetaxis_update_post_check warn "ao version failed"
	fi
	if output="$(noetaxis_bounded 20 "$cli" spawn --help 2>&1)" && printf '%s' "$output" | /usr/bin/grep -q -- --effort; then
		noetaxis_update_post_check ok "ao spawn --effort is present"
	else
		noetaxis_update_post_check warn "ao spawn --help does not list --effort"
	fi
	if output="$(noetaxis_bounded 20 "$cli" project set-config --help 2>&1)" && printf '%s' "$output" | /usr/bin/grep -q -- --permission-fallback; then
		noetaxis_update_post_check ok "ao project set-config --permission-fallback is present"
	else
		noetaxis_update_post_check warn "ao project set-config --help does not list --permission-fallback"
	fi
	if [[ -f "$ao_home/data/ao.db" ]]; then
		schema="$(noetaxis_read_schema_version "$ao_home/data/ao.db")" || schema_status=$?
		if [[ "$schema_status" -le 2 && -n "$schema" ]]; then
			update_schema_after="$schema"
			noetaxis_update_post_check ok "database schema version $schema (before: ${cap_schema_before:-unknown}; read-only$([[ "$schema_status" -eq 2 ]] && printf ', from a temporary copy'))"
		else
			noetaxis_update_post_check warn "database schema version could not be read"
		fi
	else
		noetaxis_update_post_check warn "no database at $ao_home/data/ao.db yet"
	fi
	if output="$(noetaxis_report_handler "$app_path")" && [[ "$output" == *"registered for"* ]]; then
		noetaxis_update_post_check ok "$output"
	else
		noetaxis_update_post_check warn "ao-app:// handler not confirmed (see the line printed above); run: $NOETAXIS_LSREGISTER -f \"$app_path\""
	fi
	if [[ -n "${update_health_executable:-}" && "$update_health_executable" != "$app_path/"* ]]; then
		noetaxis_update_post_check warn "the daemon reports the binary $update_health_executable, which is outside $app_path (symlinked folder, or an old daemon is still answering)"
	fi
}

noetaxis_update_live_ids_now() {
	local file="$cap_dir/sessions-now.json"
	noetaxis_update_list_sessions_json "$file" && noetaxis_update_parse_live_sessions "$file" "$cap_dir/live-now.tsv"
}

noetaxis_update_restore_sessions() {
	local app_path="$1" cli id project role status activity name output status_code attempted=0 back=0
	cli="$app_path/Contents/Resources/daemon/ao"
	if [[ "$cap_sessions_status" != ok || "$cap_live_count" -eq 0 ]]; then
		noetaxis_update_say "no sessions were live before; nothing to restore"
		return 0
	fi
	noetaxis_update_step "Restoring sessions that were live before (best effort, one attempt each)"
	if ! noetaxis_update_live_ids_now; then
		noetaxis_update_say "the session list could not be read; trying each restore anyway"
		: > "$cap_dir/live-now.tsv"
	fi
	while IFS="$noetaxis_sep" read -r id project role status activity name; do
		[[ -n "$id" ]] || continue
		if /usr/bin/awk -F "$noetaxis_sep" -v id="$id" '$1 == id { found = 1 } END { exit !found }' "$cap_dir/live-now.tsv"; then
			noetaxis_update_append noetaxis_update_summary_restore "$id: already live, nothing to restore"
			continue
		fi
		attempted=$((attempted + 1))
		status_code=0
		output="$(noetaxis_bounded 90 "$cli" session restore "$id" ${project:+--project "$project"} 2>&1)" || status_code=$?
		noetaxis_update_log "restore $id: exit $status_code: $output"
		if [[ "$status_code" -ne 0 ]]; then
			update_restore_failed=$((update_restore_failed + 1))
			noetaxis_update_append noetaxis_update_summary_restore "$id: restore FAILED (${output:-exit $status_code})"
		fi
	done < "$cap_live_file"
	# Judge by what the daemon lists afterwards, not by the command's exit status alone.
	noetaxis_update_live_ids_now || : > "$cap_dir/live-now.tsv"
	while IFS="$noetaxis_sep" read -r id project role status activity name; do
		[[ -n "$id" ]] || continue
		if /usr/bin/awk -F "$noetaxis_sep" -v id="$id" '$1 == id { found = 1 } END { exit !found }' "$cap_dir/live-now.tsv"; then
			case "$noetaxis_update_summary_restore" in
				*"$id: already live"*) ;;
				*"$id: restore FAILED"*) noetaxis_update_append noetaxis_update_summary_restore "$id: restore reported an error but the session is live now" ;;
				*) back=$((back + 1)); noetaxis_update_append noetaxis_update_summary_restore "$id: came back" ;;
			esac
		else
			case "$noetaxis_update_summary_restore" in
				*"$id: restore FAILED"*) ;;
				*) update_restore_failed=$((update_restore_failed + 1)); noetaxis_update_append noetaxis_update_summary_restore "$id: restore reported success but the session is not live" ;;
			esac
		fi
	done < "$cap_live_file"
	noetaxis_update_say "$attempted restore attempt(s); $back came back; $update_restore_failed did not"
}

noetaxis_update_restart_multica() {
	local app_path="$1" status_code=0 name
	if [[ "$cap_standalone" == yes ]]; then
		if [[ "$update_restart_multica_daemon" -eq 1 ]]; then
			noetaxis_update_step "Restarting the standalone Multica CLI daemon (it was running before)"
			noetaxis_bounded 90 "${NOETAXIS_MULTICA:-multica}" daemon restart >/dev/null 2>&1 || status_code=$?
			if [[ "$status_code" -eq 0 ]]; then
				noetaxis_update_say "multica daemon restart: ok"
				noetaxis_update_append noetaxis_update_summary_extra "standalone Multica daemon restarted"
			else
				noetaxis_update_warn "multica daemon restart failed (exit $status_code); start it yourself: multica daemon start"
				noetaxis_update_note_user "The standalone Multica daemon was running before and could not be restarted: run \"multica daemon start\"."
			fi
		else
			noetaxis_update_note_user "A standalone Multica CLI daemon was running before and was left untouched. Restart it with \"multica daemon restart\" if you need it to pick anything up (or rerun with --restart-multica-daemon)."
		fi
	fi
	if [[ -n "$cap_stack_running" && "$update_restart_multica_stack" -eq 1 ]]; then
		noetaxis_update_step "Restarting the local Multica server stack (--restart-multica-stack)"
		while IFS= read -r name; do
			[[ -n "$name" ]] || continue
			status_code=0
			noetaxis_bounded 120 "${NOETAXIS_DOCKER:-docker}" restart "$name" >/dev/null 2>&1 || status_code=$?
			noetaxis_update_say "docker restart $name: exit $status_code"
			noetaxis_update_append noetaxis_update_summary_extra "Docker container $name restarted (exit $status_code)"
		done <<EOF
$cap_stack_running
EOF
	fi
	# Hosted daemon: the new app only hosts one when it starts with AO_MULTICA_DAEMON=1.
	if [[ "$cap_hosted" == yes ]]; then
		local now_enabled=""
		if noetaxis_bounded 20 "$app_path/Contents/Resources/daemon/ao" multica status --json > "$cap_dir/multica-status-after.json" 2>/dev/null; then
			now_enabled="$(noetaxis_json_get "$cap_dir/multica-status-after.json" enabled || true)"
		fi
		if [[ "$now_enabled" != true ]]; then
			noetaxis_update_note_user "AO-hosted Multica daemon was ON before and is OFF now (the relaunched app has no AO_MULTICA_DAEMON in its environment). To host it again, quit AO completely and start it with the variable set for that launch, for example: AO_MULTICA_DAEMON=1 \"$app_path/Contents/MacOS/\"* or set it for LaunchServices with launchctl setenv AO_MULTICA_DAEMON 1 and reopen AO. Nothing in your shell profile was changed.${AO_MULTICA_DAEMON:+ (This shell has AO_MULTICA_DAEMON=$AO_MULTICA_DAEMON, but open -a does not pass shell variables to an app.)}"
		fi
	fi
}

# ---------------------------------------------------------------------------
# Automatic rollback
# ---------------------------------------------------------------------------

# Quit whatever runs from <app> (best effort with the same bounded steps), then restore the
# previous app with rollback.sh. Returns 0 when the old app is back in place.
noetaxis_update_rollback_swap() {
	local failed_app="$1" restore_db="$2" status_code=0 rollback_args
	rollback_args=(--backup-dir "$backup_dir")
	if [[ "$restore_db" -eq 1 ]]; then
		rollback_args+=(--restore-db)
	fi
	noetaxis_update_quit_app "$failed_app" || return 61
	noetaxis_update_stop_daemon "$failed_app" || return 61
	noetaxis_update_stop_helpers "$failed_app" || return 61
	noetaxis_update_step "Restoring the backed-up app$([[ "$restore_db" -eq 1 ]] && printf ' and database')"
	"$script_dir/rollback.sh" "${rollback_args[@]}" || status_code=$?
	if [[ "$status_code" -ne 0 ]]; then
		noetaxis_update_say "rollback.sh failed with status $status_code"
		return 61
	fi
	return 0
}

noetaxis_update_auto_rollback() {
	local reason="$1" app_path="$2" schema_now=""
	update_rolled_back=1
	noetaxis_update_step "The new app is not healthy ($reason): rolling back automatically"
	if ! noetaxis_update_rollback_swap "$app_path" 0; then
		noetaxis_update_append noetaxis_update_summary_extra "AUTOMATIC ROLLBACK FAILED"
		noetaxis_update_note_user "Automatic rollback did not finish. The new app may still be running or in place. Quit it completely, then run: \"$script_dir/rollback.sh\" --backup-dir \"$backup_dir\"   (add --restore-db to restore the database files too)."
		return 61
	fi
	noetaxis_update_append noetaxis_update_summary_extra "previous app restored from $backup_dir"
	if noetaxis_update_start_and_wait "$app_path" "the restored previous app"; then
		noetaxis_update_say "the previous app is healthy again ($update_health_detail)"
		noetaxis_update_append noetaxis_update_summary_extra "previous app restarted and healthy"
		return 60
	fi
	noetaxis_update_say "the previous app is not healthy either ($update_health_detail)"
	if [[ -f "$ao_home/data/ao.db" ]]; then
		schema_now="$(noetaxis_read_schema_version "$ao_home/data/ao.db" || true)"
	fi
	if [[ -n "$schema_now" && -n "$cap_schema_before" && "$schema_now" =~ ^[0-9]+$ && "$cap_schema_before" =~ ^[0-9]+$ && "$schema_now" -gt "$cap_schema_before" ]]; then
		if [[ "$update_rollback_restore_db" -eq 1 ]]; then
			noetaxis_update_say "the database was migrated from schema $cap_schema_before to $schema_now; restoring the backed-up database (--rollback-restore-db)"
			if noetaxis_update_quit_app "$app_path" && noetaxis_update_stop_daemon "$app_path" && noetaxis_update_stop_helpers "$app_path" && "$script_dir/rollback.sh" --backup-dir "$backup_dir" --restore-db && noetaxis_update_start_and_wait "$app_path" "the previous app with the restored database"; then
				noetaxis_update_append noetaxis_update_summary_extra "database restored from $backup_dir; previous app healthy"
				return 60
			fi
			noetaxis_update_note_user "The database restore after the failed update did not finish cleanly. Quit AO completely and run: \"$script_dir/rollback.sh\" --backup-dir \"$backup_dir\" --restore-db"
			return 61
		fi
		noetaxis_update_note_user "The new app migrated the database from schema $cap_schema_before to $schema_now and the previous app is not healthy with it. To restore the database too: quit AO completely, then run \"$script_dir/rollback.sh\" --backup-dir \"$backup_dir\" --restore-db (it saves the current database first), or rerun the update with --rollback-restore-db."
	else
		noetaxis_update_note_user "The previous app is back in place but did not become healthy within ${update_health_timeout}s (schema before: ${cap_schema_before:-unknown}, now: ${schema_now:-unknown}); the database was not changed by the failed update, so restoring it is not indicated. Check the app, then see $backup_dir."
	fi
	return 61
}

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------

noetaxis_update_exit_report() {
	local status="$1" now elapsed meaning
	[[ "$update_report_done" -eq 0 ]] || return 0
	update_report_done=1
	now="$(date '+%s')"
	elapsed=$((now - noetaxis_update_started_at))
	case "$status" in
		0) meaning="updated and healthy"; [[ "${update_noop:-0}" -ne 1 ]] || meaning="already up to date, nothing changed" ;;
		2) meaning="usage error, nothing changed" ;;
		20) meaning="refused: running inside an AO session (use --detached)" ;;
		21) meaning="refused: other processes block the install" ;;
		22) meaning="refused: ShipIt is running" ;;
		50) meaning="cancelled by you, nothing changed" ;;
		51) meaning="refused: live sessions (use --end-sessions)" ;;
		52) meaning="refused: session list unavailable" ;;
		53) meaning="a session could not be ended" ;;
		54) meaning="the desktop app did not quit" ;;
		55) meaning="the daemon did not stop" ;;
		56) meaning="chat hosts or helpers are still running" ;;
		60) meaning="new app unhealthy; previous app restored and healthy" ;;
		61) meaning="new app unhealthy; rollback needs your attention" ;;
		62) meaning="updated and healthy, but some post-install checks warn" ;;
		63) meaning="updated and healthy, but not every session came back" ;;
		*) meaning="failed (see the messages above)" ;;
	esac
	if [[ "$update_dry_run" -eq 1 && "$status" -eq 0 ]]; then
		printf '\n==== Dry run (exit 0): nothing was stopped, backed up or installed ====\n'
		return 0
	fi
	if [[ "$status" -ne 0 && -z "$noetaxis_update_summary_stopped" && -z "${backup_dir:-}" ]]; then
		printf '\n==== Update result (exit %s: %s). Nothing was stopped, backed up or installed. ====\n' "$status" "$meaning"
		return 0
	fi
	if [[ "$status" -ne 0 && "$status" -ne 60 && "$update_app_started" -eq 0 && -n "$noetaxis_update_summary_stopped" ]]; then
		noetaxis_update_note_user "AO was stopped by this run and is not running now. Reopen it with: open -a \"${target_app:-/Applications/$NOETAXIS_APP_NAME}\""
	fi
	printf '\n==== Update summary (exit %s: %s, %ss) ====\n' "$status" "$meaning" "$elapsed"
	printf 'Versions:  old %s  ->  new %s%s\n' "${cap_old_version:-none}" "${update_actual_new_version:-${noetaxis_update_new_version:-unknown}}" "$([[ "$update_rolled_back" -eq 1 ]] && printf '  (rolled back)')"
	if [[ -n "$noetaxis_update_summary_stopped" ]]; then
		printf 'Stopped:\n%s\n' "$(printf '%s\n' "$noetaxis_update_summary_stopped" | /usr/bin/sed 's/^/  - /')"
	else
		printf 'Stopped:   nothing\n'
	fi
	if [[ -n "${backup_dir:-}" ]]; then
		printf 'Backup:    %s\n' "$backup_dir"
		printf '           captured state: %s/state-before/   action log: %s/update-actions.log\n' "$backup_dir" "$backup_dir"
	else
		printf 'Backup:    none was created\n'
	fi
	if [[ -n "$noetaxis_update_summary_checks" ]]; then
		printf 'Checks:\n%s\n' "$(printf '%s\n' "$noetaxis_update_summary_checks" | /usr/bin/sed 's/^/  - /')"
	fi
	if [[ -n "$noetaxis_update_summary_restore" ]]; then
		printf 'Sessions:\n%s\n' "$(printf '%s\n' "$noetaxis_update_summary_restore" | /usr/bin/sed 's/^/  - /')"
	elif [[ "$cap_live_count" -gt 0 && "$update_end_sessions" -eq 1 && "$update_restore_sessions" -ne 1 ]]; then
		printf 'Sessions:  %s agent(s) stopped; resume with "ao session restore <id>" (or rerun with --restore-sessions). Ids:\n' "$cap_live_count"
		/usr/bin/awk -F "$noetaxis_sep" '{ printf "  - %s [%s]\n", $1, $2 }' "$cap_live_file"
	fi
	if [[ -n "$noetaxis_update_summary_extra" ]]; then
		printf 'Also:\n%s\n' "$(printf '%s\n' "$noetaxis_update_summary_extra" | /usr/bin/sed 's/^/  - /')"
	fi
	if [[ -n "$noetaxis_update_notes_user" ]]; then
		printf 'Left for you:\n%s\n' "$(printf '%s\n' "$noetaxis_update_notes_user" | /usr/bin/sed 's/^/  - /')"
	fi
	printf 'The bundled CLI is not on PATH in other terminals; use the full path: "%s/Contents/Resources/daemon/ao" status\n' "${target_app:-/Applications/$NOETAXIS_APP_NAME}"
	# Keep the captured state and the action log (it also holds every signal this run sent) with the backup.
	if [[ -n "${backup_dir:-}" && -d "$backup_dir" && -n "${update_capture_dir:-}" && -d "$update_capture_dir" ]]; then
		/bin/mkdir -p "$backup_dir/state-before"
		/bin/cp -R "$update_capture_dir/." "$backup_dir/state-before/" 2>/dev/null || true
		if [[ -f "$noetaxis_update_log_file" ]]; then
			/bin/cp "$noetaxis_update_log_file" "$backup_dir/update-actions.log" 2>/dev/null || true
		fi
	fi
}

# EXIT handler of update mode: the summary, then the temporary capture directory goes.
noetaxis_update_exit_handler() {
	noetaxis_update_exit_report "$1"
	if [[ -n "${update_capture_dir:-}" && -d "$update_capture_dir" ]]; then
		/bin/rm -rf "$update_capture_dir"
	fi
}

# Ask for administrator rights once, before anything is stopped, when the Applications
# folder is not writable by this user (a prompt in the middle of a stop would be too late).
noetaxis_update_prepare_privilege() {
	local apps_dir
	apps_dir="$(noetaxis_apps_dir)"
	if [[ "$(id -u)" -eq 0 || -w "$apps_dir" ]]; then
		return 0
	fi
	if ! command -v sudo >/dev/null 2>&1; then
		noetaxis_error "$apps_dir is not writable and sudo is not available; rerun from your own Terminal as an administrator. Nothing was stopped."
		return 27
	fi
	noetaxis_update_say "$apps_dir is not writable: asking for your administrator password once, before anything is stopped"
	if ! sudo -v; then
		noetaxis_error "Administrator permission was not granted, and the install needs it. Nothing was stopped (a --detached run has no terminal to ask on)."
		return 27
	fi
}

# After the swap: start the new app, require a healthy daemon, run the checks, restart what
# was asked for, and roll back automatically when the new app does not come up.
# Returns 0, 62 (checks warn), 63 (a session did not come back), 60 or 61 (rollback).
noetaxis_update_finish() {
	local app_path="$1" expected_version="$2" status_code=0
	if ! noetaxis_update_start_and_wait "$app_path" "the new app"; then
		noetaxis_update_auto_rollback "$update_health_detail" "$app_path" || status_code=$?
		return "$status_code"
	fi
	noetaxis_update_say "the new app is healthy: $update_health_detail"
	noetaxis_update_append noetaxis_update_summary_extra "new app started; $update_health_detail"
	noetaxis_update_post_checks "$app_path" "$expected_version"
	noetaxis_update_restart_multica "$app_path"
	if [[ "$update_restore_sessions" -eq 1 ]]; then
		noetaxis_update_restore_sessions "$app_path"
	fi
	if [[ "$update_post_warnings" -gt 0 ]]; then
		return 62
	fi
	if [[ "$update_restore_failed" -gt 0 ]]; then
		return 63
	fi
	return 0
}

# ---------------------------------------------------------------------------
# AO-session guard
# ---------------------------------------------------------------------------

# Variables a person sets on purpose to configure AO; they do not mean "this shell was started by
# AO". Any other AO_* variable (AO_SESSION_ID, AO_PROJECT_ID, AO_DATA_DIR ...) does.
noetaxis_update_config_variables="AO_MULTICA_DAEMON AO_MULTICA_PROFILE AO_MULTICA_SYNC AO_MULTICA_WATCH AO_KEEP_DAEMON"

# Returns 0 when this shell is not inside an AO session. Prints the offending variable names otherwise.
noetaxis_update_origin_ok() {
	local override="$1" name offending=""
	for name in $(compgen -e); do
		case "$name" in
			AO_*)
				case " $noetaxis_update_config_variables " in
					*" $name "*) ;;
					*) offending="$offending $name" ;;
				esac
				;;
		esac
	done
	if [[ "$override" -ne 1 && -n "$offending" ]]; then
		noetaxis_update_origin_detail="AO environment variables are set:$offending"
		return 1
	fi
	# The ancestry check of common.sh, with the configuration variables above set aside.
	if ! ( for name in $noetaxis_update_config_variables; do unset "$name"; done; noetaxis_check_safe_origin "$override" ) 2>/dev/null; then
		noetaxis_update_origin_detail="an Agent Orchestrator process is an ancestor of this command"
		return 1
	fi
	return 0
}
noetaxis_update_origin_detail=""

# ---------------------------------------------------------------------------
# --detached
# ---------------------------------------------------------------------------

# Re-run this script in a new session with nohup and a log file, then return. The AO session
# that started it ends when AO quits; the detached run does not. AO_* variables are removed
# from the child so its ao calls behave as they do in the user's own terminal.
noetaxis_update_detach() {
	local script_path="$1" log_file="$2"
	shift 2
	local unset_args=() name
	for name in $(compgen -e); do
		case "$name" in
			AO_*) unset_args+=(-u "$name") ;;
		esac
	done
	/bin/mkdir -p "$(/usr/bin/dirname "$log_file")"
	printf 'Update log: %s\n' "$log_file"
	printf 'The update continues in the background after this command returns. If you started it from an AO session, that session ENDS when AO quits; follow the progress with:\n  tail -f "%s"\n' "$log_file"
	: > "$log_file"
	NOETAXIS_DETACHED_CHILD=1 /usr/bin/env ${unset_args[@]+"${unset_args[@]}"} /usr/bin/nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/bash "$script_path" "$@" >> "$log_file" 2>&1 < /dev/null &
	printf 'Started in the background (pid %s).\n' "$!"
}
