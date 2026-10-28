# Custom AO macOS build

This flow creates an arm64 desktop app, `MANIFEST.sha256`, an unsigned installer package, a compressed disk image, an `installer/` directory, and `SHA256SUMS`. It does not install the app or publish any artifact.

## Build

Run from the AO fork checkout on an Apple Silicon Mac with macOS, Node 24, npm 11, Go 1.27.1 or newer, Xcode command line tools, and Corepack available.

**Company machines (default):** join the company VPN first. Every npm and pnpm registry request is pinned to the internal ProGet endpoint `https://proget.onbase.net/npm/npm`. Package credentials are read through the normal npm configuration and are never printed by these scripts. `COREPACK_INTEGRITY_KEYS=0` is set only for the pnpm install step because the mirror has no npm signature metadata; the pnpm tarball is not hash-pinned.

```bash
node frontend/scripts/noetaxis-macos/build.mjs
```

**Personal Macs (explicit opt-in):** use the public npm registry without the company VPN or company npm credentials:

```bash
node frontend/scripts/noetaxis-macos/build.mjs --public-registry
```

This mode selects `https://registry.npmjs.org/` for both AO installs, the pinned browser license package, Corepack's pnpm download, the Multica pnpm install/build, and child steps such as the ACP runtime install. It uses empty temporary user/global npm configurations, replaces project npm configuration only in the temporary build copies (preserving Multica's hoisting setting), and removes inherited npm configuration and npm/Corepack authentication variables. Corepack uses a fresh temporary cache with normal signature verification. Lockfile registry URLs are routed to public npm; unknown HTTP package download endpoints stop the build. A failed request stops the build without switching registries.

`--public-registry` overrides `NOETAXIS_NPM_REGISTRY`. The existing `--registry <url>` option must match the selected mode: ProGet without the flag, public npm with the flag. Setting `--registry https://registry.npmjs.org/` or `NOETAXIS_NPM_REGISTRY` alone does not opt in. Only these two endpoints are supported; credentials, query strings, fragments, alternate ports and other registries are rejected. `--help` lists both modes. `BUILD-INFO.txt` records the selected registry host.

Dependency check at AO `ab2b4da93`: all eight npm lockfiles contain no Hyland-only packages or private download hosts. Downloads use public npm, local workspace links, and the public `electron/node-gyp` GitHub repository. The Multica `pnpm-lock.yaml` at `4b32bc7710753a6d97277c3833a4d7d19e48b2f7` (the revision pinned by `backend/go.mod`) has no private registry/tarball URLs or internal package scopes; its local packages use workspace links. Recheck dependencies when changing either source revision.

Not every network request is a registry request. Both modes also contact `github.com` (the Multica fork, the `electron/node-gyp` source and the checksum-pinned browser release binary), the Electron binary download used by Electron Forge, `nodejs.org` for the packaged ACP runtime, and the Go module proxy. GitHub access to the source forks is still required. Company machines should keep the default VPN/ProGet path and allow these additional downloads under company policy.

The default source is `HEAD` of the checkout running the command. To select a commit or tag and output location:

```bash
node frontend/scripts/noetaxis-macos/build.mjs \
  --ref 8e2bc21fd5d95c525f536dc03b5e7b7f10b04c7c \
  --base-version 0.13.4 \
  --output "$HOME/ao-builds/noetaxis-8e2bc21"
```

The default version is `0.13.4-noetaxis.<shortsha>`. `--base-version` selects another three-part base version. Multica's desktop source is checked out at the pseudo-version revision pinned by the selected `backend/go.mod`; the daemon uses the same Go module pin. The build runs in temporary worktrees and writes final artifacts outside the AO checkout and `/Applications`.

This build and the macOS `build:daemon` script force `CGO_ENABLED=1` and verify it with `go env` before building. Native ACL checks require cgo for managed-policy delegation. The legacy `packages/build-binaries.sh` cross-builds remain without cgo; those macOS binaries allow personal unmanaged confirmation but block managed-policy delegation with `policy_unavailable`. Their empty-location checks enforce root ownership, safe mode bits and no symlinks, but cannot detect ACL write/delete grants: this is a residual risk of no-cgo builds. The shipped desktop builds require cgo and validate those ACLs.

The output contains:

- `Applications/Agent Orchestrator.app`
- `MANIFEST.sha256`, covering regular files in the app bundle
- `Agent-Orchestrator-<version>-arm64.pkg`
- `Agent-Orchestrator-<version>-arm64.dmg`
- `BUILD-INFO.txt`
- `HUMAN-INSTALL.md`, the human install guide generated from `human-install.md`
- `installer/`, including the matching update, install, rollback, survivor helpers and PKG scripts
- `SHA256SUMS`, covering the installer, packages, manifest and build information (the app itself is covered by `MANIFEST.sha256`)

