# Local library registry

The library API retains an inert approved-content catalog. Approved-library
projection, invocation, and remote transfer remain unavailable. Native chat
observations are a separate live catalog described below. Approval records
never imply provider readiness. Every catalog entry defaults to
`unsupported_provider` until a later adapter supplies version-specific evidence.

`GET /api/v1/library` returns portable source metadata, current entry manifests,
approvals, binding revisions, and the trust epoch. Machine paths and staged text
remain in the local resolver store. `POST /api/v1/library/operations` applies one
operation with `expectedRevision`; stale mutations fail without partial writes.
`ao library ls` lists the catalog; `ao library <operation> --file request.json`
submits an exact JSON request through the same HTTP boundary.

Operations are `register`, `rebind`, `allow_inspection`, `inspect`, `approve`,
`revoke`, `bind`, `detach_binding`, and `detach_source`. Registration supplies an
opaque `sourceId`, `scope`, write-only `localPath`, and declared `rootKind`:
`claude-skills`, `codex-skills`, `claude-commands`, `rules`, `claude-personas`,
`codex-personas`, or `hooks`. Choose the actual skill/command/rule root; no home
folder or arbitrary workspace discovery occurs. Root links require selecting
the resolved target explicitly. No directory enumeration occurs on registration.

Inspection requires policy permission and an explicit `rootIdentity` inspection
grant. Files are opened through confined directory handles, without following
links, with bounded nonblocking reads and before/after identity checks. Regular
files with multiple hard links and traversal across device or mount boundaries
are refused. Checked inspection is available on Darwin and Linux; other platforms
return `inspection_unsupported_platform`. Missing mount identity evidence also
refuses inspection. Staging
is limited to 8 MiB, 4,096 nodes, four directory levels, and 256 entries; each
entry has at most 256 text files. Unsafe or incomplete inventories fail as a
whole. Supporting files, frontmatter, raw line endings, and requirements all
participate in the portable digest. IDs survive edits at the registered entry
point; renames create new candidates. Removed candidates retain lightweight
identity tombstones; obsolete staged bytes and file manifests are dropped on
reinspection. Immutable snapshots retain their referenced payloads. Same display
names remain distinct.

Approvals pin root generation, exact entry IDs and hashes, purposes, and policy
revision. `approve` requires those exact `entries`, `purposes`, `sourceId`, and
`rootIdentity`; optional `expiresAt` uses UTC milliseconds. Rebinding resets
inspection and increments root generation and trust epoch. Revocation changes
trust without deleting historical records. Executable preprocessing, hooks,
roles, unknown behavioral frontmatter, and unsupported helpers stay inventory
only. They cannot obtain a load approval.

Bindings require the local owner, an existing Project (including a Project with
no repository), or explicit standalone session ownership. Knowledge and library
bindings share the 64-binding allowance. Managed policy is injected independently
of selected folders; absent policy permits personal use, required unverifiable
policy blocks the affected operation, and optional failure carries a warning.
Mutation policy checks resolve the actual source, entry, and binding owner scope
before inspection and again in the write transaction; optional request envelope
IDs cannot select a different policy resource. Managed locks cannot be detached
or shadowed by personal bindings. A managed
registration requires an independently supplied grant for the exact resolver,
root reference/generation, physical target identity, and declared root kind.
A caller-selected folder or source ID cannot establish managed provenance.

The local SQLite registry serializes mutations under the existing writer
transaction. Portable records and staged bytes share one bounded aggregate;
resolver-only paths never appear in API listings or audit records. Audit records
contain identifiers, operation, outcome, reason, revision, and trust epoch.
Migration 0220 adds the registry and ledger without modifying prior migrations.

Migration 0221 adds immutable library child snapshots. Session preparation stores
both the existing Project context and the child manifest in one transaction,
checking the session's Project, role/channel, Project revision, registry revision,
and approvals. A hidden workspace preparation pins the effective requested
identity, then validates that identity in the same transaction that promotes the
session. Project and session ownership remain mandatory throughout. A concurrent
retry uses the existing winner. The child pins
ordered bindings and revisions, approval references, provider/adapter identity,
closed text bytes, and a canonical digest. It never changes the parent manifest.
Optional unavailable selections carry an omission reason and no bytes. Required
unproved provider bindings block launch; nothing is projected or executed.

