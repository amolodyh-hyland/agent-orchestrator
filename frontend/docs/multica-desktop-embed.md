# Multica desktop embed (spike)

The AO window can swap, as a whole, between AO and Multica's own desktop renderer. The Multica renderer runs in a full-window `WebContentsView`; AO's main process answers the IPC that Multica's main process would. Switching only shows or hides the view, so neither side reloads.

Switch with the sidebar row, the View menu item "Switch AO / Multica", or the `toggle-multica` shortcut (Cmd/Ctrl+Shift+E by default). The shortcut is handled in the main process, so it also works while the Multica view has focus.

## Run it

Build Multica's desktop bundle (Node >= 22, pnpm 10.28.2, from the `repos/multica` checkout):

```bash
pnpm install
pnpm --filter @multica/desktop exec electron-vite build   # writes apps/desktop/out/{main,preload,renderer}
```

Point AO at the output and start it (use isolated data for experiments, see `AGENTS.md`, "Desktop lab"):

```bash
AO_MULTICA_DESKTOP_OUT=/path/to/multica/apps/desktop/out npm run dev
```

For packaged builds, see [Package it](#package-it). Packaged apps read `<resources>/multica-desktop` and ignore `AO_MULTICA_DESKTOP_OUT` at run time.

The server chosen in Settings feeds Multica's runtime config (see [Choosing the Multica server](#choosing-the-multica-server)). Changing it reloads the Multica view.

## Package it

1. Build Multica's desktop output first with Node 24 and pnpm 10.28.2, from the Multica checkout:

   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @multica/desktop exec electron-vite build
   ```

   Only `apps/desktop/out/renderer/` and `apps/desktop/out/preload/` are used. Do not use the full `build` script; it also bundles a CLI.

2. From `frontend/`, package AO with the output path set at package time:

   ```bash
   AO_MULTICA_DESKTOP_OUT=/path/to/multica/apps/desktop/out npm run package -- --arch=arm64
   ```

   - Without Apple signing variables (`APPLE_SIGNING_IDENTITY`, `CSC_LINK`, `AO_NOTARY_PROFILE`, `APPLE_API_KEY`, and related settings), the app is unsigned.
   - `npm run package` first runs the prepackage steps: Go 1.27.1+ daemon build, tmux built from source, agent-browser download, and ACP runtime. The Forge `prePackage` hook compiles the macOS update helper with `swiftc`. A cold cache therefore needs a Go toolchain, Xcode command line tools, and network access.
   - The result is `frontend/out/Agent Orchestrator-darwin-arm64/Agent Orchestrator.app`.

   - When `AO_MULTICA_DESKTOP_OUT` is set, Forge stages only `renderer/` and `preload/` into the git-ignored `frontend/multica-desktop/` directory, dereferences symlinks, excludes `.map` files, and ships the bundle as `Resources/multica-desktop`. Packaging fails with a clear error if `renderer/index.html` is missing or neither `preload/index.js` nor `preload/index.cjs` exists. `postPackage` re-checks the packaged resources on macOS and Linux. Without the variable, packaging is unchanged and the app has no Multica bundle.

   - The same variable also adds an empty `Resources/ao-updates-disabled` marker before signing, so it is sealed into the app. A build with this marker never self-updates: it skips startup and periodic update checks; manual check and download answer `Updates are turned off in this build.`; install is a silent no-op and update-retry relaunch does nothing; update settings are not applied; the feature-build list is empty; and the startup desktop-version-floor check is skipped. This prevents the app from updating itself to the official release and losing the Multica UI.

   - If the bundle folder is missing, or `renderer/index.html` or the preload entry (`preload/index.js` or `preload/index.cjs`) is missing, switching to Multica shows `Multica isn't bundled with this build` with no retry button instead of a generic connection error; other missing assets are not detected.

   - On macOS only, a packaged AO started outside an Applications folder compares itself with `/Applications/<same app name>` ([`frontend/src/main/relocation.ts`](../src/main/relocation.ts)); `~/Applications` counts as an Applications folder, so there is no hand-off. If the installed copy is the same version or newer, AO opens that copy and quits. If there is no installed copy or it is older, AO offers to move itself into `/Applications`. If the installed version is unreadable or invalid, AO stays where it is and does nothing. Do not double-click the build output while an official AO is installed. The build version is read from `frontend/package.json` in the checkout it is packaged from.

### Test it isolated

1. Launch the executable inside the `.app` with a clean environment (`env -i`) so variables such as `AO_APP_RUN_ID`, `AO_RUN_FILE`, and `AO_DATA_DIR` from a calling AO session do not leak. **Required:** explicitly set `HOME`, `AO_RUN_FILE`, and a free `AO_PORT`; their defaults target the real AO. Replace the example paths with fresh, short temporary directories for this run.

   ```bash
   env -i \
     HOME=/tmp/ao-multica-home \
     AO_DATA_DIR=/tmp/ao-multica-home/data \
     AO_RUN_FILE=/tmp/ao-multica-home/run/ao.json \
     AO_PORT=43127 \
     AO_TELEMETRY_EVENTS=off \
     AO_TELEMETRY_REMOTE=off \
     AO_TELEMETRY_RENDERER=off \
     AO_SENTRY_DSN= \
     TMUX_TMPDIR=/tmp/ao-multica-tmp \
     TMPDIR=/tmp/ao-multica-tmp \
     "/path/to/Agent Orchestrator.app/Contents/MacOS/agent-orchestrator" \
     --use-mock-keychain \
     --remote-debugging-port=9222
   ```

2. Choose a free `AO_PORT` other than the default daemon port 3001, which could otherwise be probed and cause the real daemon to be shut down and replaced. `HOME` moves Electron `userData` (`~/.ao/electron`), `~/.ao`, and `~/.multica`; `TMUX_TMPDIR` is needed because the tmux socket name is fixed. Set `AO_TELEMETRY_RENDERER=off` in addition to `AO_TELEMETRY_EVENTS=off` and `AO_TELEMETRY_REMOTE=off` so the isolated run does not send desktop telemetry. The `--use-mock-keychain` switch keeps Chromium and Electron storage (including `safeStorage`) off the real keychain, so there is no keychain dialog and the real “Agent Orchestrator Safe Storage” item is not used; it does not cover the browser-profile import, which calls `security find-generic-password` itself (do not use that feature in an isolated run). Without it, startup may prompt for keychain access. The remote debugging port is optional. Create no terminal sessions and do not sign in to AO Cloud during this run.

3. This recipe has been run end to end through the AO/Multica toggle and bundled Multica sign-in screen when the app is placed under a directory with an `Applications` path component (for example, `/tmp/<x>/Applications/`), which prevents the relocation hand-off. Use only throwaway test copies; never use `/Applications`.

## What is real and what is a stub

Real: app info, system locale, runtime config, `windowContext` (`main`), freeze breadcrumb (always "none"), `shell:openExternal` (AO's http/https/mailto allowlist), Cmd/Ctrl+W as `tab:close-active`, and `multica://auth/callback?token=` / `multica://invite/<id>` deep links.

Daemon (`src/main/multica-daemon-cli.ts`): `daemonAPI` drives the installed `multica` CLI with fixed argument arrays and timeouts. `getStatus`/`onStatusChange` poll `multica daemon status --output json` every 5 s, `start`/`stop`/`restart` run `multica daemon start|stop|restart`, `probeRuntimes` reports what a running daemon lists, and the log stream tails `~/.multica/daemon.log`. The binary is found on `PATH` (plus `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`); `AO_MULTICA_CLI` overrides it with an absolute path. Only start and restart scan other profiles, including the default profile and named profiles recursively under `~/.multica/profiles/`. A named profile is a directory containing `config.json`; its slash-separated relative path is the profile name and is used to derive its health port and `daemon.pid` path. Directory symlinks are followed only when their resolved target stays inside the profiles root and is not an ancestor already being scanned; an outside directory link makes discovery unknown, while cycles are skipped. Discovery scans at most 6 directory levels and 500 entries. If either bound is exceeded, the scan returns unknown and start/restart refuse to continue. Each discovered profile's health probe is a GET to `127.0.0.1`, with a 1 s wall-clock deadline and a 256 KiB response limit; exceeding either limit, a non-2xx response, an aborted request, or an unusable payload produces no usable answer. A usable health response must be an object with status `running` or `starting`, a numeric PID, and a non-empty daemon ID. If health does not answer, POSIX systems also inspect the command for a live PID from `daemon.pid`; Windows conservatively treats any live PID there as Multica. Start/restart refuse when the scan is unknown or finds a running daemon AO does not own. Stop does not enumerate other profiles: it runs the CLI only when fresh status says `running` or `starting` and the PID, profile, and required process-start identity match AO's marker. If the marker contains a daemon ID, status must also contain the same ID. A missing marker or any other status refuses with `No Multica daemon started by AO is running; stop it where it was started`. After a successful stop, AO removes the marker only when the recorded PID is confirmed gone; a stopped or failed status read does not prove exit. While that PID is alive, AO keeps the marker and reports the last owned running/starting status. The marker stores `{ pid, profile, daemonId, processStart, startedAt }` in `multica-daemon-owner.json` under Electron's user-data directory and is written atomically with mode `0600`. Process-start identity is required to establish ownership. Windows has no process-start lookup, so AO never establishes ownership there; a running Windows daemon is treated as externally managed and AO refuses to stop or restart it.

AO's `externallyManaged` status intentionally means “a daemon AO did not start.” Multica Desktop uses that field to mean a daemon on a different OS, so AO's value can cause the embedded controls to hide Stop/Restart even when the daemon is on this OS. AO passes `MULTICA_LAUNCHED_BY=desktop` only when it runs its bundled CLI; override and PATH binaries keep their own update behavior. Default-profile status polling reports only the default profile and does not surface a Desktop daemon running in a named profile. Only start and restart enumerate other profiles; stop checks ownership of the daemon its status/stop command targets. Polling and the log tail stop when the Multica view is destroyed, and lifecycle commands never overlap. `syncToken`, `clearToken` and `setTargetApiUrl` are deliberate no-ops: the CLI keeps its own login and server config. Preferences stay off (auto-start and stop-on-quit are not implemented).

### Hosted mode

When the AO daemon hosts Multica's daemon (`AO_MULTICA_DAEMON=1`, off by default), the daemon panel starts, stops, restarts and reads the daemon through the AO API (`src/main/multica-daemon-hosted.ts`) instead of this CLI-driven service; the ownership guard and marker above are not used, because AO's daemon supervises the process. A daemon that AO does not run is reported as externally managed, so the panel hides Stop and Restart for it. See [`docs/multica-hosted-daemon.md`](../../docs/multica-hosted-daemon.md).

### Known limits

- For an unbundled CLI (an override or a binary found on `PATH`), Multica's own update or reload can restart the daemon as a new process. AO cannot authenticate that successor, so it shows the daemon as externally managed until the daemon is restarted from AO or the CLI.
- The guard has no atomic lease. Another process can start or replace a daemon between AO's scan/status check and its CLI command.
- If AO starts a daemon successfully but cannot write its owner marker, that daemon remains unmanaged by AO until it is restarted.

### Daemon status mapping decisions

AO does not emit `installing_cli`, `recovery_paused`, or `auth_expired`; Multica Desktop derives those from token probing and its recovery policy. The CLI status JSON has no per-runtime liveness, so `probeRuntimes` reports every listed agent online and none offline.

Notifications and badge: `notification:show` becomes an OS banner with a title and body, using AO's icon off macOS. `src/main/multica-notifications.ts` handles banners, and `src/main/multica-notification-gate.ts` validates payloads and filters duplicates using Multica's payload limits. It shows at most one banner per inbox item id and remembers ids even when suppressed, up to 1000 ids. Banners require a signed-in account tracked through `auth:session-state` in `src/main/multica-auth-session.ts`. A click is ignored if the user signed out or switched accounts after the banner appeared. No banner appears while AO's window is focused and the Multica view is showing; a banner appears when AO's window is in the background or the AO view is showing. Clicking a banner fronts AO, switches to Multica and opens the item with `inbox:open`, using the same route as Multica's own desktop app. If the renderer is not ready, the message waits for it. `badge:set` feeds the combined dock/taskbar badge in `src/main/combined-badge.ts`: AO's unread count plus Multica's. Multica's share drops to zero on sign-out, account switch, a change of the Multica URL, and when the Multica view is destroyed. Changing the URL replaces the Multica view with a new page and new IPC registrations, so the previous page can no longer report state; it closes live banners, forgets the signed-in account, drops a queued `inbox:open`, and carries queued sign-in and invite links over. A positive badge count reported after the renderer signs out is ignored.

Stubbed: `daemonAPI.openLogFile`, `window:open-issue`, `window:close`, immersive mode, downloads, directory picker, the updater, and the macOS navigation gesture. The channel list lives in `src/main/multica-desktop-bridge.ts`.

`multica://` deep links are only routed when something hands them to AO (`open-url`, `second-instance`, launch argv). AO does not register itself as the OS handler for `multica://`.

## Issue links

An AO session can be linked to Multica issues. Nothing changes in the Multica repo or its backend.

- Linking: the action cluster at the right of the session tab strip (alongside open-in-editor, cues and archive, shown for worker sessions once a Multica URL is set) has a chip. Paste an issue URL such as `http://localhost:3000/acme/issues/MUL-123`; the workspace slug and the identifier are stored. UUID URLs and bare identifiers are rejected, because the slug is needed to open the issue and the Multica page title only carries the identifier.
- AO to Multica: choosing a linked issue switches to the Multica view and dispatches Multica's own `multica:navigate` window event with `/<slug>/issues/<IDENT>`. It waits for the `inbox:open` listener (`bridge.whenReady`), the same signed-in layout that handles the event.
- Multica to AO: Multica's renderer uses an in-memory router, so the URL never shows the issue. The host listens to `page-title-updated`; an issue page sets `document.title` to `<IDENT>: <title>`. AO adds an "Open in AO" action to the issue header. Choosing a worker links it to the issue and opens it in AO; the AO session header's links chip shows the link. The legacy `ao://sessions/<project>/<session>` handler still accepts only linked pairs and opens the session in AO.
- Storage: `multica-issue-links.json` next to `multica-settings.json` in the AO state directory (`~/.ao` by default), written atomically with mode `0600`. Desktop only: the daemon, CLI and mobile do not see links, and links are not removed when a session is deleted.
- Version 2: a link also carries `workspaceId` and `issueId` (UUIDs of the issue's workspace and of the issue), filled in the first time [status sync](#status-sync-to-multica) reads the issue, and never replaced afterwards. Both are present or neither is. The slug and identifier stay as display and navigation fields; the identifier is not a stable key (the workspace prefix can change, and two workspaces can share one). A version 1 file is read as it is and becomes version 2 on the next write. A build that only knows version 1 reads a version 2 file as empty and would overwrite it on the next link, so do not run an older build against the same state directory after upgrading.
- Loading: the links store is loaded once by `MulticaPane` at the shell level, so the Open in AO linked markers and Send to AO duplicate check work even when the session links chip is not shown.
- Fragile dependencies on Multica internals, each in one place with a unit test: the issue page title format (`parseMulticaIssueTitle`) and the `multica:navigate` event (`navigatePath` in `multica-view-host.ts`). If either changes, the header action may not appear or opening a linked issue may only surface Multica; nothing else breaks.
- Limits: lookups from the Multica page match on the identifier alone, so two workspaces with the same prefix share links. Links carry the key of the server they were made on and only the selected server's links are listed, opened and marked (see [Choosing the Multica server](#choosing-the-multica-server)).

## Choosing the Multica server

Settings → General → Multica has a **Server** switch: **Multica Cloud** or **Local / self-hosted**. Local takes the server's web address (default `http://localhost:3000`) and an optional API address. Nothing changes for an existing install: with no saved choice, or a saved version 1 file, AO stays on the local default.

Settings file `multica-settings.json` (AO state dir, mode `0600`, atomic writes): `{ "version": 2, "mode": "cloud" | "local", "customUrl": "<web origin>", "apiUrl": "<api origin or empty>" }`. A version 1 file (`{ "url": ... }`) is read as cloud when it named `https://multica.ai`, local otherwise. No tokens or passwords are stored. `resolveMulticaServer` in `src/shared/multica.ts` turns the settings into the server the view uses; it is the only place that derives the API address, partition, CLI profile and issue-link key.

| | Multica Cloud | Local / self-hosted |
| --- | --- | --- |
| Web app | `https://multica.ai` | the saved address |
| API / WebSocket | `https://api.multica.ai`, `wss://api.multica.ai/ws` (Multica Desktop's own defaults) | the explicit API address; else `localhost` or an IP address on `:8080`, a plain-http name on a private network (`http://mybox:3000`) on `:8080` of the same host, any other host on `api.<host>`; the check also tries the web origin itself (a reverse proxy serving `/api` and `/ws` on one origin) and stores that address when it is the one that answers |
| Session partition | `persist:ao-multica-cloud` | `persist:ao-multica` for `http://localhost:3000` with its derived API (so existing sign-ins survive), otherwise `persist:ao-multica-<16 hex of a hash of the server identity>`. The identity is the web origin, plus `|<api origin>` when the API is not the derived one: the sign-in token sits in the partition and is sent to the API, so another API address is another server |
| CLI profile | `ao-multica.ai` | default profile for `http://localhost:3000` with its derived API, otherwise `ao-<web host, sanitized>-<16 hex of the identity hash>`, so hosts that sanitize alike and the same host over http and https never share a profile |

**Validation.** Local addresses are http(s) origins without credentials, path or query. `https://` is required except for `localhost`, loopback, RFC 1918, CGNAT (`100.64.0.0/10`, VPN overlays), unique-local IPv6, single-label names and the `.local`, `.lan`, `.internal`, `.home.arpa` suffixes. Link-local addresses (`169.254.0.0/16`, `fe80::/10`) are not allowed over http because that range holds cloud metadata services, and neither are the well-known metadata names (`metadata`, `metadata.google.internal`, `instance-data`, …); IPv4-mapped IPv6 and credentials or `@`/backslash tricks are rejected, and numeric hosts are judged after WHATWG normalisation (`http://2130706433` is `127.0.0.1`). Hosts are judged by name, not by DNS: a name that resolves to a private address is not detected, and an https host that rebinds to a private address can still be reached. The check only ever requests the fixed paths `/api/config` and `/healthz`, and its answer is reduced to an error code, but it does tell the Settings page whether a host and port answer, so only the trusted shell can call it. Saving a local server first checks it (`src/main/multica-server-check.ts`): `GET <api>/api/config` must answer 200 with Multica's JSON (an `allow_signup` boolean), in 5 s, with no redirect followed and the body capped at 64 KiB; a 503 from `/healthz` is reported as not ready. Failures show a message per cause (unreachable, timeout, certificate not trusted, not a Multica server, not ready) and offer **Save anyway**; invalid, insecure and path errors cannot be forced. Cloud is not checked.

**What a switch does.** The change is applied from a pending bar in Settings (Save and switch / Cancel) that warns that the other server has its own accounts and data. Then the settings are written, the Multica view is destroyed and created again against the new server and partition (shown again if it was showing), queued sign-in and invite deep links are dropped (a token minted for one server is never delivered to another, including another API address for the same web address), and notifications, the badge share and the signed-in account are reset. A `multica://auth/callback?token=` link names no server, so AO only delivers one while a sign-in that the current view started is pending (the view opened its own server's `/login?platform=desktop` page in the browser in the last 10 minutes; one link per sign-in, forgotten when the view is replaced). Invite links are not gated. A switch made while Multica is not showing (for example from Settings) only drops the old server's hidden view; the new server's view is created when Multica is next shown. Saves are serialized in the main process (a check can take seconds), so the last request wins, not the slowest check. The pending bar tells the user that the other server's issue links stay hidden, that a daemon already running for it keeps running, and that AO's hosted daemon only serves the default local server. Switching back finds the earlier sign-in because each server keeps its partition. One-time cost: a user who had saved a custom address other than `http://localhost:3000` signs in again once, because the original partition now belongs to the default local server.

**Send to AO, links and live status** follow the selected server: the issue read takes the server from the live view itself and the script only runs in a view of that server (`evaluateInPage(script, serverKey)`), so a switch while a read is in flight cannot send one server's token to another's API; the issue link points at its web app. The link service learns the selected server synchronously from the view host and also refuses to add a link when the live page belongs to a different server. `multica-issue-links.json` entries carry an optional `serverKey` (`cloud`, the web origin, or `<web origin>|<api origin>`); the first server selected after the upgrade adopts the entries that have none, and the link list, chip, Open in AO markers and live status only use the selected server's entries. The other servers' links stay stored.

**Daemon.** The CLI-driven daemon panel passes `--profile ao-<host>` for every server except the default local one, so a daemon is never started against the wrong server and each server has its own token, pid and health port. AO still does not log in or sync a token: the Settings section shows the sign-in command for the profile (`multica login --profile …` for Cloud, `multica setup self-host --profile … --server-url … --app-url …` for a self-hosted server). The hosted daemon (`AO_MULTICA_DAEMON=1`) is **not** reconfigured by the switch, and the daemon panel only talks to it for the default local server: for every other server the panel drives the CLI with that server's profile (`chooseMulticaDaemonService`), so it never starts, stops or shows a daemon that belongs to another server. The hosted daemon's server and profile come from AO's daemon environment and the profile config at daemon start, and it still refuses non-loopback servers (see [`docs/multica-hosted-daemon.md`](../../docs/multica-hosted-daemon.md)). With hosting on, set `AO_MULTICA_PROFILE` to the profile of the server you want it to follow and restart AO.

**Known limits.** Invite links (`multica://invite/<id>`) carry no token and are routed without a sign-in check. The partition name and CLI profile use a 64-bit hash of the server identity, which keeps servers apart but is not collision-free by construction.

**Known limit.** Every server that was used leaves its own partition (with its Multica sign-in) under AO's `userData` (`~/.ao/electron/Partitions`). Signing out inside Multica removes the token for that server; there is no "forget this server" action yet, so partitions of servers that are no longer used stay on disk until removed by hand.

**Self-hosted server requirements** (from Multica's self-hosting guide): set `FRONTEND_ORIGIN` / `CORS_ALLOWED_ORIGINS` to the address entered here (the WebSocket handshake presents it as its origin), sign in with the email code (SMTP or Resend; without either the code is in the server log), and note that Google sign-in leaves the embedded view for the system browser and cannot finish in AO.

**Security.** Mode and URLs only in the settings file; the check logs and returns only an error code, never the URL or the transport message; no certificate-verification bypass; IPC stays limited to the trusted shell; the WebSocket origin rewrite applies to the selected server's API origin only.

## Send to AO

The existing `ao://multica/send-issue` request still opens the Send to AO dialog in AO's shell, where
the user chooses a project and optionally an agent (the project's worker agent is the default). In
the Open in AO menu, "New task from this ticket" opens the same dialog with that project
preselected through `MulticaSendRequest.projectId`. AO creates a worker session seeded with the
issue, links it to the issue, and opens it.

- Reading: main runs one async script in the Multica page with `webContents.executeJavaScript`
  (`main/multica-issue-reader.ts`). The script reads `localStorage.multica_token` and
  `multica_tabs.state.activeWorkspaceSlug`, then calls `GET <apiOrigin>/api/issues/<IDENT>` with
  `Authorization: Bearer` and `X-Workspace-Slug`. Only issue JSON fields return to main; the token
  stays in the page. As with issue links, the identifier comes from the page title.
- Multica internals that can change: `multica_token`, `multica_tabs` (zustand persist,
  `state.activeWorkspaceSlug`), `/api/issues/<IDENT>`, and the issue page title format.
- Request: `ao://multica/send-issue` carries no data and is handled by
  `multica-issue-link-service.ts`. It remains unchanged and opens the dialog; session creation
  always requires a click in AO.
- Creation: the renderer sends `POST /api/v1/sessions` with `kind: worker`, `projectId`, optional
  `harness`, `prompt`, and `displayName`. It does not send `issueId`; that field is for GitHub and
  GitLab trackers.
- The prompt in `shared/multica-send-to-ao.ts` holds the title, identifier, link, and description
  in an escaped JSON block marked untrusted. It is limited to 16000 bytes; AO rejects prompts
  above 16 KiB.
- The dialog reports signed out, no issue open, or could not read the issue (including unknown
  workspace, network, and timeout errors). There is no title-only fallback because the workspace
  slug is required to link the issue.
- Live linked sessions for the same issue are listed as duplicates; the user can still choose
  "Send anyway".
- "Keep this ticket updated" (unchecked by default, disabled while the master switch of
  [status sync](#status-sync-to-multica) is off) turns the sync on for the new link after the link has
  been saved. If the link could not be saved nothing is turned on.
- The first line of the prompt asks the worker to start the title of any pull request it opens with the
  issue key (`MUL-123: `), which is how Multica's GitHub integration links a pull request to an issue.
  Only a well-formed key is put into that instruction; it sits on the first line so the layout of the
  prompt does not move. This applies to every Send to AO session, whether or not status sync is on, and
  needs the Multica GitHub App on the user's Multica to have an effect.

## Open in AO header menu

On an issue page, AO inserts an "Open in AO" button (small bot icon and label) as a sibling
immediately before the pin button in the issue header action cluster, before the three-dot trigger
and properties-panel toggle. The label is the single constant `OPEN_WITH_AO_LABEL` in
`shared/multica-open-with-ao.ts` (it travels in the page payload; rename it there).
If the cluster is missing or hidden, a floating button with the same menu appears bottom right
above Multica's chat launcher after about 1.5 seconds. It moves back into the header when the
cluster returns; both controls are never shown together.

- Look: the control is a subtle outlined rectangle that follows Multica's own `Button`
  (`variant="outline"`, `size="sm"`; the same component as the Filter, Display and Board buttons of the
  issue list toolbar) from Multica's CSS variables: 28 px high (`--button-height-sm`), 6 px radius
  (`--radius-md`), `--background` fill, `--muted-foreground` text, 13/18 px weight 500 (`--text-label`),
  10 px side padding, 4 px gap, 14 px icon, hover and expanded `--muted` fill, focus ring `--ring`, disabled
  at 50 % opacity; the dark theme (`html.dark`) uses the `--input`-based fill like the native button. The
  border is deliberately lighter than Multica's: a hairline (1 px, 0.5 px on displays with at least 2
  device pixels per CSS pixel) in `color-mix(in oklab, var(--border) 55%, transparent)`. The controller
  injects one `<style id="ao-open-with-ao-style">` scoped to `button[data-ao-open-with-ao="trigger"]` (so
  it does not depend on Multica's compiled Tailwind utilities, which only exist when used) and removes it
  with the controller. The fallback uses the same rules inside its shadow root (`:host-context(html.dark)`).
- Menus: the dropdown and submenus keep Multica's menu component look (8 px radius, 4 px padding, 6 px row
  radius, `--menu-shadow`, `--accent` highlight, `min-width` 8 rem) with the user's compact numbers where
  they differ: a hairline ring in `color-mix(in oklab, var(--surface-border) 55%, transparent)` and hairline
  separators in the same mix of `--border` (no borders around options), 12 px weight 400 options with a
  16 px line box and 6 px vertical padding (rows stay 28 px high; state and section label text 11 px,
  14 px chevrons, 12 px link marker) and a fixed maximum height of 283 px (about 10 rows) for the dropdown
  and every submenu, scrolling inside and additionally clamped to the viewport (checked at 1000x700 and
  1320x860, with 14 projects and a 24-task submenu).
- Style constants: every tunable value is a named export of `shared/multica-open-with-ao.ts`:
  `MENU_MAX_HEIGHT_PX` (283), `MENU_BORDER_WIDTH` ("1px"), `MENU_BORDER_WIDTH_HIDPI` ("0.5px"),
  `MENU_BORDER_COLOR_MIX_PERCENT` (55), `OPTION_FONT_SIZE` ("12px"), `OPTION_FONT_WEIGHT` ("400"),
  `OPTION_LINE_HEIGHT` ("16px") and `OPTION_PADDING_Y` ("6px"), collected in `OPEN_WITH_AO_STYLE` and carried
  in the page payload as `payload.style`, so the injected controller and menu need no imports and a change
  is one line. The control label is `OPEN_WITH_AO_LABEL` ("Open in AO") in the same file.
- Anchor: the first locator layer looks for the three-dot trigger (`button[data-slot=dropdown-menu-trigger]`
  with `svg.lucide-ellipsis`) inside `span.relative.inline-flex` inside
  `div.flex.items-center.shrink-0` inside a `<header>`. The second layer uses the same structure
  without the icon class constraints. The tab strip also has `svg.lucide-pin`, so lookup starts at
  the three-dot trigger. The locator was checked against saved real header markup in
  `frontend/src/main/fixtures/`.
- Recovery: a `<body>` MutationObserver, throttled to 32 ms, and a 2 s validity interval re-anchor
  after React re-renders, route or tab changes, and header hiding. More than 5 relocations in 1 s
  switch to the fallback for 5 s.
- Menu: clicking the button opens a scrollable AO project list, with linked projects first and
  marked. Hovering for 100 ms or pressing ArrowRight opens a scrollable submenu. A project submenu
  shows its orchestrator first, or a disabled "No orchestrator running" row, then tasks, then the
  sticky "New task from this ticket" footer. Tasks sort linked first, active before terminated,
  then by tone urgency and recency. When AO deduces a project, the first level is skipped and the
  dropdown shows that project's content with an "All projects" submenu. Panels flip left near the
  right edge of the window and above the trigger near the bottom.
- Keyboard: ArrowUp/Down, Home/End, ArrowRight/Left, Enter/Space, Escape, and Tab are supported.
  Escape closes the submenu first, then the menu, and returns focus to the trigger; Tab closes the
  menu. Rows show a state dot and text, a "Linked" icon and screen-reader text, and dim stale or
  terminated sessions.
- Project deduction: all issue links point to one AO project -> that project; no links and exactly
  one eligible AO project -> that project; links in several projects -> the project list, linked
  projects first.
- Not implemented: remembered Multica workspace-to-AO project mapping, exact name matching,
  "Start orchestrator", "Send this ticket to the orchestrator" (the daemon `send` route limits its
  message to 4,096 characters), and a toast when linking fails.
- Clicks: choosing a task links the current issue to the worker session (idempotently), then opens
  it in AO. Orchestrators are never linked and open only. The session still opens if linking fails
  or the click-time workspace cannot be confirmed.
- Data: the renderer (`MulticaOpenWithAoPublisher`) publishes a project/session snapshot with a
  150 ms latest-wins publisher. It includes up to 50 projects and 40 workers per project; projects
  and sessions linked anywhere survive those caps. Standalone and cloud projects are excluded. The
  `multicaOpenWithAo:publish` IPC is sender-checked and strictly validates the snapshot. Main builds
  the page payload and runs the controller in AO's isolated page world with `runInAoWorld` on every
  title event, link change, and changed snapshot. Offline, starting, and no-projects states appear
  inside the menu.
- Actions: the page opens `ao://multica/open-with-ao/open/<project>/<session>?n=<nonce>[&w=<workspace slug>]`
  or `ao://multica/open-with-ao/new-task/<project>?n=<nonce>`. The view host offers these URLs to
  the link service, which validates the nonce and snapshot membership. For a task link, it also
  checks that the click-time workspace slug matches the slug and issue title read from the page just
  before saving. The legacy `ao://sessions/<project>/<session>` guard (linked pairs only) and
  `ao://multica/send-issue` are unchanged.
- Security: the controller and nonce live in Electron's isolated world (`MULTICA_AO_WORLD_ID` =
  1001, `executeJavaScriptInIsolatedWorld`), so Multica's page script cannot read or wrap them.
  Action rows run only for trusted events (`event.isTrusted`), so page script cannot synthesize
  clicks. The nonce is per main-process instance and never written to the DOM. Menu text uses
  `textContent` only.
- Limits: labels are English only (the injected script has no i18n); "Linked" marks and matching
  use the issue identifier only, so two Multica workspaces with the same issue prefix share marks.
  A project list over 50 or a project with over 40 workers is truncated ("+N more in AO"). Recovery
  after an AO daemon restart follows the renderer's workspace refetch, about 10–15 s. Menu status
  is the renderer's derived status, using the same tone, label, and detail helpers as before.
- Not verified: Windows and Linux; a native Enter/Space keypress on the header trigger (the live
  check used synthetic CDP key events, which do not produce click activation); screen-reader
  announcements (ARIA uses `menu`, `menuitem`, `aria-haspopup`, and `aria-expanded`; `aria-controls`
  is intentionally omitted because the menu is in a shadow root); the packaged build (the controller
  is serialized with `Function.prototype.toString`; a Vite-minified standalone script module was
  exercised in a review probe, but the packaged Electron main bundle was not run); Multica builds
  other than bundled `b2561aad`; very large (100+) project lists.
- Files: `frontend/src/shared/multica-open-with-ao.ts`,
  `frontend/src/main/multica-open-with-ao.ts`, `...-anchor.ts`, `...-menu.ts`, `...-script.ts`,
  `frontend/src/main/multica-issue-link-service.ts`, `frontend/src/main/multica-view-host.ts`,
  `frontend/src/renderer/lib/multica-open-with-ao-feed.ts`,
  `frontend/src/renderer/components/MulticaOpenWithAoPublisher.tsx`.

## Status sync to Multica

AO can write the progress of a linked session to the status of the Multica issue, so the Multica board
shows where the work is. It is **off by default** at two levels and writes **status only**.

- Settings → General → Multica → **Update Multica ticket status** is the master switch (off). With it off
  no code path writes to Multica. `AO_MULTICA_SYNC=0` in AO's environment forces everything off whatever
  the settings say; the settings page says so.
- Each link is turned on separately, off by default: the switch in the session's links chip, a row in the
  Open in AO menu, or the unchecked **Keep this ticket updated** box in Send to AO.
- It runs only while AO's desktop app is open and the embedded Multica view is loaded and signed in
  (decision D8). It writes as the signed-in user (D10): the Multica activity feed shows the change as theirs.
- Forward only: `in_progress`, `in_review`, `done`. It never writes `backlog`, `todo`, `blocked` or
  `cancelled`, never changes the assignee, never posts a comment, never deletes anything, and never ends or
  stops a session.

Decision ids (D1 to D13) and question ids (Q1 to Q14) in this section come from the board-link design review; the
answers to every question are written down below.

### The mapping (AO to Multica)

The key is the session's board column (derived by the daemon) plus its facts. `src/shared/multica-status-writer.ts`
holds the rules and `multica-status-writer.test.ts` has a test per row.

| # | AO situation | Written |
|---|---|---|
| 1 | linked issue, no live session AO knows | nothing |
| 2 | session provisioning, or provisioning failed | nothing |
| 3 | worker active, no PR | `in_progress` |
| 4 | worker idle, no PR | nothing |
| 5 | needs input, or blocked | nothing (`blocked` is never written, D11) |
| 6 | exited, no signal | nothing |
| 7 | PR open and AO still turns the loop (column `validating`) | `in_progress` |
| 8 | PR waits on a person (column `needs_review`) | `in_review` |
| 9 | PR approved or mergeable, not merged (column `ready`) | `in_review` |
| 10 | every PR merged, session alive | `done` |
| 11 | PR closed without merging (or merged beside a closed one), session alive | nothing |
| 12 | session terminated, no merged PR | nothing |
| 13 | session terminated, every PR merged | `done` |
| 14 | issue is `done` or `cancelled` (or `blocked`) and AO would write something | paused "closed in Multica"; **Reopen** writes once, only after the user confirms (D12) |
| 15 | several enabled links to one issue | the most actionable live session decides: one with something to write ranks before one with nothing to say, then AO's own board ranking; ended sessions only count when nothing is live, and then only to carry a merge to `done` |
| 16 | issue assigned to a Multica agent or squad | nothing: refused, shown as "Driven by Multica". **Triage is not covered today**, see below. A sub-issue whose parent is owned by an agent or squad (or cannot be read) is refused too, see "Sub-issues" |
| 17 | Multica shows a status AO did not write or agree with | paused "changed in Multica" |

"Forward only" is a rule on top of the rows: a status behind the one Multica shows is never written (after AO
wrote `in_review`, a later round of CI fixes does not move the issue back to `in_progress`).

### Answers to the open questions (D13)

| Q | Answer in this slice |
|---|---|
| Q1 | A session started on a Backlog issue moves it to `in_progress`; the setting "Move tickets out of Backlog" (on) turns it off. The write is previewed first (`POST /api/issues/preview-trigger`): if Multica says it would start a run, AO refuses; if it cannot ask, AO does not write (fails closed for this move only). |
| Q2 | Idle worker, no PR: no write. |
| Q3 | `needs_input`, `exited`, `no_signal`: no write, never `blocked` (D11). |
| Q4 | `in_progress` until the board column is `needs_review`. |
| Q5 | Follows the column, forward only: `in_review` while a person owns the next turn; AO does not move an issue back to `in_progress`. |
| Q6 | PR closed without merging, session alive: no write; the person decides. |
| Q7 | Session ended with no PR: no write. |
| Q8 | Reopen only with an explicit confirmation in AO (D12). The "session started after the done time" test of the design is replaced by that confirmation. |
| Q9 | Most actionable live session wins (row 15). |
| Q10 | AO always writes the built-in key. It reads `status_category`, so a custom status inside the target category counts as agreement and is left alone. Asking when a workspace has a custom status in the target category is **not built** (AO does not read the status catalog). |
| Q11 | Inbound (Multica to AO): **not in this slice.** |
| Q12 | Issue `done` while a session is live: nothing; AO has no way to end a session from sync. |
| Q13 | Forwarding comments: **not in this slice.** |
| Q14 | A session linked to several issues writes only to the first one it was linked to; the others show "Updates go to the first linked ticket". |

### Safety rules

- **Allow-list.** `src/main/multica-issue-api.ts` builds every request from validated fields and refuses
  anything else: `GET /api/issues/{identifier}`, `GET /api/issues/{id}` (only to read the parent of a
  sub-issue), `PUT /api/issues/{id}` with exactly `status`, `expected_revision` and `suppress_run`, and
  `POST /api/issues/preview-trigger`. The status must be one of
  the three writable ones. A test fails if any other method, path or body field can be produced, or if
  `assignee_*`, `backlog`, `todo`, `blocked` or `cancelled` can appear in a write.
- **`suppress_run: true` on every status write.** Multica's `PUT /api/issues/{id}` can start an agent run for
  the written issue itself (the only status write that can is `backlog` to an active status on an
  agent-assigned issue); `suppress_run` applies the change without starting that run, whatever the assignee.
  **It does not make a write inert.** After any status change Multica always runs the parent's sub-issue rules
  (`processChildEvents`: the child-done rule and people's sub-issue conditions), see the next rule. Other
  status-triggered automations in Multica (issue conditions and rules) are not modelled either. The fake
  Multica server counts runs for the written issue (`runsStarted`, stays at zero) and parent wake-ups
  (`parentWakes`).
- **Sub-issues.** Finishing a sub-issue (or any status change on it) runs the parent's rules, which wake the
  parent's assignee: an agent gets a run, a squad its leader, a member an inbox notification, and `suppress_run`
  does not cover it. Writing a status is what a person clicking Done does too, but AO does it automatically. So
  when the issue has a `parent_issue_id`, and AO is about to write, it reads the parent first (the one extra
  allow-listed `GET`). If the parent is owned by a Multica agent or squad, or cannot be read, AO does not write
  and the link shows "Sub-issue: could wake the parent's agent" (refused, `sub_issue_parent`). A parent
  owned by a member, or by nobody, is written as for a person (the member gets the usual notification). A
  transient read failure is retried with backoff. Nothing is read when there is nothing to write.
- **Row 16, and why.** AO refuses to write when the assignee is a Multica agent or squad because **an agent
  owns that status**, and Multica itself resets `in_progress` to `todo` after a failed run, not because the
  write would start a run (`suppress_run` covers that).
- **Triage is NOT protected today.** Multica's issue JSON has no `triage_state` field and no other read path
  exposes it, and its `PUT` guard only locks `parent_issue_id` for an issue in Triage. Multica treats the status
  of a Triage entry as the triager's *proposal* (accepting confirms it) and lets ordinary status writes through;
  its own PR auto-complete skips Triage ("not accepted yet"). So with sync on for a link, AO **writes over a
  triager's proposal** on an entry that still sits in Triage (shown by Multica as backlog or todo): the status
  changes, `triage_state` stays set, no agent run starts (Multica refuses runs for Triage and `suppress_run` is
  on), but a Triage child can become `done`. AO refuses only if the issue JSON ever carries a triage field, or a
  write answers `issue_in_triage`; neither happens today. Until Multica exposes the field, turn sync on only for
  tickets that have been accepted (the Settings page says so). The "Move tickets out of Backlog" setting does
  not help for a Triage entry shown as `todo`. A test pins this behaviour so it is not mistaken for coverage.
- **Compare and set.** Every write reads the issue first and sends `expected_revision`. On a revision
  conflict AO reads again once, decides again, and writes once more; a second conflict stops until the next
  pass. A person's change between the read and the write wins.
- **Pause fence.** AO remembers the status it last wrote (or last saw and agreed with) per issue. If the issue
  later shows a different status category, a person moved the card: the link pauses ("changed in Multica"),
  nothing is written, and the person's status becomes the new baseline. AO looks again when its own mapped
  status changes to a new one, or when the user presses **Resume**. A status inside the same category (a custom
  status) is not a conflict. "Sync now" on a paused link reads again and never writes.
- **Echo suppression.** A personal token writes as the member, so the actor cannot tell AO's write from the
  user's. The value and revision can: the same status at a revision no newer than the one AO's write returned
  is AO's own write coming back (`isOwnEcho`), and it changes nothing and pauses nothing.
- **Done is sticky.** A `done`, `cancelled` or `blocked` issue is never written without a confirmed reopen.
  Resume does not reopen. The confirmation is an AO dialog; the main process refuses a reopen request that
  does not carry `confirmed: true`.
- **Debounce and budget.** Changes in a 5 s window collapse into one write of the latest state; at most 12
  writes per issue per hour and 30 per server per minute; a read every 10 minutes per enabled issue to notice
  changes made in Multica; backoff 5 s to 5 min on an unreachable server; `Retry-After` on 429.
- **One server at a time.** Only links of the selected server are acted on, the in-page script is bound to
  that server (`evaluateInPage(script, serverKey)`), a server switch drops everything queued or in flight for
  the old one, and the saved state is keyed by server. A 401 stops every link of that server (no retry storm)
  until the Multica page reports a sign-in or the user presses Sync now.
- **No new secret.** Writes use the signed-in user's token that is already in the Multica page
  (`localStorage.multica_token`), read inside the page with `credentials: "omit"` and no redirects. The token
  never reaches the main process, the renderer, a file or a log, and the page hands back only a fixed set of
  scalar fields (never the description, comments or an error sentence). The sync state file stores no token,
  title or description.
- **Audit hook.** `createMulticaStatusSync({ record })` calls `record()` after every status write attempt
  (success or failure), every pause and every resume or reopen, with `kind` (`status_write`, `pause`,
  `resume`), the server key, workspace and issue ids, the identifier, the session, the allow-listed request
  fields, `revBefore`, `revAfter` and the result. It carries no token, title or text from Multica. The sink is a
  no-op today so a later action log can plug in; a failing sink never stops sync.

### What the user sees

- Open in AO menu: under each linked worker, a row: **Keep this ticket updated** (off), **Stop updating this
  ticket** with the state (**Synced**, **Syncing…**, **Paused: changed in Multica**, **Driven by Multica**,
  **In Triage**, **Sign in to Multica**, **Open Multica to sync**, **Not synced, retrying**, **AO offline**, and
  so on), or **Resume updating this ticket** after a pause. The menu is English only like the rest of that menu.
- Session links chip: per link a switch, the state, the reason, what Multica shows against what AO would set, and
  Resume, Reopen… (confirmation dialog) and Sync now where they apply. Localized in all eight locales.
- UI states per link: off, on (synced or pending), paused, refused, error.

| State | Reasons |
|---|---|
| off | link off; master switch off; `AO_MULTICA_SYNC=0` |
| paused | changed in Multica; closed in Multica; blocked in Multica |
| refused | driven by Multica (agent or squad); sub-issue whose parent an agent or squad owns, or that AO cannot read; in Triage (only if Multica ever exposes the field); identifier now names another issue; would start a Multica run; secondary link |
| error | signed out; Multica view not available; unreachable; no access (403); issue not found (404); rate limited; AO offline (the daemon feed is down, nothing is written) |

### Storage

`multica-sync-state.json` in the AO state directory (mode `0600`, atomic writes): the settings, the links that
are turned on, and per issue the last status AO wrote or saw, the pause, the last sync time and whether the issue
was not found. Version 1. Removing a link, or turning off the last link of an issue, forgets that issue's state.
Issue links move to version 2 (see [Issue links](#issue-links)).

### Not verified, and not built

- Known limit: the Open in AO menu matches links to the issue on screen by session and identifier only, the same limit as the rest of that menu (the page title carries no workspace), so two workspaces with the same prefix can show each other's sync row. The link chip in AO matches the workspace as well.
- After a write whose answer is lost (timeout, app quit), AO has recorded its intent (`intent` in `multica-sync-state.json`) and recognises its own write at the next read instead of reading it as a change made in Multica.
- Not verified live: that the embedded Multica view stays loaded and signed in while hidden (the engine waits and
  retries with "Open Multica to sync" when it is not); real PR, CI and review transitions; Multica Cloud;
  Windows and Linux; a packaged build; a Multica older than the one with `suppress_run`. Not modelled, so not
  covered: any other automation Multica runs after a status change (issue conditions and rules, parent
  rules beyond the parent's own assignee, notifications to subscribers).
- Not built: inbound changes (Multica to AO), comments, the PR link carrier beyond the title hint, a custom-status
  prompt (Q10), an action log (only the hook), a drift check for the API routes (the existing
  `check:multica-bridge` covers Multica's preload channels only; the routes and field names used here are
  `GET /api/issues/{id}`, `PUT /api/issues/{id}` with `status`, `expected_revision`, `suppress_run`, and
  `POST /api/issues/preview-trigger`), reconciliation while the desktop app is closed.

### Manual verification plan

Not run by the author. Use a throwaway local Multica and an isolated AO (see "Desktop lab" in `AGENTS.md`:
a separate worktree, its own `AO_DATA_DIR`, `npm ci`, never your real `~/.ao`); never Multica Cloud, never a
real workspace.

1. Sign in to the local Multica in the embedded view. Create issue `MUL-1` (assigned to you, status To do).
2. Settings → General → Multica: turn on **Update Multica ticket status**. Confirm nothing changed in Multica.
3. Open `MUL-1`, Send to AO with **Keep this ticket updated** ticked. Expect the menu row to read Synced and
   the issue to move to In progress within about 5 s of the worker becoming active.
4. Let the worker open a PR (title starts with `MUL-1:`). Expect In review when the PR waits on a person, then
   Done after the merge.
5. Move the card by hand to To do while the session is live: expect "Paused: changed in Multica", no further
   writes, then **Resume**.
6. Assign the issue to a Multica agent: expect "Driven by Multica" and no status writes.
7. Close the issue (Done), start another session on it: expect "Paused: closed in Multica", and **Reopen…**
   asks before writing.
8. Sign out of Multica: expect "Sign in to Multica", no requests; sign in again and expect it to resume.
9. Switch the server (Cloud or another local): links of the other server disappear and nothing is written.
   Start AO with `AO_MULTICA_SYNC=0`: expect everything off.
10. In every step the Multica activity feed should show only the status changes you expect, as you.

### Files

`src/shared/multica-status-writer.ts` (rules), `src/shared/multica-status-sync.ts` (contract and validators),
`src/main/multica-issue-api.ts` (allow-listed requests), `src/main/multica-status-sync.ts` (engine),
`src/main/multica-sync-state.ts` (state file), `src/main/multica-status-sync-ipc.ts` (shell bridge),
`src/main/multica-fake-server.test-support.ts` (the fake server the tests use), and in the renderer
`src/renderer/lib/multica-sync-facts.ts`, `components/MulticaSyncFactsPublisher.tsx`,
`components/MulticaLinkSyncControls.tsx` and `stores/multica-sync-store.ts`.

## Security model

Multica's preload is attached to the Multica view only, in its own persistent partition per server (`persist:ao-multica` for the default local server), with sandbox and context isolation on, every web permission denied, and main-frame navigation pinned to the built bundle (anything else goes to the system browser).

Multica's preload also exposes a generic `window.electron.ipcRenderer`, and several of its channel names (`daemon:start`, `daemon:stop`, `daemon:restart`) collide with AO's own global handlers. Two layers deal with that:

- The bridge registers on the view's own `webContents.ipc`, which Electron consults before the global `ipcMain`, so the Multica view reaches the bridge's stubs and never AO's handlers. Every handler also checks the sender.
- `src/main/multica-ipc-jail.ts` writes a small preload that runs before Multica's own and limits every outbound `ipcRenderer` method to the bridge's channel list.

`webSecurity` stays on (`MULTICA_WEB_SECURITY` in `src/shared/multica.ts`). Multica's cloud API and a default local self-host both accept REST calls from the `file://` renderer.

Status sync adds no stored secret and no new network path: its requests run inside the Multica page with the
signed-in user's own token (see [Status sync to Multica](#status-sync-to-multica)).

## CLI binary and attribution

The CLI resolver checks `AO_MULTICA_CLI` first; when set, it is the only candidate. Otherwise it checks the bundled CLI, then `PATH` and the usual user-install directories. Packaged apps look for the bundled executable at `Resources/multica-cli/multica` (or `multica.exe` on Windows). Builds without a bundled CLI can still use a CLI found through the remaining resolver paths.

To include the CLI in a package, set `AO_MULTICA_CLI_BIN` to the absolute path of a built Multica executable and `AO_MULTICA_NOTICE_DIR` to the directory containing Multica's `NOTICE` and `LICENSE`. Packaging stages the executable and copies both attribution files next to it, records its SHA-256 in `multica-cli/multica.sha256`, then recomputes and checks the staged digest before signing. After packaging, verification requires a non-empty regular executable with the target platform's Mach-O, ELF, or PE header, non-empty regular `LICENSE` and `NOTICE` files, and a well-formed SHA-256 record naming the expected platform binary. Unsigned builds and all non-macOS builds must match the recorded digest. A signed macOS build skips the final digest comparison only after `codesign --verify --strict` succeeds for the packaged binary. The staged pre-signing digest is always checked.

The Multica LICENSE text says that when the daemon or CLI is used without a Multica user interface, user-facing documentation must state that the product is built on Multica and link to [Multica](https://github.com/multica-ai/multica). Builds embedding the Multica UI must leave the Multica logo, product name, and copyright display unmodified.

When AO starts or restarts the daemon with its bundled CLI, it sets `MULTICA_LAUNCHED_BY=desktop`. Multica uses this attribution to skip CLI self-update and mark the runtime as managed by Desktop. To update or roll back a bundled CLI, rebuild the AO package with a different `AO_MULTICA_CLI_BIN`; the `multica.sha256` file records the staged pre-signing binary digest. For unsigned packages it also matches the packaged executable; a signed macOS package may contain changed bytes after signing.

The Open in AO controller runs in Electron's isolated world (`MULTICA_AO_WORLD_ID` = 1001),
separate from Multica's page script. Its per-process nonce is not written to the DOM, menu labels
use `textContent`, and action rows require trusted events.

The WebSocket is different: the handshake carries `Origin: file://`, and a Multica server checks it by exact match against `FRONTEND_ORIGIN`/`CORS_ALLOWED_ORIGINS`, so it answers 403. The view's session therefore replaces `file://`/`null` with the configured Multica app origin on WebSocket handshakes to the configured API origin only (`multicaWebSocketHeaders`). Normal requests are not touched, so no server config is needed.

## Checking bridge drift when multica changes

The embedded Multica UI calls channels served by AO's `multicaBridgeChannels()` list. The IPC jail
uses that list to limit outbound IPC. A renamed, added or removed channel in Multica's
`apps/desktop/src/preload/index.ts` can stop working in the embed or be blocked by the jail.

Run the check on every Multica submodule bump, and before building or packaging the embed against a
newer Multica checkout. In the noetaxis workspace, the checkout is `repos/multica` beside the AO
checkout.

From AO's `frontend/` directory, run:

```sh
npm run check:multica-bridge
```

Use `npm run check:multica-bridge -- --multica <dir>` or set `MULTICA_DIR` to select another
checkout. The default is `../../multica`, relative to `frontend/`. The check requires Node 24. It
reads the Multica checkout without executing or writing to it; its only Git operation there is
the read-only `git rev-parse HEAD` used to report the commit.

Exit codes:

- `0`: no drift; warnings are allowed.
- `1`: channel drift was found.
- `2`: an error or setup problem, including a missing checkout or baseline, unsupported preload
  construct, or unsupported Node version.

Read the report sections as follows:

| Section | Meaning and action |
| --- | --- |
| `ADDED` | Multica uses an outbound channel AO does not serve, so the jail blocks it. Add it to the bridge as a real handler or stub; this also adds it to the jail list. |
| `REMOVED` | AO serves an outbound channel Multica no longer uses. Delete the stale handler or stub. |
| `CHANGED` | The channel's IPC kind differs. Match the bridge kind; a `sendSync` listener must set `event.returnValue`. |
| `RENAMED` | The same API member now uses a different channel. Update the bridge to the new channel. |
| `INBOUND` | Main-to-renderer channels differ from the baseline. Decide whether AO delivers, stubs or ignores each change, and record that in “What is real and what is a stub.” |
| `WARNINGS` | Globals or API members changed, declarations disagree, or AO's allowlist differs from registered bridge handlers. Review each warning; warnings alone do not fail the check. |
| `NOTES` | The baseline is missing or behind the current preload. Follow the note before accepting the change. |

`scripts/multica-bridge-baseline.json` records the accepted Multica commit (`multicaCommit`),
preload path, exposed globals and members, and entries with `api`, `channel` and `kind`. It enables
channel-rename detection and comparison of inbound changes. After resolving outbound drift and
reviewing inbound changes, refresh it with:

```sh
npm run check:multica-bridge -- --update-baseline
```

The command refuses to update while outbound differences remain. Inbound-only differences do not
block the write, so decide and record their disposition before refreshing. Commit the baseline
together with the submodule bump so reviewers can inspect the accepted surface change.

The check does not compare arguments or payload shapes for unchanged channels, does not read
Multica's main-process registrations, and does not cover AO's own shell IPC. A preload construct
the extractor cannot resolve is an error, not a silently omitted channel. The extractor follows
string literals, shared constants, one-level helper functions and API members written as inline
values or inline functions, and treats any other way to reach `ipcRenderer` as an error, so ordinary
refactors are caught and unusual code makes the check fail loudly rather than pass. API member labels
in the report are best effort (calls made inside module-level helper functions are labelled `(module) <function>`); AO serves channels by name, so only channels and IPC kinds decide whether the check passes.

## Known gaps

- No updater for this build, by design.
- Windows packaging of the Multica bundle is not verified; the `postPackage` resource check runs on macOS and Linux only.
- A build is only as new as the AO base it was packaged from.
- Windows: AO's frameless window has no native controls under the Multica view.
- Not verified: macOS traffic-light placement and drag regions with real mouse input. Open in AO's platform, packaged-build, keyboard-trigger, screen-reader, and large-list verification gaps are listed above.
- The banner, click-through and badge path is covered by unit tests and was verified on macOS in the dev app against a signed-in local Multica server (real inbox events, OS banners, clicks that open the item, combined badge, sign-out). It has not been verified on Windows or Linux.
- Status sync (see above) is verified against a fake Multica server in unit tests only; the live checks are listed in its manual verification plan.
- No CLI install or update, no auto-start, and no issue windows.
