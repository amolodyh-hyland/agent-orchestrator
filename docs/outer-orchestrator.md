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

The journal covers logical operations and observable native invocation events.
It does not claim syscall coverage, same-account process isolation, a spending
cap, or a hard host-wide concurrency cap. Native permissions remain authoritative.
