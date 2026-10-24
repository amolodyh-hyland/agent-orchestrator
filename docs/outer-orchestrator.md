# Outer orchestrator M1 and M2

The host binding uses an ordinary orchestrator in its own repository-free Project.
Explicit desktop setup selects the existing Codex Chat settings. Setup and passive
reads do not submit a turn. The allowlist stores immutable Project IDs independently
of the selected-project cockpit. Removing a Project fences retained history and
requires a fresh remaining-scope conversation; historical sessions remain guarded.
A failed first launch retains the anchor and its saved settings. The console
offers an explicit setup retry; passive reopen does not retry that launch.

`domain/outer.go` defines the binding and authority vocabulary. `service/outer`
owns setup, scope and observation. SQLite migrations 0229 onward retain the host
binding, append-only timeline, exact requests, scope credentials and reservations.
Existing run records, report receipts and factory feedback holds remain independent.

Only a focused trusted desktop Send may issue one exact human request. Public
authorship fields are labels. Alternate outer input, active steering and promotion
to steering remain held. Cross-project actions use the finite M2 adapters below. Queueing a bound Send does not
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
Each Project cockpit links to its bounded affected-Project timeline. That filter
includes request-bound native events and scope removals, and remains available to
the trusted desktop after removal from the outer allowlist. Opening it changes no
scope and starts no conversation.
An incoming
sender's known identity does not establish its content provenance: it remains
labeled unknown and inert. These credentials do not isolate same-account clients.

Send stages include the visible scope revision, native generation and settings
digest. A change before native issuance holds the request, as does a later change
at queue drain or final write. Rejected native Sends retain their exact private
payload and audit link without creating executable queue entries.
When a passive binding arrives after typing, the composer stages the existing
visible draft without submitting it or requiring another edit.

The journal covers logical operations and observable native invocation events.
It does not claim syscall coverage, same-account process isolation, a spending
cap, or a hard host-wide concurrency cap. Native permissions remain authoritative.

`npm --prefix frontend run test:outer-integration` exercises the renderer,
private main-process handlers, real HTTP router/services and disposable SQLite
with a race-enabled fake provider. It covers setup/settings, exact Chat Send,
native pending replies, affected-Project audit, fresh reduced-scope replacement,
uncertain receipts and passive restart. The OS gesture is simulated at the
private preload boundary; separate preload tests reject scripted DOM events.
The fixture starts no daemon, listener, installed application or model process.

`httpd/outer_ownership_test.go` applies behavioral negative and supported-caller
matrices to the protected route manifest, including actual durable ownership and
the automation deletion controller. `cli/outer_caller_e2e_test.go` carries the
owned launch credential through the CLI transport to real report persistence,
rejects forged/missing/stale and cross-Project callers, and preserves inert
daemon report production. Unsupported controls remain held across that inventory.

Desktop forms that prepare their payload asynchronously (including New Task,
standalone tasks and Project Settings) use the shared native confirmation after
an explicit router hold. The dialog previews the frozen route, target and body;
only its trusted preload gesture submits it. `httpd/outer_desktop_routes.json` is
the finite catalog shared by the renderer, main process and daemon, checked
against every protected route. URL ownership still comes from stored resources.
Only the attachment-upload flag can cross as a header. Native HTTP receipts
preserve controller validation errors and status; closing, aborting or expiring
the confirmation never resends or claims that an uncertain attempt was canceled.
Credential fields are masked in the preview. These ordinary desktop request
journals retain the route and immutable request/control digests, preserving
single use without duplicating secrets; dedicated outer request journals keep
their existing exact-content contract. Raw GitHub daemon writes share this
transport; remaining direct renderer fetches are reads or cloud/remote requests.
This compatibility path cannot target the outer anchor, issue outer turns or
enable an outer-origin adapter. Existing outer Send and pending replies retain
their dedicated native bindings. Payloads over the bounded staging limit,
background preparation/readiness, prompt suggestions, unbound shell controls,
bulk cleanup and wildcard interfaces show a hold rather than authenticating
legacy requests. Remote/mobile/web clients receive no native privilege.

The desktop integration also mounts the actual task composer and settings form,
uses the ordinary API client through the real router, and confirms that enrolled
Project and standalone tasks and Project settings need the exact native gesture.
Scripted confirmation clicks and identical anonymous REST requests stay held.


