# Manual run evidence

A run records one human-approved task around an existing Project and implementation
session. It does not start, resume, send to, review, publish, or terminate a session.
The stages are `design`, `implementation`, `review`, and `handoff`. Advancing a stage
records a decision; it grants no execution or release authority. Feedback
continuations still need a separate human decision for each turn.

## Create and inspect

Use `ao run create --file run.json`. The request contains a caller-chosen stable
`id`, `projectId`, `taskId`, `sessionId`, approved `designDigest` (SHA-256),
`policyDecision` reference, nonempty `requiredChecks`, `actor`, and `decision`.
Optional `source` fields record the exact server, workspace, issue, and revision;
`delegationId` is an opaque reference. The existing delegation journal owns its
payload and consent records. No brief or result body belongs in this ledger.

```json
{
  "id": "factory-example-1",
  "projectId": "example",
  "taskId": "selected-task",
  "sessionId": "example-1",
  "source": {"issueId": "selected-task", "revision": "accepted-revision"},
  "designDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "policyDecision": "approved-scope-and-per-turn-continuation",
  "requiredChecks": ["focused-tests", "build"],
  "actor": "operator",
  "decision": "accepted design and scope"
}
```

Creation snapshots the registered repository/worktree/base/branch bindings. Every
registered workspace repository needs its own owned worktree and completion
receipt. Single-repository sessions may use the existing session metadata when
no `session_worktrees` row exists. Scratch projects are unsupported.

`ao run list --project example` lists persisted run records. `ao run get
factory-example-1` returns the run, ordered evidence history, current independently
observed repository facts, next action, and blockers. Reads do not mutate the
run, claim reports, acknowledge delivery, or submit a turn. The API routes are:

- `GET /api/v1/runs?projectId=example`
- `GET /api/v1/runs/{runId}`
- `POST /api/v1/runs`
- `POST /api/v1/runs/{runId}/evidence`
- `POST /api/v1/runs/{runId}/advance`

The generated OpenAPI document describes the complete request/response fields.
The CLI uses the daemon HTTP boundary; it never opens the database or invokes
Git. There is no additional desktop view in this change.

## Record completion and review

`ao run record factory-example-1 --file receipt.json` accepts exactly one
`completion` or `review`, plus `expectedVersion`, `actor`, and `decision`.
Completion fields name `repoName` (`__root__` for the root), an existing owned
`reportId` whose state is `done`, `attempt`, the claimed `facts`, input/output
artifacts, and checks. A report's `done` state is a claim, not verification.

Facts contain canonical `repoPath` and `worktreePath`, full `baseSha` and
`headSha`, `branch`, `changedFiles`, `staged`, `unstaged`, and `untracked` arrays.
The optional claimed fingerprint must match if supplied. Claim paths are never
used to select a repository. The verifier uses the Project and owned worktree
records, compares Git common-directory identity and the initial binding, checks
base ancestry and branch, and reads HEAD, index, working-tree and untracked
facts. Hidden index flags, unavailable repositories, dirty source, mismatched
claims and missing evidence hold readiness. Observations are point-in-time
facts; the ledger does not lock out external Git writers. Every read and stage
advance rechecks them, including after handoff.

Artifacts use `root: "worktree"` or `root: "artifacts"`, a relative `path`, and
SHA-256 `digest`. The roots come from owned worktree records or the existing
session artifact directory under the configured data directory. Absolute paths
and escapes outside those roots are refused. Files must be regular, at most
32 MiB, present, and match their digest. Receipts retain digests and references;
existing session artifact storage owns the files.

Check receipts include `name`, full `sha`, `environment`, `exitCode`, `verifiedBy`,
and the hashed `output` artifact. They are human-verified attestations of an
existing execution, not a test runner or independent proof that a command ran.
The operator must verify the execution and its source/environment before
recording them. A receipt without that verification, successful exit, matching
current SHA, or readable matching output cannot satisfy a required check.

Review receipts include `repoName`, `reviewerId`, `independent`, full `sha`,
`beforeFingerprint`, `afterFingerprint`, `verdict`, finding IDs/severities,
`round`, and a hashed `artifact`. Local review independence and the original
before/after observation are explicitly attested by the operator; this ticket
neither launches a reviewer nor provisions a read-only snapshot. Both
fingerprints must match the current source fingerprint. A native `reviewRunId`,
when supplied, must also resolve to the existing session's completed, approved
per-SHA review record. No provider write is performed. Missing/stale review,
mutation, self-review, a non-approved verdict, or any P0/P1/P2 finding holds the
handoff gate. Three review rounds remain the limit, not permission to run them.

## Advance, recovery and boundaries

```sh
ao run advance factory-example-1 --expected-version 0 \
  --actor operator --decision 'approve implementation stage'
```

Each mutation appends an immutable evidence row and changes the run's version
in the same SQLite transaction. A blocked advance appends a `hold` decision and
keeps the stage. Failed structural requests and stale versions return errors.
A version conflict requires reading the latest history before making a new
decision. After a lost response, inspect the stable run ID/version; do not
invent a replacement execution or assume the write failed. A crash before
commit exposes neither a partial header nor a partial receipt. Restarts retain
all committed decisions and re-evaluate files, ownership, HEAD, checks and review.
New claims append history; they never overwrite old receipts. A handoff decision
also pins the observed source. After HEAD or ownership changes, fresh receipts
alone cannot reuse that decision: explicitly advance again to reconfirm handoff
at the new source. This does not authorize publication or installation.

The ledger's stages are human decisions, not persisted derived session status.
Report coordinator/outbox delivery and native review records keep their existing
ownership. This change only references and reads them. Existing review/CI/report
injection policy is not changed by creating a run; enrolling participants under
an enforced factory continuation policy is separate work. An allowed next action
is informational and cannot authorize a model turn, release, installation, or
cleanup. Handoff always retains a separate human release decision.

## Implementation and validation

Domain shapes live in `backend/internal/domain/factory_run.go`; the service in
`backend/internal/service/factoryrun/`; repository/file inspection in
`backend/internal/adapters/runrepo/`; storage/query definitions in the existing
SQLite layer, with additive migration `0222_factory_run_evidence.sql`.
Controller routes and `ao run` use the existing API/CLI layering. Evidence is
immutable at the database boundary and retained independently of report delivery.

Focused tests use disposable repositories, owned Git worktrees and SQLite
files. They cover manual gates, false completion, stale checks/HEAD/review,
missing and modified artifacts, staged/unstaged/deleted/untracked source,
hidden index changes, ownership drift, concurrent versions, immutable evidence,
failed-append rollback, process crash, and restart. API/CLI tests cover strict
bounded input, request paths, version transmission and error envelopes.
