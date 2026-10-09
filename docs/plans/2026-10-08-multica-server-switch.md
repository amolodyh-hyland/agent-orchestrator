# Multica server switch: Cloud or Local / self-hosted

Status: implemented on `feat/multica-server-switch` (local). The shipped behavior is described in `frontend/docs/multica-desktop-embed.md` ("Choosing the Multica server"); this file keeps the findings and the decisions behind it.

A switch in Settings → General → Multica that chooses which Multica server the embedded view talks to:
**Multica Cloud** (the hosted service) or **Local / self-hosted** (the user's own server, default `http://localhost:3000`, or any custom URL such as `https://multica.example.com`). Moving between them never moves data; each server has its own accounts, workspaces and sign-in.

## How it works today (findings)

| Question | Answer |
| --- | --- |
| Where is the server URL stored? | `multica-settings.json` in the AO state dir (`browserProfileStateDir()`, `~/.ao` by default), shape `{ "url": "<web url>" }`, mode `0600`, written atomically. `frontend/src/main/multica-settings.ts`. Default `http://localhost:3000` (`MULTICA_DEFAULT_URL`). Empty string turns the view off. |
| Who reads it? | The view host (`multica-view-host.ts`, at start and on every `multica:setSettings`), `multica-send-to-ao.ts` and `multica-issue-link-service.ts` (each calls `readSettings()` per use), and the settings section through the `multica:getSettings`/`setSettings` IPC (`preload.ts`, `renderer/lib/bridge.ts`). `main.ts` wires `readMulticaSettings`/`writeMulticaUrl`. |
| How does the embedded UI pick its server? | AO embeds Multica's **built desktop renderer** (a `file://` page from the bundle, `AO_MULTICA_DESKTOP_OUT` or `Resources/multica-desktop`), not the web app. The desktop bridge answers its `runtime-config:get` with `multicaRuntimeConfig(url)` (`shared/multica.ts`): host `localhost` or an IP literal → API on `:8080` of that host; any other host → `api.<host>`; ws URL derived; `appUrl` = the web origin. |
| What is Multica Cloud? | Multica Desktop's `DEFAULT_RUNTIME_CONFIG` (`apps/desktop/src/shared/runtime-config.ts`): app `https://multica.ai`, API `https://api.multica.ai`, ws `wss://api.multica.ai/ws`. AO's `multicaRuntimeConfig("https://multica.ai")` already yields exactly that, so cloud works today by typing the URL. |
| How does standalone Multica Desktop switch servers? | It reads `~/.multica/desktop.json` (`{schemaVersion:1, apiUrl, appUrl?, wsUrl?}`) once at startup (restart needed; missing file = cloud). It derives a CLI profile `desktop-<api host>` (`~/.multica/profiles/desktop-<host>/`) so each server has its own CLI login, daemon, pid and health port. |
| Session partition | One fixed partition `persist:ao-multica` for any URL. The renderer is a `file://` page, so its `localStorage` (Multica keeps its token there) is keyed by `file://` and **shared by every server**: today a cloud token would be offered to a local server and the reverse. This is the main thing the switch must fix. |
| URL change at runtime | `applySettings` destroys the view and creates a new one (queued sign-in/invite deep links are carried over), resets notifications and the badge share. |
| Send to AO / issue links / live status | Send to AO runs a script in the Multica page that reads `localStorage.multica_token` and calls `<apiUrl>/api/issues/<ID>` (`apiUrl` and the issue web URL come from the settings through `multicaRuntimeConfig`). Issue links (`multica-issue-links.json`) store `{sessionId, projectId, workspaceSlug, issueIdentifier}` with no server; lookups match on identifier alone. Live status is published into the page for linked issues (`multica-status-publisher.ts`, `multica-link-status.ts`) and is reset whenever the page reloads. |
| Daemon (CLI path) | `multica-daemon-cli.ts` runs the `multica` CLI with fixed args and passed **no `--profile`** (the CLI has a persistent root `--profile` flag, and `login` and `setup self-host` honour it; only the hosted daemon's environment variable `AO_MULTICA_PROFILE` is fixed at daemon start), so AO always targeted the default profile (`~/.multica/config.json`), whatever the view shows. Token sync is a deliberate no-op (the CLI keeps its own login). |
| Daemon (hosted, `AO_MULTICA_DAEMON=1`) | The supervisor in AO's Go daemon reads `AO_MULTICA_PROFILE`/`AO_MULTICA_HEALTH_PORT` from AO's environment **once at daemon start**; the child reads the profile's `token` and `server_url` (or `MULTICA_SERVER_URL`) and **refuses any non-loopback server** (`requireLocalServer`, exit 78). It never writes the token. |
| Settings UI | `renderer/components/settings/MulticaSettingsSection.tsx` (one `SettingsInputRow`), mounted in `GeneralSettingsSection.tsx`. Existing building blocks: `SettingsRow`, `SettingsInputRow`, `SettingsOptionMenu`. |
| i18n | `renderer/i18n/{en,zh-CN,ja,ko,es,fr,de,pt-BR}.json`, English is the typed source (`messages.ts`); a parity test requires all eight. Multica keys are `multica.*`. |
| Server side (from the Multica checkout) | `GET /api/config` is public and reachable on the API origin and, through the web app's rewrites, on the web origin; `/healthz` (ready) and `/health` (live) exist on the API origin only. WebSocket handshakes are accepted only if their `Origin` is in `CORS_ALLOWED_ORIGINS`/`FRONTEND_ORIGIN` (AO already presents the app origin, `multicaWebSocketHeaders`), so a self-hosted server must list the app origin (`SELF_HOSTING_ADVANCED.md`). Email-code sign-in works with SMTP or Resend, or from the backend log; Google OAuth redirects to another origin, which the embedded view sends to the system browser, so it cannot complete in the view (existing limit). A same-origin deployment (reverse proxy serving `/api` and `/ws` on the web origin, no `api.` host) is a documented, recommended layout; the current `api.<host>` rule cannot reach it. |

## Settings model

`multica-settings.json`, version 2:

```json
{ "version": 2, "mode": "local", "customUrl": "http://localhost:3000", "apiUrl": "" }
```

- `mode`: `"cloud"` or `"local"`. Cloud uses the fixed Multica Cloud config above and ignores `customUrl`, which is kept so switching back restores it.
- `customUrl`: the web origin for local/self-hosted mode. Default `http://localhost:3000`. Empty = view off (today's "cleared" behavior), still allowed in local mode.
- `apiUrl` (advanced, optional): explicit API origin. Empty = auto-resolve (below).
- Migration from `{ "url": ... }` on read, no data loss: missing file → `local` + default (**current behavior is the default**); `url` empty → `local`, empty; `url` is `https://multica.ai` → `cloud`; otherwise `local` + that URL. The file is rewritten as version 2 on the next save.
- One pure function `resolveMulticaServer(settings)` in `shared/multica.ts` returns `{ key, mode, appUrl, apiUrl, wsUrl, partition, label } | null` and replaces the direct `multicaRuntimeConfig(url)` calls in the view host, Send to AO and the WebSocket header rewrite. `multicaRuntimeConfig` stays as the default derivation inside it.
- API URL resolution for local mode: explicit `apiUrl` wins; else the existing rule (localhost/IP → `:8080`, other host → `api.<host>`); the connection check (below) also probes the web origin itself, so a same-origin deployment is found and the winning API origin is persisted as `apiUrl`.

IPC: `multica:getSettings` returns the version 2 object plus the resolved server; `multica:setSettings` takes `{ mode, customUrl, apiUrl?, force? }` and returns `{ ok: true, settings } | { ok: false, error }`; new `multica:checkServer` runs the check without saving. The old `setSettings(url: string)` signature is replaced everywhere it appears (preload, bridge types, fake bridges, test setup).

## Validation

Pure, in `shared/multica.ts`, unit tested (extends `parseMulticaUrl`):

- http(s) only, no userinfo (as today); normalized to the origin; a non-root path or query is rejected ("enter the server address without a path"); persisted values with a path are reduced to their origin on read.
- **https required**, except for `localhost`, loopback IPs, RFC 1918 ranges, link-local, `fc00::/7`, CGNAT `100.64/10` (VPN overlays), single-label hosts and `.local`, `.lan`, `.internal`, `.home.arpa`. A public host over `http://` is rejected with a message that names the fix ("use https://"). Hostnames are judged by name, not by DNS; this is a usability guard, not a security boundary.
- Cloud mode takes no user input, so it cannot be pointed anywhere else.

Connection check (main process, `net.fetch`, 5 s timeout, no redirects followed to another origin, response capped at 64 KiB):

1. `GET <candidate>/api/config` for each candidate API origin (explicit, derived, web origin itself).
2. Shape check on the JSON (an object carrying Multica's `allow_signup` boolean) so a random web server on :3000 is not mistaken for Multica.
3. Optional `GET /healthz` on the API origin; a 503 is reported as "reachable but not ready (database or migrations)".

Errors are codes mapped to localized messages with the fix: `invalid_url`, `insecure_http`, `unreachable` (connection refused / DNS), `timeout`, `tls` (certificate not trusted; the system trust store is used and AO offers no "ignore certificate errors"), `not_multica`, `not_ready`. On a failed check the section shows the error and a "Save anyway" action (`force: true`), because a self-hosted server may legitimately be down when the user saves; `invalid_url` and `insecure_http` cannot be forced.

## What a switch does at runtime

Saving a changed server (mode, custom URL or API URL; compared by `key`, not by string) goes through a confirmation dialog in the section, then:

1. **Persist** (queued, atomic, `0600`, as today).
2. **Reload the view against the new origin**: the existing destroy-and-recreate path in `applySettings`, with `createView` choosing the partition from the resolved server. If the Multica view was showing it stays showing and loads the new server's sign-in; if not, it stays idle.
3. **Separate partition per server**. `persist:ao-multica` is kept for `http://localhost:3000` so existing logins survive the upgrade; Cloud uses `persist:ao-multica-cloud`; any other origin uses `persist:ao-multica-<first 16 hex of a 64-bit hash (two FNV-1a passes) of the server identity; it only has to keep servers apart, it is not a security hash>`. Because the `file://` renderer's `localStorage` lives in the partition, a cloud token is never offered to a local server and the reverse. Switching back finds the previous login. Known one-time cost: a user who already had a custom URL other than `localhost:3000` signs in again once.
4. **Deep links**: queued `multica://auth/callback` and invite links are **not** carried over a server change (today they are carried over a URL change); a token minted for one server must not be delivered to another. Notifications, the badge share, the signed-in account and any queued `inbox:open` are reset, as on a URL change today.
5. **Send to AO** and **issue links** follow the new server: Send to AO takes `apiUrl` and the issue web URL from `resolveMulticaServer`. Links gain an optional `serverKey`; new links get the current key, the list/open/duplicate lookups filter on it, and legacy links without a key are adopted once by the first server resolved after the upgrade (they were made under that URL). Links of the other server stay stored and reappear when switching back. **Live status** is only published for links of the active server, and the publisher already resets on page reload, so the new page starts clean.
6. **CLI daemon path**: `localhost:3000` default keeps today's behavior (default profile, no `--profile`). For Cloud and any other server the service passes `--profile ao-<host>` (Multica's own convention, the standalone desktop uses `desktop-<host>`), so a daemon is never started against the wrong server and each server has its own token, pid and health port. AO still does not log in or sync a token: the section shows the exact sign-in command for that profile (`multica setup self-host --profile ao-<host> --server-url <api> --app-url <web>` for a self-hosted server, as in the self-hosting guide; `multica login --profile ao-<host>` for Cloud) and the daemon panel surfaces the CLI's own "not signed in" error.
7. **Hosted daemon** (`AO_MULTICA_DAEMON=1`, off by default): its server and profile still come from AO's daemon environment and the profile config, fixed at daemon start, and the loopback-only rule stays (Cloud and remote URLs are refused, exit 78, exactly as `docs/multica-hosted-daemon.md` states). The switch therefore does **not** restart or reconfigure it. The daemon panel talks to it only for the default local server; other servers get the profile-bound CLI service. Sign-in deep links (`multica://auth/callback?token=`) name no server and are only delivered while a sign-in started by the current view is pending. With hosting on, set `AO_MULTICA_PROFILE` to the profile of the server the daemon should follow and restart AO (documented; a mismatch warning in the section was left out because the renderer has no hosted-status reader). `AO_MULTICA_PROFILE`, `AO_MULTICA_HEALTH_PORT` and `MULTICA_SERVER_URL` set by the user pass through unchanged; AO never invents them.

User-facing warning shown in the confirmation dialog and under the switch: *"The other server has its own accounts and data. You will need to sign in again there, and nothing is copied between servers."* A one-line note says the self-hosted server must list the entered address as its frontend origin (`FRONTEND_ORIGIN`/`CORS_ALLOWED_ORIGINS`; AO presents that origin on WebSocket handshakes) and that Google sign-in is not available in the embedded view (email code is).

## Default

No settings file, or a file with `url` unset/default: Local, `http://localhost:3000`, partition `persist:ao-multica`, default CLI profile, hosted daemon untouched. Nothing changes for an existing user until they flip the switch.

## Security

- The settings file holds mode and URLs only: no tokens, no passwords, mode `0600` (unchanged). Multica's token stays where Multica puts it (the view's partition `localStorage`, and `~/.multica` for the CLI); AO does not read, copy, sync or write it, and does not log it.
- Nothing credential-like is logged or returned over IPC: the check logs only the origin and an error code; URLs with userinfo are rejected, so none can leak into logs or the UI. The reader script's token handling is unchanged (the token never leaves the page).
- Plain `http://` only for loopback and private networks; no TLS verification bypass; redirects to another origin are not followed by the check.
- IPC stays gated on the trusted shell sender; the Multica view still has no AO bridge. Main-frame navigation stays pinned to the bundle.
- The WebSocket `Origin` rewrite applies only to the active server's API origin, and the permission, popup and `will-navigate` rules are unchanged.
- Cloud mode talks to a third-party hosted service by the user's explicit choice; nothing is sent to it until the Multica view is opened.

## Decisions taken

1. **Hosted daemon vs custom servers**: unchanged (loopback-only, not reconfigured by the switch, no Go change). Serving an explicit self-hosted HTTPS server from the hosted daemon would need a Go change (allowlist env, supervisor reconfigure API, OpenAPI regeneration) and is left for a follow-up.
2. **Legacy login for a non-default custom URL** is lost once (partition naming).
3. **Check-before-save** blocks with "Save anyway".

## Test plan

Vitest unless noted; each new test must fail without the change.

- `shared/multica.test.ts`: URL validation matrix (https required, private-network allowances, path/query rejection, userinfo), `coerce` migration of version 1 files, `resolveMulticaServer` (cloud config equals Multica's defaults, local derivation, same-origin API, explicit `apiUrl`), partition naming (legacy name for `localhost:3000`, cloud, hashed, stable).
- `main/multica-settings.test.ts`: persistence of mode and URLs, migration on read, atomic write and `0600`, invalid input rejected, queueing.
- `main/multica-server-check.test.ts` (new): each error code, shape check, timeout, no cross-origin redirects, no body/URL secrets in the result.
- `main/multica-view-host.test.ts`: switching mode destroys the view and loads with the new partition; switching back reuses the first partition; deep links not carried across a server change but still carried across a no-op re-save; view active/idle preserved; WebSocket header rewrite uses the active server.
- `main/multica-send-to-ao.test.ts`, `main/multica-issue-link-service.test.ts`, `main/multica-issue-links.test.ts`: follow the active server, key filtering, one-time legacy adoption.
- `main/multica-daemon-cli.test.ts`: default profile for `localhost:3000`, `--profile ao-<host>` otherwise, fixed argument arrays preserved.
- `main/multica-daemon-hosted.test.ts` and a `main.ts`-level env test: hosting on/off leaves `AO_MULTICA_*`/`MULTICA_SERVER_URL` untouched; mismatch warning input is derived from the hosted status.
- `MulticaSettingsSection.test.tsx`: mode switch, confirmation dialog and warning text, error codes, Save anyway, custom URL and advanced API URL, sign-in command for the profile.
- i18n: the existing parity test covers all eight locales; new `multica.settings.*` keys added to each.
- Go: no Go change planned, so `go build/vet/test` only run if the open question 1 is answered the other way.
- Gates: `npm run typecheck`, `npm run typecheck:e2e`, vitest for the touched files and the i18n/shell tests that stub the bridge, then the full `npm test` before handover.

## Manual verification in the packaged app

Use the isolated launch recipe in `frontend/docs/multica-desktop-embed.md` ("Test it isolated": `env -i`, scratch `HOME`, `AO_DATA_DIR`, `AO_RUN_FILE`, a free `AO_PORT` other than 3001, `--use-mock-keychain`, a copy outside `/Applications`). Then: open Settings → General → Multica; confirm Local `http://localhost:3000` is selected; start a local Multica (`docker compose -f docker-compose.selfhost.yml up -d`, sign in with the code from the backend log); switch to Cloud, confirm the dialog warns, the view reloads to Multica Cloud's sign-in and the local login is not offered; switch back and confirm the local session is still signed in; enter an unreachable and an `http://` public URL and check the messages; enter a reachable self-hosted URL (listed in `CORS_ALLOWED_ORIGINS`) and confirm sign-in, then Send to AO on an issue and the live status chip against that server.
