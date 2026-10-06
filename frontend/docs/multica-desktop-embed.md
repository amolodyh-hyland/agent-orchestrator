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

The Multica URL in Settings (default `http://localhost:3000`) feeds Multica's runtime config: a local or IP-address host uses its API on `:8080`, any other host uses `api.<host>`. Changing it reloads the Multica view.

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
- Loading: the links store is loaded once by `MulticaPane` at the shell level, so the Open in AO linked markers and Send to AO duplicate check work even when the session links chip is not shown.
- Fragile dependencies on Multica internals, each in one place with a unit test: the issue page title format (`parseMulticaIssueTitle`) and the `multica:navigate` event (`navigatePath` in `multica-view-host.ts`). If either changes, the header action may not appear or opening a linked issue may only surface Multica; nothing else breaks.
- Limits: lookups from the Multica page match on the identifier alone, so two workspaces with the same prefix share links.

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

## Security model

Multica's preload is attached to the Multica view only, in its own persistent partition (`persist:ao-multica`), with sandbox and context isolation on, every web permission denied, and main-frame navigation pinned to the built bundle (anything else goes to the system browser).

Multica's preload also exposes a generic `window.electron.ipcRenderer`, and several of its channel names (`daemon:start`, `daemon:stop`, `daemon:restart`) collide with AO's own global handlers. Two layers deal with that:

- The bridge registers on the view's own `webContents.ipc`, which Electron consults before the global `ipcMain`, so the Multica view reaches the bridge's stubs and never AO's handlers. Every handler also checks the sender.
- `src/main/multica-ipc-jail.ts` writes a small preload that runs before Multica's own and limits every outbound `ipcRenderer` method to the bridge's channel list.

`webSecurity` stays on (`MULTICA_WEB_SECURITY` in `src/shared/multica.ts`). Multica's cloud API and a default local self-host both accept REST calls from the `file://` renderer.

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
- No CLI install or update, no auto-start, and no issue windows.
