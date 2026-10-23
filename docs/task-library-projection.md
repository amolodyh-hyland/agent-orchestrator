# Task library projection

Task launches consume TK-MA36's immutable library child snapshot and exact-content
approval ledger. There is no separate task registry. Retained launches use the
same snapshot, including after a source edit or Project binding detach, and
recheck current approval, revocation, policy, and aggregate budgets.

## Release status

Claude Code task loading is **unsupported pending native-provider conformance**.
No provider version is released as ready. Codex task loading is unsupported.
Required unavailable entries refuse the affected launch; optional entries remain
unavailable and are omitted. Empty selections preserve ordinary launches.

The Claude adapter plans native names from approved content, preserves skill
frontmatter and command argument placeholders, and detects skill/command name
collisions. The fixture placement path covers text skills, unconditional rules,
and declarative prompt commands. It produces `prepared`, never `ready`, and does
not grant invocation. The production adapter returns `version_evidence_required`
before filesystem materialization. No setting, approval, or fixture result can
turn this release gate on.

Before enabling any version, separately authorized native-provider checks must
prove actual file/content resolution, all competing lookup sources and native
precedence, command argument semantics, lower runtime limits, and resume behavior.
An unknown external same-name source cannot be treated as a verified binding.
Role conversion, path-scoped rules, executable preprocessing, imported hooks,
arbitrary configuration, and provider-home changes are unsupported.

## Startup and ownership

`ports.TaskLibrarySelection` leases the retained selection through runtime creation
and handle publication. Spawn, resume, and target-provider activation use this
boundary. Session manager checks selection before activity hooks and native folder
trust, and again before runtime launch preparation. A nested launch context holds
only an active, service-owned lease; released contexts cannot bypass new checks.

`ports.TaskLibraryProjector` is the adapter boundary. It returns entry/hash/native
name/path bindings and prepared guidance separately from Project lifecycle
commands. Native paths are backend-only metadata and do not authorize invocation.
The current release discards any unverified prepared result before starting hooks.

The placement helper writes exact bytes with exclusive file creation through
verified directory handles. It rejects links and existing destination files,
verifies written hashes, and rolls back partial materialization. Cleanup removes
only unchanged files of the recorded identity and empty owned directories. Edited,
replaced, added, or unverifiable files remain with `cleanup_conflict`. Original
sources are never used as runtime links or cleanup targets. Windows placement is
explicitly unsupported.

## Revocation

Revocation fences admission for the affected approval before waiting for input
leases. The terminal mux closes affected attachments and discards pending bytes,
releasing their leases; reconnects cannot reopen that runtime's input lane.
Closing each attachment interrupts its outstanding stream writes before a bounded
drain; a failed drain refuses the mutation. Closed attachments send `exited` and
unregister, so a denied mutation can reopen on the same connection after its fence
is released. Unrelated selections retain admission.

Ledger commitment is tracked separately from response assembly. Response read
failures or request cancellation after commit retain the input fences and still
complete shutdown under a detached context with a 30-second deadline.
After commit, the service enumerates retained affected snapshots again and asks
session manager to stop each live runtime, even without any new input. Session
manager destroys the runtime and records termination while retaining the workspace
and snapshot; it does not run Project lifecycle commands or remove native history.
A failed or unsupported stop returns `runtime_stop_failed`, leaves the durable
revocation in force, and retains the stop/replacement requirement in the session
view. This does not promise an enforceable provider mid-turn boundary. A new
approved selection requires a successor session.

## Verification

Tests use temporary owned files and fake launch/runtime/terminal drivers. They
cover exact bytes and names, command/skill collisions, lower limits, unsupported
behavior, rollback and cleanup conflicts, retained snapshot roles/channels,
prelaunch hook/trust ordering, buffered and attached terminal admission, startup
races, implicit mid-turn revocation, and failed runtime stop. They do not certify
native-provider conformance.
