# Manual run evidence

The desktop session controls are hidden by default. Enable **Experimental: software factory controls**
in **Settings → General → Advanced** to show **Run evidence** and **Delegate to Multica**
for eligible local worker and project orchestrator sessions. The `factoryControlsEnabled` boolean
is saved with the other app preferences in `ui-settings.json` under the AO state directory.
Turning it off closes these panels and dialogs; existing run evidence, delegation data, and APIs are preserved.

A run records one task claim, confirmed by a person in the desktop app, around an existing Project and implementation
session. Recording a run does not start, resume, send to, review, publish, or terminate a session. Findings delivery is a separate native-confirmed action.
The stages are `design`, `implementation`, `review`, and `handoff`. Advancing a stage
records a decision; it grants no execution or release authority. Feedback
continuations still need a separate human decision for each turn.

## Create and inspect

Use `ao run create --file run.json`. The request contains a caller-chosen stable
`id`, `projectId`, `taskId`, `sessionId`, approved `designDigest` (SHA-256),
`policyDecision` reference, nonempty `requiredChecks`, `actor`, and `decision`.
Optional `source` fields record the exact server, workspace, issue, and revision;
`delegationId` is an opaque reference. The existing delegation journal owns its
payload and consent records. Briefs remain in that journal. A separate native-confirmed specialist-result import can append bounded untrusted text and its immutable snapshot receipt to the run ledger.

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
factory-example-1` returns the run, its most recent 100 history entries, current independently
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

API and CLI mutations are **unconfirmed claims**. Caller-supplied `actor`,
`decision`, `verifiedBy` and `independent` values never grant readiness. In the
local session topbar, open **Run evidence**, enter the run ID and preview a pending
claim. A real user click and the native confirmation dialog attest the exact
creation, check receipt or review claim. Confirm each pending claim separately;
preview and confirm a stage decision separately. The dialog binds the run version,
current source observations, claim contents and artifact-verification results to
an evidence digest. Changed HEAD, evidence or version requires a fresh preview.
The private desktop key arrives through the existing inherited bootstrap pipe;
it is never exposed to the renderer, API, CLI or settings. Expiring, single-use
requests and version checks reject replay. A standalone daemon without that
bootstrap can record claims and read history but cannot confirm or advance runs.

Check receipts include `name`, full `sha`, `environment`, `exitCode`, `verifiedBy`,
and the hashed `output` artifact. They are human-verified attestations of an
existing execution, not a test runner or independent proof that a command ran.
The operator must verify the execution and its source/environment before
recording them. A receipt without that verification, successful exit, matching
current SHA, or readable matching output cannot satisfy a required check.

Review receipts include `repoName`, `reviewerId`, `independent`, full `sha`,
`readOnly`, `beforeFingerprint`, `afterFingerprint`, `verdict`, finding IDs/severities,
`round`, and a hashed `artifact`. Local review independence and the original
before/after observation are explicitly attested by the operator; this ticket
does not launch a reviewer. Before confirmation the operator must verify a separately human-started read-only reviewer and its immutable source view. The `readOnly` attestation is required; missing or writable reviews hold readiness. Both
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
in the same SQLite transaction. A public advance claim always holds for native confirmation. A blocked native
advance appends a `hold` decision and
keeps the stage. Identical repeated public blocked observations are deduplicated
without changing the version. Failed structural requests and stale versions return errors.
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
ownership. This change only references and reads them. Existing review/CI/report settings are not rewritten. Sessions named by natively confirmed run records now have a continuation gate: automatic turns and review starts hold for human action, while unrelated sessions keep their existing behavior. An allowed next action
is informational and cannot authorize a model turn, release, installation, or
cleanup. Handoff always retains a separate human release decision.

## Implementation and validation

Domain shapes live in `backend/internal/domain/factory_run.go`; the service in
`backend/internal/service/factoryrun/`; repository/file inspection in
`backend/internal/adapters/runrepo/`; storage/query definitions in the existing
SQLite layer, with additive migrations `0222_factory_run_evidence.sql` and
`0223_factory_run_evidence_bounds.sql`. Existing migrations remain unchanged.
Controller routes and `ao run` use the existing API/CLI layering. Evidence is
immutable at the database boundary and retained independently of report delivery.

Focused tests use disposable repositories, owned Git worktrees and SQLite
files. They cover manual gates, false completion, stale checks/HEAD/review,
missing and modified artifacts, staged/unstaged/deleted/untracked source,
hidden index changes, ownership drift, concurrent versions, immutable evidence,
failed-append rollback, process crash, and restart. API/CLI tests cover strict
bounded input, request paths, version transmission and error envelopes.

## Read and admission limits

Read older history with `ao run get RUN --after-version -1 --limit 100`, then
continue from `nextAfterVersion`. The corresponding route is
`GET /api/v1/runs/RUN/evidence?afterVersion=-1&limit=100`. Cursors are exclusive;
pages accept 1–100 entries. Readiness selects the latest receipt per owned
repository and kind from an indexed query, independently of paginated history.

Runs admit at most eight repositories, 50 required checks, 64 KiB per submitted
claim, 64 KiB per header and 256 KiB per stored observation/receipt. A run has at
most 512 immutable events; reaching that bound preserves history and makes the
ledger read-only. Native dialogs refuse previews over 24,000 characters. Git
output is bounded to 32 MiB per command and 100,000 indexed paths. Repository
facts remain limited to 16 KiB of source identity and changed paths; the full
index is hashed separately before computing the observation fingerprint. Raw
source/artifact files are limited to 32 MiB each, with 2 GiB total source bytes
per pass. Index snapshots accept 64 MiB. The private object view accepts up to
250,000 entries and 8 GiB of object files.
Oversized or unsupported observations hold readiness. Registered project
repositories must own their `.git` directory; linked project roots are
conservatively held. Git submodules and worktree bytes requiring normalization are conservatively held rather than converted.

Repository and artifact roots are anchored beneath validated filesystem parents;
root symlinks are refused. Unix inspection enters an inherited open directory in
a child-only trampoline; Windows holds each path component without delete sharing.
Git plumbing compares index/tree object identities to raw file bytes. It disables
global/system configuration, filesystem monitors, optional locks, pagers and
external diff/textconv, and never invokes status, worktree diff, clean/process
filters, hooks or project-defined commands. This inspection does not run checks.

Git reads a disposable metadata view with a fixed, generated configuration. It
never opens the original local config or config.worktree, and never evaluates
include/includeIf directives. The view contains bounded, anchored HEAD/ref/index
snapshots, owned object files and the owned info/exclude patterns. Object files
are inode-verified links or anchored copies; outward symlinks and alternate
object stores are refused. Git sees no original metadata paths. Source HEAD,
branch, index and exclusion snapshots are checked again after observation, and
the private view is removed afterwards. Unsupported metadata layouts (including
split indexes or reftable refs) hold readiness rather than falling back to reading
unvalidated configuration. Packed refs and ordinary linked worktrees are supported.

## Passive monitoring and attention

Approved run references are scanned at daemon startup and every 30 seconds. The
scan reads existing sessions, reports, persisted feedback policies and native
report receipts. It starts no worker and submits no continuation. The desktop
restores read-only delegation polling for the same approved project/task and
exact request or remote delegation ID, including when new admissions are off.
Offline, authentication and rate-limit failures retain the original reference.
No replacement admission, cancellation or retry-as-new execution is inferred.

`ao run status <id>` performs a five-second bounded GET. `ao run attention
--project <id>` lists monitoring projections. The cockpit and session run dialog
show these same deadlines, next owner, observation/activity timestamps, report
acknowledgement and native receipt facts. Report acknowledgement is distinct from
native acceptance; neither is verified work completion. Idle and unavailable
ownership always retain work in progress.

`ao run monitor <id> --file monitor.json` changes display settings only:

```json
{"silenceSeconds":300,"buildSeconds":1800,"heavy":false,"nextOwner":"operator"}
```

The default silence deadline is five minutes; a heavy/build stage uses thirty
minutes. Set `heavy` for an approved build, or set an explicit `stageDeadline`
(UTC timestamp) for a tighter stage limit. Each confirmed stage change clears the
previous explicit deadline. Silence is measured from stage entry, worker activity
and worker reports, never from a view refresh. Attention coalesces by immutable
project/run/stage-version/condition. First/last occurrence and deliberate display
acknowledgement survive restart. `POST /runs/{runId}/attention` with the current
`key` acknowledges display only: the cause remains until fresh evidence, report
outbox acknowledgement is unchanged, and work never resumes.

Decision 6(b) holds execution-producing feedback for confirmed run workers and
their project's report-recipient coordinators. Effective inherited automatic
review, CI/review injection, persisted PR/comment/review policies and report routes
are snapshotted without editing session settings or project defaults. Gates cover
automatic review, lifecycle nudges, scheduled reports, stuck-report interrupts,
piggyback, semantic sends, queued Chat dispatch and deferred starts. Delayed or
queued feedback remains held across restart; toggles, elapsed deadlines, a pause
or an old/revoked approval cannot make it executable. Monitoring issues no
continuation grants and offers no automatic resume or steer. Unrelated workers
and projects keep their existing behavior. Direct human conversation remains a
separate action; these monitoring controls confer no authority on it.

There is no terminal run status or resource-release operation in this ledger.
Handoff remains an active human release gate. Approved references remain monitored
and feedback held; unknown ownership never frees a workspace. This consumes the
PR #48 report coordinator and PR #57 native receipt distinction, preserving their
cross-project deferral and recovery behavior. Monitoring does not implement factory admission or isolation. The separate exact
findings continuation approval is described below.

Monitoring sweeps advance at most 25 references per pass and persist an exclusive
cursor before each observation. A timeout, restart or failed observation advances
the next pass beyond that reference; the cursor wraps at the end. Each run has its
own observation lock. Listing never waits for a complete sweep: it returns saved
snapshots and explicit `unobserved` references in pages of 1–100 rows, using
`afterId`/`nextCursor`. `ao run attention --after-id <cursor> --limit 100` reads the
next page. The desktop follows every page when restoring delegation observation.
SQL limits report observations to the newest 100 metadata rows before hydration;
no report bodies or output attachments are loaded. Participant queries read only
the run worker and active report recipients. Feedback policy metadata is bounded
to 1,000 entries, with an explicit held marker for additional entries.

All review trigger sources recheck the factory hold after admission waits and
before invoking the shared review engine. A source label cannot authorize a new
factory review. Reviewer Chat messages from the daemon pass the same hold at
queue drain, dispatch, provider submission and deferred transport admission.

## Exact-commit findings and one approved continuation

In **Run evidence**, confirm the review receipt before choosing **Preview findings
delivery**. The preview names the assigned implementation session, native
conversation/controller generation, full SHA, round, findings and exact text.
Reading, displaying, and recording a receipt performs no delivery or provider
write. Local review never posts a provider review or comment. After separately
authorized publication, continue using the existing native PR review records and
feedback; referencing a `reviewRunId` does not create publication authority.

Each pass is immutable. Repeating the same receipt does not create another round;
changing it requires the next separately human-started pass. Three passes and
two findings continuations are the maximum per run. Unresolved P0/P1/P2 findings,
a missing verdict, failed or stale checks, changed HEAD, or source mutation hold
handoff. A new commit needs fresh checks, review, and a reconfirmed handoff.

The real desktop click and main-process native dialog approve exactly one next
turn in the existing implementer. CLI/API claims, receipt text, read acknowledgement,
and renderer calls cannot issue that authority. Delivery requires an already live
Codex Chat controller with a native identity and one owned repository. Workspace receipts remain readable and release-gated; multi-repository findings require manual handoff until a single approved payload can cover their rounds. Other transports hold until they
can enforce the same final submission and acceptance boundary. Delivery cannot
wake, restore, start, or replace a station. Before approval, turn off automatic
review and review/CI injection for this participant; the gate also refuses
unapproved automation regardless of persisted injection policies. Ordinary message APIs cannot manufacture human authority for an enrolled participant; unsupported continuations hold for a trusted native action.

Authority expires two minutes after confirmation unless actual submission has
begun. A queued message does not consume it or extend its deadline. Dispatch
checks the exact payload, target/generation, settings, run version, current
source and artifact bytes, daemon epoch and feedback control revision. Deferred
transports check again at their actual start boundary. No appended skills,
excerpts, piggyback or permission fallback can change the approved message.

The run read model exposes `feedback` with separate approved, queued, attempted
(unknown), provider-submitted and native-accepted facts. The durable native
`turn.started` evidence used by report receipts acknowledges findings once;
synthetic starts and successful enqueue do not. Late native acceptance remains
evidence of the original delivery even after expiry. Lost responses and uncertain
submission retain the same identity without resending. A held or lost delivery
needs human inspection. An expired, revoked or pre-restart approval that never attempted submission can be replaced only by a fresh native decision. Its old queued identity is fenced. An uncertain or accepted submission cannot be replaced; no automatic resend is offered.

**Pause findings delivery** revokes pending authority. **Allow new findings
approvals** permits new previews but never replays an old turn. Restart also
invalidates unsubmitted authority and restores receipts for observation only.
Evidence and attempted deliveries survive rollback; hiding the UI cannot grant
permission. No local release action is introduced.

Migration `0228_factory_review_feedback.sql` adds immutable delivery bindings and
versioned feedback controls after 0225. Native receipt updates share the existing
provider-event transaction. Focused regressions cover stale/mutated source,
missing verdict, lost/duplicate delivery, pre-submission expiry, paused/revoked
controls, settings/generation changes, restart, native acceptance and bounded rounds.

The feedback ledger retains at most 16 immutable authority bindings per run. Reaching that bound holds new approvals and preserves every earlier receipt.

The passive factory hold and exact findings authority share the same durable
participant policy, including report recipients. The main Chat controller admits
an exception only after validating the exact native approval binding at dispatch
and again at actual transport submission. A source label, copied delivery ID,
review request, or queued message grants no authority. Reviewer starts remain held
at the shared review engine boundary. Raw terminal input and side conversations
have no native approval transport and remain held for enrolled participants;
this includes opening, restoration, retries, queued sends and deferred submission.

Raw terminal input resolves its persisted owner before any policy or input lease:
main session/runtime handles, reviewer handles (including native runtime wrappers),
and session-scoped shell handles all use their owning session. Project-only shells
remain held for enrolled projects. Unknown or conflicting mappings fail closed;
admission rechecks both the mapping and policy after any library wait.


## Import an approved specialist answer

WI-FAC-08 adds `specialist_result` receipts to this ledger through the private
boot-authenticated desktop boundary. A run must name the exact source delegation
(request ID or remote delegation ID) for the same Project/task; optional server
and workspace bindings must agree. The receipt includes exact terminal identities,
text bytes, digest, snapshot revision, and separate fresh read/import consent IDs
and timestamps. Version comparison and append are transactional. A changed answer
requires a fresh receipt; a stale or replayed approval cannot overwrite history.

Later native stage confirmations show bounded source/consent metadata, terminal
revision, snapshot revision, SHA-256 and byte count for each current specialist
receipt. Their confirmation digest seals this metadata projection. The answer
body is omitted from stage dialogs, including for a maximum-size 32768-byte
import; the full untrusted text remains unchanged in ledger history.

This receipt does not advance readiness or stages, satisfy checks/review evidence,
or submit a continuation. Imported content is untrusted evidence. See
[multica-delegation-contract.md](multica-delegation-contract.md#specialist-text-result-v1-wi-fac-08)
for the two-step desktop workflow and paired contract validation.
