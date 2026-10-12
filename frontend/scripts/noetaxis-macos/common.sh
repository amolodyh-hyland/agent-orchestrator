#!/bin/bash
set -euo pipefail

NOETAXIS_APP_NAME="Agent Orchestrator.app"
NOETAXIS_BUNDLE_ID="dev.agent-orchestrator.desktop"
NOETAXIS_LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

# Run one of this script's OWN helper commands (ao, osascript, lsof, docker, multica, open ...) with a
# time limit. A SIGALRM alone does not bound a Go program (the Go runtime catches and ignores it, and
# the bundled ao is one), so the helper runs as a child of a small perl supervisor, in a process
# group of its own. At the deadline the supervisor sends that group SIGTERM, waits one second,
# then SIGKILL (also to descendants that outlive a leader that exited on TERM; the group id stays reserved because the leader is reaped only after the last signal), copies the helper's output (it wrote to private files) and prints "timed out" on stderr and exits 142 (143 when the script itself is
# interrupted). This is the ONLY place in the installer that can send SIGKILL, and it can only
# reach the process group of the helper command it started itself. It never touches AO's own
# processes (the app, daemon, chat hosts, agents), which are only ever sent SIGTERM, only by
# noetaxis_signal_own_pid in update-lib.sh, and only with --force.
noetaxis_bounded() {
	local seconds="$1"
	shift
	# Tests shorten every helper deadline with NOETAXIS_HELPER_TIMEOUT_MAX; it can only lower a limit.
	if [[ "${NOETAXIS_HELPER_TIMEOUT_MAX:-}" =~ ^[0-9]+$ && "$NOETAXIS_HELPER_TIMEOUT_MAX" -lt "$seconds" ]]; then
		seconds="$NOETAXIS_HELPER_TIMEOUT_MAX"
	fi
	# The helper's output is capped in size too: ulimit -f stops a runaway writer at twice the cap, the
	# supervisor stops it at the cap, and at most the cap is copied out (and said to be truncated).
	local max_bytes="${NOETAXIS_HELPER_OUTPUT_MAX:-4194304}"
	( ulimit -f "$(( max_bytes * 2 / 512 + 8 ))" 2>/dev/null; exec /usr/bin/perl -e '
		use Fcntl;
		use POSIX qw(:signal_h :sys_wait_h);
		my $blocked = POSIX::SigSet->new(SIGALRM, SIGTERM, SIGINT, SIGHUP);
		my $limit = shift @ARGV;
		my $max = shift @ARGV;
		# The helper writes into private files (mode 0600, unlinked at once), never into this
		# script'"'"'s pipes: a descendant that outlives the helper or ignores signals can then not hold
		# the caller'"'"'s command substitution open. The output is copied out after the helper is gone.
		my $dir = $ENV{TMPDIR} || "/tmp";
		sub private_file {
			my $path = sprintf("%s/noetaxis-helper.%d.%d.%d", $dir, $$, time, int(rand(1000000000)));
			sysopen(my $fh, $path, O_RDWR | O_CREAT | O_EXCL, 0600) or exit 127;
			unlink $path;
			return $fh;
		}
		my $out = private_file();
		my $err = private_file();
		my $child = fork();
		exit 127 unless defined $child;
		if (!$child) {
			setpgrp(0, 0);
			open(STDIN, "<", "/dev/null");
			open(STDOUT, ">&", $out) or exit 127;
			open(STDERR, ">&", $err) or exit 127;
			exec @ARGV;
			exit 127;
		}
		# The captured output is read from the private files (at most $max bytes each) and handed to the
		# caller by a short-lived COPIER child that makes ordinary blocking writes on the inherited
		# descriptors. This process never changes the flags of the descriptors it inherited (O_NONBLOCK belongs
		# to the open file description, which the caller shares), and a caller that does not drain its
		# pipe only blocks the copier: after two seconds the copier is terminated and the call fails (145).
		sub gather {
			my $cut = 0;
			my @data;
			for my $file ($out, $err) {
				$cut = 1 if (-s $file) > $max;
				seek($file, 0, 0);
				my $data = "";
				read($file, $data, $max);
				push @data, $data;
			}
			return ($cut, @data);
		}
		# The ONE TERM-then-KILL sequence of the installer. It is only ever aimed at a process group this
		# supervisor started itself (the helper, or the output copier) and whose leader it has NOT reaped,
		# so the group id is still reserved; the caller reaps only after this returned.
		sub end_group {
			my ($pgid, $grace) = @_;
			kill "TERM", -$pgid;
			select(undef, undef, undef, $grace);
			kill "KILL", -$pgid;
		}
		# Returns 0 when everything was written, 1 when the caller did not take it in time.
		sub deliver {
			my ($outdata, $errdata) = @_;
			my $copier = fork();
			return 1 unless defined $copier;
			# The copier leads a process group of its own (set on both sides of the fork, so there is no
			# window in which it still shares the supervisor group).
			setpgrp($copier, $copier) if $copier;
			if (!$copier) {
				setpgrp(0, 0);
				# The copier must be terminable and must end by itself. The inherited handlers only record a
				# flag, so they are reset to the default action WHILE the signals are still blocked, then the
				# signals are unblocked (a TERM that arrives in between stays pending and terminates it), and
				# an alarm ends it at the copy deadline even if no signal is ever sent to it.
				$SIG{TERM} = $SIG{ALRM} = $SIG{INT} = $SIG{HUP} = "DEFAULT";
				alarm 2;
				sigprocmask(SIG_UNBLOCK, $blocked);
				for my $pair ([\*STDOUT, $outdata], [\*STDERR, $errdata]) {
					my ($fh, $data) = @$pair;
					my $offset = 0;
					while ($offset < length($data)) {
						my $written = syswrite($fh, $data, length($data) - $offset, $offset);
						POSIX::_exit(1) unless defined $written;
						$offset += $written;
					}
				}
				POSIX::_exit(0);
			}
			my $until = time + 2;
			while (time < $until) {
				if (waitpid($copier, WNOHANG) == $copier) { return $? == 0 ? 0 : 1; }
				select(undef, undef, undef, 0.05);
			}
			# Not taken in time: end the copier (TERM, then KILL through the one sequence above), and only then
			# reap it, so this call never returns while the copier can still hold the pipe of the caller.
			end_group($copier, 0.2);
			for (1 .. 60) { last if waitpid($copier, WNOHANG) == $copier; select(undef, undef, undef, 0.05); }
			return 1;
		}
		# Group ownership: the helper'"'"'s process id (and so its group id) stays reserved for as long as
		# its leader is unreaped, so every signal below can only reach this helper'"'"'s own group. The
		# leader is therefore reaped ONLY (a) when it exits on its own before any deadline or
		# interruption, after which nothing is ever signalled, or (b) after the last signal was sent.
		# The signals that could start the stop sequence are blocked while the leader is polled and
		# reaped, so a handler can never run between a reap and a kill.
		my $fired = 0;
		$SIG{ALRM} = sub { $fired ||= 142; };
		$SIG{TERM} = $SIG{INT} = $SIG{HUP} = sub { $fired ||= 143; };
		alarm $limit;
		while (1) {
			sigprocmask(SIG_BLOCK, $blocked);
			unless ($fired) {
				if (waitpid($child, WNOHANG) == $child) {
					my $status = $?;
					alarm 0;
					my ($cut, $outdata, $errdata) = gather();
					$errdata .= "noetaxis: helper output exceeded $max bytes and was truncated: @ARGV\n" if $cut;
					exit 145 if deliver($outdata, $errdata);
					exit 144 if $cut;
					exit(($status & 127) ? 128 + ($status & 127) : ($status >> 8));
				}
				$fired = 144 if (-s $out) > $max || (-s $err) > $max;
			}
			last if $fired;
			sigprocmask(SIG_UNBLOCK, $blocked);
			select(undef, undef, undef, 0.05);
		}
		# Stop sequence, with the signals still blocked and the leader still unreaped.
		# Whoever is in the group after the grace (a hung leader, or descendants that outlived a leader that
		# exited on TERM) gets KILL; the leader is a zombie at worst, so the group id is ours.
		end_group($child, 1);
		for (1 .. 60) { last if waitpid($child, WNOHANG) == $child; select(undef, undef, undef, 0.05); }
		my ($cut, $outdata, $errdata) = gather();
		$errdata .= "noetaxis: helper command timed out after ${limit}s: @ARGV\n" if $fired == 142;
		$errdata .= "noetaxis: helper output exceeded $max bytes and was truncated: @ARGV\n" if $fired == 144 || $cut;
		deliver($outdata, $errdata);
		exit $fired;
	' "$seconds" "$max_bytes" "$@" )
}

# Start time of a process ("Mon Oct 12 04:33:21 2026"); with the pid it identifies one process.
noetaxis_process_start() {
	ps -ww -o lstart= -p "$1" 2>/dev/null | /usr/bin/tr -s ' ' | /usr/bin/sed 's/^ //; s/ $//' || true
}

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
	noetaxis_pattern_running "$1/Contents/"
}

