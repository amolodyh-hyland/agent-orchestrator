# Multica member Public API client

`frontend/src/main/multica-public-api.ts` is a main-process-only connection API.
It uses the member `/api/v1` contract, separately from the legacy awareness
client and Plugin API. No renderer or preload IPC is registered.

Create a connection with a configured `MulticaServer`, a workspace UUID, the
existing `MulticaCredentials` instance, and `getConfiguredServer`. That callback
must return the current trusted server configuration. Task text and project
data never supply connection configuration. A changed server key or API origin
invalidates the connection before credentials are sent; an in-flight response
is also discarded if configuration changes.

Call `setToken` with a user-created scoped member PAT, `getState` for safe
connection metadata, and `clearToken` to remove it. There is no PAT issuance or
CLI-profile credential import. `mul_` syntax is checked locally; Multica verifies
scope grants, workspace binding and current membership on every request.

The credential store key contains a digest of the canonical API origin and
workspace UUID, under a separate Public API namespace. Awareness credentials
cannot be used accidentally. The existing credential service uses its protected
OS vault when available, and memory only otherwise. Settings, state DTOs and task
payloads do not contain the token. Tests inject a fake vault and scratch state
directories; they never open a real credential store.

Methods and scopes:

| Method | Scope | Result |
| --- | --- | --- |
| `listAgents`, `getAgent` | `agents:read` | Safe profile projection |
| `listRuntimes`, `getRuntime` | `runtimes:read` | Stable runtime IDs and coarse availability |
| `delegate` | `delegations:write` | Accepted delegation and current status |
| `listDelegations` | `delegations:read` | Caller-owned records; exact key/ID filters and cursor pagination |
| `getDelegation` | `delegations:read` | Authoritative status by delegation ID |
| `cancelDelegation` | `delegations:write` | Authoritative cancellation/completion outcome |

Responses are rebuilt from explicit fields. Configuration, environment, device
details and execution contents are discarded. Workspace IDs and requested
resource IDs must match. Secret-bearing strings in projected fields invalidate
the response. Delegation status includes `terminal`, opaque `revision`, and an
optional allow-listed `failure_reason`. Revisions are not sortable counters.
Callers must retain observed terminal outcomes; `unavailable` does not prove
execution ended. An empty reconciliation list does not authorize a new key.

`delegate` requires `delegationsEnabled: true`, a caller-supplied idempotency
key, the confirmed expected runtime ID and `confirmed: true`. These transport
guards supplement the [durable confirmation/intent coordinator](multica-delegation-coordinator.md). No
orchestrator, assignment event or project automation is wired to this client.
The server rollout flag remains independently disabled by default.

`cancelDelegation(id, true, revision?)` requires explicit cancellation. Pass the
unquoted revision from a prior status DTO for conditional cancellation, or `*`;
the client builds `If-Match`. Without a revision, cancellation is convergent.
`revision_conflict` requires reconciliation. Neither status nor cancellation is
blocked by AO's local admission guard, so accepted work can still be stopped.
Only the returned authoritative status proves the remote terminal outcome.

An optional `policy` callback receives only connection and target IDs. An absent
policy permits personal use; a configured callback must explicitly return true.
Errors and unknown decisions deny admission. Policy cannot bypass confirmation,
the local rollout guard, or Multica authorization.

Requests use a pinned origin, explicit path templates, bearer and workspace
headers, no cookies, and manual redirects. All redirects are refused. There is
no arbitrary URL, method, headers or request entry point. HTTPS is required for
public hosts using AO's existing configured-server validation rules. This
Multica contract has no server-instance identity endpoint: the configured origin
(and TLS for HTTPS), PAT workspace validation and returned workspace/resource
IDs establish the available identity boundary.

Results contain safe DTOs or stable failure codes. Remote problem details,
request IDs, raw exceptions and headers are never returned or logged. A server
with delegation operations disabled currently returns `not_found`; the client
preserves that ambiguity. `feature_disabled` is preserved if explicitly returned
by a compatible server. `runtime_binding_changed` requires a fresh preview and
confirmation upstream; the client never chooses a replacement runtime.

Calls are serialized per connection. A 429 pauses subsequent calls for the
server's `Retry-After` interval (seconds or HTTP date), capped at 60 seconds by
`MAX_RETRY_AFTER_MS`. This bounds the effect of an excessive server delay on
status reconciliation and explicit cancellation. Calls during that interval
return `rate_limited` and the remaining delay. Invalid/missing headers use five
seconds. There are no automatic
write retries. After ambiguous submission, callers retain the same key and
payload. Timeouts, malformed/oversized responses and redirect failures do not
prove a write failed to reach Multica.

The canonical contract is Multica commit `a6a415a2b`,
`server/pkg/publicapi/v1/{routes.go,openapi.yaml,types.go,delegations.go}`.
Safe DTOs and parsers live in `frontend/src/main/multica-public-api-model.ts`;
mock-server coverage lives in `frontend/src/main/multica-public-api.test.ts`.

Validation from `frontend/`:

```sh
npm run typecheck
npm test -- src/main/multica
```
