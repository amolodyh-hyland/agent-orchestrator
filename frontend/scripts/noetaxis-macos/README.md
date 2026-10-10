# Custom AO macOS build

This flow creates an arm64 desktop app, `MANIFEST.sha256`, an unsigned installer package, and a compressed disk image. It does not install the app or publish any artifact.

## Build

Run from the AO fork checkout on an Apple Silicon Mac with macOS, Node 24, npm 11, Go 1.27.1 or newer, Xcode command line tools, and Corepack available. Join the company VPN first. Every npm and pnpm registry request is pinned to the internal ProGet endpoint `https://proget.onbase.net/npm/npm`. Package credentials are read through the normal npm configuration and are never printed by these scripts. Not every network request is a registry request. Besides the registry, the build contacts: `github.com` (git clone of the Multica fork and the checksum-pinned agent-browser release binary), the Electron binary download used by Electron Forge, and the Go module proxy. Check that your VPN and policy allow these. `COREPACK_INTEGRITY_KEYS=0` is set only for the pnpm install step, and the pnpm tarball is not hash-pinned.

```bash
node frontend/scripts/noetaxis-macos/build.mjs
```

The default source is `HEAD` of the checkout running the command. To select a commit or tag and output location:

```bash
node frontend/scripts/noetaxis-macos/build.mjs \
  --ref 8e2bc21fd5d95c525f536dc03b5e7b7f10b04c7c \
  --base-version 0.13.4 \
  --output "$HOME/ao-builds/noetaxis-8e2bc21"
```

The default version is `0.13.4-noetaxis.<shortsha>`. `--base-version` selects another three-part base version. Multica's desktop source is checked out at the pseudo-version revision pinned by the selected `backend/go.mod`; the daemon uses the same Go module pin. The build runs in temporary worktrees and writes final artifacts outside the AO checkout and `/Applications`.

The output contains:

- `Applications/Agent Orchestrator.app`
- `MANIFEST.sha256`, covering regular files in the app bundle
- `Agent-Orchestrator-<version>-arm64.pkg`
- `Agent-Orchestrator-<version>-arm64.dmg`
- `BUILD-INFO.txt`

The app is signed with an ad-hoc signature (`codesign --sign -`). It has no Apple Developer ID, certificate chain, or notarization ticket. The PKG and DMG are unsigned. `MANIFEST.sha256` detects corruption and unlisted files; it sits next to the app, so it is not tamper protection. The PKG has not been run through Installer.app (Installer compares `CFBundleVersion` before the scripts run, so it may skip an upgrade between `-noetaxis` builds); the script install from the build output is the verified path. The app contains `Resources/ao-updates-disabled`; rebuild and reinstall from a reviewed source ref to update it.

## Install from your own Terminal

Start installation from your own Terminal or Finder, outside AO. The install script refuses to quit AO or stop any process for you; it checks and tells you what is left.

On macOS, **Quit and Cmd+Q only close AO's window**. The Dock icon, the menu-bar tray, the app-owned daemon and any enabled mobile or remote access keep running, so the "app is still running" refusal is expected after a plain Quit. To exit completely, click the Agent Orchestrator icon in the menu bar and choose **Quit AO Completely**. The app-owned daemon then stops itself about 5 seconds later, so wait about 10 seconds. Builds without the menu-bar tray exit on Cmd+Q. Check the active sessions you care about before a full quit; quitting interrupts work that depends on the app.

The preflight names what is still running and always exits with status 21 (ShipIt: 22):

| Still running | What to do |
| --- | --- |
| The desktop app (`Contents/MacOS`, helper processes) | Use **Quit AO Completely** in the menu-bar tray. `--allow-background-processes` never bypasses this. |
| The bundled AO daemon, with the app already gone | It normally stops within about 10 seconds of a full quit. If it is still there (a crashed app, or a daemon started from a terminal) and you do not need its sessions, stop it yourself with the full path: `"/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao" stop`. |
| Agent chat hosts (`ao chat-host`) | They keep agent conversations alive while the daemon is replaced, so they can outlive a full quit until their sessions end. Let the running turns finish or end those sessions in AO. |
| Other helper processes under the bundle | Quit completely and verify with `pgrep -fl "/Applications/Agent Orchestrator.app/Contents/"`. |
| ShipIt (the updater) | Wait for it to finish. Never bypassed. |

`--allow-background-processes` (install.sh and rollback.sh) lets the script continue past the last four background cases except ShipIt, after printing a warning that lists them. Use it only when you have decided those processes may keep running: they continue from the previous app (moved to the backup), so stop the old daemon with the `ao stop` command above before opening the new app. The PKG preinstall has no such flag and always refuses while any of them runs.

