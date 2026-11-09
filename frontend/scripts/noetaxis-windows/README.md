# Custom Windows x64 desktop

The root `app:` commands select the existing macOS implementation on macOS and this implementation on native Windows x64. AO, its daemon, ACP Node runtime, browser helper and embedded Multica CLI run natively. The separately managed Multica server runs in Docker Desktop WSL2 Linux containers. These wrappers do not install or stop the server or its runners.

## Prerequisites

Use Windows 11 x64, Node 24+, npm 11+, Git, globally available Corepack with pnpm 10.28.2 support, the Go version in `backend/go.mod`, Visual Studio C++ Build Tools for Electron native modules, and Windows .NET Framework 4.x (Framework64 C# compiler and System.Speech). Windows PowerShell 5.1, CIM and a policy permitting local PowerShell scripts are required. Scripts do not change execution policy, PATH, registry, credentials or services. WorkOS sign-in requires the existing `VITE_WORKOS_CLIENT_ID` build setting.

## Build contract

Run from a reviewed AO fork checkout in PowerShell. Substitute the full commit containing the Windows implementation: builds exclude uncommitted changes, checking out exactly the selected commit in a temporary worktree.

```powershell
$revision = 'FULL_REVIEWED_COMMIT'
$output = Join-Path $HOME 'ao-builds\noetaxis-windows-reviewed'
npm run app:build -- --ref $revision --output $output
# Explicit public alternative; use a separate empty directory:
npm run app:build:public -- --ref $revision --output (Join-Path $HOME 'ao-builds\noetaxis-windows-public')
node frontend/scripts/noetaxis-windows/verify.mjs $output --source $revision
```

Default builds use company ProGet/VPN. Public builds explicitly opt into public npm. Both reuse the existing registry allowlist, parsed lockfile/config gates and isolated npm/Corepack configuration. Company credentials are imported only for ProGet. Temporary build/config directories have private Windows ACLs for the current user and SYSTEM. Configuration is removed on success, failure and catchable interruption; power loss or forced termination can leave that private temporary directory behind. Node/executable invocation avoids interpolating paths into `cmd.exe`. Spaces and Unicode paths are supported.

The builder reuses Forge prerequisites, target-OS dictation compilation, native dependency rebuild, platform-aware Multica staging/checksums/notices and the existing NSIS maker. Output must be empty and outside source and `.ao`. It contains `app/agent-orchestrator.exe`, the complete packaged app, `installers/` with NSIS artifacts, `BUILD-INFO.txt`, `build-manifest.json` and finally `SHA256SUMS`. No publishing occurs. The managed transaction consumes `app/`; running NSIS directly follows NSIS's separate install paths/lifecycle and does not create a managed receipt.

Manifest schema version 1 records `platform: win32`, `arch: x64`, `appDirectory: app`, `executable: agent-orchestrator.exe`, `source.{repository,revision,tree}`, `multica.{repository,revision}`, decimal-string `databaseSchema`, stamped `version`, selected `registry`, build time and `files[{path,size,sha256}]`. Full revisions are 40 hex characters. `SHA256SUMS` covers the manifest, which covers all other output files including notices and NSIS artifacts. Verification rejects missing/extra/changed files, links, traversal, NTFS streams, reserved names, case collisions, foreign fork identity and non-x64 PE binaries. Adjacent checksums detect corruption, not replacement of artifacts and checksums together.

Source provenance: AO base `70436c5e948e287f8a99f152ff0205098b9e8d2c`, tree `277c12b18291a1f64e7cd01efa15771f386bccfa`, was verified against remote fork main. Embedded Multica UI/CLI is built from AO's existing backend module replacement pin, `amolodyh-hyland/multica` at `4b32bc7710753a6d97277c3833a4d7d19e48b2f7`. The hosted Go facade uses that same pin. The workspace's separate server/runner target (`60ecc…` during Windows integration) is a different contract. No pin is advanced or replaced with upstream; no restricted-only runner mode is introduced. Server compatibility remains a workspace/server validation requirement.

## Install/update contract

Use your own PowerShell outside AO. Both actions refuse `AO_SESSION_ID` with exit 20 before discovery/modification. Supply a completed build explicitly; there is no latest-build fallback or upstream download.

```powershell
npm run app:install -- $output --source $revision --dry-run
npm run app:install -- $output --source $revision --health-timeout 900
npm run app:update -- $nextOutput --source $nextRevision --dry-run
npm run app:update -- $nextOutput --source $nextRevision --health-timeout 900
```

The managed install is `$HOME\.ao\desktop\windows-x64\app\agent-orchestrator.exe`. Presence requires that executable plus `install-receipt.json` and `build-manifest.json` in `windows-x64`. The receipt records exact source, version, Multica revision, database schema, manifest checksum and state/run-file paths. Update verifies the installed app against its manifest. Install refuses existing targets; update refuses absent/unrecognized targets, changed data location and schema downgrades. NSIS/upstream installations are never silently taken over.

Daemon data remains `$HOME\.ao`, overridable by absolute `AO_DATA_DIR`. `AO_RUN_FILE` must be directly inside the data directory; when set alone its parent selects data. Packaged Electron's profile always stays at `$HOME\.ao\electron`. A daemon data directory inside that profile is refused; an external daemon directory is supported with a separate profile snapshot. The default `.ao` snapshot already covers the profile and captures it once. Install paths stay under the current user's `.ao`. Source/build/data/install trees cannot overlap, and reparse-point ancestors are refused. Dry-run verifies artifacts, source, receipt and ownership without stopping processes or creating installation state; its read-only result is advisory, and real operations reload state under the lock.

Real operations take `desktop/windows-x64.lock` before reading authoritative install state, receipt or schema, then stage and rehash on the target volume and write `desktop/windows-x64-pending.json`. Installed state is revalidated under that lock before stopping processes and before replacement. A caller delayed until another install/update completes must use the newly installed receipt and schema. Exact executable, current Windows user SID, PID and native creation FILETIME establish app ownership. Only visible main windows receive `CloseMainWindow`; draft confirmation remains interactive. The wrapper waits for all app children. An owned daemon must match the run file, both loopback probes, native identity twice and ready startup record before `/shutdown` with the exact desktop run ID is requested. That request gracefully stops owned agents. Hidden/hung apps must be quit manually; timeout refuses replacement. No process-name kills, taskkill or forced termination are used. Docker and Multica are untouched.

After shutdown, mutable data is snapshotted and verified before replacement. Daemon-data `worktrees/` and `artifacts/` remain in place and are never deleted/restored; the desktop install/transaction tree is excluded. Other private state, including SQLite/WAL/SHM, credentials and settings, is copied together. When Electron's fixed profile is outside the daemon data directory, its complete contents, including cookies, local storage and encrypted profile state, are copied to a separate `electron-profile/` backup with `electron-profile-manifest.json`; the journal records the actual path and whether it originally existed. Both backups must verify before either root is restored. An originally absent profile is removed on rollback, and new/restored separate profiles receive a private ACL before file creation. Linked/special state entries are refused. Private backups, prior app and transaction evidence remain in `.ao/desktop/transactions/<id>`; the backup destination needs space for both snapshots and reserve, and backups are never automatically pruned.

Success requires the launched desktop PID/creation identity, matching version and fresh ready desktop record linked to the verified daemon's startup launch ID, `/healthz` and `/readyz`. The mandatory `ao-updates-disabled` marker prevents substitution via upstream self-update.

Failed startup first requires proven candidate-process exit. The wrapper then verifies the snapshot and restores previous app/data, exiting nonzero; launch the previous app manually. First-install rollback restores original data and removes the failed app. Ambiguous ownership, unverified daemon, failed shutdown or damaged backup retains the candidate/evidence and exits 64, without restoring a live database. Interrupted transactions block further installs/updates for human recovery from the journal and snapshot. Do not remove locks/journals while an installer or affected app is running. Power-loss crash-atomic restoration is not claimed.

## Validation

```powershell
node --test frontend/scripts/noetaxis-windows.node-test.mjs
npm run app:build:public -- --ref $revision --output $output
node frontend/scripts/noetaxis-windows/verify.mjs $output --source $revision
# On a disposable Windows account/data set, run install then a second-build update above.
```

Real Windows validation must additionally cover ProGet/VPN, spaces/non-ASCII paths, NSIS creation, native dictation/modules, embedded CLI `version --json`, integrated UI, standard/restricted native runners through the separately managed server, existing encrypted credentials, graceful app/daemon/agent exit, draft cancellation, locked executable/database, foreign daemon/PID reuse, competing updates, failed-start rollback and interrupted recovery. Test failures only on disposable data. DACL/SID, DPAPI, GUI close, native modules and Docker Desktop networking cannot be established by Mac mocks or cross-compilation.

The `Noetaxis Windows desktop` workflow runs regressions and an actual native PID/creation probe on `windows-latest`. Its optional manual build uses this entrypoint and uploads short-lived artifacts without a release; it does not run install/GUI validation. No workflow was dispatched. At 2026-11-08T04:29:01Z, the AO fork repository (`amolodyh-hyland/agent-orchestrator`) `actions/runners` API returned HTTP 200 with `total_count: 0`. This repository-scoped result does not establish runner availability for other repositories or machines; the workspace repository query returned HTTP 404, leaving its runner visibility unknown. Mac PowerShell parsing and injected lifecycle tests provide limited source validation only.

File map: `../noetaxis.mjs` dispatches; `build.mjs` owns build/source isolation; `common.mjs` owns manifests; `verify.mjs` asserts full source; `runtime.mjs` and `native.ps1` own Windows process/health checks; `app.mjs` owns installation transactions. Parent workspace scripts and Multica server/runner changes are maintained separately.
