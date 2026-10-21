# Install this build from your own Terminal

For routine updates, **`--fast` is RECOMMENDED**. Set `ART` to this build's folder:

```bash
ART="$HOME/ao-builds/noetaxis-<shortsha>"
cd "$ART"
shasum -a 256 -c SHA256SUMS
"$ART/installer/update.sh" --fast --dry-run
"$ART/installer/update.sh" --fast
```

Review the short plan and type `yes` once, or use `--fast --yes`. Run outside AO;
quitting AO ends the terminal session that started an update from inside the app.

The updater verifies checksums, app signature and version, stages the build,
quits AO completely, backs up selected state and the old app under `~/ao-backups`,
swaps the app, relaunches and checks daemon health. If macOS denies tray scripting,
click **Quit AO Completely** in AO's menu-bar tray while the updater waits (up to
120 seconds). Cmd+Q only closes the window.

Sessions will be restored by AO on launch. Fast mode performs no per-session
exits or machine-wide ancestry scans. After AO quits it waits up to 60 seconds
for bundle processes, then sends TERM and, after another identity check, KILL
only to verified bundle survivors. External agent CLIs are never signalled;
they wait at most 10 seconds and any remaining candidates are informational.
Routine updates target roughly 1–3 minutes; manual interaction, copying a large
app, a health timeout or rollback can take longer. `--restore-sessions` explicitly
adds one best-effort restore pass and may take longer with many sessions.

Failures after the old app moves automatically restore it. A failed health check
returns 60 when the previous app is healthy again, or 61 when rollback needs
attention. Read the final summary and retain the backup.

The original cautious updater remains available by omitting `--fast`; see
`installer/README.md` for its session controls and manual install/rollback flow.
Do not run the PKG as a substitute for a routine update. The ad-hoc signature is
not notarized; the OS may ask about Gatekeeper or Keychain access after relaunch.