noetaxis_shipit_running() {
	if pgrep -fl ShipIt >/dev/null 2>&1; then
		return 0
	fi
	return 1
}

# pgrep -f takes an extended regular expression. App paths come from APPS_DIR and may
# contain regex metacharacters (".", "(", "+"), so every pattern is escaped: a path
# must match literally, neither missing a real process nor matching a lookalike.
noetaxis_regex_escape() {
	printf '%s' "$1" | /usr/bin/sed 's/[]\\.*^$(){}?+|[]/\\&/g'
}

noetaxis_pattern_running() {
	pgrep -f "$(noetaxis_regex_escape "$1")" >/dev/null 2>&1
}

# Process ids (space separated, possibly empty) of the processes matching a pgrep pattern.
noetaxis_pattern_pids() {
	local pids
	pids="$(pgrep -f "$(noetaxis_regex_escape "$1")" 2>/dev/null | /usr/bin/tr '\n' ' ')" || true
	printf '%s' "${pids% }"
}

noetaxis_daemon_running() {
	noetaxis_pattern_running "$1/Contents/Resources/daemon/ao daemon"
}

noetaxis_desktop_running() {
	local app_path="$1"
	noetaxis_pattern_running "$app_path/Contents/MacOS/" || noetaxis_pattern_running "$app_path/Contents/Frameworks/"
}