```bash
frontend/scripts/noetaxis-macos/install.sh --dry-run \
  "$HOME/ao-builds/noetaxis-8e2bc21/Applications/Agent Orchestrator.app"
frontend/scripts/noetaxis-macos/install.sh \
  "$HOME/ao-builds/noetaxis-8e2bc21/Applications/Agent Orchestrator.app"
```

The script checks the manifest, bundle version and source revision (the app's `NoetaxisSourceRevision` must start with the 7-character version suffix), free space, app processes, and ShipIt. It stages the app with `ditto`, then backs up `ao.db` and its WAL/SHM files (the Electron user-data directory is not included), `app-state.json`, `update-settings.json`, `editor-settings.json`, and the previous app before replacing anything. Backups are stored in `~/ao-backups/<stamp>/`; the previous bundle ends in `.app.bak` so Finder does not treat it as another installed app. The install script will not move the old app until all selected AO state backups verify successfully.

`AO_SESSION_ID` and any `AO_*` environment setting, or an AO app/daemon process in the command's ancestry, blocks installation. `--allow-ao-session` overrides this guard. Use it only when ending the active sessions is intentional. `APPS_DIR` and `AO_HOME` can point at isolated test roots; setting `AO_HOME` also triggers the guard unless the explicit override is supplied.

To restore the app from the newest complete backup:

```bash
frontend/scripts/noetaxis-macos/rollback.sh
```

To restore the database files too, add `--restore-db`. This replaces current database files with the selected backup; the rollback script first saves the current database files under a new `rollback-current-data-<timestamp>-<pid>/` directory in that backup directory (a repeated rollback never overwrites an earlier one). Use `--backup-dir <path>` to select a specific backup.

The scripts use the full bundled CLI path. The install script checks `ao version`, the `spawn --effort` and `project set-config --permission-fallback` flags, and the database schema using read-only SQLite access. A WAL database with no `-wal`/`-shm` files (the daemon is not running) cannot be opened read-only, so the schema check then reads a temporary copy; if that fails too it prints a notice and does not fail the install. Open the app from Finder before checking daemon status:

```bash
AO="/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao"
"$AO" status
"$AO" version
"$AO" multica status
"$AO" spawn --help | grep -- --effort
"$AO" project set-config --help | grep -- --permission-fallback
sqlite3 -readonly "$HOME/.ao/data/ao.db" \
  'select max(version_id) from goose_db_version where is_applied=1;'
```

At source commit `8e2bc21`, the database schema result is `190`. `ao status` needs the app to have been opened after installation. The `ao` command does not need to be on `PATH`.

## Install with the PKG or DMG

Open the PKG in Installer from your own Finder session. Its preinstall hook refuses a running app, daemon, chat host or ShipIt (with the same messages and no override) and creates the same backup before package payload files are installed. Its postinstall hook clears quarantine, verifies the build stamp and updates-disabled marker, and checks the `ao-app://` handler.

The DMG contains the app, an `Applications` shortcut, and a short readme for Finder drag-and-drop placement. Use the script or PKG when you want the automatic AO state and old-app backup.

Ad-hoc signing is not notarization. If Gatekeeper blocks the first open, use Finder's **Open** action from the app's context menu, then choose **Open Anyway** in Privacy & Security if macOS asks. The script and PKG clear the quarantine attribute during installation. If macOS says the app is damaged, open Terminal and run:

```bash
xattr -dr com.apple.quarantine "/Applications/Agent Orchestrator.app"
```

The new signature may trigger a Keychain prompt for **Agent Orchestrator Safe Storage**. Choose **Always Allow** and enter your login password so stored credentials remain readable. macOS may also ask again for access to Documents, Desktop, Downloads, or other folders because those permissions were granted to the previous signature.

## Verification

```bash
shellcheck -x frontend/scripts/noetaxis-macos/*.sh \
  frontend/scripts/noetaxis-macos/pkg-scripts/*
node --test frontend/scripts/noetaxis-macos.node-test.mjs
```

The end-to-end test uses a synthetic app in a temporary home and Applications directory. It expands the unsigned PKG with `pkgutil`, checks its payload and scripts, creates and mounts the DMG read-only, and detaches it. It does not run `installer`, launch Electron, connect to the live daemon, access the real Keychain, or register a URL handler. Set `NOETAXIS_TEST_ARTIFACTS=/private/tmp/noetaxis-macos-test-artifacts` to retain the generated test app, package, and disk image for inspection.
