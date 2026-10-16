# Google sign-in callback for AO's embedded Multica

**Status:** Design only. This note does not implement Google sign-in in AO.

## Recommendation

Keep Google sign-in unsupported inside AO for now and document email-code sign-in. Email-code login has been confirmed against official Multica Cloud; self-hosted servers need working outbound email. If embedded Google sign-in becomes a priority, pursue a loopback callback with a short-lived, single-use handoff code and AO-generated state. Do not register `multica://` in AO while Multica Desktop also owns that scheme.

## Existing Multica Desktop flow

The desktop login page opens `<Multica web origin>/login?platform=desktop` in the system browser. For official Cloud, the web origin is `https://multica.ai`; a self-hosted desktop build uses its configured app URL.

For email-code login, the web app establishes its cookie session, calls `api.issueCliToken()` for the desktop handoff, then navigates to `multica://auth/callback?token=<JWT>`. For Google, the login page sends `platform:desktop` in OAuth state and uses `<Multica web origin>/auth/callback` as Google's redirect URI. That callback exchanges Google's code through `api.googleLogin(code, redirectUri)`, then sends the same token-bearing deep link. The callback page also shows an explicit button that retries the deep link if automatic navigation did not open the desktop app.

The desktop package declares the `multica` protocol in `apps/desktop/electron-builder.yml`; the macOS package receives a `CFBundleURLTypes` entry. At runtime, `apps/desktop/src/main/index.ts` calls `app.setAsDefaultProtocolClient("multica")` and accepts links through macOS `open-url` or Windows/Linux second-instance and cold-start arguments. The main process extracts the token and sends `auth:token` to the renderer. `apps/desktop/src/renderer/src/App.tsx` passes it to `loginWithToken`, which completes the desktop login.

The token is a bearer JWT in the callback URL query. Whoever receives that URL receives the credential. The callback carries no AO-generated sign-in state, server identity, or audience binding.

## AO behavior today

AO packaging registers only `ao-app://` for AO cloud authentication in `frontend/forge.config.ts` and `frontend/src/main/cloud-auth.ts`. The main process also recognizes `multica://` in its `open-url`, second-instance, and cold-start argument handlers, then routes a delivered link to the embedded view. Those handlers do not make AO the operating system's `multica://` client.

`frontend/src/main/multica-view-host.ts` starts a 10-minute sign-in window only when the current view opens its own server's `/login?platform=desktop` page in the system browser. A token callback is delivered only if that same view is still live and the window has not expired. The window is consumed before dispatch, so the callback is single-use, and it is cleared when the view is replaced. The bridge queues dispatch until the embedded renderer is ready. This blocks unsolicited callbacks when no sign-in is pending, but does not cryptographically bind a callback to the pending attempt: the deep link contains only a token, and the OS does not confirm which app produced it.

## Options

| Option | Work and effort | Security and behavior |
| --- | --- | --- |
| **A. Register `multica://` in AO** | Add a second protocol to the Electron Forge packaging configuration and runtime registration, then route accepted callbacks to the live embedded view. The packaged macOS app must include a `CFBundleURLTypes` entry. Add packaged-app coverage for cold and warm launches on macOS, Windows, and Linux. **Effort: low to medium.** | Any installed application can claim a custom scheme. Multica Desktop already registers `multica://`; macOS routes a link to the one Launch Services handler selected for that scheme, not to both apps. The selected app can vary with installation/registration history or the user's handler choice. AO could receive the callback instead of Multica Desktop, or vice versa. This also exposes the bearer JWT to whichever handler wins. The existing pending-view gate does not stop an attacker from substituting a callback during a real sign-in. A nonce returned through the callback would still be needed. **Risk: high; delivery is not reliable when both apps are installed.** |
| **B. Use a loopback HTTP callback** | When a sign-in begins, have the AO main process bind an ephemeral port on `127.0.0.1`, create unpredictable state, and serve one exact callback path. Multica web would need to accept that client callback and return a short-lived, single-use handoff code; AO would exchange the code for a token. Close the listener after success, failure, or a short timeout. Google's redirect URI can remain `<Multica web origin>/auth/callback`; the Multica web callback would perform the final handoff to AO. This web/API support is unverified; the inspected flow only emits `multica://`. **Effort: medium to high**, including an AO main-process listener and a Multica web/API contract. | No custom-scheme ownership conflict. Require exact loopback host and path, a random state/nonce checked by AO, a single-use code bound to that state, and a short listener lifetime. Do not put the bearer JWT in the callback URL. A local process could probe or race for the listener, so port randomness alone is insufficient; state validation and one-time exchange are required. Multica must validate and restrict the callback to loopback rather than becoming an open redirect. **Risk: medium with the stated controls; contract and browser-to-loopback behavior need end-to-end verification.** |
| **C. Leave Google unsupported and document it** | Keep the existing pending-sign-in gate and explain that email-code login is the supported AO path. **Effort: low.** | Adds no callback listener or protocol ownership. The current product limitation remains. **Risk: low.** |

## Security details

- **Scheme hijacking and app conflict:** registering `multica://` does not authenticate the receiving app. On a Mac with both applications installed, only the registered default handler receives the URL; the operating system does not broadcast it. AO must not assume that its own protocol registration will win or that registration by AO and Multica Desktop can coexist safely.
- **State and CSRF:** AO's 10-minute, single-use gate ties receipt to a recent login action in the current view, but the callback contains no attempt identifier. A callback sent during that window could still substitute a token from another account or server. A future flow needs unpredictable AO-generated state carried through the web flow and checked at the final handoff. Bind the handoff to the selected server as well.
- **Token leakage:** the current deep link puts a reusable bearer token in the URL. It can be exposed to the operating system's protocol handler, the receiving application's launch arguments, diagnostics, or other URL logging. A one-time code exchanged over the loopback connection limits the value of a leaked URL.
- **Loopback boundary:** bind only to `127.0.0.1`, use an ephemeral port, validate the exact host, path, and state, accept one callback, and close promptly. A random port without state is not CSRF protection. Do not reuse AO's daemon listener for this callback.

## Source paths reviewed

- AO: `frontend/src/main/multica-view-host.ts`, `frontend/src/main.ts`, `frontend/src/main/cloud-auth.ts`, `frontend/forge.config.ts`
- Multica Desktop: `apps/desktop/src/renderer/src/pages/login.tsx`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/electron-builder.yml`
- Multica Web: `apps/web/app/(auth)/login/page.tsx`, `apps/web/app/auth/callback/page.tsx`