`GET /api/v1/library/sessions/{sessionId}` and `ao library session <session-id>`
read retained selections and current admission. Resume verifies retained hashes
and current policy/trust, without resolving live source files. Launch-specific
policy denial or unavailability also refuses launch and records the denied audit
outcome. Detach and Project
archive preserve snapshots; existing session retention owns their lifetime.
Knowledge payloads and library bytes share the 8 MiB/1,024-file allowance, and
existing guidance plus rules share 64 KiB. Verified policy may lower these limits.

Revocation advances trust epoch and closes input admission for every affected
retained session. Task terminal input is raw bytes: admission receives only the
session identity and blocks all subsequent writes, including ordinary text that
might trigger implicit native selection. Controlled chat dispatch also validates
known library markers; inert entries remain non-invocable. An already executing
turn has no enforceable mid-turn boundary. Admission reports
`input_closed_stop_or_replace_required`; stopped sessions report
`stopped_replacement_required`. Personal reapproval cannot reopen an old revoked
snapshot. A successor selection requires a new session.

Deferred chat prompts are revalidated after preparation and durable provider-ID
binding. Both main and side ACP conversations pass admission into the scheduled
worker. It acquires the lease immediately before writing `session/prompt` and
releases it after the frame write, before waiting for the response. A revocation
completed before submission refuses the write and settles the turn as failed.
A stalled write closes its transport after five seconds so it cannot indefinitely
hold admission; an already submitted prompt never keeps revocation waiting for
its response.

## Live chat catalogs

`GET /api/v1/sessions/{sessionId}/conversation/skills` reports `status` and
`reasonCode` separately from `skills`. A ready empty catalog, unsupported listing,
and a controller awaiting its first catalog are distinct outcomes. Responses
include session, pinned snapshot, controller generation, provider, adapter,
resolver (where available), Project revision, catalog revision and trust epoch.
Clients must scope their cache by the selected host as well as these identities;
a response from a prior controller must not replace a newer controller's rows.

Native observations carry opaque controller-scoped observation IDs and
`native_unverified` trust. ACP commands retain `/name` and raw native arguments.
App-server catalogs preserve enabled path-distinct entries, explicitly query the
session working directory, and expose `$name` markers. Paths remain backend-only.
Same-name skills require an opaque selection when the path is ambiguous. Manual
unambiguous native skill tokens use the same backend resolution; ambiguous tokens
are refused. Submission carries unchanged text plus native structured skill items.
Structured skill steering is explicitly unsupported; queue the message as a new
turn. Unrelated native slash commands retain passthrough behavior.

Independent side chats apply the same native-name validation to each question,
including queued and retried delivery. Unique native skill names receive backend
structured items; ambiguous names are refused. Quoted history, references, and
attachments do not select skills. A provider awaiting its first command catalog
still accepts ordinary text, including paths and dollar words. Explicit catalog
selections and known pinned library tokens remain checked.

The ordinary message endpoint accepts optional `skillSelection` with `entryId`,
`snapshotId`, `controllerGeneration`, `catalogRevision`, `bindingRef`, and `token`.
There is no client path field or execution endpoint. The opaque selection is
persisted with delivery content, revalidated on queue drain/retry, and removed
from the native payload. Altering/removing the selected token clears its binding;
queue edits also discard the stored binding. Current trust admission is checked
at transport dispatch. Library rows remain non-invocable with explicit reasons
until exact-byte projection and version-specific native resolution evidence are
available. An advertised native command never supplies approval evidence, and
unproved native/library name collisions disable that invocation.

`POST /api/v1/sessions/{sessionId}/conversation/skills/refresh` accepts an optional
`snapshotId`. Supported same-snapshot refresh relists the existing immutable
selection (`forceReload` for app-server). ACP reload is explicitly unsupported.
Failed reload returns unavailable/restart state rather than old ready bindings.
Requesting a different snapshot or observing a pending selection returns
`restart_required`, `snapshot_change_requires_successor`, and
`nextAction: start_successor_session`. It does not create a successor automatically
or change the active snapshot, transcript, or trust permissions.
