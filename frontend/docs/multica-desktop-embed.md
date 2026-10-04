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

Packaged builds read the bundle from `<resources>/multica-desktop` and ignore the env var. Packaging that directory is not wired yet.

The Multica URL in Settings (default `http://localhost:3000`) feeds Multica's runtime config: a local or IP-address host uses its API on `:8080`, any other host uses `api.<host>`. Changing it reloads the Multica view.

## What is real and what is a stub

Real: app info, system locale, runtime config, `windowContext` (`main`), freeze breadcrumb (always "none"), `shell:openExternal` (AO's http/https/mailto allowlist), Cmd/Ctrl+W as `tab:close-active`, and `multica://auth/callback?token=` / `multica://invite/<id>` deep links.

Daemon (`src/main/multica-daemon-cli.ts`): `daemonAPI` drives the installed `multica` CLI with fixed argument arrays and timeouts. `getStatus`/`onStatusChange` poll `multica daemon status --output json` every 5 s, `start`/`stop`/`restart` run `multica daemon start|stop|restart`, `probeRuntimes` reports what a running daemon lists, and the log stream tails `~/.multica/daemon.log`. The binary is found on `PATH` (plus `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`); `AO_MULTICA_CLI` overrides it with an absolute path. Polling and the log tail stop when the Multica view is destroyed, and lifecycle commands never overlap. `syncToken`, `clearToken` and `setTargetApiUrl` are deliberate no-ops: the CLI keeps its own login and server config. Preferences stay off (auto-start and stop-on-quit are not implemented).

Stubbed: `daemonAPI.openLogFile`, `window:open-issue`, `window:close`, notifications, badge, immersive mode, downloads, directory picker, the updater, and the macOS navigation gesture. The channel list lives in `src/main/multica-desktop-bridge.ts`.

`multica://` deep links are only routed when something hands them to AO (`open-url`, `second-instance`, launch argv). AO does not register itself as the OS handler for `multica://`.

## Issue links

An AO session can be linked to Multica issues. Nothing changes in the Multica repo or its backend.

- Linking: the session header (next to the status pill, shown once a Multica URL is set) has a chip. Paste an issue URL such as `http://localhost:3000/acme/issues/MUL-123`; the workspace slug and the identifier are stored. UUID URLs and bare identifiers are rejected, because the slug is needed to open the issue and the Multica page title only carries the identifier.
- AO to Multica: choosing a linked issue switches to the Multica view and dispatches Multica's own `multica:navigate` window event with `/<slug>/issues/<IDENT>`. It waits for the `inbox:open` listener (`bridge.whenReady`), the same signed-in layout that handles the event.
- Multica to AO: Multica's renderer uses an in-memory router, so the URL never shows the issue. The host listens to `page-title-updated`; an issue page sets `document.title` to `<IDENT>: <title>`. When that identifier has links, AO injects a small shadow-DOM pill (`multica-linked-sessions-pill.ts`) into the page. Clicking it calls `window.open("ao://sessions/<project>/<session>")`; the view's window-open handler offers the URL to the link service, which accepts only linked pairs, switches back to AO and asks the shell to open the session.
- Storage: `multica-issue-links.json` next to `multica-settings.json` in the AO state directory (`~/.ao` by default), written atomically with mode `0600`. Desktop only: the daemon, CLI and mobile do not see links, and links are not removed when a session is deleted.
- Fragile dependencies on Multica internals, each in one place with a unit test: the issue page title format (`parseMulticaIssueTitle`) and the `multica:navigate` event (`navigatePath` in `multica-view-host.ts`). If either changes, the pill disappears or opening an issue only surfaces Multica; nothing else breaks.
- Not verified: behavior against a signed-in Multica server and the pill's position over Multica's UI. Verified in an Electron 33 probe: title events for page-initiated changes, `executeJavaScript` in the page main world, the pill rendering, and a click reaching the window-open handler.
- Limits: lookups from the Multica page match on the identifier alone, so two workspaces with the same prefix would share links; the pill label is English only.

## Send to AO

The AO pill on every Multica issue page has a "Send to AO" button. It opens a dialog in AO's shell
where the user chooses an AO project and optionally an agent (the project's worker agent is the
default). AO creates a worker session seeded with the issue, links it to the issue, and opens it.

- Reading: main runs one async script in the Multica page with `webContents.executeJavaScript`
  (`main/multica-issue-reader.ts`). The script reads `localStorage.multica_token` and
  `multica_tabs.state.activeWorkspaceSlug`, then calls `GET <apiOrigin>/api/issues/<IDENT>` with
  `Authorization: Bearer` and `X-Workspace-Slug`. Only issue JSON fields return to main; the token
  stays in the page. As with issue links, the identifier comes from the page title.
- Multica internals that can change: `multica_token`, `multica_tabs` (zustand persist,
  `state.activeWorkspaceSlug`), `/api/issues/<IDENT>`, and the issue page title format.
- Request: `ao://multica/send-issue` carries no data and is handled by
  `multica-issue-link-service.ts`. Any page script can trigger it, but it only opens the dialog;
  session creation always requires a click in AO.
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
- Not verified: behavior against a signed-in live Multica server, pill placement, and localization
  of the pill label (main uses English literals).

## Security model

Multica's preload is attached to the Multica view only, in its own persistent partition (`persist:ao-multica`), with sandbox and context isolation on, every web permission denied, and main-frame navigation pinned to the built bundle (anything else goes to the system browser).

Multica's preload also exposes a generic `window.electron.ipcRenderer`, and several of its channel names (`daemon:start`, `daemon:stop`, `daemon:restart`) collide with AO's own global handlers. Two layers deal with that:

- The bridge registers on the view's own `webContents.ipc`, which Electron consults before the global `ipcMain`, so the Multica view reaches the bridge's stubs and never AO's handlers. Every handler also checks the sender.
- `src/main/multica-ipc-jail.ts` writes a small preload that runs before Multica's own and limits every outbound `ipcRenderer` method to the bridge's channel list.

`webSecurity` stays on (`MULTICA_WEB_SECURITY` in `src/shared/multica.ts`). Multica's cloud API and a default local self-host both accept REST calls from the `file://` renderer.

The WebSocket is different: the handshake carries `Origin: file://`, and a Multica server checks it by exact match against `FRONTEND_ORIGIN`/`CORS_ALLOWED_ORIGINS`, so it answers 403. The view's session therefore replaces `file://`/`null` with the configured Multica app origin on WebSocket handshakes to the configured API origin only (`multicaWebSocketHeaders`). Normal requests are not touched, so no server config is needed.

## Known gaps

- Windows: AO's frameless window has no native controls under the Multica view.
- Not verified: macOS traffic-light placement and drag regions with real mouse input, and Electron 33 against Multica's screens beyond sign-in, onboarding and the empty workspace.
- No CLI install or update, no auto-start, and no issue windows.