The app is signed with an ad-hoc signature (`codesign --sign -`). It has no Apple Developer ID, certificate chain, or notarization ticket. The PKG and DMG are unsigned. `MANIFEST.sha256` detects corruption and unlisted files; it sits next to the app, so it is not tamper protection. The PKG has not been run through Installer.app (Installer compares `CFBundleVersion` before the scripts run, so it may skip an upgrade between `-noetaxis` builds); the script install from the build output is the verified path. The app contains `Resources/ao-updates-disabled`; rebuild and reinstall from a reviewed source ref to update it.

## Update with one command

**`update.sh --fast` is RECOMMENDED for routine updates**, run from **your own Terminal**. It verifies the build, shows a short plan, asks for `yes` once, quits AO completely, backs up, swaps the app, relaunches and checks health. Sessions will be restored by AO on launch. `update.sh` is equivalent to `install.sh --update`; omitting `--fast` retains the original cautious updater described below. The default `install.sh` (no `--update`) still never stops anything.

```bash
ART="$HOME/ao-builds/noetaxis-<shortsha>"      # the build folder: it holds Applications/ and installer/
AO="/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao"

"$ART/installer/update.sh" --fast --dry-run    # verify and print the short plan; changes nothing
"$ART/installer/update.sh" --fast              # RECOMMENDED: plan, then type "yes" once
"$ART/installer/update.sh" --fast --yes        # the same routine update without a question
```

`ao` is usually **not on `PATH` in other terminals** (it is only the CLI bundled inside the app), so every command in this document and every command the scripts print uses the full path `"$AO"` above. The `.app` argument is optional: it defaults to `../Applications/Agent Orchestrator.app` next to `installer/`.

### Fast mode

Fast mode checks `SHA256SUMS` from the complete build folder, `MANIFEST.sha256`, app signature and version. It stages and verifies the app before stopping anything. It uses the same selected state backup (`ao.db` plus WAL/SHM, `app-state.json`, `update-settings.json`, `editor-settings.json`) and old-app backup as the cautious updater, with `BACKUP_COMPLETE` written before moving the old app. State is copied after shutdown so the backup includes AO's final writes. Capture scratch stays in a private directory under the human's home, outside `/tmp`.

It tries the System Events tray click; if permissions are denied it tells you to click **Quit AO Completely** and waits in the same run for up to 120 seconds. `--manual-quit` skips scripting. It waits briefly for the daemon to stop, then uses `ao stop` if necessary, after the existing daemon identity check. A foreign daemon is never stopped. Helpers do not prolong the manual quit wait: after the main app quits, all remaining verified bundle executables get a separate wait of up to 60 seconds, then TERM, a five-second grace, an executable/start-time/command identity recheck, and KILL if still verified. Each signal is logged. Unverified executables, deleted executable identities, external agent CLIs and other apps are never signalled. External agent CLI candidates wait at most ten seconds and are then listed as informational; their continued existence does not block the swap. ShipIt still blocks an update.

Fast mode performs **no session list, per-session exit/restore calls, or machine-wide ancestry scans** by default, regardless of session count. AO restores its own sessions from `~/.ao` on launch. `--restore-sessions` explicitly requests the existing best-effort restore pass, one attempt per captured live session, and can increase runtime. It never calls `exit-agent` in fast mode. The session/force/survivor and Multica restart options belong to the cautious mode and cannot be combined with `--fast`.

The app swap, relaunch, daemon health verification and post-install checks reuse the existing flow. Failures after moving the old app restore it automatically; a healthy rollback returns 60. `--rollback-restore-db` retains its existing opt-in behavior if a schema migration prevents the previous app from becoming healthy. Rollback also uses bundle-only process checks in fast mode. Routine updates target roughly **1–3 minutes**; copying a large app, manual interaction, a failed health wait or rollback can take longer. Fast defaults are 120s for quit, 10s for daemon stop, 60s for health; explicit `--quit-timeout`, `--stop-timeout` and `--health-timeout` override them. A smaller stop timeout also shortens the bundle/agent waits for diagnostics; it cannot raise their 60s/10s caps.

### Cautious mode: what it does, in this order

Omit `--fast` to use the unchanged cautious workflow, including per-session identity checks, machine-wide ancestry analysis, ambiguity refusals and final survivor scans. For example:

```bash
"$ART/installer/update.sh" --yes --end-sessions --restore-sessions
```

