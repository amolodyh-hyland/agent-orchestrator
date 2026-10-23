# Selected-project cockpit

Open **Project cockpit** in the desktop sidebar and select projects. Selection
uses immutable local Project IDs and is stored only in the desktop's local
preference `ao.cockpit.project-ids`. It is a human observation preference, not
factory enrollment, execution consent, information-export consent or a request
to start a coordinator.

The view reads the existing project/session lists and each selected project's
report listing. A missing coordinator or a failed report read does not hide
other projects. A renamed project keeps its selection; an archived or removed
project retains its selected ID with an unavailable message and no new report
reads. Deselecting it removes its visible facts. Project boards are the source
navigation targets, carrying `observation=true` in the URL to suppress shell
readiness checks and model-catalog warming, including after reload. The cockpit
also suppresses those checks on focus. Session surfaces can resume execution on mount, so the
cockpit does not link directly to them. Report bodies and output references
remain plain text; they cannot provide navigation or actions.

Each session's source update time and each report's recorded time are separate
from the successful read's observation time. Ages update while the view is
open. Coordinator facts older than 15 minutes, no-signal/exited observations,
missing timestamps and unavailable status readiness are explicitly stale or
unknown; this threshold is a presentation rule, not proof of process death.
Read failures retain previous facts with an explicit stale warning. Report
states, including `done`, remain claims. Verified run evidence and native
acceptance/settlement receipts are unavailable pending their owning work.

## Read boundary

Desktop workspace reads use `GET /api/v1/sessions?readOnly=true`. This additive
query option projects current session facts and artifact listings without the
legacy artifact-metadata repair callback. Existing callers that omit the
option keep their previous behavior. Project and report GETs already perform
fact reads. Selection, refresh, board navigation and reopening the cockpit
claim/acknowledge no reports, write no coordination state and invoke no
ensure/restore/spawn/send path. No schema migration is needed.

The aggregate view exists only in the supervisor renderer. There is no new
aggregate daemon endpoint, command, session role, conversational input or
project-session integration. This does not introduce authentication or process
isolation for the existing loopback API; that boundary belongs to later work.

## Implementation and verification

- `ProjectCockpit.tsx` and `_shell.cockpit.tsx`: selection, read queries and view.
- `Sidebar.tsx` and `ShellTopbar.tsx`: desktop navigation and orientation.
- `useWorkspaceQuery.ts`: shared desktop read-only session request.
- `_shell.tsx` and `useDaemonStatus.ts`: observation navigation and suppression
  of lifecycle/readiness warming on mount, focus and reload.
- `service/session/service.go`: optional read-only projection; controller DTO,
  query parsing and generated API types describe the same option.
- `ProjectCockpit.test.tsx`: two-project allowlist, claims, timestamps,
  missing/stale coordinators, inert content, partial failures, refresh,
  rename/archive, removal and remount checks with mutation assertions.
- `observation_test.go` and `session_observation_test.go`: read-only projection
  and query validation. Existing report tests cover read ordering and API shape.
