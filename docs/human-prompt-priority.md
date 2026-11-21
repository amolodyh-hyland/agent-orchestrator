# Human prompts in project orchestrators

Default Send admits explicitly human-authored requests before waiting automation,
with FIFO order among admitted humans. It records the message durably, then uses
the existing single-row queued promotion to deliver it into an active steerable
turn. It never attaches the report backlog to that guidance. The separate Queue
button deliberately waits for a later turn; Stop keeps its existing cancellation
semantics. Queued humans are selected before automation; reordering remains
stable within each priority group.

Production Service.Send keeps genuine human input, including explicit Queue,
separate from pending worker report piggyback payloads. Reports remain pending
for the coordinator's own durable submission and native-acceptance receipts.
Report-linked historical rows retain their existing promotion restrictions.

The UI requires the AO daemon's explicit `supportsHumanPriority` snapshot flag
as well as an orchestrator session. An absent/false flag keeps prior Queue
behavior on Cloud and older remote AO daemons. The same current capability gates
held, staged and durable QueueOnly emission; supported startup/account waits
retain an already deliberate Queue intent.

Priority uses explicit human origin or trusted user-authorship metadata. A sender
session, report batch or spawn opening prompt cannot gain human priority. Unknown
origin is not promoted to human priority by the legacy normalization fallback.
Existing historical rows without explicit authorship retain neutral queue priority.
New orchestrator human intake, including intake while provisioning or sleeping,
records explicit authorship with the existing durable field. Relayed user feedback
keeps its automation origin and its trusted authored-by-user fact.

Worker steer-or-send requests targeting an orchestrator enter the durable queue
rather than building a provider-side active guidance backlog. Direct steering
already in flight can be cancelled using its own request context. Only a currently
registered automated request is cancelled; provider-wide withdrawal is reserved
for Stop so earlier uncertain human guidance is not withdrawn. Cancellation alone
never proves non-delivery, never requeues the guidance and never interrupts tools.
Existing definitive refusal and uncertain receipt rules still govern recovery.

A human waiting to acquire the controller dispatch lock gets an unaccepted
`CHAT_INPUT_WAITING` response after a five-second scheduler admission budget.
Its draft and message handle can be retried. This bounds scheduler admission,
not provider execution or model response time. A provider that ignores request
cancellation may still hold the lock. Unsupported steering, non-steerable turns
and unsupported structured content leave the complete message visibly queued.
Possibly accepted promotion is settled uncertain and cannot be automatically resent.
Already accepted provider input and in-flight external tool side effects are not
reordered, interrupted or restarted.

Regression coverage lives in `human_priority_test.go` and
`human_priority_internal_test.go`, alongside existing queue, promotion, steering
and protocol tests. Fake-clock admission tests cover human FIFO against automation
and permit cleanup. Real controller tests use isolated SQLite stores and fake
providers for active delivery, cancellation, uncertain recovery, attachments,
explicit Queue, reorder, fallback and database reopen. These tests do not establish
real provider collection time or desktop rollout readiness.
