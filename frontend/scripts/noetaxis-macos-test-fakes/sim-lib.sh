#!/bin/bash
# Shared helpers of the fake AO world used by the update-mode tests. Nothing here touches a
# real process, app, daemon, or network: the "process table" is a text file.
SIM="${NOETAXIS_SIM:?NOETAXIS_SIM must point at the simulation directory}"

sim_log() { printf '%s\n' "$*" >> "$SIM/calls.log"; }
sim_has() { [[ -e "$SIM/cfg/$1" ]]; }
sim_value() { cat "$SIM/cfg/$1" 2>/dev/null || true; }

sim_add_proc() {
	local pid
	pid=$(( $(cat "$SIM/nextpid" 2>/dev/null || echo 5000) + 1 ))
	printf '%s\n' "$pid" > "$SIM/nextpid"
	printf '%s|%s\n' "$pid" "$1" >> "$SIM/procs"
	printf '%s' "$pid"
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