1. **Verify** (read only): manifest, version stamp, signature, free space, and that the Applications folder is writable (it asks for your administrator password once here, before anything stops, if it is not).
2. **Capture** (read only), into a temporary folder that later becomes `state-before/` of the backup: `"$AO" status --json`, `"$AO" session ls --all --include-terminated --json`, `"$AO" multica status --json` (is `AO_MULTICA_DAEMON` hosting on), `multica daemon status --output json` (a standalone daemon), the local Multica server's Docker containers (`docker ps`, information only), the processes of this app, the database schema version.
3. **Plan, then confirm.** It prints what will be stopped (in order), how many live sessions there are and which, what will be backed up, and what will be restarted, then asks for `yes` (any other answer exits 50 and nothing has changed). `--yes` skips the question.
4. **Refuse early.** Live sessions make the run stop with exit 51 and the list, before anything is touched, unless you give `--end-sessions`. Processes that only look like this bundle (another copy of AO whose path ends the same way, an editor with a file open inside the app) stop it with exit 21 and the list; they are never signalled. Executable ownership comes from macOS `proc_pidpath`, with bundle directories compared by filesystem identity so case aliases work without merging distinct directories. An unverifiable executable (except the deleted-provider case below) or a bundled executable with an unsupported command shape (such as `node <app>/Contents/.../index.js`) also blocks with exit 21. External session agents with a verified bundle ancestor are listed separately and waited for after ending their sessions; the default and `--force` never signal them. The separately confirmed `--kill-survivors` option below can handle verified survivors.
5. **Stage** the new build with `ditto` and verify the staged copy (as `install.sh` always did).
6. **Stop**, with a bounded wait and a progress line at each step:
   1. `--end-sessions` only: `"$AO" session exit-agent <id>` for every confirmed live session, with up to eight concurrent exits while the daemon can still answer. Each exit retains the per-session identity checks and action log; all in-flight exits finish before proceeding. That stops the agent (and its chat host) but keeps the session, its worktree and its conversation; **`ao session kill` is never used** because it also tears down the worktree.
   2. Only the sessions the plan listed and you confirmed are touched: the list is re-read first, and a session that appeared since is refused (exit 51) so you see it in a new plan.
   3. Quit the desktop app completely, see below.
   4. Wait for the app-owned daemon to stop itself (about 5 s after the app exits); if it does not, `"$AO" stop`.
   5. Wait for chat hosts, helper processes and ShipIt to exit. Survivors are listed and the run stops (exit 56; ShipIt: 22) unless `--force`.
7. **Back up**, exactly as in the manual flow: `ao.db` + WAL/SHM, `app-state.json`, `update-settings.json`, `editor-settings.json`, the old app renamed `*.app.bak`, `BACKUP_COMPLETE` written **before** the old app moves, the swap trap restores the old app on interruption; plus `state-before/` (the captured state) and `update-actions.log` (every step and every signal sent) in the same `~/ao-backups/<stamp>/` folder.
8. **Install**: swap the staged app in, clear quarantine, re-verify manifest, signature and version stamp.
9. **Restart**: `open -a "/Applications/Agent Orchestrator.app"`, wait for the app process, then for `"$AO" status --json` to say `ready` and `http://127.0.0.1:<port>/healthz` (the port `ao status` reports) to say `ok`, up to `--health-timeout` seconds (default 120). The daemon that answers must be this app's own: its reported binary has to be `<app>/Contents/Resources/daemon/ao` (symlinked folders compare equal) and its pid one of this bundle's `ao daemon` processes, otherwise it is not healthy and the update rolls back.
10. **Check** (read only): installed version, `ao version`, `spawn --effort`, `project set-config --permission-fallback`, database schema version (read-only; a temporary copy if the WAL files are absent), the `ao-app://` handler. A missing flag is a warning with exit 62, not a rollback.
11. **Restart the rest, only as asked**: the standalone Multica CLI daemon only if it was running before **and** `--restart-multica-daemon` (`multica daemon restart`); the running local Multica Docker containers only with `--restart-multica-stack` (`docker restart <name>`, filter `name=multica`, overridable with `NOETAXIS_MULTICA_STACK_FILTER`). Without the flags both are left alone and listed under "Left for you". If AO's hosted Multica daemon was on before and is off after the restart, it tells you how to turn it back on (set `AO_MULTICA_DAEMON=1` for the app's launch, for example `launchctl setenv AO_MULTICA_DAEMON 1` and reopen); **it never edits your shell profile**.
12. **`--restore-sessions`**: one `"$AO" session restore <id>` per session that was live (for an exited agent this resumes it), then it re-reads the session list and reports each one as *came back*, *restore FAILED* or *reported success but is not live*. Restore has been unreliable; a partial result is exit 63, not a failure of the update. `--restore-sessions` also applies when the update ends on the previous app (a healthy automatic rollback, or the reopen after a failure before the swap); if no healthy app was reached, the summary says no restore ran and lists the session ids to resume by hand.
13. **Summary** and exit code: what was stopped, where the backup is, versions old and new, health and check results, session restore results, and what is left for you.

