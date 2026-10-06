# AO-hosted Multica daemon

AO's daemon can run Multica's agent daemon for you, as a supervised child process. It is **off by default**. With it off, nothing in this document is active: the hidden helper commands do nothing, no supervisor runs, and the embedded Multica view drives the `multica` CLI as described in [`frontend/docs/multica-desktop-embed.md`](../frontend/docs/multica-desktop-embed.md).

## Turn it on

Export `AO_MULTICA_DAEMON=1` (`true` and `on` also work) in the environment that launches AO, for the app or for `ao daemon`. Preconditions:

- A Multica profile that is already signed in: `~/.multica/config.json` (or `~/.multica/profiles/<name>/config.json`) with a non-empty `token`. AO does not log in and never writes the token.
- A **local** Multica server: the server URL (`MULTICA_SERVER_URL`, else the profile's `server_url`) must be a loopback address. A remote or cloud URL is refused.
- Optional: `AO_MULTICA_PROFILE` selects a named profile (default: the default profile) and `AO_MULTICA_HEALTH_PORT` overrides the health port (default: Multica's own formula, 19514 for the default profile). The desktop app sets `AO_MULTICA_CLI` itself, to the `multica` CLI it found (override, bundled, or `PATH`), so tasks can run `multica issue get` and `multica repo checkout`.

## How it runs

```text
Electron app  --HTTP-->  AO daemon (ao daemon)  --supervises-->  child: ao __multica_daemon  --->  Multica server (local)
```

- **One binary, two processes.** `ao daemon` starts the same `ao` executable with the hidden command `__multica_daemon --watch-stdin`. The child runs Multica's own daemon (`server/internal/daemon`, reached through a one-file facade package on the pinned fork) with auto-update and auto-reload off and `LaunchedBy` set to `desktop`. Nothing of the daemon is reimplemented.
- **Same files as the Multica CLI.** The child writes `daemon.pid` and `daemon.log` in the profile directory and listens on the profile's health port, so `multica daemon status|stop|restart` work against it.
- **Environment.** The child receives an allowlist of AO's environment, not all of it: `HOME`, `PATH`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TZ`, `MULTICA_*`, and the four AO variables `AO_MULTICA_DAEMON`, `AO_MULTICA_PROFILE`, `AO_MULTICA_HEALTH_PORT` and `AO_MULTICA_CLI`. Variables such as `SSH_AUTH_SOCK`, proxy settings and provider API keys are **not** passed on; agents that need them must get them through Multica's own agent settings.
- **Hidden helpers do nothing while the flag is off.** `ao __multica_daemon` is always registered but refuses to run without the flag (it prints one line and exits 78 without creating any file), and the execution-environment helper `__multica_execenv_prepare` (Multica's daemon re-executes its own binary for it) is dispatched only while the flag is on, so otherwise it is an unknown command.

## State outside `~/.ao` (an exception to AO's rule)

AO keeps its own state under `~/.ao` only. The hosted daemon is Multica's program and keeps Multica's state where the Multica CLI and desktop app look for it: `~/.multica` (profile config, token, `daemon.pid`, `daemon.log`, repository cache) and `~/multica_workspaces` (task workspaces). AO writes nothing of its own there. The exception is recorded where the rule is stated (`AGENTS.md`).

## Supervision

AO's daemon owns a desired state (`running` or `stopped`) and watches the child:

| What happens | Result |
|---|---|
| The child exits with 78 (no token, non-local server, health port busy, another profile's daemon alive) | `failed` with the child's last log lines; never restarted automatically |
| The child exits with 0 although AO did not ask | An explicit stop from outside (for example `multica daemon stop`): AO stands down and does not fight it |
| The child crashes (any other exit, or a signal) | Restart with exponential backoff, 1 s doubling to 60 s, reset after the child has run 2 minutes |
| 8 crashes in a row, each shorter than 2 minutes | `failed` until an explicit start or restart |
| Another daemon already answers on the profile's health port | `external`: AO does not start, stop or restart it, shows it, and takes over only on an explicit start after the port is free |
| AO's daemon stops | The child is asked to stop (`/shutdown`, then its stdin is closed), waited for up to about 20 s, then that child, and only it, is killed |
| AO's daemon dies abruptly | The child sees its stdin close and stops on its own |

The shutdown request is sent to the health port only when the daemon answering there reports the child's own pid, so AO can never stop somebody else's daemon.

## Start, stop, restart: what works where

| Action | Result |
|---|---|
| Stop or restart from the embedded Multica daemon panel | Goes through the AO API to the supervisor (hosting on) |
| `ao multica status\|start\|stop\|restart [--json]` in a terminal | The supported terminal path; AO keeps supervising |
| `multica daemon stop` in a terminal | Safe: it can only reach the child's pid, and AO sees a graceful exit and stands down. Use `ao multica start` to run it again |
| `multica daemon restart` in a terminal | Safe, but it stops the child and then starts a **standalone** daemon that AO does not supervise. AO stays hands-off while that daemon holds the port and shows it as `external`. Use `ao multica restart` instead |
| `multica daemon start` while the child runs | Refused by Multica (`already running (pid N)`); nothing is started |
| `ao multica start\|stop\|restart` while a daemon outside AO holds the profile | Refused with `MULTICA_EXTERNAL`; AO runs nothing there and says so instead of reporting a stop that did not happen. Stop that daemon where it was started, then `ao multica start` takes over |

## API and CLI

Loopback only; the routes are blocked on the LAN listener and listed in the OpenAPI spec.

- `GET /api/v1/multica/status`, `POST /api/v1/multica/start|stop|restart`. Each returns `{"daemon": {...}}` with `enabled`, `state` (`disabled`, `stopped`, `starting`, `running`, `backoff`, `failed`, `external`), `desired`, `pid`, `profile`, `healthPort`, `startedAt`, `restarts`, `nextRetryAt`, `lastExit`, `lastError`, `logLines` and `health`.
- Status follows the profile's health port with up to about 2 s of lag, so a status read right after something outside AO started or stopped a daemon can still show the previous state; read it again.
- Errors: 409 `MULTICA_DISABLED` (hosting is off), 409 `MULTICA_EXTERNAL` (a daemon AO does not run holds the profile), 503 `MULTICA_UNAVAILABLE`.
- Start, stop and restart run on a context detached from the request, so a client that goes away mid-stop cannot make the supervisor kill the child while it drains tasks.

## The pinned Multica dependency

AO's `backend/go.mod` replaces `github.com/multica-ai/multica/server` with `github.com/amolodyh-hyland/multica/server` at a pseudo-version of the commit on the fork's branch `feature/daemonhost-facade`. That branch adds one file, `server/pkg/daemonhost/daemonhost.go`, which re-exports the daemon's types and constructors from the otherwise `internal` package. There is no local path in the replace.

Bumping the pin:

1. In a clone of the fork, merge the wanted upstream Multica commit into `feature/daemonhost-facade`, make sure the facade still compiles, and push **that branch only** (no force).
2. In `backend/`, run `go list -m -json github.com/amolodyh-hyland/multica/server@<commit>` to get the pseudo-version, then `go mod edit -replace=github.com/multica-ai/multica/server=github.com/amolodyh-hyland/multica/server@<pseudo-version>` and `go mod tidy`.
3. Prove a clean build: with an empty `GOMODCACHE` and `-mod=readonly`, `go build ./...` must pass; a renamed upstream symbol fails here, which is the intended alarm.
4. Run the backend tests, then `npm run check:multica-bridge -- --multica <fork checkout>` from `frontend/`.

## Known limits

- Verified only on macOS, in an isolated environment (scratch `HOME`, data directory, ports and tmux socket; a throwaway Multica account; the real `multica` CLI; a stub agent instead of a real model). Checked live: the child registers and `multica daemon status` reports the child's pid, not AO's; a task whose agent runs `multica issue get` finds the CLI on its `PATH` and reads the issue with the task's own credentials; five tasks complete (the daemon ran two at once); `multica daemon stop` stops only the child and AO stands down without restarting it; `ao multica start|restart` supervise a new child; `multica daemon restart` leaves a standalone daemon that AO shows as `external` and refuses to touch, and an explicit start takes over once it is stopped; an invalid token crash-loops with the 1, 2, 4, 8, 16 s backoff and ends as `failed` after 8 crashes; a missing token is `failed` at once with no retry (exit 78); stopping AO's daemon stops the child within a fraction of a second and removes its pid file; the child stops by itself when its stdin pipe closes; a secret in AO's environment does not reach the child; with hosting off the status is `disabled`, `start` is refused and the hidden command exits 78. Windows and Linux have not been run; the supervisor kills only its own child and uses `/shutdown` and stdin close, which are not platform specific.
- The child's environment is an allowlist (see above), so agent tooling that relies on inherited variables must be configured through Multica.
- `multica daemon restart` run directly leaves a standalone daemon outside AO's supervision (see the table above).
- The Multica daemon's auto-update and auto-reload are off; updating the Multica code means bumping the pin.
- Multica Cloud is out of scope: the server must be local.
