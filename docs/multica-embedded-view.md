# Embedded Multica view

Phase 1 of a gradual Multica integration: the desktop app can switch between
AO's own UI and the Multica web UI inside the same window. The backends stay
fully separate. AO does not talk to the Multica server, and nothing in the
Multica repository changes.

## Behavior

- AO is always the default view; the choice is not persisted across launches.
- Switch from the sidebar footer row ("Multica"), the View menu
  ("Switch AO / Multica"), or the `toggle-multica` shortcut (⌘⇧E on macOS,
  Ctrl+Shift+E elsewhere; rebindable under Settings → Keyboard shortcuts).
- Choosing a project or session in the sidebar while Multica is showing returns
  to AO.
- Switching only shows or hides a native view. AO's routes stay mounted and the
  Multica page stays loaded, so neither side reloads or resets.
- The URL lives in Settings → General → Multica (default
  `http://localhost:3000`, the web port from Multica's self-hosting guide).
  Clearing it turns the view off and shows an empty state. An unreachable server
  shows an error state with a retry button.

## Security model

The Multica page is untrusted web content in its own `WebContentsView`:

| Control | Value |
| --- | --- |
| Session | `persist:ao-multica`: separate cookies and storage from the shell and from per-worker browser profiles |
| `contextIsolation` / `nodeIntegration` / `sandbox` | `true` / `false` / `true` |
| Preload | none, so no AO bridge and no IPC |
| Permissions | every request and check denied |
| Main-frame navigation | pinned to the configured origin; anything else is cancelled and, for `http(s)`/`mailto`, opened in the system browser |
| Popups | always denied; same-origin loads in place, other URLs go to the system browser |

Known limits: the Windows custom titlebar paints its own menu, so the View menu item is not shown there (the sidebar row and shortcut still work); only main-frame navigation is pinned (subframes are not), and a
sign-in flow that redirects to another origin (for example Google OAuth) is sent
to the system browser, so it cannot complete inside the embedded view. Use the
email-code sign-in.

## Code map

| Area | Files |
| --- | --- |
| Main process | `frontend/src/main/multica-view-host.ts` (view, lockdown, IPC), `frontend/src/main/multica-settings.ts` (`multica-settings.json` in the AO state dir) |
| Shared | `frontend/src/shared/multica.ts` (URL parsing, constants, state types) |
| Renderer | `components/MulticaPane.tsx`, `components/MulticaSidebarToggle.tsx`, `components/settings/MulticaSettingsSection.tsx`, `stores/multica-store.ts` |

## Upstream-sync touchpoints

Small additive edits in files upstream changes often. Resolve conflicts by
keeping both sides:

- `frontend/src/main.ts`: host creation before the renderer loads, disposal on window close, menu callbacks.
- `frontend/src/main/menu.ts`, `frontend/src/main/app-shortcuts.ts`, `frontend/src/shared/shortcuts.ts`: menu item, shortcut channel, `toggle-multica` catalog entry.
- `frontend/src/preload.ts`, `frontend/src/renderer/lib/bridge.ts`, `frontend/src/renderer/test/setup.ts`: the `multica` bridge namespace and its two stubs. Tests that replace the bridge wholesale and render the shell or General settings (`GlobalSettingsForm.test.tsx`, `test/shell-new-session-shortcut.test.tsx`) also carry a small `multica` stub.
- `frontend/src/renderer/routes/_shell.tsx`, `components/Sidebar.tsx`, `components/settings/GeneralSettingsSection.tsx`: one mount or insert each.
- `frontend/src/renderer/styles.css`: one appended block that keeps the shell transparent over a live page, mirroring the Browser panel's native-composition rules.
- `frontend/src/renderer/i18n/*.json`, `i18n/key-maps.ts`: `multica.*` and `shortcut.toggle-multica` keys in every locale (a parity test requires all eight).
