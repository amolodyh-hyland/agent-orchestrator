# Report delivery receipts

Scheduled Chat reports and reports appended to a human Chat message remain
pending until the driver supplies native acceptance evidence for that exact
turn. Durable queue insertion, a prepared provider ID, a running turn row and
successful start scheduling do not acknowledge reports.

The message and queued turn commit with a unique batch-to-message link, fenced
by the report claim token and destination project. The link retains the client
message ID, conversation ID and turn ID across restart. Report-bearing queued
messages cannot be edited or promoted to steering; cancellation retains the
link without acknowledging or automatically submitting another copy.

The delivery contract distinguishes these observations:

- `ao_queued`: the original linked turn is still queued.
- `provider_submitted`: the driver proved submission through its native protocol;
  the observation time is recorded separately from acceptance.
- `native_accepted`: explicit driver evidence identifies the native conversation
  and exact provider turn. The receipt commits in the provider-event transaction.
- `unknown`: local preparation, an ambiguous response or missing evidence
  cannot establish native acceptance.
- `held`: a terminal or cancelled local turn lacks native acceptance, or an
  upgrade could not safely correlate an existing delivery.

Codex's correlated `turn/started` notification and native turn-history replay
supply acceptance evidence. Its successful `turn/start` response establishes
submission, separately. History text matching or remapped local IDs cannot
substitute for exact native turn identity. ACP's synthetic `turn.started` precedes transport I/O
and carries no acceptance evidence. Drivers without a demonstrated native
signal retain pending receipts, held after a terminal local row; this change
does not add protocol support for those drivers.

The coordinator reconciles linked batches by reading receipts, never by sending
them again. This includes a restart after native acceptance but before batch
acknowledgement. Acknowledgement remains token-fenced and happens once. A held
batch uses its own retry deadline, allowing other projects to continue. Old
acknowledged reports are not retroactively described as native receipts.

TUI delivery keeps its existing, separate semantics: a stable coordination ID
wraps the report and must match a `UserPromptSubmit`-derived checkpoint in the
current runtime launch generation, observed within ten seconds. A pane write
alone does not qualify. `prompt_submitted` acknowledges that observation; it
proves neither process settlement nor a verified work outcome. A timeout is
not definitive evidence that submission never happened.

Migration `0224_report_chat_acceptance.sql` adds the receipt links and observation
times without modifying existing migrations. Receipt identity survives transcript
removal; losing local display rows never makes a batch eligible for resubmission.
No factory approval, expiry, admission or outer-session behavior is introduced.

## Upgrade recovery and explicit resolution

Migration `0225_report_delivery_recovery.sql` reconciles pre-existing scheduled
Chat messages by their unique stable batch/client identity. Matching historical
Codex native-start evidence is recovered during upgrade; synthetic start events
never establish acceptance. A retry deduplicated against an existing message
can still acquire the same token-fenced receipt link. Ambiguous or unidentifiable
pre-upgrade Chat claims and previously attempted pending batches are held for
inspection rather than submitted again. This includes an ambiguous piggyback
send released back to pending: its human client ID cannot establish the report
link. The old schema supplies no definitive no-start evidence for such retries;
error text alone never permits resubmission. Unattempted pending batches remain
eligible.

`GET /api/v1/reports?projectId=...` exposes `deliveryState`, `deliveryStatus`,
`deliveryBatchId`, `lastError` and `resolutionNote`. `held` includes cancelled or
terminal turns without native acceptance; `unknown` includes unsupported or
ambiguous native evidence. These states remain distinct from acknowledgement.

Use `ao report status --project <project-id> [--json]` to inspect delivery errors.
After independently delivering or reading the report, explicitly record the
human choice with:

```sh
ao report resolve <report-id> --delivered-elsewhere --note "Read in the source transcript"
```

This calls `POST /api/v1/reports/{reportId}/resolve` with
`{"resolution":"delivered_elsewhere","note":"..."}`. It resolves the entire
batch, records the reason, stops automatic reconciliation and allows newer
reports to proceed. Repeating the same resolution is idempotent; a changed
reason conflicts. Queued or already natively accepted deliveries cannot be
resolved this way. Resolution neither acknowledges native acceptance nor
resends, cancels or proves settlement of the original turn, which may still
complete independently. There is no automatic resend action.
