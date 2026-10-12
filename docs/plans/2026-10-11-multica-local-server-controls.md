# Multica local server controls: start, stop, restart with live status

Status: design, then implemented on `feat/multica-local-server-controls` (local). The shipped behavior is described in `frontend/docs/multica-desktop-embed.md` ("Local Multica server controls").

In Settings → General → Multica, when the server switch is on **Local / self-hosted** and points at this computer, a "Local server" block lets the user start, stop and restart the self-hosted Multica **server** (backend + web app + Postgres, run by Docker Compose) and shows its live status and backend log. This is the Multica **server**. It is not the Multica **agent daemon** (the agent runtime, `AO_MULTICA_DAEMON=1`, driven through the `multica` CLI); the two never share a button, a status or a sentence in the UI.

Motivation: the embedded Multica sign-in failed because nothing listened on `localhost:3000`/`8080` and Docker Desktop was not running. Nothing in AO could say that or fix it.

## Findings

| Question | Answer |
| --- | --- |
| How does the main process run external programs? | `execFile` with fixed argument arrays, a timeout, `maxBuffer` and `windowsHide`, injected as `ExecFileLike` so tests never spawn (`multica-daemon-cli.ts`, one `lifecycleBusy` flag serializes lifecycle commands). Never a shell string. The Go `forbidigo` rule (`exec.Command` only through `internal/process`) covers the Go daemon; this feature is TypeScript only and adds no Go. |
| Where do server settings live? | `multica-settings.json` (`mode`, `customUrl`, `apiUrl`), read per use with `readMulticaSettings`, resolved by `resolveMulticaServer`. Probe: `checkMulticaServer` (`/api/config` shape check, `/healthz`, 5 s, no redirects). Both reused unchanged. |
| How do shell-only IPC modules look? | `registerMulticaStatusSyncIpc`: a separate module, handlers checked against `shellWebContents.id`, payloads validated, `dispose` removes handlers. The new feature follows it and does not touch `multica-view-host.ts` (hidden-attached-view lesson: the view host's attach/detach logic stays as is; AO never reloads the view for the user, the Multica pane already has a Retry button that calls the existing reload). |
| i18n | `renderer/i18n/{en,zh-CN,ja,ko,es,fr,de,pt-BR}.json`; English types `MessageKey`; parity and interpolation tests require all eight. |
| The stack (from the Multica checkout) | `docker-compose.selfhost.yml`, project `name: multica`, services `postgres`, `backend` (127.0.0.1:8080), `frontend` (127.0.0.1:3000). It **requires `JWT_SECRET`** (`${JWT_SECRET:?…}`), so `up -d` fails until a `.env` exists; `make selfhost` creates it from `.env.example` with random `JWT_SECRET`, `POSTGRES_PASSWORD`, `MULTICA_VCS_SECRET_KEY` (and the password inside `DATABASE_URL`). Ports are published to localhost only; the real published port is what `docker compose ps` reports. The installer puts the checkout at `~/.multica/server`. With neither SMTP nor Resend configured the backend prints `[DEV] Verification code for …` in its log. |
| Docker outputs | `docker compose ps --format json` prints NDJSON (compose ≥ 2.21) or one JSON array (older); fields `Service`, `State`, `Health`, `ExitCode`, `Publishers[{PublishedPort,TargetPort}]`. `docker compose ls --all --format json` prints an array of `{Name, Status, ConfigFiles}`. |

## Where the stack lives

Setting file `multica-local-server.json` in the AO state dir (`browserProfileStateDir()`), mode `0600`, atomic write, `{ "version": 1, "stackDir": "<absolute dir or empty>" }`. A separate file so the server-switch contract (`MulticaSettings`, `multica:setSettings`) is untouched.

Resolution, in order, evaluated only when the controls are visible:

1. the saved `stackDir`;
2. `~/.multica/server` (where Multica's installer puts it, documented);
3. a **suggestion**, never used silently: `docker compose ls --all --format json`, project `multica`, first config file named `docker-compose.selfhost.yml`, its directory. The block shows "Found a Multica stack at <dir>" with a **Use this folder** button.

The user can also **Choose folder…**: the *main* process opens the native folder dialog; the renderer never sends a path that reaches a command. Only a directory that passes validation is saved. A user-provided arbitrary compose file name is not supported: the file is always `docker-compose.selfhost.yml` in the chosen folder (a `docker-compose.selfhost.build.yml` overlay from `make selfhost-build` is not applied; such users keep using the terminal).

### Path validation (`validateStackDir`)

Absolute path, no NUL; `realpath` (canonical, symlinks resolved); it is a directory owned by the current user and not group/world-writable; `docker-compose.selfhost.yml` inside it is a regular file (`lstat`, not a symlink), its `realpath` stays under the canonical directory, it is not group/world-writable and ≤ 256 KiB; its text has the top-level `name: multica` and `postgres`, `backend`, `frontend` services (a sanity check that this is Multica's file, not a security boundary: the user chose the folder and Compose will run whatever it says). The canonical directory and canonical file path are what the commands receive. Validation is repeated before every mutating operation (a folder can change after it was saved).

## Allow-listed commands

One module (`multica-local-server-commands.ts`) is the only place that builds argument vectors. It exports a closed set of operations; each is a function of an enum and validated values, returning `{ file, args }`. There is no generic "run this" entry point, no shell, no string concatenation of user text.

| Operation | `file` | `args` |
| --- | --- | --- |
| `dockerInfo` | docker | `version --format {{.Server.Version}}` |
| `composeVersion` | docker | `compose version --short` |
| `composeList` | docker | `compose ls --all --format json` |
| `ps` | docker | `compose -f <file> --project-directory <dir> ps --all --format json` |
| `up` | docker | `compose -f <file> --project-directory <dir> up -d` |
| `stop` | docker | `compose -f <file> --project-directory <dir> stop` |
| `restart` | docker | `compose -f <file> --project-directory <dir> restart` |
| `logs` | docker | `compose -f <file> --project-directory <dir> logs --no-color --tail <N> <service>` (`N` integer 1..500, `service` one of `backend`, `frontend`, `postgres`) |
| `openDocker` | `/usr/bin/open` (macOS only) | `-a Docker` |

`<file>` and `<dir>` come only from `validateStackDir`. The docker binary is located like the Multica CLI: absolute candidates (`/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Docker.app/Contents/Resources/bin`, `~/.docker/bin`, absolute `PATH` entries), executable regular file; a GUI-launched app inherits a minimal PATH. Argument injection is covered by construction (every dynamic value is a separate argv element; a `service` or `N` outside the enum is rejected before a command exists; a folder named `-f x` or containing spaces, quotes, `;` or `$()` is only ever one argument after an absolute-path prefix).

Execution options: `timeout`, `maxBuffer` 512 KiB, `windowsHide`, an `AbortSignal` for cancel, and a **minimal environment**: `PATH` (augmented), `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`, and the pinned `DOCKER_HOST`. `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `COMPOSE_*` and the remote-engine variables from AO's own environment are not passed (a remote one must not redirect a button labelled "local"). The engine is pinned: AO finds a local socket from a fixed list and sets `DOCKER_HOST` to it for every engine command, which makes the Docker CLI ignore a remote `currentContext`; with no local socket no engine command runs, and the runner refuses an engine command without a `unix://`/`npipe` endpoint. Timeouts: version/ls/ps/logs 10–15 s, stop 60 s, restart 120 s, up 10 min (the first start pulls the images), Docker Desktop wait 120 s polled every 2 s.

**One operation at a time**: a module-level busy flag (as `lifecycleBusy`) covers setup, start, stop, restart and Docker launch, across service instances. A second request returns `busy`. Reads (`ps`, health probe, logs) are not blocked but the poller skips a tick while an operation runs. **Cancel** aborts the in-flight child and the Docker wait, then refreshes the status; a cancelled `up -d` may leave a partial pull or stack, which the next status shows truthfully.

**Secrets and logs.** AO never reads `.env` (it only stats it) and never passes it anywhere: Compose reads it itself. The service logs nothing but the operation name and a result code. Failure messages shown to the user are `compose` stderr reduced to its last 400 characters with `(…SECRET|PASSWORD|TOKEN|KEY|JWT…)=value` pairs and `://user:password@` redacted. Backend log lines are returned only through the IPC reply to the trusted shell and live in that component's state; they are never written to disk, to AO's action log, to the console or to telemetry.

## Status model

`MulticaLocalServerState`: `unavailable` (not Local, or the URL is not this computer; carries a reason), `no_folder`, `invalid_folder`, `needs_setup` (folder valid, `.env` missing), `docker_not_installed`, `compose_missing`, `docker_not_running`, `docker_starting`, `stopped`, `starting`, `healthy`, `unhealthy`, `port_conflict`, `running_elsewhere`, plus the transient operation states `setting_up`, `starting_server`, `stopping`, `restarting`.

Inputs per refresh: availability (settings), folder validation, `.env` stat, `docker version`, `docker compose version` (only when docker answers), `compose ps`, and an HTTP probe of the configured URL through `checkMulticaServer` (shape check on `/api/config` and `/healthz`), run only when Docker is up or the stack has containers. Derivation is a pure function (`deriveLocalServerState`), table-tested from fake docker output:

1. operation in flight → its transient state.
2. docker ENOENT → `docker_not_installed`; `compose version` missing → `compose_missing`; daemon not reachable (stderr patterns) → `docker_not_running` (`docker_starting` while AO waits after `open -a Docker`).
3. folder missing/invalid → `no_folder` / `invalid_folder`; no `.env` → `needs_setup`.
4. no containers, or none running → look at the probe: Multica answers → `running_elsewhere` (another copy, for example `make dev`, owns the port); something else answers or answers badly → `port_conflict`; nothing → `stopped`.
5. all three services running and no health `unhealthy` → probe ok → `healthy`; probe failing → `starting` for the first 90 s of continuous failure, then `unhealthy`.
6. a service exited, restarting, dead or health `unhealthy`, others running → `unhealthy`; Compose health `starting` → `starting`.
7. a `start` that failed with `port is already allocated` / `address already in use` → `port_conflict` with the message; other failures keep the derived state and set `lastError`.

The published port Compose reports for the web service is compared with the configured URL's port; a mismatch adds a note ("the server runs on :3001 but Settings points at :3000"). The user fixes it in the existing URL field; AO does not edit the server settings.

## UI

A "Local server" group inside `MulticaSettingsSection`, rendered only when the saved mode is Local (hidden in Cloud, and the main process also answers `unavailable` so a stale renderer cannot act). It never appears until the Settings page is open: the poller starts on mount (`watch(true)`), polls every 5 s (2 s while an operation runs), pushes only changes, and stops on unmount and at quit. No poll, probe or docker call runs when these controls are not displayed, so users who never open them see no change.

- Header: "Local Multica server" with a one-line explanation that it is the server (backend, web app and database in Docker) and that the agent daemon is separate. A status chip with a text label (never colour alone) and a `role="status"` live region.
- Rows: folder (path, **Choose folder…**, **Use this folder** for a detected one), buttons **Start**, **Stop**, **Restart**, **Cancel** (only while busy), **Set up** (only when needed), **Show log**.
- Enablement: Start in `stopped`, `unhealthy`, and `docker_not_running` (macOS: it launches Docker Desktop, waits, then starts the server; the label says so); Stop and Restart when containers exist (`starting`, `healthy`, `unhealthy`); Cancel only while an operation runs; everything else disabled with the reason as text. `port_conflict` and `running_elsewhere` disable Start and say what is in the way. A short note says Restart does not re-read `.env` changes: use Stop then Start.
- Log viewer: collapsible `<pre>` with the last 200 backend lines, refreshed every 3 s while open and visible, selectable and scrollable, a Copy button. **Verification codes are shown**: with no mail provider configured the log is how the user signs in; they are never stored (see Secrets). A caption says so.
- Errors: a message per code, the redacted stderr tail under "Details".
- Accessibility: buttons are real `<button>`s with names, busy state via `aria-busy`, status announcements via the live region, keyboard order: folder, Start, Stop, Restart, Show log.
- i18n: every string is a `multica.localServer.*` key in all 8 locales; the parity and interpolation tests cover them.

## First-time setup

`make selfhost` does two things: it creates `.env` with random secrets, then pulls and starts. Starting is already the Start button (`up -d` pulls what is missing). Creating `.env` is small and local, so AO offers **Set up local server** as a single non-command step in `needs_setup`: read `.env.example` from the validated folder, replace `JWT_SECRET`, `POSTGRES_PASSWORD`, `MULTICA_VCS_SECRET_KEY` and the password in `DATABASE_URL` with values from `crypto.randomBytes` (32, 24 and 32 bytes, hex, hex, base64, as in the Makefile), and create `.env` with exclusive-create (`wx`, never overwrites an existing file), mode `0600`. No process is run, the file content is not returned or logged, and an existing `.env` makes the step a no-op (`already_set_up`).

Not offered: obtaining the Multica files (cloning the repository or running the installer script downloads and then runs third-party code with Docker; the user does that deliberately, the exact commands are in the docs), `make selfhost-build`, and anything that edits `.env` after creation (email provider, origins, `APP_ENV`): those stay manual, as the self-hosting guide describes. Known limit: if a `multica_pgdata` volume from an earlier run with another password still exists, a new random Postgres password will not match it; the backend log shows the authentication error and the docs give the remedy.

## Server switch interplay

`availability` is a pure function of the saved server settings: Cloud → `unavailable: cloud`; Local with an empty URL → `unavailable: no_url`; Local with a host that is not loopback (`localhost`, `127.0.0.0/8`, `::1`) → `unavailable: remote_url`; a loopback web address whose resolved API address (explicit `apiUrl`, else the derived one) is not loopback → `unavailable: remote_api` (the Compose stack binds `127.0.0.1`, so a LAN or remote address is a different machine and AO must not offer to control it); otherwise available. The probe target is the same resolved server the view uses. Saving a different URL in the switch does not start or stop anything. The view host, its partition logic and attach/detach are not modified; after the server is healthy the user presses Retry in the Multica pane (or opens it).

## Security

- Closed allow-list, argv arrays, no shell; folder via native dialog and canonical validation; the renderer sends no paths or command text, only an operation name and an enum service name with a clamped integer.
- IPC only from the trusted shell; payloads that are not exactly the expected shape are ignored; the Multica page cannot reach these channels (its preload is jailed to the bridge channels and they are not on the list).
- Minimal child environment; nothing secret read, passed, logged or persisted; redaction on error text; log lines in memory only.
- One operation at a time, timeouts on every call, cancel.
- Docker is only ever the local engine; AO does not touch the Docker Desktop settings, the images other than by Compose, or any other Compose project: every command names the validated Multica compose file.
- Not a security boundary: the user-chosen folder's compose file runs as that user's Docker; validation makes a mistaken or tampered selection less likely, not harmless.

## Test plan

Vitest, each test must fail without the change, safety tests mutation-checked:

- `multica-local-server-commands.test.ts`: every operation's exact argv; no operation outside the table; `service` and `N` validation; injection attempts (folder names with spaces, quotes, `;`, `$()`, newline, leading `-`); minimal environment (no `COMPOSE_*`, no `DOCKER_HOST`, no AO secrets); docker binary lookup.
- `multica-local-server-validate.test.ts` (real temp dirs): symlinked compose file, escape via symlinked directory, world-writable, wrong name, not Multica, oversized, relative path, NUL byte, other owner is covered through the injected `uid`.
- `multica-local-server.test.ts` (fake exec, fake probe, fake clock): the status table from fake docker output (NDJSON and array forms, every state above), docker missing / daemon down / compose missing, port-conflict and elsewhere derivation, the 90 s grace, ops (start, stop, restart, Docker launch + wait + timeout), one-at-a-time, cancel, timeouts, no secrets in logs and results, redaction, setup (exclusive create, no overwrite, mode `0600`, placeholders replaced, nothing returned), log tail clamping and no persistence.
- `multica-local-server-ipc.test.ts`: untrusted sender ignored, payload validation, dispose.
- `MulticaLocalServerControls.test.tsx`: each state's buttons enabled/disabled, hidden in Cloud, unavailable for a remote URL, busy and cancel, setup, log viewer, error display, live region, no calls before mount.
- i18n parity (existing) and a renderer-coverage check for the new keys.
- Gates: `npm run typecheck`, `npm run typecheck:e2e`, vitest for the touched areas and the full `npm test`, compared with pristine `origin/main` (baseline: native better-sqlite3 / Electron environment failures, 3 files / 22 tests; 54 type errors from `../packages`).

## Decisions

1. No blocker needing a human decision found. Controls are limited to loopback URLs (stricter than the switch's "private network" allowance), because the managed stack is a localhost-only Compose project.
2. Detection suggests, never acts on its own.
3. Verification codes are visible in the log viewer and never persisted.
4. `.env` creation is offered (small, local, exclusive-create); fetching Multica's files is documented, not automated.
5. A separate settings file and a separate IPC module; the server switch and the view host are untouched.

## Implementation notes

- The `.env` existence check runs whenever the folder is valid, even with Docker down, so "Docker not running" is reported when `.env` exists and "Needs setup" when it does not.
- The runner only executes command objects issued by the builders in `multica-local-server-commands.ts` (a module-private `WeakSet`); a hand-built or spread copy is rejected.
- Mutation check of the safety tests: 47 single-point mutants (allow-list guard, service and tail validation, path and mode checks, symlink and escape checks, `.env` exclusive create and mode, redaction, busy flag, timeout and cancel mapping, availability rules, IPC sender and payload checks, UI gating). Every mutant is killed except five single-layer removals of checks that other layers duplicate (the compose-file symlink, the compose-file escape and the template symlink are each rejected by two or three independent checks); removing all layers together is killed.
- The Settings form tests and the e2e fake bridge stub the preload bridge and needed the new `multica.localServer` entry.
- The command tests also run through the real `nodeExec` adapter with `child_process` mocked (every other process API is a recorder that fails the test), using hostile folder names: each validated path must reach `execFile` as one argument, with no `shell` option, no shell binary and no command string. The service tests record every file-system write (`fs`, `fs/promises`, default-import and `promises` styles), console and stdout/stderr output while backend log lines (with a sign-in code) are read, polled and the server is operated; the Settings block test does the same for browser storage and the console. Mutants for argument splitting, `shell: true`, writing log lines to a scratch file and logging them are killed.
- A failed inspection is not a stopped stack: `docker compose ps` failing or printing non-JSON, or `docker version` failing without a recognized connection error (permission denied, unexpected text), derives `unknown` with an `inspect_failed` reason instead of `stopped`; the UI offers no Start for it and the probe is skipped.
- Cancel is checked between the awaits of every operation, not only inside the running command: a cancel during preparation never reaches `setupEnv`, `open -a Docker` or `up`. Setup is checked up to the point the `.env` write begins; from then on cancel reports it is too late, the write completes, and the UI does not show Cancel for setup. The runner's own pre-abort guard remains a second layer.
- The docker binary and the child's PATH come from fixed trusted install roots, not from AO's inherited PATH, and a candidate must pass an ownership and write-permission check on the canonical file and every ancestor directory (see the embed doc). This replaced the earlier PATH-first lookup, which let a writable PATH entry such as /tmp/bin supply `docker` or its helpers.
- Stack validation also checks every ancestor directory, the `.env` (plain file, user-owned, not group/world-writable; a symlink or an uninspectable one is refused) and the compose text (no include/extends/env_file/privileged/host namespaces/devices/build, no bind mounts, loopback ports only, no flow-style volumes/ports). Compose commands pass `-p multica`, and the stack is validated again right before the command so the Docker-start wait cannot widen the window. What stays by design: the image and other settings come from the user's `.env`, and Compose runs the validated file as the user.
- Group write is accepted only for gid 0 (root/wheel) and 80 (macOS `admin`). `staff` (gid 20 on macOS, 50 on Debian) and the user's primary group are shared with other ordinary users, so a binary, compose file or directory that they can write is refused even when the owner is the current user.
- The compose text check was replaced by a parse (js-yaml, declared as a direct dependency; it was already shipped through electron-updater) and an allow-list over the decoded document: quoted or flow-style keys, aliases/merge keys and named-volume `driver_opts` binds can no longer slip through. The image still comes from the user's `.env`, and a Multica release that adds service keys is refused until the allow-list is extended.
