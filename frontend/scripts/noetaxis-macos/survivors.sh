#!/bin/bash

noetaxis_process_cwd() {
	local raw line
	raw="$(noetaxis_bounded 5 "${NOETAXIS_LSOF:-/usr/sbin/lsof}" -a -p "$1" -d cwd -Fn 2>/dev/null)" || return 1
	while IFS= read -r line; do
		if [[ "$line" == n/* ]]; then printf '%s' "${line#n}"; return 0; fi
	done <<< "$raw"
	return 1
}

noetaxis_ao_marker() {
	local command_line="$1" cwd="$2" home="${ao_home:-$(noetaxis_ao_home)}" directory
	if [[ "$cwd" == /* && -d "$cwd" ]]; then
		directory="$(cd -P "$cwd" && pwd -P)" || return 1
		while [[ -n "$directory" ]]; do
			[[ "$directory" -ef "$home" ]] && return 0
			directory="${directory%/*}"
		done
	fi
	[[ "$command_line" != *'/../'* && "$command_line" != *'/./'* ]] || return 1
	printf '%s\n' "$command_line" | /usr/bin/grep -E "(^|[[:space:]\"'=])$(noetaxis_regex_escape "$home/")" >/dev/null
}

noetaxis_fixture_marker() {
	local command_line="$1" base="${TMPDIR:-/tmp}" physical
	base="${base%/}"
	physical="$(cd -P "$base" 2>/dev/null && pwd -P)" || physical="$base"
	printf '%s\n' "$command_line" | /usr/bin/grep -E "(^|[[:space:]\"'])($(noetaxis_regex_escape "$base/")|$(noetaxis_regex_escape "$physical/"))noetaxis-(watchdog|bounded|trace|copier|cap|helperdelay|undrained|flags)-[^/[:space:]]+/" >/dev/null
}

# kind, pid, ppid, start, executable, command, chain, cwd, eligible (unit-separated).
noetaxis_survivor_scan() {
	local app_path="$1" out="$2" table="$2.table" seeds="$2.seeds" chosen="$2.chosen"
	local raw pid parent weekday month day clock year command_line started info executable cwd kind eligible chain previous old_kind old_pid old_parent old_start old_exe old_command old_chain old_cwd old_eligible
	local sep="$noetaxis_sep" bundle_mentions history
	: > "$out" || return 56
	: > "$table" || return 56
	: > "$seeds" || return 56
	bundle_mentions=" $( { pgrep -if "$(noetaxis_regex_escape "$app_path/Contents/")" 2>/dev/null || true; } | /usr/bin/tr '\n' ' ') "
	if ! raw="$("${NOETAXIS_PS:-/bin/ps}" -ww -axo pid=,ppid=,lstart=,command= 2>/dev/null)"; then
		noetaxis_error 'Cannot complete the survivor process inventory; nothing may be swapped.'
		return 56
	fi
	while IFS= read -r info; do
		read -r pid parent weekday month day clock year command_line <<< "$info"
		[[ "$pid" =~ ^[0-9]+$ && "$parent" =~ ^[0-9]+$ && -n "$year" && "$pid" -ne "$$" ]] || continue
		printf '%s\t%s\n' "$pid" "$parent" >> "$table" || return 56
		if [[ "$bundle_mentions" == *" $pid "* ]]; then printf '%s\ta\n' "$pid" >> "$seeds"; fi
		if [[ "$parent" -eq 1 ]]; then
			cwd="$(noetaxis_process_cwd "$pid" || true)"
			if noetaxis_ao_marker "$command_line" "$cwd"; then printf '%s\tb\n' "$pid" >> "$seeds"; fi
		fi
		if noetaxis_fixture_marker "$command_line"; then printf '%s\tc\n' "$pid" >> "$seeds"; fi
	done <<< "$raw"
	for history in "${cap_survivors_file:-}" "${cap_survivors_confirmed_file:-}"; do
		[[ -f "$history" && "$out" != "$history" ]] || continue
		while IFS="$sep" read -r old_kind old_pid old_parent old_start old_exe old_command old_chain old_cwd old_eligible; do
			info="$(noetaxis_process_info "$old_pid")" || continue
			IFS=$'\t' read -r pid parent started command_line <<< "$info"
			[[ "$started" != "$old_start" ]] || printf '%s\t%s\n' "$pid" "$old_kind" >> "$seeds"
		done < "$history"
	done
	/usr/bin/awk -F '\t' 'FILENAME == ARGV[1] { kind[$1] = $2; next } { parent[$1] = $2 } END { for (n = 0; n < 64; n++) for (p in parent) if (!(p in kind) && parent[p] in kind) kind[p] = kind[parent[p]]; for (p in kind) print p "\t" kind[p] }' "$seeds" "$table" > "$chosen" || return 56
	while IFS=$'\t' read -r pid kind; do
		info="$(noetaxis_process_info "$pid")" || continue
		IFS=$'\t' read -r pid parent started command_line <<< "$info"
		executable="$(noetaxis_process_executable_path "$pid" || true)"
		cwd="$(noetaxis_process_cwd "$pid" || true)"
		eligible=0
		chain="$(noetaxis_process_ancestor_chain "$pid" | /usr/bin/awk -F '\t' 'BEGIN { ORS="" } { printf "%s%s", (NR == 1 ? "" : " -> "), $1; tail = $2 } END { if (NR > 0) printf " -> %s", tail }')"
		chain="$pid -> ${chain:-$parent}"
		if [[ -n "$executable" ]]; then
			case "$kind" in
				a)
					if noetaxis_executable_path_is_in_bundle "$app_path" "$executable" || noetaxis_deleted_process_bundle_session "$app_path" "$pid" >/dev/null; then eligible=1; fi
					for history in "${cap_survivors_file:-}" "${cap_survivors_confirmed_file:-}"; do
						[[ "$eligible" -eq 0 && -f "$history" && "$out" != "$history" ]] || continue
						previous="$(/usr/bin/awk -F "$sep" -v pid="$pid" '$2 == pid { print; exit }' "$history")"
						IFS="$sep" read -r old_kind old_pid old_parent old_start old_exe old_command old_chain old_cwd old_eligible <<< "$previous"
						if [[ "$started" == "$old_start" && "$executable" == "$old_exe" && "$command_line" == "$old_command" && "$old_eligible" == 1 ]]; then eligible=1; fi
					done
					;;
				b) if noetaxis_ao_marker "$command_line" "$cwd"; then eligible=1; fi ;;
				c) if noetaxis_fixture_marker "$command_line"; then eligible=1; fi ;;
			esac
		fi
		if [[ "$command_line$cwd$executable" == *"$sep"* || "$command_line$cwd$executable" == *$'\n'* ]]; then
			noetaxis_error "Cannot safely represent survivor pid $pid; end it manually through its session and rerun. Nothing may be swapped."
			return 56
		fi
		[[ "$(noetaxis_process_info "$pid")" == "$info" ]] || eligible=0
		printf '%s\n' "$kind$sep$pid$sep$parent$sep$started$sep$executable$sep$command_line$sep$chain$sep$cwd$sep$eligible" >> "$out" || return 56
	done < "$chosen"
}

noetaxis_survivor_report() {
	local file="$1" kind pid parent started executable command_line chain cwd eligible heading wanted
	for wanted in a b c; do
		case "$wanted" in a) heading='Bundle descendants (current or confirmed ancestry)' ;; b) heading='Anchored AO orphans and their children' ;; c) heading='Leaked installer test fixtures (manual cleanup only)' ;; esac
		printf '\n%s:\n' "$heading" >&2
		while IFS="$noetaxis_sep" read -r kind pid parent started executable command_line chain cwd eligible; do
			[[ "$kind" == "$wanted" ]] || continue
			printf '  pid %s, ppid %s, chain %s\n    %s\n    cwd: %s\n' "$pid" "$parent" "$chain" "$command_line" "${cwd:-unavailable}" >&2
			if [[ "$eligible" -ne 1 ]]; then
				printf '    Identity unverified/deleted executable: never signal this PID. End its session through the app or ao session exit-agent, then rerun.\n' >&2
				continue
			fi
			printf '    Verified stop command (TERM, 3s grace, identity recheck, KILL):\n    /bin/bash -c ' >&2
			printf '%q ' '. "$1/common.sh"; . "$1/survivors.sh"; ao_home="$2"; TMPDIR="$3"; shift 3; if noetaxis_survivor_matches "$@"; then /bin/kill -TERM "$2"; /bin/sleep 3; if noetaxis_survivor_matches "$@"; then /bin/kill -KILL "$2"; fi; fi' noetaxis "$script_dir" "${ao_home:-$(noetaxis_ao_home)}" "${TMPDIR:-/tmp}" "$kind" "$pid" "$parent" "$started" "$executable" "$command_line" "$chain" "$cwd" "$eligible" >&2
			printf '\n' >&2
		done < "$file"
	done
	noetaxis_survivor_respawners
}

noetaxis_survivor_respawners() {
	local file content found=0
	printf '\nPotential respawners (reported only; nothing is unloaded):\n' >&2
	noetaxis_bounded 5 "${NOETAXIS_LAUNCHCTL:-/bin/launchctl}" list 2>/dev/null | /usr/bin/grep -Ei 'agent[ ._-]*orchestrator|dev\.agent-orchestrator|noetaxis' >&2 || true
	for file in "${user_home:-$(noetaxis_user_home)}/Library/LaunchAgents/"*.plist; do
		[[ -f "$file" ]] || continue
		content="$(/usr/bin/plutil -convert xml1 -o - "$file" 2>/dev/null || true)"
		if printf '%s' "$content" | /usr/bin/grep -Fq "${target_app:-/Applications/Agent Orchestrator.app}"; then printf '  %s\n' "$file" >&2; found=1; fi
	done
	[[ "$found" -eq 0 ]] || printf 'Disable the listed relaunch job yourself before retrying if it recreates survivors.\n' >&2
}

noetaxis_survivor_matches() {
	local kind="$1" pid="$2" parent="$3" started="$4" executable="$5" command_line="$6" chain="$7" cwd="$8" eligible="$9" info current_pid current_parent current_start current_command current_exe
	[[ "$eligible" == 1 ]] || return 1
	info="$(noetaxis_process_info "$pid")" || return 1
	IFS=$'\t' read -r current_pid current_parent current_start current_command <<< "$info"
	current_exe="$(noetaxis_process_executable_path "$pid")" || return 1
	[[ "$current_start" == "$started" && "$current_command" == "$command_line" && "$current_exe" == "$executable" ]] || return 1
	if [[ "$kind" == b ]]; then noetaxis_ao_marker "$current_command" "$(noetaxis_process_cwd "$pid" || true)" || return 1; fi
	if [[ "$kind" == c ]]; then noetaxis_fixture_marker "$current_command" || return 1; fi
	[[ "$(noetaxis_process_info "$pid")" == "$info" ]]
}

noetaxis_survivor_signal() {
	local signal="$1"; shift
	[[ "${update_kill_survivors:-0}" -eq 1 && "${update_survivors_confirmed:-0}" -eq 1 && ( "$signal" == TERM || "$signal" == KILL ) ]] || return 1
	[[ "$1" != c ]] || return 1
	noetaxis_update_say "checking survivor pid $2 before SIG$signal (typed --kill-survivors confirmation)"
	noetaxis_survivor_matches "$@" || return 1
	NOETAXIS_CONFIRMED_SURVIVOR=1 "${NOETAXIS_KILL:-/bin/kill}" "-$signal" "$2" || return 1
	noetaxis_update_say "SIG$signal sent to verified survivor pid $2"
}

noetaxis_survivor_targets_gone() {
	local kind pid parent started executable command_line chain cwd eligible info actual ppid current_start command
	while IFS="$noetaxis_sep" read -r kind pid parent started executable command_line chain cwd eligible; do
		info="$(noetaxis_process_info "$pid")" || continue
		IFS=$'\t' read -r actual ppid current_start command <<< "$info"
		[[ "$current_start" != "$started" ]] || return 1
	done < "$1"
}

noetaxis_update_survivors() {
	local app_path="$1" file="$cap_dir/survivors-current.tsv" ordered="$cap_dir/survivors-approved.tsv" answer expected ids signal kind pid parent started executable command_line chain cwd eligible
	noetaxis_survivor_scan "$app_path" "$file" || return 56
	[[ -s "$file" ]] || return 0
	noetaxis_survivor_report "$file"
	if [[ "${update_kill_survivors:-0}" -ne 1 ]]; then
		noetaxis_error 'Survivors remain. Nothing will be swapped. Use the listed verified stop commands, or rerun with --kill-survivors for a typed confirmation. Unverified processes must be ended through their sessions.'
		return 56
	fi
	if /usr/bin/awk -F "$noetaxis_sep" '$1 == "c" || $9 != 1 { found = 1 } END { exit !found }' "$file"; then
		noetaxis_error '--kill-survivors cannot signal unverified/deleted executable PIDs or test fixtures outside the bundle/AO anchors. End those manually first; nothing was signalled.'
		return 56
	fi
	/usr/bin/awk -F "$noetaxis_sep" '{ depth = split($7, parts, " -> "); print depth "\t" $0 }' "$file" | /usr/bin/sort -rn | /usr/bin/cut -f2- > "$ordered" || return 56
	ids="$(/usr/bin/awk -F "$noetaxis_sep" '{ printf "%s%s", (NR == 1 ? "" : " "), $2 }' "$ordered")" || return 56
	expected="kill survivors $ids"
	update_survivors_prompted=1
	printf 'These verified PIDs will receive TERM, then KILL after a bounded grace if their identities still match. Children are signalled before parents.\nType exactly: %s\n> ' "$expected"
	IFS= read -r answer || answer=""
	[[ "$answer" == "$expected" ]] || { noetaxis_error 'Survivor teardown cancelled; no survivor PID was signalled.'; return 50; }
	cap_survivors_confirmed_file="$ordered"
	update_survivors_confirmed=1
	for signal in TERM KILL; do
		while IFS="$noetaxis_sep" read -r kind pid parent started executable command_line chain cwd eligible; do
			noetaxis_survivor_signal "$signal" "$kind" "$pid" "$parent" "$started" "$executable" "$command_line" "$chain" "$cwd" "$eligible" || true
		done < "$ordered"
		noetaxis_wait_until "confirmed survivors after $signal" "$update_stop_timeout" noetaxis_survivor_targets_gone "$ordered" || true
	done
	update_survivors_confirmed=0
	noetaxis_survivor_scan "$app_path" "$file" || return 56
	if [[ -s "$file" ]]; then
		noetaxis_survivor_report "$file"
		noetaxis_error 'Final survivor scan is not empty (possibly a respawner or changed identity). Nothing will be swapped.'
		return 56
	fi
}