noetaxis_desktop_pids() {
	local app_path="$1"
	printf '%s %s' "$(noetaxis_pattern_pids "$app_path/Contents/MacOS/")" "$(noetaxis_pattern_pids "$app_path/Contents/Frameworks/")" | /usr/bin/xargs
}

# Since the macOS tray ships in every build, Quit / Cmd+Q only closes AO's window: the
# Dock icon, the menu-bar tray and the app-owned daemon keep running, and so do the chat
# host processes that hold agent conversations. Only "Quit AO Completely" in the tray
# menu exits the app, after which the daemon stops itself about 5 seconds later. A
# "still running" result is therefore not always a mistake, and the right next step
# depends on which part is left. Nothing here ever quits or kills a process.
#
# Usage: noetaxis_assert_idle <app path> [allow background processes: 0|1]
# The desktop app and ShipIt always refuse. The daemon, chat hosts and other helper
# processes under the bundle refuse unless the caller passes 1 (the
# --allow-background-processes flag).
noetaxis_assert_idle() {
	local app_path="$1" allow_background="${2:-0}" cli pids found=""
	cli="$app_path/Contents/Resources/daemon/ao"
	if noetaxis_desktop_running "$app_path"; then
		pids="$(noetaxis_desktop_pids "$app_path")"
		noetaxis_error "The Agent Orchestrator desktop app is still running from $app_path${pids:+ (pid $pids)}. On macOS, Quit and Cmd+Q only close its window: the Dock icon, menu-bar tray and daemon stay up. Quit it completely yourself: click the Agent Orchestrator icon in the menu bar and choose \"Quit AO Completely\", then wait about 10 seconds for the daemon to stop and rerun this command. This command never quits AO or kills processes for you."
		return 21
	fi
	if noetaxis_pattern_running "$cli daemon"; then
		pids="$(noetaxis_pattern_pids "$cli daemon")"
		found="$found the AO daemon${pids:+ (pid $pids)}"
		if [[ "$allow_background" -ne 1 ]]; then
			noetaxis_error "The AO daemon is still running from $app_path${pids:+ (pid $pids)} although the desktop app is not. After \"Quit AO Completely\" it stops on its own within about 10 seconds; if it is still there (a crashed app, or a daemon started from a terminal), stop it yourself with: \"$cli\" stop    Stopping the daemon ends the work of every active session it manages (running agent turns and terminals), and agent chat hosts keep running until their sessions are ended separately, so make sure you do not need those sessions first. This command never stops it for you. To install anyway, rerun install.sh or rollback.sh with --allow-background-processes (the PKG installer has no override); stop the old daemon before opening the new app."
			return 21
		fi
	fi
	if noetaxis_pattern_running "$cli chat-host"; then
		pids="$(noetaxis_pattern_pids "$cli chat-host")"
		found="$found chat host processes${pids:+ (pid $pids)}"
		if [[ "$allow_background" -ne 1 ]]; then
			noetaxis_error "Agent chat host processes are still running from $app_path${pids:+ (pid $pids)}. They keep agent conversations alive while the daemon is replaced, so they survive both \"Quit AO Completely\" and \"ao stop\" and only end when their sessions end. Safe procedure: reopen AO, list the sessions with \"$cli\" session ls, let their turns finish or end them yourself, then quit completely again. Nothing here kills a host for you. To install anyway, rerun install.sh or rollback.sh with --allow-background-processes; the new daemon reattaches to hosts that are still compatible. The PKG installer has no override and keeps refusing while they run, so use install.sh."
			return 21
		fi
	fi
	if noetaxis_app_process_running "$app_path"; then
		if ! noetaxis_pattern_running "$cli daemon" && ! noetaxis_pattern_running "$cli chat-host"; then
			pids="$(noetaxis_pattern_pids "$app_path/Contents/")"
			found="$found other helper processes${pids:+ (pid $pids)}"
			if [[ "$allow_background" -ne 1 ]]; then
				noetaxis_error "Agent Orchestrator helper processes are still running from $app_path${pids:+ (pid $pids)}. Quit the app completely (menu-bar icon, \"Quit AO Completely\"), verify with: pgrep -fl \"$app_path/Contents/\"    and rerun. Helpers that serve live sessions (agent supervisors, terminal hosts) can outlive both a full quit and \"ao stop\" like chat hosts: reopen AO, list the sessions with \"$cli\" session ls, let them finish or end them yourself, then quit completely again. This command never kills processes for you. To install anyway, rerun with --allow-background-processes."
				return 21
			fi
		fi
	fi
	if noetaxis_shipit_running; then
		noetaxis_error "ShipIt is running. Wait for the updater to finish, then rerun this command."
		return 22
	fi
	if [[ -n "$found" ]]; then
		printf 'Warning: continuing with%s still running from %s because --allow-background-processes was given. They keep running from the previous app; stop the daemon with "%s" stop before opening the new app.\n' "$found" "$app_path" "$cli" >&2
	elif [[ -z "${noetaxis_port_warned:-}" ]]; then
		# Once per run: the install checks idle again after staging.
		noetaxis_port_warned=1
		noetaxis_warn_port_listener "$app_path"
	fi
}

