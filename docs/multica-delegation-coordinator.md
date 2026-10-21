# Confirmed Multica delegation coordinator

`frontend/src/main/multica-delegation-coordinator.ts` provides one main-process
coordinator to task and project orchestrators. Both handles refer to the same
instance, share serialization, and use the same task identity and journal.
There is no renderer/preload IPC, assignment/status trigger, background dispatch,
or UI registration. TK-MA66/67 own the user-facing wiring. Admission defaults off
at the coordinator and independently at the member Public API client and server.

Construct it with `createDaemonDelegationJournal`, a trusted daemon-origin
callback, and a resolver returning TK-MA63 connections for configured bindings.
The resolver must use configured connections, never connection data from task
text. The coordinator compares all connection binding fields before use. Tokens
stay in the existing main-process Public API client; they never enter the journal.

The explicit `confirm` entry point takes the exact previewed binding and payload
and an approval ID, user identity and timestamp captured by the trusted user
interaction. It persists these together with the canonical server origin/key,
workspace/profile/runtime IDs, AO project/task IDs, payload digest and generated
request ID. This records what the user approved. It performs no admission.
`process` and `processTask` can act only on this persisted confirmation.

The digest is SHA-256 over the seven ordered wire-payload string fields
(profile, expected runtime, source system/project/task, title, instructions),
each prefixed by its UTF-8 byte length and a colon. This keeps the Go/TypeScript
boundary independent of JSON key order, HTML escaping, and Unicode escaping.
Binding and approval fields are immutable separately from the payload digest.
The coordinator and daemon both verify the payload before processing.

`backend/internal/storage/sqlite/migrations/0218_multica_delegations.sql` adds the
request journal, a unique current request per project/task, unique confirmation
IDs, and an append-only transition history with timestamps and record snapshots.
Reservation, replacing a task's current request for a confirmed rerun, and
transition recording are transactional. Updates compare the persisted version;
a stale writer fails and must reload. Intent and attempt markers commit before
any remote admission. The daemon owns SQLite; the desktop never opens its DB.
The private `/internal/multica-delegation-journal` endpoint accepts only local
control requests without an Origin header and is excluded from the LAN listener.
It is an internal transport, outside the public daemon OpenAPI contract.

On recovery, an attempted request without remote IDs is looked up by its original
idempotency key. Failed, incomplete or ambiguous lookups cannot trigger a retry.
A successful empty lookup permits replay of the exact approved payload and key;
it never permits a fresh key. A found record must match the approved workspace,
profile and runtime. Once accepted, status uses its exact delegation ID and task
identity. Revisions are opaque; terminal observations cannot be overwritten.
`unavailable` is nonterminal. Neither polling nor admission changes AO task or
Multica issue status.

A definite rejection on the first admission is retained with its stable failure
code. A failed replay cannot prove an earlier ambiguous admission was rejected.
A changed payload on the same task conflicts, and the coordinator refuses to
process a digest mismatch. Changing the payload or binding requires another
preview and confirmation, expressed as a rerun.

Repeated confirmation/processing of the same task reuses its existing request.
A rerun requires a new approval ID and `rerunOf` naming the current request.
Repeated delivery of that approval returns the same rerun. A stale rerun pointer
conflicts. Explicitly confirmed reruns may coexist with prior running/unknown
remote work: only the current pointer changes. Prior records remain addressable
for reconciliation and cancellation; rerunning never implicitly cancels them.

`cancel` persists a separate approval before using the client's cancellation
path. Accepted work stays `cancellation_requested` until an authoritative terminal
observation arrives. Unknown admissions reconcile first; an empty lookup does
not justify submitting a cancelled request. Cancellation before any attempt
closes the local intent without remote admission. Cancellation and status remain
available when local admission is disabled. Lost cancellation responses recover
by status before another cancellation attempt.

Validation covers process and local-write crash windows, recovery, one-current
uniqueness, approval replay, confirmed reruns, immutable payload/approval fields,
version conflicts, terminal retention, cancellation, rollout defaults, and the
private HTTP transport boundary. All databases and journal fixtures use scratch
directories; tests do not use the installed app, live daemon, or credential vault.
