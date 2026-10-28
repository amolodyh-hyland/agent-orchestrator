# Install this build from your own Terminal

From the source repository root on an Apple Silicon Mac:

```bash
npm run app:build          # default ProGet build; join the company VPN
npm run app:build:public   # public npm build without the company VPN
npm run app:install        # first install on a Mac without AO
npm run app:update         # routine fast update of an existing install
```

Source builds require Node 24+, npm 11+, Go 1.27.1+, Xcode command line tools
and Corepack. The install/update wrappers need Node/npm and a completed local
build; they do not require an existing `ao` command. Only the default
`app:build` needs the company VPN; install/update do not.

The default build folder is `~/ao-builds/noetaxis-<shortsha>`. Install/update
select the newest `noetaxis-*` build by its `SHA256SUMS` modification time and
verify all checksums before running its packaged installer. Incomplete folders
without `SHA256SUMS` are ignored; verification failure stops the command.
Override the output or select a build explicitly (directory first):

```bash
npm run app:build -- --output "$HOME/ao-builds/my-build"
npm run app:install -- "$HOME/ao-builds/my-build" --dry-run
npm run app:update -- --dry-run
npm run app:update -- "$HOME/ao-builds/my-build" --yes --health-timeout 300
```

**Run `app:update` from your own Terminal outside AO.** It calls
`installer/update.sh --fast` and refuses with exit 20 if `AO_SESSION_ID` is set,
even with `--dry-run` or `--detached`. The packaged installer's origin checks
also remain in place. `app:install` calls `installer/install.sh` for a safe
first install and never stops processes.

These commands use the `app:` namespace intentionally. Root `install`,
`preinstall`, `postinstall` and `prepare` scripts would run automatically as npm
lifecycle hooks during `npm install` or `npm ci` and could unexpectedly start
the app installer. A generic root `build` script is also deliberately avoided.

## Using this build folder without a source checkout

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
