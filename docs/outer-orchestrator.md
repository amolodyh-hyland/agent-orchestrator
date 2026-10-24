# Outer orchestrator M1

The host binding uses an ordinary orchestrator in its own repository-free Project.
Explicit desktop setup selects the existing Codex Chat settings. Setup and passive
reads do not submit a turn. The allowlist stores immutable Project IDs independently
of the selected-project cockpit. Removing a Project fences retained history and
requires a fresh remaining-scope conversation; historical sessions remain guarded.

`domain/outer.go` defines the binding and authority vocabulary. `service/outer`
owns setup, scope and observation. SQLite migrations 0229 onward retain the host
binding, append-only timeline, exact requests, scope credentials and reservations.
Existing run records, report receipts and factory feedback holds remain independent.

Only a focused trusted desktop Send may issue one exact human request. Public
authorship fields are labels. Alternate outer input, active steering, promotion to
steering and cross-project mutations remain held. Queueing a bound Send does not
extend its two-minute submission deadline. Restoring observation never grants a
new turn or replays an uncertain submission.

M1 binds visible plain-text Send content. Skills, excerpts and attachments whose
expanded bytes lack a pre-Send preview stay held. Native tool use within an
authorized turn retains the existing permissions. Pending native approvals and
input replies name the exact interaction and original authorized turn.

The Codex RPC writer checks authority after acquiring its serialized write lock.
The request journal records an attempt before any bytes, and an ambiguous result
cannot be retried with that request. Exact setup, scope and other native control
payloads use a separate immutable private journal; the public timeline carries
digests and safe metadata. Restored receipts include earlier outer generations.

Admission and its passive capacity view share the same observed counts. Outside
workers and reviewers consume capacity; unknown activity holds new admission.
The view shows foreground-reserve overage without stopping unrelated work.

Owned asynchronous setup retains its exact native identity across the background
launch and rechecks it before work begins. Project-local service contexts recheck
their caller generation. Queued requests hold if a labeled session revision,
report projection or run version changes before submission.

Project-local credentials cannot read the outer's cross-project projections.
Outer reads require the current native owner and hold retained/replaced history.
Anonymous requests and project-local credentials cannot obtain these projections.
The desktop uses a separate bounded preload/main read channel and a private,
purpose-separated request and response MAC. That passive authority cannot issue
a human request or authorize a turn. Current outer runtimes receive only current
scope receipts and audit rows; the trusted desktop retains historical visibility.
An incoming
sender's known identity does not establish its content provenance: it remains
labeled unknown and inert. These credentials do not isolate same-account clients.

Send stages include the visible scope revision, native generation and settings
digest. A change before native issuance holds the request, as does a later change
at queue drain or final write. Rejected native Sends retain their exact private
payload and audit link without creating executable queue entries.

The journal covers logical operations and observable native invocation events.
It does not claim syscall coverage, same-account process isolation, a spending
cap, or a hard host-wide concurrency cap. Native permissions remain authoritative.
