# Codex permissions and the permission fallback

Status: implemented on `feature/codex-approve-for-me`.
Scope: how AO maps its permission modes to Codex launch settings, and what happens
when Codex refuses the requested mode.

## Problem

An organization can enforce Codex *requirements* (managed policy) that allow only
some sandbox and approval values. Observed on `codex-cli 0.159.2`:

- allowed `sandbox_mode`: `ReadOnly`, `WorkspaceWrite`
- allowed `approval_policy`: `OnRequest`, `UnlessTrusted`

AO asked for `DangerFullAccess` and `never` whenever a Codex session ran in
`default` or `bypass-permissions`. Codex handles that request three different ways
depending on where it arrives:

| Request | Codex 0.159.2 behavior |
| --- | --- |
| TUI flag `--dangerously-bypass-approvals-and-sandbox`, `codex exec` | Coerced to the allowed value with a startup warning (`falling back to required value OnRequest`). No failure. |
| App-server `thread/start` with `sandbox: danger-full-access` | Coerced silently (thread comes back `workspaceWrite`, `on-request`). |
| App-server `turn/start` with `sandboxPolicy: {type: dangerFullAccess}` | **Hard error**: `invalid thread settings override: invalid value for sandbox_mode: DangerFullAccess is not in the allowed set [ReadOnly, WorkspaceWrite] (set by enterprise-managed requirements …)` |

AO Chat sends the conversation's approval mode on every turn, so the first prompt of
a spawned worker failed (`SPAWN_DELIVER_PROMPT_FAILED`). `auto` was verified to pass.
Omitting every override yields the configured default (`workspaceWrite`,
`on-request` on the machine where this was verified).

## Mapping

AO keeps its four modes; no new mode or API enum was added.

