# Multica delegation v1 contract verification

`test/contracts/multica-delegation-v1.json` is the versioned shared fixture. Its
identical peer is `server/pkg/publicapi/v1/testdata/multica-delegation-v1.json` in
Multica. Update both copies together when the public contract changes. The fixture
covers profile discovery, confirmed submission, exact idempotent retry, lookup and
status reconciliation, policy denial and explicit cancellation. It fixes the safe
DTO fields, source payload, Unicode brief, scoped request key, queue/terminal
semantics, opaque revisions, methods and operation scopes.

Run from AO's `frontend/` (no Multica service or Docker):

```sh
npm ci --ignore-scripts
MULTICA_CONTRACT_FIXTURE=/absolute/path/to/multica/server/pkg/publicapi/v1/testdata/multica-delegation-v1.json \
  npm test -- src/main/multica-delegation-contract.test.ts
npm test -- src/main/multica-delegation-desktop.test.ts src/main/multica-delegation-integration.test.ts
```

The first suite uses the production Public API client and shared confirmation flow
with an injected transport and journal. It verifies exact headers/payloads, no
write before native approval, durable intent before send, lost-response recovery,
identical retry keys, terminal monotonicity and policy denial before any POST.
Retry uses another preview and native approval; the journal mock returns the
existing durable request instead of inserting a second one.
Both task and project processing remain read-only without live approval. The
integration suite additionally builds a test-only Go journal with temporary SQLite
data and ephemeral loopback HTTP fixtures; it never uses an installed daemon,
Keychain or a running Multica instance. Its desktop cancellation cases invalidate
approval during the final credential lookup and assert zero cancel POSTs.
The task/project retry cases recreate the desktop, restore the saved rollout
preference, reject replaying the consumed preview, and require fresh native
approval. The real SQLite journal returns the original request ID and the retry
sends the identical payload/key. Declining the new approval sends nothing.

Run from Multica's `server/` (no database or network service):

```sh
AO_CONTRACT_FIXTURE=/absolute/path/to/agent-orchestrator/test/contracts/multica-delegation-v1.json \
  go test ./pkg/publicapi/v1 ./internal/middleware ./internal/featureflags
```

Multica verifies the identical fixture against its production wire DTOs, operation
ledger, request hashing, state/revision projection and scope middleware. The local
managed-policy decision belongs to AO and must emit zero HTTP writes; the server
independently enforces member scopes. These offline checks do not replace the
transaction and authorization tests that require PostgreSQL.

For the optional database-backed pass, use only a separately provisioned, migrated
throwaway PostgreSQL database owned by the test operator. No running Multica HTTP
server is needed. Do not use an existing application database. From Multica's
`server/`, explicitly supply its connection string:

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/THROWAWAY_DB?sslmode=disable' \
  MULTICA_RUN_DELEGATION_CONTRACT=1 \
  go test ./internal/handler -run '^TestDelegationSharedContractHandlers$' -count=1 -v
```

This opt-in pass drives real profile/admission/lookup/status/cancel handlers and
transactional storage, checks same-key replay and changed-payload conflict, denies
unauthorized writes, checks cancellation revision/terminal races and asserts one
admission and one execution. The package's existing test setup requires a reachable
migrated database; a “Skipping tests” message from that setup is not a pass of the
contract scenarios. No migration is introduced by this work.

## Specialist text result v1 (WI-FAC-08)

`test/contracts/multica-delegation-result-v1.json` is byte-identical to Multica's
`server/pkg/publicapi/v1/testdata/multica-delegation-result-v1.json`. Set
`MULTICA_RESULT_CONTRACT_FIXTURE` for the frontend result suite and
`AO_RESULT_CONTRACT_FIXTURE` for Multica's contract suite to check the pair.
The separate member `GET /api/v1/delegations/{id}/result` operation requires
`delegations:results:read`, requester/workspace authorization and an exact terminal
status revision in `If-Match`. `X-Result-Revision` pins an answer on import.
The existing status DTO is unchanged. V1 contains at most 32768 UTF-8 text bytes,
producer/task/delegation/workspace identities, terminal revision/time, SHA-256,
byte count and a snapshot revision. Snapshot revision hashes compact JSON in the
published DTO field order with an empty revision field and Go JSON escaping.
The client and ledger validate the bytes and both digests independently.

In **Run evidence**, enter a run bound to the selected delegation and choose
**Preview specialist result scope**. The metadata preview reads no result body.
A trusted click and native approval permit retrieval into a plain-text preview.
A second trusted click and native approval permit copying that exact text into
local run evidence. Copy re-reads the result with the pinned revision and current
PAT, rechecks policy, connection, run version and digest, then appends an immutable
receipt. Cancellation, expiry, changed bindings or revoked credentials require a
fresh preview. The source journal, not renderer input, selects the delegation.

Result-read and result-import request `task_result` with `result_read` and
`result_import` respectively. Existing brief-only managed policies deny both.
Unsupported or malformed managed-policy responses fail closed. Personal absence
remains supported. Runtime class stays unknown unless independently resolved;
managed policies therefore cannot silently infer local execution.

The preview and receipt label every answer as untrusted, including prompt
injection. Only text is rendered; no Markdown, links, attachments, shell commands,
continuation or execution actions are interpreted. The flow never sends a session
turn. Each later continuation still needs its own human approval. No file,
history, repository, branch or remote-upload operation is provided. Recognizable
credentials, paths, URLs and control data are refused; arbitrary prose still
requires human review for confidentiality. No raw result enters operational logs.
