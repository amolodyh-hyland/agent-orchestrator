# Confirmed Multica delegation coordinator

`frontend/src/main/multica-delegation-coordinator.ts` provides one main-process
coordinator to task and project orchestrators. Both handles refer to the same
instance, share serialization, and use the same task identity and journal.
There is no renderer/preload IPC, assignment/status trigger, background dispatch,
or UI registration. TK-MA66/67 own the user-facing wiring. Admission defaults off
at the coordinator and independently at the member Public API client and server.

Construct it with `createDaemonDelegationJournal`, a trusted daemon-origin
callback, the private main-process authority, and a resolver returning TK-MA63
connections for configured bindings.
The resolver must use configured connections, never connection data from task
text. The coordinator compares all connection binding fields before use. Tokens
stay in the existing main-process Public API client; they never enter the journal.

The private `human.confirmFromUserAction` entry point takes the exact previewed binding and payload
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
The private `/internal/multica-delegation-journal` endpoint requires a HMAC over
the exact request body, including operation and record version, in addition to
local-control and LAN-listener guards. Every request includes a fresh nonce;
successful responses are separately HMAC-authenticated and bound to that request,
so a rogue loopback server cannot invent a confirmed journal record or replay an
old response. Response size is bounded. It has no confirmation issuer. Reserve
only commits a main-process-minted per-intent proof: a second purpose-separated
HMAC binds the stable intent/request ID nonce, principal, time, rerun predecessor, exact target
tuple and payload hash. Neither a valid-looking record nor a loopback Host can
create confirmation. Proofs and MAC keys are never returned in journal DTOs.

Electron generates a fresh 32-byte key in memory and delivers it through the
existing private daemon-stdin handoff alongside the browser token. The key is
never in environment variables, CLI args, settings, run files, or sessions.
The daemon does not inherit this consumed pipe into workers. Legacy/headless
launches have no authority and reject all journal calls. Attaching a new desktop
to an already running daemon cannot enroll a replacement key through HTTP;
this capability remains unavailable until a newly paired daemon is launched.
No UI/IPC/MCP route exposes the authority or the `human` handle. Task and project
handles expose only processing/reconciliation. TK-MA66 must invoke the private
human API only from its validated explicit user-action flow.

Migration `0219_multica_confirmation_verification.sql` marks legacy records
unverified by default. Only authenticated, proof-verified reservations set the
provenance fact. Reads/updates never adopt pre-proof records. This durable fact
survives daemon and desktop restarts without persisting the boot key or proof.
Intent, remote projection and cancellation fields are strictly decoded (unknown
fields rejected), checked for secrets as decoded strings, and rebuilt from typed
schemas before persistence, so JSON escape spelling cannot conceal credentials.
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
conflicts. A rerun is reserved only when the predecessor is terminal or definitively
rejected. Running, queued, unknown, and cancellation-pending predecessors block
reservation atomically, so two independent coordinators cannot replace work
that remains processable. Reconcile or explicitly cancel the predecessor and
observe its terminal outcome first. This API does not implement a "cancel
previous" shortcut; that option must not be offered by a caller. Prior terminal
records remain addressable and can never submit work again.

`human.cancelFromUserAction` persists a separate approval before using the client's cancellation
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

The real-journal integration test builds a scratch Go HTTP fixture on an ephemeral
loopback port and drives two independently constructed TypeScript coordinators
against its SQLite store. It checks forged/unsigned HTTP writes, proof binding,
concurrent confirmation/processing, strict schemas, escaped secrets, and the
terminal-predecessor rerun gate. It never launches the actual daemon.
