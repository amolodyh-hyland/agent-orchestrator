#!/bin/bash
# Shared helpers of the fake AO world used by the update-mode tests. Nothing here touches a
# real process, app, daemon, or network: the "process table" is a text file.
SIM="${NOETAXIS_SIM:?NOETAXIS_SIM must point at the simulation directory}"

sim_unlock() { if [[ "${SIM_LOCKED:-0}" -eq 1 ]]; then /bin/rmdir "$SIM/.table-lock"; SIM_LOCKED=0; fi; }
sim_lock() {
	[[ "${SIM_LOCKED:-0}" -ne 1 ]] || return 0
	local attempt=0
	until /bin/mkdir "$SIM/.table-lock" 2>/dev/null; do
		attempt=$((attempt + 1)); [[ "$attempt" -lt 1000 ]] || exit 1
		/bin/sleep 0.01
	done
	SIM_LOCKED=1
}
sim_lock
trap sim_unlock EXIT

sim_log() { printf '%s\n' "$*" >> "$SIM/calls.log"; }
sim_has() { [[ -e "$SIM/cfg/$1" ]]; }
sim_value() { cat "$SIM/cfg/$1" 2>/dev/null || true; }

sim_add_proc() {
	local pid command="$1" app executable
	pid=$(( $(cat "$SIM/nextpid" 2>/dev/null || echo 5000) + 1 ))
	printf '%s\n' "$pid" > "$SIM/nextpid"
	printf '%s|%s\n' "$pid" "$1" >> "$SIM/procs"
	app="${command%%/Contents/*}"
	case "$command" in
		*/Contents/Resources/daemon/ao*) executable="$app/Contents/Resources/daemon/ao" ;;
		*/Contents/MacOS/*) executable="$app/Contents/MacOS/Agent Orchestrator" ;;
		*/Contents/Frameworks/*) executable="$app/Contents/Frameworks/fake-helper" ;;
		*) executable="/bin/bash" ;;
	esac
	printf '%s|%s\n' "$pid" "$executable" >> "$SIM/executables"
	printf '%s|1\n' "$pid" >> "$SIM/ppids"
	printf '%s' "$pid"
}

sim_ppid_of() {
	local pid="$1" row parent
	while IFS='|' read -r row parent; do
		if [[ "$row" == "$pid" ]]; then printf '%s' "$parent"; return; fi
	done < "$SIM/ppids"
	printf '1'
}

sim_end_session_agents() {
	local session="$1" row agent_session delay
	while IFS='|' read -r row agent_session; do
		[[ "$agent_session" == "$session" ]] || continue
		if sim_has agents_survive; then continue; fi
		delay="$(sim_value agents_exit_ticks)"
		sim_timer "${delay:-2}" "sim_remove_pid '$row'"
	done < "$SIM/agents"
}

# Remove processes whose command line starts with the given prefix.
sim_remove_prefix() {
	/usr/bin/awk -v prefix="$1" '{ command = substr($0, index($0, "|") + 1); if (index(command, prefix) != 1) print }' "$SIM/procs" > "$SIM/procs.tmp"
	/bin/mv "$SIM/procs.tmp" "$SIM/procs"
}

sim_remove_pid() {
	/usr/bin/awk -F '|' -v pid="$1" '$1 != pid' "$SIM/procs" > "$SIM/procs.tmp"
	/bin/mv "$SIM/procs.tmp" "$SIM/procs"
}

sim_command_of() {
	/usr/bin/awk -F '|' -v pid="$1" '$1 == pid { print substr($0, index($0, "|") + 1) }' "$SIM/procs"
}

sim_app_running_daemon() {
	/usr/bin/grep -qF -- "|$1/Contents/Resources/daemon/ao daemon" "$SIM/procs" 2>/dev/null
}

sim_quit_bundle() {
	if [[ -f "$SIM/cfg/exec_after_quit" ]]; then
		local pid executable
		IFS='|' read -r pid executable < "$SIM/cfg/exec_after_quit"
		/usr/bin/awk -F '|' -v pid="$pid" -v executable="$executable" '$1 == pid { print $1 "|" executable; next } { print }' "$SIM/executables" > "$SIM/executables.tmp"
		/bin/mv "$SIM/executables.tmp" "$SIM/executables"
	fi
	# Test hook: a process id is reused (new start time) once the app has been asked to quit.
	if [[ -f "$SIM/cfg/reuse_pid_after_quit" ]]; then printf 'Tue Oct 13 11:11:11 2026\n' > "$SIM/cfg/lstart_$(cat "$SIM/cfg/reuse_pid_after_quit")"; fi
	if [[ -f "$SIM/cfg/foreign_after_quit" ]]; then /bin/cp "$SIM/cfg/foreign_after_quit" "$SIM/cfg/foreign_status_versions"; fi
	sim_remove_prefix "$1/Contents/MacOS/"
	sim_remove_prefix "$1/Contents/Frameworks/"
	if ! sim_has daemon_stays; then
		sim_timer "${DAEMON_TICKS:-4}" "sim_stop_daemon '$1'"
	fi
}

sim_stop_daemon() {
	sim_remove_prefix "$1/Contents/Resources/daemon/ao daemon"
	if sim_has chat_hosts_die_with_daemon; then
		sim_remove_prefix "$1/Contents/Resources/daemon/ao chat-host"
	fi
}

# Timers count down once per fake pgrep call, so waits finish deterministically.
sim_timer() {
	/bin/mkdir -p "$SIM/timers"
	printf '%s|%s\n' "$1" "$2" > "$SIM/timers/$RANDOM$RANDOM"
}

sim_tick() {
	local file n action
	for file in "$SIM"/timers/*; do
		[[ -f "$file" ]] || continue
		IFS='|' read -r n action < "$file"
		n=$((n - 1))
		if [[ "$n" -le 0 ]]; then
			/bin/rm -f "$file"
			eval "$action"
		else
			printf '%s|%s\n' "$n" "$action" > "$file"
		fi
	done
}

sim_json_escape() {
	printf '%s' "$1" | /usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g' | /usr/bin/awk '{ gsub(/\t/, "\\t"); printf "%s", $0 }'
}

sim_schema() {
	/usr/bin/sqlite3 "$HOME/.ao/data/ao.db" 'select max(version_id) from goose_db_version where is_applied=1;' 2>/dev/null || true
}
