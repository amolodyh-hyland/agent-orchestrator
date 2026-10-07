# Grouped orchestrator and task tabs (top toolbar)

One flat tab system in the toolbar: a group per project, each group = an orchestrator "head" tab followed by that project's task tabs. Tabs follow VS Code preview/persistent semantics. Additive: the sidebar and the Kanban board stay.

## Behaviour

- **Preview vs persistent.** Any activation of a session (sidebar, board, command palette, notifications, links, tray, the Multica "Open in AO" action, back/forward) opens it as a **preview** tab (italic title). The next preview in the same group replaces it in place. A tab becomes **persistent** when the user acts on the session (send/answer/interrupt/steer a chat message, change turn settings, type in the terminal, run a cue/command, switch agent, save a file, restore, rename) or double-clicks the tab. Viewing never persists (scrolling, focus, resize, terminal protocol replies, agent output, opening a file for reading, inspector tabs, pin/unpin, staging attachments).
- **Head and task previews are independent slots.** When a task tab of a group becomes persistent, an opened preview head of that group becomes persistent too.
- **Groups.** A group exists once its orchestrator or one of its tasks was opened. An orchestrator that was never opened shows as an "anchor" head (no status dot). Projectless sessions share one logical "Scratchpad" group of head-styled tabs. Groups can be collapsed (head + "+N" badge); activating a task of a collapsed group expands it.
- **Closing.** Close button, middle-click, or the menu. Closing the head closes the whole group. Closing the active tab navigates to its left neighbour, else the head, else the project board (`/sessions` for scratchpads).
- **Cap.** At most 100 tabs. When a new tab would exceed it, the oldest non-active preview (task, scratchpad or opened head) goes first, then the least-recently-active non-active persistent task; the active tab and heads are never evicted individually; one toast reports the closed count.
- **Lifecycle.** Tabs of killed/archived sessions and of removed projects are pruned once the workspace data has settled (cloud origin is never inferred from the id shape; the routed session is never pruned while viewed).
- **Menus.** Every tab has exactly one three-dot menu (right-click opens the same entries, minus the session-scoped actions): task/scratch tabs: Rename (F2), Keep open, Close, Close other tabs, Close to the right, Close all, Copy session link; heads: Hide/Show task tabs, Keep open, New task, Close group, Close to the right, Close other groups, Project colour (when colour coding is on); anchors add Open orchestrator. The ACTIVE tab's menu starts with the session actions that used to live on the old primary tab (switch interface, switch agent), then a separator. While an interface switch runs, its status replaces the three-dot button.
- **Secondary session tabs** (reviewer, shell terminals, workspace/file tabs) live in a thin sub-row under the tab row, only when present. Clicking the already-active tab returns to the session's main view.

## Layout (single tab row, actions at the right)

The grouped tabs replace the old primary session tab in `TopbarToolbar` (session routes: `CenterPane` and `ChatWorkspace` headers) and render as `TopbarTabsRow` on other routes when tabs exist. The existing action region (and the pinned Open Browser/Notifications) stays at the right of the tab row; its measured width becomes `--topbar-actions-w`.

- **Scroll mode**: the scroll viewport ends at the actions (`margin-right: var(--topbar-actions-w)`), so tabs are clipped there and never render under the actions; chevrons and wheel scroll; the active tab is revealed inside the clipped viewport (chevron hit areas excluded).
- **Wrap mode**: a float spacer reserves the actions column in the FIRST row only; rows 2+ extend to the right edge. If the wrapped strip exceeds its max height (six rows or 50vh) it scrolls vertically and every row reserves the actions column (`data-wrap-scrolling`).
- **Density**: comfortable = 36px row, labelled actions; compact = 32px row, icon-only smaller actions.
- Tabs are flat: no border radius, no borders, edge to edge, full row height.

## Settings (Settings -> General -> Appearance), persisted, live

| Setting | Options | Default | localStorage key |
|---------|---------|---------|------------------|
| Tab overflow | Scroll, Wrap | Scroll | `ao.topbarTabs.overflow` |
| Tab density | Comfortable, Compact | Comfortable | `ao.topbarTabs.density` |
| Colour-code projects | on/off | off | `ao.topbarTabs.colorCoding` |

Tab state: `ao.topbarTabs.v1` (versioned envelope, defensively coerced on load). Per-project colour slots: `ao.topbarTabs.projectColors` (`{projectId: 0..9}`).

## Colour coding (off by default)

When on: a 3px accent line across every tab of the project's group plus a light tint, and a left bar on the project row and its task rows in the sidebar. Palette: 10 hues evenly spaced in OKLCH (H = 20, 56, 92, 128, 164, 200, 236, 272, 308, 344), `oklch(0.56 0.15 H)` in light and `oklch(0.74 0.14 H)` in dark (contrast against the app surfaces at least 3.87:1 light / 5.97:1 dark). Assignment: `fnv1a32(projectId) % 10`, first free slot probing forward, persisted so it never shifts; overridable from the head's menu.

## Code map

- Model and store: `src/renderer/lib/topbar-tabs.ts` (pure state machine, cap, prune, coerce), `src/renderer/stores/topbar-tabs-store.ts` (zustand + localStorage), `src/renderer/lib/project-colors.ts`.
- Components: `src/renderer/components/topbar-tabs/` (`TopbarTabs`, `TopbarTabGroup`, `TopbarTab`, `TopbarTabMenu`, `topbar-tab-menu`, `TopbarToolbar`, `TopbarTabsRow`, `TopbarTabsRouteSync` (route-driven activation, the single choke point), `TopbarTabsLifecycle` (prune + eviction toast), `useTopbarTabsView`, `useTopbarTabsActions`, `useProjectColors`).
- Interaction signal: `markInteracted(sessionId)` is called at the user-action sites (`hooks/useConversation.ts`, `CloudSessionChatSurface.tsx`, `hooks/useTerminalSession.ts` via `onHumanInput`, `CueRunMenu.tsx`, `SwitchAgentDialog.tsx`, `FileContentPane.tsx`, `hooks/useRestoreSession.ts`, `hooks/useSessionRename.ts`).
- Integration: `CenterPane.tsx`, `chat/ChatWorkspace.tsx`, `SessionView.tsx`, `routes/_shell.tsx`, `styles.css` (`.topbar-tabs*`, `.topbar-toolbar*`), `Sidebar.tsx` (colour tint), `settings/GeneralSettingsSection.tsx`.

## Known limits

- Non-session routes (board, home, automations) show a tabs-only row; the route's own actions stay where they are.
- Cloud task rename is not offered where no rename API exists.
- Drag reordering of tabs is not implemented (the pure `reorderTab` model and store action exist and are tested).
- Hot-reload note for development: the dev app rebuilds native modules for Electron on launch; run `npm rebuild better-sqlite3` before Node-based vitest runs afterwards.