# Process detection only sees a daemon whose command line names this app's bundle. A
# daemon left behind by an earlier --allow-background-processes install now runs from
# the moved backup copy and is invisible to it, yet still holds the daemon port. A
# listener on the default port is only a warning (the port is configurable and may
# belong to something else); the check is read-only and never fails or stops anything.
noetaxis_port_listener_pids() {
	local lsof_bin="${NOETAXIS_LSOF:-/usr/sbin/lsof}" port="${NOETAXIS_AO_PORT:-3001}" listener
	[[ -x "$lsof_bin" ]] || return 0
	listener="$(noetaxis_bounded 15 "$lsof_bin" -nP -iTCP:"$port" -sTCP:LISTEN -Fp 2>/dev/null | /usr/bin/sed -n 's/^p//p' | /usr/bin/tr '\n' ' ')" || true
	printf '%s' "${listener% }"
}

noetaxis_warn_port_listener() {
	local app_path="$1" port="${NOETAXIS_AO_PORT:-3001}" listener
	listener="$(noetaxis_port_listener_pids)"
	if [[ -n "$listener" ]]; then
		printf 'Warning: something is listening on port %s (pid %s), the default AO daemon port, although no AO process was found under %s. If it is an AO daemon from an earlier install (for example one left running by --allow-background-processes, now running from a backup copy), stop it yourself with the "ao stop" command of the bundled CLI, after checking you do not need its active sessions; stopping it interrupts them. Nothing is stopped for you.\n' "$port" "$listener" "$app_path" >&2
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
	local marker="${NOETAXIS_TEST_PAUSE_MARKER:-}"
	[[ -n "${NOETAXIS_TEST_PAUSE_AT:-}" && " $NOETAXIS_TEST_PAUSE_AT " == *" $1 "* ]] || return 0
	# The cleanup pause has its own marker so a test can tell the two pauses apart.
	[[ "$1" != cleanup-end ]] || marker="${marker:?}.cleanup"
	/usr/bin/touch "${marker:?}"
	/bin/sleep "${NOETAXIS_TEST_PAUSE_SECONDS:-20}" &
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
		# Dead only when ps ran and said so (ps sees pids of other users).
		if [[ "$owner" =~ ^[0-9]+$ ]] && ! noetaxis_pid_may_be_alive "$owner"; then
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
	local backup_dir="$1" app_backup="$2" app_version="$3" allow_background="${4:-0}" extra_lines="${5:-}" temporary_record
	temporary_record="$backup_dir/.BACKUP_COMPLETE-$$"
	if ! {
		printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		printf 'app_backup=%s\n' "$app_backup"
		printf 'app_version=%s\n' "$app_version"
		# Audit trail: this install went ahead with AO background processes still running.
		if [[ "$allow_background" -eq 1 ]]; then
			printf 'allow_background_processes=1\n'
		fi
		# Update mode records its mode and the schema it saw before the swap.
		if [[ -n "$extra_lines" ]]; then
			printf '%s\n' "$extra_lines"
		fi
	} > "$temporary_record"; then
		/bin/rm -f "$temporary_record"
		return 1
	fi
	if ! /bin/mv "$temporary_record" "$backup_dir/BACKUP_COMPLETE"; then
		/bin/rm -f "$temporary_record"
		return 1
	fi
	# Run by Installer as root, hand the state copies back to the user so they can inspect or delete them.
	if [[ "$(id -u)" -eq 0 ]]; then
		local user_name
		user_name="$(noetaxis_user_name)"
		if [[ -n "$user_name" && "$user_name" != root ]]; then
			/usr/sbin/chown -R -h "$(id -u "$user_name"):$(id -g "$user_name")" "$backup_dir" || true
		fi
	fi
}

