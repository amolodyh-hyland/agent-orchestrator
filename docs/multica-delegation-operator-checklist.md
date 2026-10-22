# Confirmed Multica delegation: operator checklist

Delegation starts disabled on every desktop launch. In Settings → Multica, enable
**Confirmed delegation** and approve the native dialog for the current desktop
session. Each task/project handoff still needs its own preview and native approval.
There is no unattended mode, CLI enablement, factory enablement or pilot.
Disabling the setting revokes pending handoffs and cancellation approvals; it does
not cancel accepted work. Status reads and explicitly confirmed cancellation remain
available while admission is disabled.

- **Credentials:** Select the intended server and workspace. Supply a workspace-bound
  member PAT with `agents:read`, `runtimes:read`, `delegations:read` and
  `delegations:write`. Plugin credentials are unsuitable. The currently supported
  member surface uses PATs; do not assume OAuth support from the broader credential
  vocabulary. Keep the token out of task briefs, screenshots and logs. Verify both
  the AO setting and Multica's independently managed `public_delegations_v1` flag;
  AO cannot enable the server flag.
- **Permissions:** Verify the selected profile is visible, invocable, unarchived and
  bound to the displayed ready runtime. Workspace administration alone does not
  permit invoking another owner's private profile. Managed policy denial or an
  unavailable/unknown policy blocks submission. An empty policy configuration is
  supported for personal use.
- **Remote runtime:** Verify the runtime supports `public-delegation-v1`, and that
  execution location, credentials and data handling are permitted. Do not infer
  compatibility from availability. Review the exact destination, runtime, title,
  brief and task identifiers. Only the displayed task brief and identifiers leave
  AO; files, roots and history require a separate supported sharing contract.
- **Unknown response:** Preserve the original request ID. Refresh status so AO looks
  up the original scoped idempotency key, then the accepted delegation ID. Do not
  create a rerun merely because a response was lost. Background processing and
  restart recovery only reconcile; another admission send requires a fresh live
  preview/approval and reuses the existing request ID for the same intent. An
  ambiguous lookup stays unknown. Reauthenticate the same binding if prompted.
  Queue acceptance does not reserve a runtime execution slot.
- **Cancellation:** Check the accepted remote delegation/task IDs and confirm the
  native cancellation dialog. Keep “cancellation requested” until Multica reports
  a terminal state. A completion race may legitimately finish as completed or
  failed. A lost response does not prove cancellation; reconcile first. Another
  cancel send needs another native confirmation. Navigation, credential/server
  changes, disabling delegation or closing the desktop revoke pending approval,
  including during credential resolution. Reassignment and task/status changes do
  not imply cancellation.

See [coordinator boundaries](multica-delegation-coordinator.md) and
[contract verification](multica-delegation-contract.md).
