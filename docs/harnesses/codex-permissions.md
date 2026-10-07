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
| `accept-edits` | `--ask-for-approval on-request` | `on-request`, `workspace-write`, reviewer `user` | same, `workspaceWrite` |
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
- Per-turn `default` cannot withdraw an earlier explicit per-turn choice: Codex has
  no "reset to configured default" on `turn/start`, so selecting it mid-thread
  leaves the thread on its last explicit posture.
- `PermissionDefault` in `pkg/agentruntime` keeps its full-access launch for Cloud
  workers (the `cloud/` module is unchanged); the desktop adapter uses the new
  `PermissionAgentDefault` policy.

## Permission fallback

When the provider refuses the requested mode for a permission or sandbox reason, AO
retries with the next less permissive mode instead of failing the spawn.

Order, most to least permissive (`ports.PermissionFallbackModes`):

`bypass-permissions` → `auto` → `accept-edits` → `default`

Relative permissiveness was checked against the Codex mapping: `auto` and
`accept-edits` share `on-request` + `workspace-write`, but `auto` lets the automatic
reviewer approve escalations that `accept-edits` leaves to the user. `default` is
last on purpose: it asks Codex for nothing, so it is the one posture that cannot
contradict a managed requirement. On an unmanaged machine whose own configuration is
`danger-full-access`, `default` could in theory be *more* permissive than `auto`;
that only happens after the stricter modes were refused, and the effective mode is
logged and recorded either way.

Rules:

- Step down **only** on `ports.ErrPermissionRejected`, which a driver wraps solely
  for a provider refusal of the permission/sandbox/approval posture. The Codex driver
  matches a JSON-RPC error that names a sandbox or approval field together with
  "is not in the allowed set", "disallowed by requirements" or "managed
  requirements". Transport errors, usage limits and every other failure surface
  untouched, on the first attempt and after a step-down.
- Strictly downward: the ladder never contains the requested mode or a more
  permissive one. A requested `default` has no fallback.
- Never bypasses a managed requirement. Each step asks for a weaker mode; AO does not
  edit Codex configuration or retry a refused mode.
- Not silent: every refused mode is logged (`permission mode rejected by the
  provider; stepping down`, with the provider's reason) and the result is logged
  (`permission fallback applied`, with `requested`, `effective`, `rejected`). The
  effective mode is stored as the conversation's approval mode (so the picker shows
  it and later turns start from it), stored as the session's pinned permissions
  (`ao session get` shows `permissions:`, the API reports `permissions`), and used
  by restore.
- If every mode is refused the spawn or turn fails with a
  `PermissionFallbackExhaustedError` that lists each mode and its reason.
- A lower mode that the provider cannot admit (it needs an approval channel the
  provider lacks) is treated as refused at launch, not launched.
- A mode the user picks while a turn is being sent is not overwritten by the
  fallback.

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

### Other harnesses

The retry loop is harness-neutral. A driver opts in by returning
`*ports.PermissionRejectedError` (matching `ports.ErrPermissionRejected`) when its
provider refuses a mode. Only Codex does today.

### Not covered

- TUI sessions: Codex coerces a managed-policy violation with a startup warning
  instead of failing, so there is no error to step down on.
- The `cloud/` Codex worker mapping.
- A Codex build that rejects `thread/start` is handled (same classification), but
  only `turn/start` rejection was observed live.

## Verification

Live, isolated daemon (own data dir, run file, port) against `codex-cli 0.159.2`
with the managed requirements above:

| Scenario | Result |
| --- | --- |
| `bypass-permissions`, fallback on | `turn/start` rejected with the managed error, stepped to `auto`, turn completed; `ao session get` shows `permissions: auto`. |
| `bypass-permissions`, fallback off | Spawn failed with the managed-requirement message surfaced in `SPAWN_DELIVER_PROMPT_FAILED`; no retry. |
| `default` | No override sent, turn completed, no step-down, no `sandbox_mode` error. |
| `auto` | Turn completed, no step-down. |
| TUI flags | `codex` accepted the `auto`, `bypass` and no-flag launches; bypass printed the `approval_policy … falling back` warning. |

Unit tests: launch-flag mapping (`pkg/agentruntime`, `adapters/agent/codex`), chat
wire payloads and rejection classification (`codexappserver`), step-down per rung, no
step-down on unrelated errors, no escalation, all-fail, disabled, launch-level and
concurrent-choice cases (`service/chat`), config merge and persistence
(`session_manager`), CLI flag and `session get` output, and the API field.
