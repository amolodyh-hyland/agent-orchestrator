# Project context

Choose **Create a project without a repository** in Add Project to create a durable
context container. It opens the normal project board. Start a task there to use
its instructions and selected references in a session; no repository or Git
setup is required.

In project Settings → General → Project context, edit shared, worker, and
coordinator instructions. Link local files or folders using the native picker,
then save context. Each link shows its originating machine and whether it is
required. Removing a link detaches the reference; it does not delete the source.
Local links must be added from the application on the owning machine.
Switching Settings sections or closing Settings saves context edits first and
waits for pending link selection. Failed writes and conflicts keep the draft
open for review.

Links are not uploads. The owning daemon resolves files at session creation.
Supported text files become session snapshots. Directories stay references;
their contents are not enumerated or injected. Missing required references block
that session with a visible error. Missing optional references are recorded as
unavailable. Attachment availability in Settings is checked at session start,
not inferred from a cached path.

Context edits submit `expectedRevision`. If another edit advanced the project,
the draft remains visible. Reload discards the draft; Merge combines changed
instruction text and reference edits for review. Save again after reviewing the
merged draft. A conflict never retries a write automatically.

Open **Context at session start** in the session inspector to read the pinned
manifest, including project revision, instruction text, source machines,
availability, digests, byte counts, and materialized text. Later project edits,
source changes, and detachments do not change that manifest. Older sessions
without a recorded manifest are identified explicitly.
While a session starts, an open inspector retries a missing snapshot. Session
lifecycle events also refresh missing snapshots; populated manifests stay cached.

The read-only `GET /api/v1/sessions/{sessionId}/project-context` endpoint returns
`{ "manifest": null }` for a visible session without a snapshot. It reads stored
session context and does not resolve the current project or source files.
