# Local Multica server takeover and restore

Local server controls always target Compose project `multica`, regardless of directory, ports or volume contents. Preparation validates the directory and prerequisites; it grants no ownership. Before **every** start, stop or restart, the controls inspect the selected local engine's identity, all project containers (including stopped ones), their immutable image IDs, service/configuration labels and mounts, plus retained project volumes and networks. It also inspects every resolved target volume and network name, and generated container names, independently of project labels. Restored or foreign-labeled resources cannot bypass approval. Resource fingerprints bind the full inspection metadata without displaying driver options or other potentially secret values. Existing resources conservatively require takeover approval even when the selected folder matches their labels. This also applies when restoring the original stack.

A failed or incomplete inventory blocks mutation. An empty inventory is checked again immediately before the command. Approval is native, one action only, bound to the exact engine/project snapshot and selected stack. Cancel, changed source/env/folder/engine/project, unverifiable recovery evidence or an approval older than five minutes blocks mutation. Builds and pulls are disabled by `up -d --no-build --pull never`. The stack validator still rejects build overrides, host binds, non-bare volume declarations and non-loopback ports.

**Activation is blocked in this revision.** The desktop has no enforcing provider for exclusive engine control. Start, stop and restart therefore refuse to run Compose even after a successful preflight and takeover approval. This is a deployment blocker, not a successful activation path. A cooperative host lock cannot exclude another app or CLI with direct access to the same socket, and a check after migration cannot undo data changes. Do not bypass the refusal with a manual command.

A future trusted execution provider must exclude every competing engine writer while comparing the approved snapshot and performing the mutation, bind the engine/target configuration, verify the resulting service/image/volume identities before releasing control, and preserve recovery evidence on any failure. Renderer inputs, a checkbox, a lockfile alone, or an assertion of exclusive access cannot enable it. No such provider is installed or configured by this change. The controls never run `down`, delete volumes, execute a recovery procedure, or claim that a backup file proves successful restoration.

Docker must already be running. The controls never launch Docker Desktop: engine startup can itself resume existing services through restart policies. Starting the engine is a separate explicit human action.

Reading logs requires its own native approval bound to the current engine/project snapshot, selected service and line limit. The dialog warns about existing-project sign-in codes and private data. Cancel or missing approval issues no log command. A project change before or during the read discards the output; no log content is returned or persisted on that path.

## Prepare recovery before approving takeover

The first native dialog displays the snapshot and its SHA-256 digest, affected services (running or stopped), exact image IDs, configuration paths and mounts. Cancel while preparing recovery. Obtain separate approval for any backup downtime or disposable restoration work before running it. Do not stop existing services merely to make the conflict disappear; retained data still belongs to the same project.

The operator must preserve and test all of the following in a private directory (0700, owned by the operator, with no writable or symlink ancestors). All files below must be ordinary private files (0600), not symlinks. Store them outside source control and outside the deployment directory being replaced.

1. **Configuration archive:** the existing Compose file(s), `.env`, any separately supplied env files, secrets and required configuration. Keep permissions intact. The snapshot omits environment values deliberately; inspect the existing deployment's effective configuration privately to find all required inputs.
2. **Image archive:** save the exact image IDs listed for every existing service with `docker --host <selected-socket> image save --output <private-image-archive> <exact-image-IDs>`. Include the original references/ID mapping and PostgreSQL image. Never rely on a mutable tag for rollback.
3. **Data backup:** use a consistent PostgreSQL backup and preserve uploads and every other necessary writable mount/external store named by the deployment. Use approved credentials privately. A raw copy of a running PostgreSQL volume is not a verified backup. Document how writes were quiesced and which consistency point was captured. A stopped service's data still needs preservation.
4. **Restore procedure:** write the exact deployment-specific restore commands, image IDs, configuration locations, data destinations, original service running/stopped states, order, health checks and supported authentication check. Name the disposable database/volumes used for rehearsal. Never rehearse under `-p multica` or against original volumes, ports or credentials. Do not let a rehearsal start duplicate executors or send real email.
5. **Restore verification:** rehearse that procedure in separately approved disposable state, record the tested artifact hashes and engine identity, migration/startup result, expected data and upload checks, health/sign-in evidence and how original stopped states will be retained. Record the operator and time. A written procedure without successful rehearsal is insufficient.

After recovery is complete, open the action again and use the **current** snapshot digest. If image/config/data facts have changed, refresh the backup and rehearsal as needed; do not relabel stale evidence as current. Snapshot equality deliberately includes service state. Additional human decisions are needed when ownership, consistent backup or restoration is uncertain.

## Recovery receipt

Create a JSON receipt with this shape. Replace every path/digest with the actual canonical private file and SHA-256 of its bytes. `shasum -a 256 /absolute/private/file` computes a file checksum. The five artifacts may be large; the verifier hashes them as streams. The receipt is never sent to the renderer or persisted by the controls.

```json
{
  "version": 1,
  "snapshotDigest": "digest displayed by the native dialog",
  "configurationPreserved": true,
  "imageIdentitiesPreserved": true,
  "dataBackupComplete": true,
  "restoreVerified": true,
  "configurationArchive": { "path": "/absolute/private/config.tar", "sha256": "64 lowercase hex characters" },
  "imageArchive": { "path": "/absolute/private/images.tar", "sha256": "64 lowercase hex characters" },
  "dataBackup": { "path": "/absolute/private/data.tar", "sha256": "64 lowercase hex characters" },
  "restoreProcedure": { "path": "/absolute/private/restore.md", "sha256": "64 lowercase hex characters" },
  "restoreVerification": { "path": "/absolute/private/verification.txt", "sha256": "64 lowercase hex characters" }
}
```

Select this receipt in the native file chooser. The controls check ownership, modes, canonical paths, completeness, snapshot binding and checksums. They do not execute or interpret commands in these files. After verification, a second native dialog requires explicit approval of the one action's takeover and downtime for **all** listed services. That confirmation is the operator's attestation that the archives cover the inventory and restoration actually succeeded; booleans in a file alone grant no authority. The service verifies evidence again and reinspects the engine/project and target configuration before issuing a command. A failure changes nothing in the project.

## Restore after an approved takeover

Restoration is a separate human operation with its own downtime approval. Preserve any new data before rollback. Follow the rehearsed procedure: quiesce writers, recover the exact archived images/configuration and required data consistently, then restore the recorded service states. Do not issue blanket `down -v`, delete retained volumes, rerun a migration against the wrong database, or use a current tag as a substitute for the preserved image ID. When returning through the local controls, select the restored protected image-only recipe, prepare a receipt for the **new current** snapshot and approve that action again. Old approval is never reusable.

For the fork build and start commands, use the matching Multica fork's `docs/fork-server-images.md`. Building/pulling, activation, takeover, enabling delegation, installing a runtime and starting a task remain separate approvals. No live migration/auth/health or recovery rehearsal is implied by the mocked command-runner tests.
