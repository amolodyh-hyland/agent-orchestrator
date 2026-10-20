# Claude Code authentication and model discovery

The daemon owns local harness authentication. Electron imports the login-shell
environment (`frontend/src/shared/shell-env.ts`, `frontend/src/main.ts`) and
passes it to the daemon. Electron's `provider-auth-flow.ts` and `cloud-auth.ts`
implement a separate, user-initiated Cloud connection; they do not discover
existing local enterprise logins for Settings.

## Native status

`backend/internal/adapters/agent/claudecode/auth.go` invokes the resolved binary's
`auth status --json` in the launch directory and environment, with a three-second
timeout. It parses declared status/account fields and never forwards raw command
output. A reported login is `configured`, not proof of live provider access.
Settings shows the sign-in alongside that qualification, with organization and
plan when supplied. Those fields alone do not establish that SSO was used.

Native status covers claude.ai enterprise accounts, saved Console keys, Console
OAuth profiles, federation, `apiKeyHelper`, environment keys/tokens, corporate
gateway sessions and cloud providers, without requiring AO to extract secrets.
Future auth methods with `loggedIn: true` also remain recognizable. Explicit
sign-out for the selected provider disables stored-credential fallback, including
ambient environment keys, whether or not `authMethod` is supplied. Unrecognized or unavailable CLI
status retains the legacy fallback and is not proof of sign-out.

## Optional account model listing

`backend/pkg/agentcreds/resolve.go` retains legacy discovery for an account model
list when a compatible credential is available. Its precedence is
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, then stored
login. On macOS, `keychain.go` tries fixed services `Claude Code-credentials`
(OAuth JSON or bare OAuth token) and `Claude Code` (managed key/setup token), then
falls through to `$CLAUDE_CONFIG_DIR/.credentials.json` or
`~/.claude/.credentials.json`. The file parser accepts nested
`claudeAiOauth.accessToken` or flat `accessToken`, expiry and refresh-token
presence. AO never refreshes native tokens.

These legacy readers do not reproduce profile/federation stores, helper
execution, config-directory-specific Keychain names, gateway SSO tokens, or cloud
credential chains. Native status handles their login state. Opaque auth methods
skip unrelated legacy secrets. Known methods filter incompatible credential
classes, and explicit config-directory overrides skip the unscoped Keychain
services. Legacy listing failures do not reject a CLI-reported login.

`claude_settings.go` merges allowlisted user, project and project-local settings,
then explicit launch environment. It does not execute helpers. A configured
`ANTHROPIC_BASE_URL` selects a compatible gateway; Bedrock, Vertex and Foundry
flags are recognized without sending their credentials to Anthropic. AO does not
directly implement those cloud providers' model-list authentication.

`providers.go` requests `GET {base}/v1/models?limit=1000`, using
`https://api.anthropic.com` unless a gateway is configured, and paginates results.
Requests set `anthropic-version: 2023-06-01`. API keys use `x-api-key`; auth tokens
use `Authorization: Bearer`; OAuth also sets
`anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `x-app: cli` and the existing
`user-agent: claude-code/2.1.220`. First-party results are filtered to Claude IDs;
gateway IDs are preserved. Provider labels and effort capabilities take priority.

## Alias fallback and caching

`backend/internal/adapters/agent/modelcatalog/catalog.go` supplies the built-in
CLI alias table when listing fails or returns no usable models. Every choice is
labelled **built-in alias; availability unverified**, with source `built-in`.
The service prefers a matching cached provider list, marks failed discovery stale,
retains warnings/retries, and permits manual entry. Aliases are CLI selectors,
not account entitlements or provider-native model IDs. Native account,
organization, sign-in state and config directory are hashed into catalog identity
so an account switch invalidates the old provider list.

The pre-existing static alias fallback for spawn effort validation did not
populate an empty model picker.

## Model restrictions

Both provider choices and built-in aliases are filtered after adding a configured
default. `agentcreds/claude_model_policy.go` reads user/project/local lists and
cached remote, OS-managed and file-managed settings. Managed allowlists replace
lower scopes; unmanaged lists union. Explicit empty lists block named choices.
Managed source priority and opt-in merging, family/version/snapshot entries,
managed deny/exact rules, alias pins, provider IDs, model overrides and disabling
1M context are included in the effective policy and catalog cache fingerprint.
Policy changes therefore prevent reuse of an old provider catalog. The Default
option remains the CLI's responsibility; the picker does not assert its model.

Windows policy reads in `claude_model_policy_registry_windows.go` use the registry
API with read-only access. Missing keys or values are recognized by error code,
independent of Windows display language; access failures remain unresolved policy.
Discovery does not invoke `reg query`.

Discovery never executes `policyHelper` or fetches remote policy. Dynamic,
unreadable or ambiguous policy withholds named choices with a warning. Cached
remote policy and organization entitlements may lag server changes; built-in
aliases continue to carry the availability-unverified label. Claude Code remains
the authority that enforces policy when a session starts.

## Evidence and tests

Claude Code 2.1.304 was identified with `--version`; its help documents the status
interface. The exact credential used in a particular incident cannot be inferred
from help/docs alone. No real status, login, credential-file or Keychain operation
is needed for regression verification. Tests use fake CLI reports, injected
resolution, temporary credential fixtures and local HTTP servers, including
secret omission, account switches, provider results and cached/fallback models.

Official references: [authentication](https://code.claude.com/docs/en/authentication),
[CLI status contract](https://code.claude.com/docs/en/cli-reference),
[settings precedence](https://code.claude.com/docs/en/settings), and
[corporate gateway](https://code.claude.com/docs/en/claude-apps-gateway),
[model restrictions](https://code.claude.com/docs/en/model-config), and
[managed sources](https://code.claude.com/docs/en/managed-settings).