noetaxis_schema_query() {
	/usr/bin/sqlite3 "${@:2}" "$1" 'select max(version_id) from goose_db_version where is_applied=1;'
}

# A WAL-mode database with no -wal/-shm files (the daemon is not running) cannot
# be opened with -readonly: SQLite would need to create the -shm file. Read a
# temporary copy in that case so the real data directory is never written.
# Prints the version and returns 0 (read directly), 2 (read from a temporary copy)
# or 1 (unreadable, nothing printed). Never fails the install.
noetaxis_read_schema_version() {
	local database="$1" version copy_dir
	if version="$(noetaxis_schema_query "$database" -readonly 2>/dev/null)"; then
		printf '%s' "$version"
		return 0
	fi
	copy_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/noetaxis-schema.XXXXXX")" || copy_dir=""
	if [[ -n "$copy_dir" ]]; then
		/bin/cp "$database" "$copy_dir/ao.db" 2>/dev/null || true
		[[ -f "$database-wal" ]] && { /bin/cp "$database-wal" "$copy_dir/ao.db-wal" 2>/dev/null || true; }
		version="$(noetaxis_schema_query "$copy_dir/ao.db" 2>/dev/null)" || version=""
		/bin/rm -rf "$copy_dir"
		if [[ -n "$version" ]]; then
			printf '%s' "$version"
			return 2
		fi
	fi
	return 1
}

