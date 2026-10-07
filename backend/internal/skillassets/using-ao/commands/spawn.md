# ao spawn

Spawn a worker agent session in a registered project, or a standalone workspace session that is not tied to a project.
Standalone sessions run in an AO-managed directory. Register a project first with `ao project add` for project-scoped sessions.

## Syntax

```
ao spawn [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--branch string` | Branch for the session worktree | `ao/<session-id>/root` |
| `--claim-pr string` | Immediately claim an existing PR for the spawned session | - |
| `--effort string` | Per-session reasoning effort override; supported values depend on harness and model | - |
| `--harness string` | Agent harness to use (see list below) | Project `worker.agent`; required if the project has none |
| `--issue string` | Issue id to associate with the session | - |
| `--model string` | Per-session model override | - |
| `--name string` | Display name shown in the sidebar (max 100 characters) | Required |
| `--no-takeover` | Refuse if another active session owns the claimed PR (requires `--claim-pr`) | - |
| `--project string` | Project id to spawn the session in | Optional when `--standalone` is used; defaults to `AO_PROJECT_ID` or the current repo's registered project |
| `--standalone` | Spawn a projectless worker session in an AO-managed directory | Disabled when `--project` is set |
| `--prompt string` | Initial prompt for the agent | - |

`--agent` is an alias for `--harness`.

`--model` and `--effort` override project/role config for this session only and do not change it.
Claude Code and Codex use the model's supported effort list (for example, Codex
`gpt-6-luna` lists `low`, `medium`, `high`, `xhigh`, and `max`; Sol models also
list `ultra`); Copilot supports `low`, `medium`, `high`, `xhigh`, and `max`.
Effort is passed at launch as Claude Code `--effort <level>`, Codex
`-c model_reasoning_effort=<level>`, or Copilot `--reasoning-effort <level>`.
When a Claude Code spawn has an explicit `--model` or `--effort`, or a Codex
spawn has an explicit `--effort`, validation uses the provider model catalog.
If a Codex catalog cannot be refreshed, spawn fails with
`MODEL_CAPABILITIES_UNAVAILABLE`. If a Claude Code catalog is stale (for
example, discovery finds no credential), validation falls back to a built-in
table of Claude's aliases: `sonnet`, `fable`, `opus`, and `opus[1m]` accept
`low`, `medium`, `high`, `xhigh`, and `max`, and `haiku` accepts no effort. The
model checked is the resolved one, including a project or role model, or the
default configured in the local Claude settings when none is set. The table
assumes the aliases resolve to Claude's first-party models; it is not used when
the catalog lists a configured custom or gateway model. In every other case
(any other `--model`, an effort with no model and no configured default, no
catalog service, or a failed discovery) spawn still fails with
`MODEL_CAPABILITIES_UNAVAILABLE`.
Explicit effort for a harness that cannot apply it fails with HTTP 400 / CLI
exit 1 (`UNSUPPORTED_EFFORT`); the error names the harness and lists supported
harnesses (`claude-code`, `codex`, `copilot`). An unsupported level also fails
with `UNSUPPORTED_EFFORT`; the error names the model, or the harness for
Copilot, and lists supported levels. Inherited effort is dropped for any
harness that cannot apply it, including Copilot. Empty `--effort ""` is a
usage error (exit 2).
`ao session get` shows resolved `model` and `effort` values in its table and
JSON output. When a session has no resolved model or effort, the `model:` and
`effort:` table rows and the `model` and `effort` JSON properties are omitted;
their absence means the agent's default.

Available harnesses: `claude-code`, `codex`, `aider`, `opencode`, `opencode-v2`, `grok`, `droid`, `amp`, `agy`, `crush`, `cursor`, `qwen`, `copilot`, `goose`, `auggie`, `continue`, `devin`, `cline`, `kimi`, `muse`, `kiro`, `kilocode`, `vibe`, `pi`, `kimchi`, `prime-agent`, `autohand`, `omp`, `fx`, `deepseek-harness`.

`fx` is experimental and Terminal UI only: spawn it with `--agent fx --mode tui`.

## Examples

```bash
# Spawn a worker for issue 142 in the agent-orchestrator project
ao spawn --project agent-orchestrator --issue 142 --name "fix-session-leak" --prompt "Fix the session leak described in issue 142. Branch off upstream/main."
```

```bash
# Spawn a worker and immediately claim an open PR
ao spawn --project agent-orchestrator --name "review-pr-88" --claim-pr 88 --harness claude-code
```

```bash
ao spawn --name "fix flaky test" --harness codex --model gpt-6-luna --effort xhigh --prompt "..."
```
