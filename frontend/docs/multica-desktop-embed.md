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

Stubbed: every `daemonAPI` call reports a stopped daemon (run the daemon from the multica CLI), `window:open-issue`, `window:close`, notifications, badge, immersive mode, downloads, directory picker, the updater, and the macOS navigation gesture. The channel list lives in `src/main/multica-desktop-bridge.ts`.

`multica://` deep links are only routed when something hands them to AO (`open-url`, `second-instance`, launch argv). AO does not register itself as the OS handler for `multica://`.

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
- No daemon management and no issue windows.