## M2 confirmed actions

`AO_OUTER_M2_ACTIONS=1` opts a separately launched build into the three adapters.
The default is off. This setting does not start a turn, approve a plan, install
anything or activate another interface. Existing launch settings and native
permission gates still apply.

The outer uses `ao outer view` to inspect its current request and
`ao outer plan --file manifest.json` to propose concrete instances. The CLI carries
the owned scope credential; environment identity labels grant no authority.
There is no CLI approval command. A proposal is inert and is sealed once for its
original human request. The desktop obtains the actual sealed journal through
its private read channel, displays the original request, full ordered manifest,
identities, settings, sources, destinations and digest, then asks for one native
confirmation. Execution permission and source clarification/disclosure consent
are separately audited within that interaction. Decline permanently cancels
that manifest. Changed content requires a new human request. The outer console
keeps selected-project lifecycle shortcuts held; confirmed plans are its only
cross-project action surface.

The finite operations are `send`, `spawn`, `kill` and `retire`:

- `send` names an existing eligible Codex Chat project coordinator and exact
  plain text. It never ensures, restores or resumes the target.
- `spawn` names one Project, exact new task branch, plain text and explicit
  model, effort and permissions. The existing manager creates the owned task
  worktree, enrolls the worker before launch, and starts Chat without an opening
  turn. The separate exact approved turn uses the ordinary controller afterward.
  Projects with setup commands or shared symlink provisioning hold this adapter;
  they cannot become an implicit installation or heavy-job path.
- `kill` and `retire` name an already participating worker and stop only that
  execution. Worktrees, artifacts, restore inventory and containers are retained.
  Neither action authorizes cleanup, a replacement or a later continuation.

Example proposal (the model and identities must match the intended real targets):

```json
{
  "requestId": "exact-current-human-request-id",
  "sourceProjects": ["source-project-id", "destination-project-id"],
  "actions": [
    {
      "operation": "send",
      "projectId": "destination-project-id",
      "sessionId": "exact-existing-coordinator-id",
      "text": "Exact outgoing content",
      "config": {},
      "dependsOn": []
    }
  ]
}
```

Dependencies are one-based indexes of earlier manifest entries. The maximum is
16 concrete operations; there are no wildcard or future targets. The passive
view bounds full manifests to the eight most recent plans; older journals and
receipts remain retained. An action can wait in the existing Chat queue, but its
two-minute submission deadline starts at native confirmation and never extends.

Migration 0233 adds immutable plans, action attempts and retained participant
snapshots. It reuses the monitoring participant vocabulary and holds feedback,
review starts, automatic spawning and alternate input for enrolled executions.
A worker-only plan also enrolls its existing project report recipients before
launch; later coordinators in that Project inherit the same continuation hold.
Outgoing messages display the outer request and immutable source labels at the
destination, including after a queued delivery, without changing approved text.
Existing confirmed factory-run review gates remain independent: a generic M2
send cannot replace an exact-head review continuation approval. Unsupported
steer, terminal, ensure/delegate, restore/resume, review and release adapters
remain held.

Every continuation has its own immutable request and turn link. Final eager and
deferred writes recheck scope, pause, current owner, settings, sources, epoch,
expiry and station admission. New workers reserve a background station before
launch and retain it through uncertain submission. The same 2-station/1-heavy
accounting and foreground reservation apply. No plan grants a child execution
or feedback turn. Selected-project reads retain transitive imported sources;
removing a source holds reimport through another Project's retained content.
Reads exceeding 1,000 imported source records per Project hold rather than
discarding labels from the history.

The existing native acceptance and settlement hooks update the original request
and action receipts. Submission is single use even when its result is unknown;
late native acceptance may reconcile the original handle after expiry. Restart
never replays an action or revives its authority. Unknown reservations remain
visible until exact settlement evidence. Partial completion is visible and
uncompleted dependencies hold; independent listed actions can proceed within
their original authority and capacity. Results and feedback never wake the outer.

Focused coverage includes real router/controller/storage paths with synthetic
providers, both final transport seams, omitted/forged authority, sealed-plan
changes, concurrent/replayed approval, queue expiry, pause/settings/generation
changes, source removal, unknown receipts, preserving stop and held adapters.
No model or provider call is needed for these checks.
