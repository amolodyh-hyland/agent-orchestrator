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
Both task and project processing remain read-only without live approval. The
integration suite additionally builds a test-only Go journal with temporary SQLite
data and ephemeral loopback HTTP fixtures; it never uses an installed daemon,
Keychain or a running Multica instance. Its desktop cancellation cases invalidate
approval during the final credential lookup and assert zero cancel POSTs.

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
