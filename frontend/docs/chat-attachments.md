# Chat attachment references

Adding a file through the picker, paste, or drag/drop, or selecting a folder,
adds an atomic inline reference at the composer caret. The existing attachment
strip remains visible. A reservation preserves the insertion point during
asynchronous staging and the native folder picker; cancellation adds no text.
File mentions continue to use the same Lexical token pattern.

Inline references show a basename and expose the entire path in their title.
Windows drive paths, UNC paths, POSIX paths, and trailing separators are
supported. Image references retain their thumbnail and show the file name.
Submitted text contains the complete reference path, plus the existing durable
attachment block. Files staged by the daemon retain its workspace-relative
`.ao/attachments/...` wire paths; folder references retain their absolute paths.
This preserves the attachment delivery and native-image contracts.

Deleting an inline reference removes that positional reference only. The file
remains attached in the strip and in the durable attachment block, matching the
existing image behavior. Removing an item from the strip also removes its
inline references, including from a saved draft while browsing sent history.
Restored drafts reconstruct chips from their retained attachment paths. Before
submission, stale attachment chips restored by undo are pruned without removing
ordinary typed paths or independent file/code references.

## Path actions

Inline chips and attachment-strip items share the existing Radix context menu.
A focused chip or strip item opens the menu with the context-menu key or
Shift+F10. The menu provides:

- Reveal in Finder, Show in File Explorer, or the Linux file-manager equivalent.
  The Electron main process uses `shell.showItemInFolder`.
- Open in side panel for files and folders inside the session workspace.
  File requests open a preview in the Files rail; folder requests filter its
  tree. These requests preserve the host identity and leave center tabs alone.
- Copy path. Staged local paths resolve against the session workspace through
  Electron IPC before the absolute path is copied. Explicit absolute paths are
  copied unchanged, including whitespace and trailing separators.

Host-local reveal and resolution are unavailable for remote attachments. A
remote absolute path can still be copied. Cloud attachment menus omit host-local
actions and the session Files-rail action, whose path contract is workspace-bound. Side-panel navigation uses the
existing host-scoped workspace request store.
AO's current viewer is confined to the session workspace. Paths outside that
workspace show a translated notice; they can still be revealed or copied.
Multica's embedded bridge navigates application routes and
has no filesystem-path opening contract, so no Multica action is offered.

Sent human messages reconstruct non-image path chips only for paths declared
in the durable attachment block, outside code regions. They use the same menu.
Existing sent-image previews remain available.

## Implementation and verification

`ComposerEditor` owns tokens and caret reservations; `ChatComposer` owns the
attachment strip and staging; `AttachmentPathChip` shares the display and menu;
`messageAttachments` parses known paths; `ChatTimelineItems` renders sent chips.
`SessionView` reveals the Files rail for a panel request; `SessionFileExplorer`
resolves the host-owned path and selects a file preview or folder tree filter.
`chat-folder-attachment-ipc` resolves local staged paths and reveals targets.
Preload forwards the typed request, and all eight renderer catalogs contain
menu and failure labels.

Renderer tests cover caret placement, cancellation, atomic deletion, restoration,
list removal, history browsing, submitted paths, sent chips, menu keyboard
access, side-panel callbacks, clipboard/reveal IPC, and cross-platform paths.
Main/preload tests verify path resolution, reveal dispatch, and invalid paths.

## Changed-file registry

This document and the following files comprise the feature change:

| Area | Files (relative to `frontend/`) |
| --- | --- |
| Shared chip | `src/renderer/components/chat/AttachmentPathChip.tsx`, `AttachmentPathChip.test.tsx` |
| Composer | `src/renderer/components/chat/ChatComposer.tsx`, `ChatComposer.test.tsx`, `ComposerEditor.tsx`, `ComposerEditor.test.tsx`, `ChatWorkspace.tsx`, `ChatQueuedAttachments.test.tsx` |
| Sent references | `src/renderer/components/chat/ChatMarkdown.tsx`, `ChatTimelineItems.tsx`, `ChatTimelineItems.test.tsx`, `messageAttachments.ts` |
| Files panel | `src/renderer/components/SessionView.tsx`, `SessionView.test.tsx`, `SessionFileExplorer.tsx`, `SessionFileExplorer.test.tsx`, `src/renderer/stores/ui-store.ts` |
| Desktop boundary | `src/main.ts`, `src/main/chat-folder-attachment-ipc.ts`, `src/main/chat-folder-attachment-ipc.test.ts`, `src/preload.ts`, `src/preload.test.ts`, `src/shared/chat-folder-attachment.ts` |
| Locales | `src/renderer/i18n/en.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `zh-CN.json` |
| Bridge support | `src/renderer/lib/bridge.ts`, `src/renderer/test/setup.ts`, `e2e/support/fake-bridge.ts` |