| AO mode | TUI launch | Chat thread start / resume | Chat per-turn |
| --- | --- | --- | --- |
| `default` | no approval or sandbox flag | no `approvalPolicy`, `approvalsReviewer`, `sandbox` | nothing sent |
| `accept-edits` | `--ask-for-approval on-request --sandbox workspace-write` | `on-request`, `workspace-write`, reviewer `user` | same, `workspaceWrite` |
| `auto` (approve-for-me) | `--ask-for-approval on-request --sandbox workspace-write -c approvals_reviewer="auto_review"` | `on-request`, `workspace-write`, reviewer `auto_review` | same, `workspaceWrite` |
| `bypass-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `never`, `danger-full-access` | same, `dangerFullAccess` |

- `default` is the legacy no-override launch. Codex's own configuration, and any
  managed requirements over it, decide. It never sends `DangerFullAccess`.
- `auto` is Codex's `--approve-for-me` (auto review inside the workspace-write
  sandbox). The explicit flags are used instead of `--approve-for-me` so older CLIs
  still work, and the sandbox is now pinned so a user-level
  `sandbox_mode = "danger-full-access"` cannot widen it.
- `bypass-permissions` is the only mode that requests full access. AO sends it as
  asked and never works around a managed requirement that rejects it.

### Default and trade-offs

- Spawn already resolves an unset permission to `auto`
  (`applySpawnAgentConfig`), so an unconfigured project gets approve-for-me.
- **Behavior change:** Codex `default` used to mean full access. It now means "do not
  override". A project that stored `default` and relied on full access must set
  `bypass-permissions`. The Codex pickers and the project-permission memory were
  updated to match (they previously labeled and stored Codex `default` as full
  access / bypass).
- Returning to `default` mid-thread: Codex applies a turn's override to later turns
  and has no way to withdraw it, so sending nothing would leave, for example, full
  access running under a "Codex defaults" label. When a thread has carried an
  explicit posture (from its launch or an earlier turn), the first `default` turn
  sends the Ask for approval posture explicitly (`on-request`, workspace-write,
  reviewer `user`), after which `default` sends nothing again. For the common setup
  that equals Codex's own default; for a user whose configuration is wider it is
  deliberately safer, and for one whose configuration is narrower (for example a
  user-level `read-only` sandbox) it is wider than their default, a limitation of
  Codex having no way to withdraw an override. A thread that never overrode anything is never touched. A resumed
  thread keeps the override its last turn left (checked live: a prior turn's automatic
  reviewer was still in effect after a plain `thread/resume` that sent nothing), and
  a host that survived a daemon restart keeps whatever posture it had, which this
  process never saw. So after any resume the first `default` turn resets too, unless
  the conversation is read-only. If
  a managed requirement refuses the reset posture, the error says so ("returning to
  Codex defaults sent the ask-for-approval posture, which was refused") and names
  `accept-edits`, the posture actually sent, rather than `default`.
  A refused reset has a terminating rule so it cannot lock a conversation out. When
  the posture to withdraw is only assumed (a resume or surviving host that sent no
  override), a refusal means this process knows of nothing to withdraw and the
  provider will not accept the posture that would withdraw it; asking again would
  refuse every default turn, and under a policy that allows only approval `Never`
  the explicit modes are refused too. So the refusal is reported once, with a warning
  that the thread may still carry the override it had before it was reopened, and
  the next `default` turn sends nothing. That never widens anything AO sent: nothing
  is sent, and the one extra message is the user's confirmation. A posture this
  process did send (a launch, a resume with an override, or an accepted turn
  override) is known, not assumed, so a refused reset of it keeps being reported:
  the user can return to that mode, and sending nothing would run the wider posture
  under a "Codex defaults" label. Only a refusal of the posture ends the assumption;
  any other failure asks for the reset again.
- **Existing data:** conversations whose stored approval mode is `default` (the old
  picker showed it as "Full access"), sessions with no pinned permissions, and
  projects that stored `default` now launch or resume with no override instead of
  full access. They are less permissive than before, so unattended workers that
  relied on full access can stall on approvals until the mode is set to
  `bypass-permissions`. There is no data migration.
- `PermissionDefault` in `pkg/agentruntime` keeps its full-access launch for Cloud
  workers (the `cloud/` module is unchanged); the desktop adapter uses the new
  `PermissionAgentDefault` policy.

## Permission fallback

When the provider refuses the requested mode for a permission or sandbox reason, AO
retries with the next less permissive mode instead of failing the spawn.

Order, most to least permissive (`ports.PermissionFallbackModes`):

`bypass-permissions` → `auto` → `accept-edits`

Relative permissiveness was checked against the Codex mapping: `auto` and
`accept-edits` share `on-request` + `workspace-write` (the sandbox is pinned in both
the TUI and chat), but `auto` lets the automatic reviewer approve escalations that
`accept-edits` leaves to the user.

`default` is **not** a rung. It asks Codex for nothing, so its posture is whatever
Codex's own configuration says, and that can be wider than the mode that was just
refused: with a managed requirement that only constrains approvals and a user-level
`sandbox_mode = "danger-full-access"`, stepping `auto` → `default` would run
unsandboxed although workspace-write was requested. A fallback that can widen the
posture is not a fallback, so the ladder ends at `accept-edits` and, if that is
refused too, the spawn or turn fails. A user who wants Codex's own configuration
chooses `default` explicitly.

Rules:

- Step down **only** on `ports.ErrPermissionRejected`, which a driver wraps solely
  for a provider refusal of the permission/sandbox/approval posture. The Codex driver
  matches a JSON-RPC error that names the `sandbox_mode`, `approval_policy` or
  `approvals_reviewer` setting (in backticks, before any "(set by …)" label) together
  with "is not in the allowed set" or "disallowed by requirements". Transport errors,
  usage limits and every other failure surface untouched, on the first attempt and
  after a step-down. If a Codex build rewords these errors the step-down goes inert
  and the error simply surfaces.
- Read-only and review conversations never step down and their refusals are never
  classified as permission rejections: their sandbox is forced whatever mode they
  carry, so a lower mode cannot change what was refused.
- Strictly downward: the ladder never contains the requested mode or a more
  permissive one, and never `default`. A requested `accept-edits` or `default` has
  no fallback.
- Never bypasses a managed requirement. Each step asks for a weaker mode; AO does not
  edit Codex configuration or retry a refused mode.
- Not silent: every refused mode is logged (`permission mode rejected by the
  provider; stepping down`, with the provider's reason) and the result is logged
  (`permission fallback applied`, with `requested`, `effective`, `rejected`). The
  effective mode is stored as the conversation's approval mode (so the picker shows
  it and later turns start from it), stored as the session's pinned permissions
  (`ao session get` shows `permissions:`, the API reports `permissions`; written by
  the daemon's permissions hook with a targeted query, because the general session
  update does not write the pinned permissions), recorded as a timeline notice, and
  used by restore. The notice is written last: it publishes an event that makes
  clients refetch, so the conversation's mode and the session record are already
  current when they do.
- If every mode is refused the spawn or turn fails with a
  `PermissionFallbackExhaustedError` that lists each mode and its reason. A refusal
  with nothing below the requested mode (`accept-edits`, `default`) is reported as
  the provider's refusal itself, not as an exhausted ladder.
- A refusal is reported with `409 CHAT_PERMISSION_REJECTED` carrying that message,
  never an anonymous `500`, wherever an error is returned to the caller: the
  conversation routes (send, steer, queue, retry, edit, branch and the rest, through
  `writeConversationError`) and the session routes (spawn, delegate, restore,
  restart, through the session service's error mapping, where the refusal wins over
  the stage it surfaced in, such as `SPAWN_DELIVER_PROMPT_FAILED`). A switch of
  interface (TUI to Chat) records a refused target controller as
  `TARGET_PERMISSION_REJECTED` on the transition, both when the target is started and
  when it is recovered. A switch of agent records its own provider-start failure
  boundary and keeps that generic code. Reviewer launches are read-only and never
  reach any of this. Error codes are not enumerated in the OpenAPI spec, so it is
  unchanged. The chat client treats the code as a definitive non-acceptance of a
  steer or an edit.
- A permission refusal counts as the provider declining while the conversation stays
  healthy (`ChatRefusal`, which the chat service reads structurally). So an edit that
  carries a delivery handle settles as rejected rather than staying "uncertain", the
  source branch is restored, and replaying the handle never reaches the provider
  again (the replay reports the stored refusal with the generic
  `CHAT_PROVIDER_REFUSED` code and the same message); steers settle the same way.
- A lower mode that the provider cannot admit (it needs an approval channel the
  provider lacks) is treated as refused at launch, not launched.
- A mode the user picks while a turn is being sent is not overwritten by the
  fallback.
- A fallback refusal on resume is reported as the policy refusal it is, not as an
  unresumable conversation (`CHAT_RESUME_FAILED`), so the client does not offer a
  fresh conversation for it.

Where it runs (`service/chat`): `Service.Start` for `thread/start` and
`thread/resume`, and `Controller.sendTurn` for every `turn/start`, including the
queued opening prompt of an asynchronous spawn. On Codex 0.159.2 only `turn/start`
refuses, so that is where the step-down is observed.

### Configuration

`agentConfig.permissionFallback` (boolean, unset means **on**) at project level or in
a role override (`worker`, `orchestrator`); a spawn-level override also applies.

```bash
ao project set-config <id> --permission bypass-permissions --permission-fallback=false
```

`--permission-fallback=false` reports the provider's rejection as is, for example
`turn/start: permission mode "bypass-permissions" rejected: invalid thread settings
override: … (set by enterprise-managed requirements …)`. The setting is read when a
controller starts or resumes, so a change applies to new and restarted sessions.

### Settings UI

Settings → Project → Agents shows the Codex modes by what they do, not by AO's
generic names, and explains the selected one under the picker:

| Setting value | Label | Meaning |
| --- | --- | --- |
| `default` | Codex defaults (no override) | Legacy launch: AO sends no sandbox or approval setting. |
| `auto` | Approve for me | Auto review inside the workspace-write sandbox. |
| `accept-edits` | Ask for approval | Workspace-write sandbox, you approve escalations. |
| `bypass-permissions` | Full access (bypass) | Explicit full access; a managed policy can reject it. |

Under each Codex worker/orchestrator picker, **Step down if rejected** is the
`agentConfig.permissionFallback` toggle (on by default; only an explicit off is
saved, in the role override). Its tooltip states that it only steps down, never up,
and never bypasses managed policy. The toggle is hidden for other harnesses, for
the read-only reviewer, and for the modes that have nothing less permissive to step
down to (Codex defaults, Ask for approval). A project-level `agentConfig.permissionFallback` set through
the CLI is moved into the role overrides when the form saves, like the other
agent-config fields.

The mode actually in use is visible in three places: the chat's approval picker (the
fallback stores the effective mode as the conversation's approval mode), a
**Permission mode lowered to …** row in the chat timeline listing each refused mode
with the provider's reason (a durable `permission.fallback` system activity), and
`permissions` on the session API / `ao session get`.

### Other harnesses

The retry loop is harness-neutral. A driver opts in by returning
`*ports.PermissionRejectedError` (matching `ports.ErrPermissionRejected`) when its
provider refuses a mode. Only Codex does today.

### Not covered

- TUI sessions: Codex coerces a managed-policy violation with a startup warning
  instead of failing, so there is no error to step down on.
- The `cloud/` Codex worker mapping, and the Cloud session picker, which keeps the
  "Full access" wording for Codex's default because Cloud still launches it that way.
- Read-only (reviewer) Codex turns still send `approvalPolicy: never`; under an
  approval allow-list that excludes `never` they would be refused. This predates the
  change and is not a permission mode AO can lower.
- A Codex build that rejects `thread/start` is handled (same classification), but
  only `turn/start` rejection was observed live.

## Verification

Live, isolated daemon (own data dir, run file and port) against `codex-cli 0.159.2`
with the managed requirements above:

| Scenario | Result |
| --- | --- |
| `bypass-permissions`, fallback on | `turn/start` rejected with the managed error, stepped to `auto`, turn completed; `ao session get` shows `permissions: auto`; the chat timeline has the **Permission mode lowered from bypass-permissions to auto** row with the provider's reason. |
| `bypass-permissions`, fallback off | Spawn failed with the managed-requirement message surfaced in `SPAWN_DELIVER_PROMPT_FAILED`; no retry. |
| `default` | No override sent, turn completed, no step-down, no `sandbox_mode` error. |
| `auto`, then `default` chosen mid-thread | Both turns completed; the second carried the explicit Ask for approval posture, which the managed policy accepted. |
| TUI flags | `codex` accepted the `auto`, `bypass` and no-flag launches; bypass printed the `approval_policy … falling back` warning. |

Unit and integration tests: launch-flag mapping (`pkg/agentruntime`,
`adapters/agent/codex`); chat wire payloads, rejection classification, the default
mode reset and read-only handling (`codexappserver`); step-down per rung, no
step-down on unrelated errors, no escalation and never to `default`, all-fail,
disabled, launch and turn level, concurrent choice, cancellation, replacement
controllers, review and read-only conversations, and persistence on a real SQLite
store (`service/chat`); config merge, resume and agent-switch plumbing and the
persistence method (`session_manager`); the daemon permissions hook (`daemon`); the
CLI flag and `session get` output; the API field; and the settings form, timeline row
and picker labels (frontend).

Not verified: a Codex build that rejects `thread/start`, other operating systems, and
the Cloud Codex worker.