### Cautious mode: quitting the app completely

Upstream (`frontend/src/main/desktop-quit.ts`, from the macOS tray change) turns Cmd+Q, the Dock "Quit", an AppleScript `quit` and a plain SIGTERM into "close the window" on macOS. Only the tray item **Quit AO Completely** (and a system shutdown) exits the app, and there is no CLI command, daemon API or URL for it. The item's label is translated, so the script tries the label of every UI locale the app ships (a test keeps the list in step with `renderer/i18n/*.json`). So the script drives that tray item through the accessibility API (`osascript` with System Events), for the exact process id of this bundle's main process (never by bundle id, which another copy shares). macOS asks once to let your terminal control System Events and to grant it Accessibility. If AO asks about unsaved chat drafts while quitting, answer in the app; the wait is bounded, so rerun if it ran out. This path has been **compiled and tested against fakes only**, not against a real tray: if it cannot click, it says so and waits up to `--quit-timeout` seconds (default 60) for you to click **Quit AO Completely** yourself, which is always the fallback. `--manual-quit` skips the scripting and just waits. After the wait, `--force` sends SIGTERM to the app's own processes (a tray build may treat it as a window close); if the app is still there the run stops with exit 54. Without `--kill-survivors`, the updater never sends SIGKILL to AO processes.

### Cautious mode: what the signal guarantee covers

Tray scripting requires **both** System Settings > Privacy & Security > **Automation > your terminal > System Events**, and **Accessibility > your terminal**. If scripting times out, choose **Quit AO Completely** by hand first, then rerun. Updating works with the desktop app already quit and does not require scripting permissions in that case.

Two different things are signalled, under two different rules.

**AO's own processes with `--force`** (the app, the daemon, chat hosts, helper processes): the script sends only **SIGTERM, never SIGKILL**, only with `--force`, only to a process that was part of the confirmed plan (same pid, same start time and an own-bundle command line; a process that started after you confirmed, such as the chat host of a session created later, is listed and never signalled), each one logged. Before ending a session's agent it also re-checks that the session is still the confirmed one: it must be in the confirmed list (the list read at plan time is what gets worked through; a re-read list is only used to refuse additions, never adopted), still live, its record unchanged (project, role, creation time, harness, branch, issue: a re-created session reusing the id fails this), and its host process unchanged (pid, start time, command line). The daemon's own identity is verified again after that list read and immediately before the `exit-agent` call (a swap in between aborts with exit 57). After that blocking daemon check, the last step before the call is a local-only host check against the process table (pid, start time and command line of the session's confirmed host; no `ao` call, no wait): a host replaced during the daemon check is skipped and reported, never ended. A session with no chat host of this app (for example a terminal agent) is listed as hostless in the plan and is **never ended**: its agent process is invisible to the updater, so it cannot be verified, and two empty host sets are never treated as equal; it keeps running and is reported in the summary; the updater cannot see its agent process, so only the record pins it, and a new agent generation inside the same unchanged record would not be noticed; a session that changed is skipped, reported, and the run stops with exit 51 before the app is touched.

By default, the only SIGKILL is the watchdog on helper process groups started by the script. `--force` remains SIGTERM-only. `--kill-survivors` is a separate opt-in with a typed PID confirmation; see below.

**The script's own helper commands** (`ao`, `osascript`, `lsof`, `docker`, `multica`, `open`, run with a deadline): each runs as a child of a small watchdog in a process group of its own (created from both the parent and the child side of the fork, so the group can be signalled even if the child has not run yet). The helper writes into private temporary files (mode 0600, unlinked immediately), not into the script's pipes, so no descendant can hold a command substitution open; the output is copied out when the helper is gone, at most 4 MiB per stream (`ulimit -f` stops a runaway writer, the watchdog stops it at the cap, and the call fails with exit 144 and a "truncated" message instead of returning partial output as a success). The copy-out is done by a short-lived copier child with ordinary blocking writes, so the flags of the caller's stdout and stderr are never changed (O_NONBLOCK belongs to the shared open file description); it never takes longer than two seconds: a caller that does not drain its pipe gets exit 145, and the copier is terminated. The copier resets its signal handlers to the default action before it unblocks the stop signals (so a TERM cannot be swallowed by an inherited handler) and arms its own two-second alarm, so it ends even if no signal ever reaches it. The copier leads a process group of its own, and a copier that has not finished at the deadline is ended through the same single TERM-then-KILL sequence as a helper (aimed only at helper groups the installer started) and reaped before the call returns, so the call never returns while the copier can still hold the pipe of the caller. At the deadline the watchdog sends the helper's process group SIGTERM, then SIGKILL after 1 second to whatever is still in the group (a hung helper, or descendants that outlived a helper that exited on SIGTERM). The watchdog keeps the helper's process id, and so its group id, reserved by reaping the helper's leader only when nothing will be signalled any more: either it ended by itself before the deadline, or after the last signal. The signals that start the stop are blocked while the leader is polled and reaped, so a recycled group id can never be signalled, reports "timed out" and returns exit 142, which the callers treat as a failure (for example exit 52 when the session list times out, 53 for an agent that could not be stopped). This watchdog's SIGKILL can only reach the process group of a helper the script itself started; survivor signals use the separately confirmed path below. (A plain `alarm` would not do: the bundled `ao` is a Go program and Go ignores SIGALRM.)

