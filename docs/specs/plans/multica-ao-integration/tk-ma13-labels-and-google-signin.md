# TK-MA13: Multica server labels and Google sign-in

**Status:** Server-switch wording implemented. Google sign-in remains unsupported in AO; this document records the design only.

## Result

Settings → General → Multica now distinguishes the official hosted service from self-hosted servers:

| Choice | English label | Existing translation key |
| --- | --- | --- |
| Official service | `Multica Cloud (official)` | `multica.settings.mode.cloud` |
| Local or remote deployment | `Self-hosted (local or remote)` | `multica.settings.mode.local` |

The same keys remain in use across `en`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, and `zh-CN`. The helper text explains that self-hosted sign-in needs working email delivery and that Google sign-in currently cannot finish inside AO. The pending switch bar now says the selected server has its own accounts and data, needs a separate sign-in, and does not copy data from the server being left. Its additional notes clarify that links from the previous server remain hidden until switching back and that AO's hosted daemon serves the default local Multica server.

The Settings test covers both server labels, the helper and pending-bar copy, and the apply/cancel behavior. `frontend/docs/multica-desktop-embed.md` describes the two server choices and links this design note. The wording change does not alter server selection, saved settings, OAuth, or callback handling.

## Multica Desktop sign-in flow

The Multica Desktop login page opens `<Multica web origin>/login?platform=desktop` in the system browser. The official Cloud origin is `https://multica.ai`; a self-hosted desktop build uses its configured web origin.

1. **Email code:** the user completes email-code sign-in on the web page. The page calls `api.issueCliToken()` and returns to the desktop app through `multica://auth/callback?token=<JWT>`.
2. **Google:** the login page starts Google OAuth with `platform:desktop` in its OAuth state and uses `<Multica web origin>/auth/callback` as Google's redirect URI. The web callback exchanges the provider code through `api.googleLogin(code, redirectUri)`, then returns through the same token-bearing `multica://` URL. The page offers a button to retry opening the desktop app if automatic navigation fails.
3. **Desktop receipt:** `apps/desktop/electron-builder.yml` declares the `multica` protocol, including a macOS `CFBundleURLTypes` entry. The desktop main process calls `app.setAsDefaultProtocolClient("multica")` and accepts warm and cold launch URLs through the platform handlers. It extracts the token and sends `auth:token` to the renderer; the renderer calls `loginWithToken` to complete the session.

The callback URL contains a bearer JWT. Any process that receives or records the URL can obtain that credential. The callback has no AO-generated state, server identity, or audience binding.

## AO behavior today

AO registers `ao-app://` for AO cloud authentication in `frontend/forge.config.ts` and `frontend/src/main/cloud-auth.ts`. AO also has runtime handlers that recognize a delivered `multica://` URL and route an eligible token to the embedded Multica view. Those handlers do not register AO as the operating system's `multica://` client.

`frontend/src/main/multica-view-host.ts` gates delivery on a sign-in initiated by the current embedded view. The view must open its selected server's `/login?platform=desktop` page in the system browser; the view must remain live; and the callback must arrive within ten minutes. The gate is consumed before dispatch, so it accepts one callback, and it is cleared when the view is replaced. Dispatch waits until the embedded renderer is ready. This rejects unsolicited callbacks outside a pending sign-in, but it is not cryptographic attempt binding: the URL has no nonce or state and the token is not bound to the selected server.

## Design options

