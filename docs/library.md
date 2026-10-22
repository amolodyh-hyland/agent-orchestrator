# Local library registry

The library API is an inert backend catalog. Provider execution, runtime discovery
projection, live invocation, and remote transfer are unavailable. Approval records
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
links, with bounded nonblocking reads and before/after identity checks. Staging
is limited to 8 MiB, 4,096 nodes, four directory levels, and 256 entries; each
entry has at most 256 text files. Unsafe or incomplete inventories fail as a
whole. Supporting files, frontmatter, raw line endings, and requirements all
participate in the portable digest. IDs survive edits at the registered entry
point; renames create new candidates. Same display names remain distinct.

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
Managed locks cannot be detached or shadowed by personal bindings.

The local SQLite registry serializes mutations under the existing writer
transaction. Portable records and staged bytes share one bounded aggregate;
resolver-only paths never appear in API listings or audit records. Audit records
contain identifiers, operation, outcome, reason, revision, and trust epoch.
Migration 0220 adds the registry and ledger without modifying prior migrations.