It does **not** cover what AO does when asked to stop a session. `--end-sessions` calls `ao session exit-agent`, and the daemon tears the agent's controller down by its own code: `exit-agent` -> stop chat / runtime -> controller terminate -> adapter close, which ends in `syscall.Kill(-pgid, SIGKILL)` of the agent's process group (`backend/internal/adapters/chatdriver/acp/process_unix.go`, `chatdriver/persistenthost/child_unix.go`). Those are the selected sessions' provider processes (the agent CLI and what it started), outside the bundle, and they are force-killed by AO, not by this script. A running agent turn is interrupted without a chance to finish. So use `--end-sessions` only when that is acceptable, let turns finish first, or stop the sessions yourself in the app beforehand. The test suite uses a fake `ao` and cannot observe that teardown.

### Cleaning up survivors explicitly

After the app quits, survivor reports group verified bundle descendants, orphans with an anchored full path under `~/.ao/` in their command line or working directory, and leaked installer test fixtures. Reports include PID, PPID chain, full command, working directory and a guarded copy-paste TERM/grace/KILL command when executable identity can be verified. Deleted or unverified executables have instructions to end the session instead of PID commands. Potential relaunch jobs from `launchctl list` and `~/Library/LaunchAgents` are reported; the updater never unloads them.

`--kill-survivors` requires a separate exact `kill survivors <pid> ...` answer after displaying the list. `--yes` cannot answer it and `--detached` cannot be combined with it. Only verified bundle descendants and anchored AO orphans are eligible; test fixtures, deleted/unverified executables and processes outside those anchors are never automatically signalled. Children receive TERM before parents, followed by a bounded grace and KILL only if PID, start time, command, executable and orphan anchor still match. New processes are never silently added to the confirmed list. A nonempty final rescan stops before swapping, including when a launch job respawns a process.

The installer tests register owned children and forked watchdog helpers, give stubborn/escaped fixtures a cleanup lease, and reap them before deleting their temporary directories. Cleanup runs after assertions and timeouts; a surviving registered fixture fails the suite.

### Deleted provider executables

A package-manager upgrade can delete the executable of a provider process that is still running. When macOS `proc_pidpath` returns ENOENT, a stable chain of ancestors with verified executable identities can identify it as a bundle descendant. The plan labels it **deleted executable; identity unproven**, with its PID and session ID. Other lookup failures, including permission errors, malformed paths and gaps in ancestry, still block as foreign or unverified processes.

These descendants are never included in the PID signal inventory, even with `--force`. Update mode requires a confirmed live session, a verified chat host of this bundle, and `--end-sessions`; it ends the agent only through `ao session exit-agent`, then waits for its original PID and start time to disappear before quitting the desktop. Orchestrators across projects are included by `session ls --all` and use the same checks and teardown as workers. A survivor or missing session coverage stops the update with instructions to end the agent through the app or `ao session exit-agent <id> --project <project>` and rerun. This permits session teardown without claiming executable ownership that macOS cannot prove. Classic install, rollback and PKG preinstall require the user to end these agents first; the background-process override cannot bypass that refusal.

### Options

| Option | Effect |
| --- | --- |
| `--dry-run` | Verify, capture, print the plan, exit. Same refusals (51, 21) as a real run. |
| `--yes` | Skip the update-plan question. Required with `--detached`; never confirms survivor PID teardown. |
| `--end-sessions` | Stop the agents of live sessions with `ao session exit-agent` (sessions, worktrees and conversations are kept). Without it, live sessions are refused. |
| `--restore-sessions` | Afterwards try `ao session restore` once per session that was live. |
| `--kill-survivors` | Separate typed PID confirmation after quit; TERM then KILL for verified bundle descendants and anchored AO orphans only. Never deleted/unverified PIDs or leaked test fixtures. |
| `--force` | SIGTERM, never SIGKILL (sent by this script), to processes of **this bundle only** (command line starts with `<app>/Contents/`) that survive the waits and were already running when the plan was captured (a process that started afterwards, such as the chat host of a session created after you confirmed, is listed but never signalled); each signal is logged. |
| `--manual-quit` | Do not script the tray; wait for your click. |
| `--restart-multica-daemon` | Restart a standalone `multica` CLI daemon that was running before. |
| `--restart-multica-stack` | `docker restart` the Multica containers that were running before. |
| `--rollback-restore-db` | On automatic rollback also restore the database, but only if the schema was migrated and the old app stays unhealthy. |
| `--detached` | Re-run in a new session with `nohup` and a log file (see below). |
| `--quit-timeout N`, `--stop-timeout N`, `--health-timeout N` | Waits in seconds (defaults 60, 45, 120). |

