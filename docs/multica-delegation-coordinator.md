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

## Optional managed policy (TK-MA65)

The coordinator always evaluates the journal's managed-policy resolver before
minting a confirmation proof, before marking an admission attempt, and again
immediately before `delegate`. `createDaemonDelegationJournal` evaluates policy
through the existing signed, nonce-bound journal route (`evaluatePolicy`), with
no new listener, renderer/preload IPC, or confirmation issuer. Policy documents
stay in the daemon. Only a fixed code crosses back to the main process.

`backend/pkg/agentcreds/multica_delegation_policy.go` uses the same cached remote,
OS-managed, system-file and drop-in reader as AO's Claude model-policy resolver.
It never reads user/project settings as authority, reads credentials, fetches
policy, or executes a policy helper. Managed sources can supply the optional
`aoMulticaDelegation` object. With no object configured, `policy_absent` permits
normal explicit confirmation; it does not enable rollout or override any other
client/server check. Unreadable or malformed managed sources fail closed because
the resolver cannot establish whether they contain a delegation restriction.

The object has `version: 1`, a non-empty `revision`, an RFC3339 `validUntil`, and
`effect: "allow"` or `"deny"`. An allow requires explicit arrays named
`serverOrigins`, `workspaceIds`, `profileIds`, `runtimeClasses`, `dataScopes`, and
`actions`. Each request must match every array exactly; an empty array denies
all choices in that dimension. A deny needs no allowlists. Null, unknown fields,
unknown versions/effects, expired or malformed validity, and dynamic helpers are
unavailable. Every configured delegation object is a ceiling, including separate
drop-ins and OS-managed documents; their intersection applies even when the
underlying model settings use replacement precedence. Local settings and higher
managed sources cannot widen another delegation ceiling. The existing Windows
user-policy fallback selection remains in effect.

The request contains only canonical server origin, workspace/profile/runtime IDs,
runtime class, the fixed approved data scope `task_brief`, and action `delegate`.
It excludes task title/instructions, local paths, user identity, and credentials.
The current wire payload supports only that task brief; this does not authorize
file reads, root sharing or upload. Adding such payloads requires extending the
approval and policy contracts together.

A trusted main-process `resolveRuntimeClass` callback must establish `local` or
`remote` for the exact configured binding/runtime ID and is called afresh at each
check. Do not infer location from a loopback Multica server or profile name.
TK-MA63's Public API runtime metadata does not establish execution location, so
an omitted resolver supplies `unknown`. Personal use without managed policy still
works; a managed allow with unknown location blocks with `policy_runtime_unknown`
until trusted location metadata is available. Remote execution requires an
explicit `remote` match in every configured ceiling.

An additional main-process `policy` plug-in may narrow the managed decision; it
cannot replace the mandatory journal resolver. It returns only `{code}` with
`policy_absent`, `policy_allowed`, `policy_denied`, `policy_unavailable`, or
`policy_runtime_unknown`. Unknown outcomes, extra fields, exceptions and a
five-second evaluation timeout become `policy_unavailable`. No source-provided
reason, revision, policy text or error message is logged, persisted, or exposed.

Before confirmation, a block throws only its safe reason code and creates no
proof or journal reservation. At dispatch, the same code is persisted in the
existing `failureCode` field, leaving the intent pending. A restored policy can
permit that exact confirmed intent later. If policy changes after the durable
attempt marker, the conservative `submission_unknown` marker remains, even if
this process has not submitted; subsequent processing reconciles by the same key
before any replay. Policy blocks do not turn an earlier ambiguous admission into
a rejection. Status reconciliation and explicitly confirmed cancellation remain
available. No database schema or migration changes are required.