| Option | Work and effort | Security and behavior |
| --- | --- | --- |
| **A. Register `multica://` in AO** | Add the scheme to AO's Electron Forge protocol configuration and macOS `Info.plist` `CFBundleURLTypes`; register it at runtime and route warm and cold launch callbacks to the live embedded view. Add packaged-app checks on macOS, Windows, and Linux. **Effort: low to medium.** | Custom schemes can be claimed by another application. Multica Desktop already registers `multica://`. On a Mac with both installed, Launch Services chooses one handler for the URL; it does not deliver the callback to both. Which app receives it can depend on the selected default handler and registration history. The same class of handler conflict exists on Windows and Linux. The winning app receives the bearer token. An attacker can also register the scheme, and AO's pending-sign-in gate alone does not prevent substitution during a real sign-in. **Risk: high; delivery is unreliable when both apps are installed.** |
| **B. Use a loopback HTTP callback** | At sign-in start, AO's main process binds an ephemeral port on `127.0.0.1`, creates unpredictable state and a PKCE verifier, and serves one exact callback path for a short time. The browser still returns from Google to the Multica web callback. Multica then issues a short-lived, single-use handoff code bound to AO's state, PKCE challenge, and selected server, and redirects to AO's loopback callback. AO validates the host, path, state, expiry, and single-use status, exchanges the code over HTTPS, and closes the listener. This requires a new Multica web/API contract; the inspected flow currently emits `multica://` instead. **Effort: medium to high.** | Avoids custom-scheme ownership conflicts and keeps the bearer JWT out of the callback URL. Require exact `127.0.0.1` binding, a random port, unpredictable state, a one-time code, PKCE verification, server binding, a short expiry, and listener shutdown on every outcome. Random port selection alone is not CSRF protection; a local process can probe or race for the listener. Multica must validate and restrict loopback return targets rather than becoming an open redirect. Browser-to-loopback behavior and platform packaging need end-to-end verification. **Risk: medium with these controls.** |
| **C. Keep Google unsupported and document it** | Keep the current pending-sign-in gate and explain that email-code sign-in is the supported AO path. Self-hosted servers must be configured to send email. **Effort: low.** | Adds no listener and no protocol registration. The limitation remains clear to users. **Risk: low.** |

## Security findings

- **Scheme hijacking and app conflict:** registering `multica://` does not prove which application receives a link. With AO and Multica Desktop installed on the same Mac, only the handler selected by Launch Services receives the callback. AO must not assume both registrations can coexist or that AO will win.
- **CSRF and state:** the current ten-minute, single-use gate is useful defense in depth, but it does not bind a callback to the account, server, or OAuth attempt. A future callback needs unpredictable AO-generated state checked at receipt and a handoff credential bound to that attempt and server.
- **Token leakage:** the existing JWT in the URL can pass through OS handler arguments, diagnostics, and URL logging. A short-lived one-time code, redeemed directly by AO, limits the value of a leaked callback.
- **Loopback boundary:** use only `127.0.0.1`, an ephemeral port, an exact path and host check, single-use state and code, short expiry, and prompt listener closure. Do not reuse AO's daemon listener. Avoid logging callback query values.

## Recommendation and what to build

For TK-MA13, ship the clearer server labels and authentication guidance, and keep Google sign-in unsupported inside AO. Email-code sign-in works with official Multica Cloud; a self-hosted deployment needs outbound email configured. Do not register `multica://` in AO while the official Multica Desktop app uses the same scheme.

If embedded Google sign-in becomes a product requirement, pursue Option B with Multica web/API support for a one-time handoff code, AO-generated state, PKCE, selected-server binding, and a strict loopback return target. Then implement an ephemeral callback listener in AO's main process and test wrong-state, wrong-server, expired, replayed, canceled, and concurrent attempts as well as packaged warm/cold launches. Do not pass a bearer JWT in the callback URL. Option A should be reconsidered only if the Multica Desktop scheme conflict is removed or there is a reliable user-managed handler-selection design.

## Sources reviewed

- AO: `frontend/src/main/multica-view-host.ts`, `frontend/src/main.ts`, `frontend/src/main/cloud-auth.ts`, `frontend/forge.config.ts`, and the Multica Settings strings and tests.
- Multica: `apps/desktop/src/renderer/src/pages/login.tsx`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/electron-builder.yml`, `apps/web/app/(auth)/login/page.tsx`, and `apps/web/app/auth/callback/page.tsx`.