# The check is informational and never fails the install.
noetaxis_print_schema_version() {
	local database="$1" version status=0
	version="$(noetaxis_read_schema_version "$database")" || status=$?
	case "$status" in
		0) printf 'SQLite schema version: %s\n' "$version" ;;
		2) printf 'SQLite schema version: %s (read from a temporary copy; the daemon is not running)\n' "$version" ;;
		*) printf 'SQLite schema version: could not be read from %s (non-fatal check; run the sqlite3 command from the README after opening the app).\n' "$database" ;;
	esac
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
	# The app is already installed at this point, so a failing check is a labelled warning.
	"$cli" version || printf 'WARNING: "ao version" failed; the install itself completed.\n'
	"$cli" spawn --help | /usr/bin/grep -- --effort || printf 'WARNING: the bundled ao CLI does not list spawn --effort; the install itself completed.\n'
	"$cli" project set-config --help | /usr/bin/grep -- --permission-fallback || printf 'WARNING: the bundled ao CLI does not list project set-config --permission-fallback; the install itself completed.\n'
	if [[ -f "$database" ]]; then
		noetaxis_print_schema_version "$database"
	else
		printf 'SQLite schema check skipped until the app has created %s.\n' "$database"
	fi
	printf '\nAfter opening the app from Finder, run:\n  "%s" status\n' "$cli"
}

# One install, update or rollback at a time: two of them swapping the same app, or one
# restoring a backup under another's stop, would corrupt both. The lock is a directory
# (mkdir is atomic) holding the owner's pid at <home>/.ao-install.lock. It is never taken over.
# A rollback.sh started by install.sh --update inherits the lock through NOETAXIS_LOCK_HELD_BY.
noetaxis_lock_held=0

# 0 when the pid may be alive. A pid is only declared dead when ps ran and said so: if ps cannot
# run or is refused (a sandbox, a missing binary), the owner is assumed alive and the lock stands.
noetaxis_pid_may_be_alive() {
	local pid="$1" output status=0
	# No readable pid (the creator has not written it yet, or the file is damaged) is unknown, and
	# unknown fails closed: the owner may be alive.
	[[ "$pid" =~ ^[0-9]+$ ]] || return 0
	output="$("${NOETAXIS_PS:-/bin/ps}" -p "$pid" 2>&1)" || status=$?
	if [[ "$status" -eq 0 ]]; then
		return 0
	fi
	if [[ "$status" -eq 1 && "$output" != *[Dd]enied* && "$output" != *"not permitted"* && "$output" != *"not found"* && "$output" != *rror* ]]; then
		return 1
	fi
	return 0
}

# The lock is never taken over. A lock whose owner is gone (a run killed with SIGKILL, or a power
# loss) stays until a person removes it: reclaiming it automatically would need a compare-and-delete
# that the filesystem does not offer, and every attempt races with a live run that publishes its own
# lock in the meantime. A normal exit, INT, TERM or HUP releases the lock through the EXIT trap.
noetaxis_acquire_lock() {
	local user_home="$1" lock holder
	lock="$user_home/.ao-install.lock"
	if [[ -n "${NOETAXIS_LOCK_HELD_BY:-}" && "$(/bin/cat "$lock/pid" 2>/dev/null || true)" == "$NOETAXIS_LOCK_HELD_BY" ]]; then
		return 0
	fi
	if ! /bin/mkdir "$lock" 2>/dev/null; then
		holder="$(/bin/cat "$lock/pid" 2>/dev/null || true)"
		# The creator makes the directory and writes its pid a moment later: give it time.
		local waited=0
		while [[ ! "$holder" =~ ^[0-9]+$ && "$waited" -lt 20 ]]; do
			/bin/sleep 0.1
			waited=$((waited + 1))
			holder="$(/bin/cat "$lock/pid" 2>/dev/null || true)"
		done
		if noetaxis_pid_may_be_alive "$holder"; then
			noetaxis_error "Another install, update or rollback is running (pid ${holder:-unknown}, lock $lock). Wait for it to finish; two at once could corrupt the app or the backup. If you are sure no run is active (the lock has no readable owner), remove the lock yourself: rm -rf \"$lock\""
		else
			noetaxis_error "A previous install, update or rollback (pid $holder) left its lock behind and is no longer running (it was killed or the machine lost power). This command never removes a lock by itself. Check that no install is running, then remove it and rerun: rm -rf \"$lock\""
		fi
		return 36
	fi
	printf '%s' "$$" > "$lock/pid"
	noetaxis_lock_held="$lock"
}

noetaxis_release_lock() {
	if [[ "$noetaxis_lock_held" != 0 && -d "$noetaxis_lock_held" && "$(/bin/cat "$noetaxis_lock_held/pid" 2>/dev/null || true)" == "$$" ]]; then
		/bin/rm -rf "$noetaxis_lock_held"
	fi
	noetaxis_lock_held=0
}