### Automatic rollback

If the new app does not start, or the daemon is not `ready` and healthy within `--health-timeout`, the run quits the new app the same way, restores the backed-up app with `rollback.sh`, reopens it, and waits for it to be healthy: exit 60 and a report. The database is only restored with `--rollback-restore-db`, and only when the new app migrated the schema (the version is higher than the one captured) and the old app is still unhealthy; the migrated database is saved first as `rollback-current-data-*`. If the run fails after AO was stopped but before the new app replaced the old one (an interruption, a refusal at the survivors check), the previous app is restored on disk and reopened (bounded 30 s health wait). If the new app cannot be quit, or `rollback.sh` fails, it stops with exit 61 and prints the exact `rollback.sh --backup-dir ...` command.

### From inside an AO session

An update run inside an AO session would end that session in the middle (it quits AO), so it refuses with exit 20 (naming the `AO_*` variables it found; your own `AO_MULTICA_DAEMON`, `AO_MULTICA_PROFILE`, `AO_MULTICA_SYNC`, `AO_MULTICA_WATCH` and `AO_KEEP_DAEMON` settings do not count) (`--allow-ao-session` does not unlock it; with `--dry-run` it does). `--detached --yes` re-runs the script in a new session (`setsid`) with `nohup`, no `AO_*` variables, stdin from `/dev/null` and output to `~/ao-backups/update-<stamp>.log`, prints that path first, and returns immediately. **The AO session that started it ends when AO quits.** Follow it with `tail -f <log>`; the same summary is written to the log. The default stays off.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Updated and healthy (or already up to date, nothing touched). |
| 2 | Usage error. |
| 20 | Inside an AO session (use `--detached`). |
| 21 / 22 | Other processes block / ShipIt is running. |
| 23-35 | As in the default install (metadata, manifest, space, backup, privilege, staging, swap). |
| 36 | Another install, update or rollback holds the lock (`~/.ao-install.lock`, owner pid in `pid`), or an earlier run left it behind. The lock is **never taken over or removed by the scripts**: a normal exit, INT, TERM and HUP release it, but a run killed with SIGKILL (or a power loss) leaves it, and then the message tells you to check that nothing is running and remove it with `rm -rf ~/.ao-install.lock`. Install, update and rollback all take it, so two swaps cannot overlap. A dry run does not take it. |
| 50 | The plan or survivor PID confirmation was cancelled. Survivor cancellation may follow session/app teardown; nothing is installed. |
| 51 | Live sessions and no `--end-sessions`; nothing stopped. |
| 52 | The daemon runs but its session list could not be read; nothing stopped. |
| 53 | A session's agent could not be stopped; the app and daemon were not touched. |
| 54 | The app did not quit. |
| 55 | The daemon did not stop. |
| 56 | Bundle descendants, anchored orphans, leaked test fixtures or changed/unverified survivors still block the swap. |
| 57 | The daemon that owns `~/.ao`'s run file is not this bundle's (another AO copy). The bundled `ao` controls whichever daemon owns that file, so the run refuses before listing, ending or stopping anything through it; `ao stop` is also skipped if that turns up later (with `--force` only this bundle's own daemon process gets SIGTERM). |
| 60 | New app unhealthy; the previous app was restored and is healthy. |
| 61 | New app unhealthy and the rollback needs you (instructions printed). |
| 62 | Updated and healthy, but a post-install check warns. |
| 63 | Updated and healthy, but not every session came back. |

### Trying it safely

`"$ART/installer/update.sh" --dry-run` changes nothing and shows the plan and refusals. The node tests run the whole flow against fake `ao`, `ps`, `pgrep`, `osascript`, `open`, `kill`, `curl`, `multica` and `docker` in a throwaway home and Applications folder and never touch a real process, daemon, port, Keychain or URL handler: `node --test scripts/noetaxis-macos-update.node-test.mjs`.

## Appendix A: manual install and rollback from your own Terminal

This is the default mode of `install.sh` (no `--update`): the script refuses to quit AO or stop any process for you; it checks and tells you what is left. Prefer the one-command update above; this appendix is the manual route and the reference for the refusals.

On macOS, **Quit and Cmd+Q only close AO's window**. The Dock icon, the menu-bar tray, the app-owned daemon and any enabled mobile or remote access keep running, so the "app is still running" refusal is expected after a plain Quit. To exit completely, click the Agent Orchestrator icon in the menu bar and choose **Quit AO Completely**. The app-owned daemon then stops itself about 5 seconds later, so wait about 10 seconds. Check the active sessions you care about before a full quit; quitting interrupts work that depends on the app.

The preflight names what is still running and always exits with status 21 (ShipIt: 22):

| Still running | What to do |
| --- | --- |
| The desktop app (`Contents/MacOS`, helper processes) | Use **Quit AO Completely** in the menu-bar tray. `--allow-background-processes` never bypasses this. |
| The bundled AO daemon, with the app already gone | It normally stops within about 10 seconds of a full quit. If it is still there (a crashed app, or a daemon started from a terminal) and you do not need its sessions, stop it yourself with the full path: `"/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao" stop`. Stopping the daemon ends the work of every active session it manages (running agent turns and terminals); agent chat hosts keep running until their sessions are ended separately (next row). Check first. |
| Agent chat hosts (`ao chat-host`) | They keep agent conversations alive while the daemon is replaced, so they survive both a full quit and `ao stop` and only end when their sessions end. Safe procedure: reopen AO, list the sessions with `"/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao" session ls`, let their turns finish or end the sessions yourself (ending a session interrupts it), then **Quit AO Completely** again. Nothing kills a host for you. If you would rather keep the sessions running, use `install.sh --allow-background-processes`; the new daemon reattaches to compatible hosts. The PKG has no override and keeps refusing (the reason is in `/var/log/install.log`) until the hosts are gone, so use `install.sh` or follow the procedure first. |
| Other helper processes under the bundle (agent supervisors, terminal hosts) | Quit completely and verify with `pgrep -fl "/Applications/Agent Orchestrator.app/Contents/"`. Helpers that serve live sessions can outlive a full quit and `ao stop` like chat hosts: reopen AO, list the sessions with `"/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao" session ls`, let them finish or end them yourself, then quit completely again. Matching is by substring, so a copy running from another folder whose path ends the same way (for example `~/Applications/Agent Orchestrator.app`) also blocks; that is deliberately conservative. |
| ShipIt (the updater) | Wait for it to finish. Never bypassed. |

`--allow-background-processes` (install.sh and rollback.sh) lets the script continue past the last four background cases except ShipIt, after printing a warning that lists them. Use it only when you have decided those processes may keep running: they continue from the previous app (moved to the backup), so stop the old daemon with the `ao stop` command above before opening the new app. The PKG preinstall has no such flag and always refuses while any of them runs; use `install.sh` in that case. `rollback.sh --restore-db` is refused while the daemon runs even with the flag, and also while something listens on port 3001 (a daemon from an earlier flagged install runs from a backup copy and is otherwise invisible), because the daemon holds the database open; stop it first. A run that used the flag records `allow_background_processes=1` in that backup's `BACKUP_COMPLETE`. Process detection only sees processes whose command line names the installed bundle, so a daemon left running by an earlier flagged install (now running from the `.app.bak` copy) is not found by it; the scripts therefore also print a warning, and never fail, when something listens on port 3001 (the default daemon port, `lsof` is read-only) while no bundle process was found. Stop such a daemon yourself with the `ao stop` of the bundled CLI, after checking its sessions.

```bash
frontend/scripts/noetaxis-macos/install.sh --dry-run \
  "$HOME/ao-builds/noetaxis-8e2bc21/Applications/Agent Orchestrator.app"
frontend/scripts/noetaxis-macos/install.sh \
  "$HOME/ao-builds/noetaxis-8e2bc21/Applications/Agent Orchestrator.app"
```

The script checks the manifest, bundle version and source revision (the app's `NoetaxisSourceRevision` must start with the 7-character version suffix), free space, app processes, and ShipIt. It stages the app with `ditto`, then backs up `ao.db` and its WAL/SHM files (the Electron user-data directory is not included), `app-state.json`, `update-settings.json`, `editor-settings.json`, and the previous app before replacing anything. Backups are stored in `~/ao-backups/<stamp>/`; the previous bundle ends in `.app.bak` so Finder does not treat it as another installed app. The install script will not move the old app until all selected AO state backups verify successfully.

`AO_SESSION_ID` and any `AO_*` environment setting, or an AO app/daemon process in the command's ancestry, blocks installation. `--allow-ao-session` overrides this guard. Use it only when ending the active sessions is intentional. `APPS_DIR` and `AO_HOME` can point at isolated test roots; setting `AO_HOME` also triggers the guard unless the explicit override is supplied.

To restore the app from the newest complete backup:

```bash
frontend/scripts/noetaxis-macos/rollback.sh
```

To restore the database files too, add `--restore-db`. This replaces current database files with the selected backup; the rollback script first saves the current database files under a new `rollback-current-data-<timestamp>-<pid>/` directory in that backup directory (a repeated rollback never overwrites an earlier one). Use `--backup-dir <path>` to select a specific backup.

The scripts use the full bundled CLI path. The install script checks `ao version`, the `spawn --effort` and `project set-config --permission-fallback` flags, and the database schema using read-only SQLite access. A WAL database with no `-wal`/`-shm` files (the daemon is not running) cannot be opened read-only, so the schema check then reads a temporary copy; if that fails too it prints a notice and does not fail the install. Open the app from Finder before checking daemon status:

```bash
AO="/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao"
"$AO" status
"$AO" version
"$AO" multica status
"$AO" spawn --help | grep -- --effort
"$AO" project set-config --help | grep -- --permission-fallback
sqlite3 -readonly "$HOME/.ao/data/ao.db" \
  'select max(version_id) from goose_db_version where is_applied=1;'
```

At source commit `8e2bc21`, the database schema result is `190`. `ao status` needs the app to have been opened after installation. The `ao` command does not need to be on `PATH`.

## Appendix B: install with the PKG or DMG

Open the PKG in Installer from your own Finder session. Its preinstall hook refuses a running app, daemon, chat host or ShipIt (with no override; Installer shows only a generic failure and the explanatory messages go to `/var/log/install.log`, so run `install.sh --dry-run` from Terminal to read them) and creates the same backup before package payload files are installed. Its postinstall hook clears quarantine, verifies the build stamp and updates-disabled marker, and checks the `ao-app://` handler.

The DMG contains the app, an `Applications` shortcut, and a short readme for Finder drag-and-drop placement. Use the script or PKG when you want the automatic AO state and old-app backup.

Ad-hoc signing is not notarization. If Gatekeeper blocks the first open, use Finder's **Open** action from the app's context menu, then choose **Open Anyway** in Privacy & Security if macOS asks. The script and PKG clear the quarantine attribute during installation. If macOS says the app is damaged, open Terminal and run:

```bash
xattr -dr com.apple.quarantine "/Applications/Agent Orchestrator.app"
```

The new signature may trigger a Keychain prompt for **Agent Orchestrator Safe Storage**. Choose **Always Allow** and enter your login password so stored credentials remain readable. macOS may also ask again for access to Documents, Desktop, Downloads, or other folders because those permissions were granted to the previous signature.

## Verification

```bash
shellcheck -x frontend/scripts/noetaxis-macos/*.sh \
  frontend/scripts/noetaxis-macos/pkg-scripts/*
node --test frontend/scripts/noetaxis-macos*.node-test.mjs
```

The fake-world harness registers helper identities for safe cleanup. On a busy Mac, run suites with limited test concurrency; `NOETAXIS_TEST_COMMAND_TIMEOUT_MS=300000` raises the harness's outer command budget from its normal 150 seconds. The detached test uses the same budget. This does not change installer wait options or the fast-mode timing assertions.

The end-to-end test uses a synthetic app in a temporary home and Applications directory. It expands the unsigned PKG with `pkgutil`, checks its payload and scripts, creates and mounts the DMG read-only, and detaches it. It does not run `installer`, launch Electron, connect to the live daemon, access the real Keychain, or register a URL handler. Set `NOETAXIS_TEST_ARTIFACTS=/private/tmp/noetaxis-macos-test-artifacts` to retain the generated test app, package, and disk image for inspection.

The update tests (`noetaxis-macos-update*.node-test.mjs`, helper `noetaxis-macos-update-world.mjs`, fakes in `noetaxis-macos-test-fakes/`) cover fast mode with 56 sessions and no session calls/ancestry scan, single confirmation/`--yes`, denied permission and manual quit, slow external CLIs, bundle-only TERM/KILL with identity rechecks, foreign/unverified processes, checksum failure and automatic rollback. They also retain the cautious plan and confirmation, refusal with live sessions, stop order, SIGTERM-only --force handling, separately confirmed survivor teardown, backup before the swap, restart and health, automatic rollback (with and without the database), session restore reporting, AO-session guard and `--detached`, state capture, executable and ancestry identity, deleted-executable descendants and orchestrators, bounded concurrent exits, fixture cleanup after failures/timeouts, automatic installer/checksum packaging, and mutation checks that break safety rules. `buildPackages` copies the complete `installer/` directory, produces `HUMAN-INSTALL.md` from its template, and writes `SHA256SUMS`; `build.mjs` refreshes checksums after writing `BUILD-INFO.txt`.
