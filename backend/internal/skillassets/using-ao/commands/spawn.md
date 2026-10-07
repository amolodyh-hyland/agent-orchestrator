# ao spawn

Spawn a worker or orchestrator agent session in a registered project, or a standalone worker session that is not tied to a project.
Standalone sessions run in an AO-managed directory. Register a project first with `ao project add` for project-scoped sessions.

## Syntax

```
ao spawn [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--branch string` | Branch for the session worktree | `ao/<session-id>/root` |
| `--claim-pr string` | Claim an existing PR for authorized implementation continuation. Omit for review-only work | - |
| `--effort string` | Per-session reasoning effort override; supported values depend on harness and model | - |
| `--kind string` | Session role: `worker` or `orchestrator` | `worker` |
| `--harness string` | Agent harness to use (see list below) | Project `worker.agent`; required if the project has none |
| `--issue string` | Issue id to associate with the session | - |
| `--model string` | Agent model override for this session only; overrides project/role config | - |
| `--name string` | Display name shown in the sidebar (max 100 characters) | Required |
| `--mode chat\|tui` | Initial session interface; Chat requires harness support | Daemon default, otherwise Terminal UI |
| `--output artifact` | Ask the worker for a file in its artifact directory instead of a PR | Ordinary task |
| `--no-takeover` | Refuse if another active session owns the claimed PR (requires `--claim-pr`) | - |
| `--project string` | Project id to spawn the session in | Optional when `--standalone` is used; defaults to `AO_PROJECT_ID` or the current repo's registered project |
| `--standalone` | Spawn a projectless worker session in an AO-managed directory | Disabled when `--project` is set |
| `--prompt string` | Initial prompt for the agent | - |
| `--skip-agent-check` | Skip CLI readiness warnings; the daemon still validates launch readiness | - |
| `--tracker-provider string` | Issue tracker provider: `github` or `gitlab` | `github` |

`--agent` is an alias for `--harness`.

`--model` and `--effort` override project/role config for this session only and do not change it.
Claude Code and Codex use the model's supported effort list (for example, Codex
`gpt-6-luna` lists `low`, `medium`, `high`, `xhigh`, and `max`; Sol models also
list `ultra`); Copilot supports `low`, `medium`, `high`, `xhigh`, and `max`;
Command Code has no per-model effort catalog, so AO forwards the level as given
and `cmd --effort` rejects an unknown value at launch.
Effort is passed at launch as Claude Code `--effort <level>`, Codex
`-c model_reasoning_effort=<level>`, Command Code `--effort <level>`, or Copilot
`--reasoning-effort <level>`.
When a Claude Code spawn has an explicit `--model` or `--effort`, or a Codex
Chat spawn has an explicit `--effort`, validation uses the provider model
catalog. If a Codex catalog cannot be refreshed, spawn fails with
`MODEL_CAPABILITIES_UNAVAILABLE`; a Codex terminal (TUI) spawn only refines its
launch with the catalog and leaves an unlisted level to the Codex CLI. If a Claude Code catalog is stale (for
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
harnesses (`claude-code`, `codex`, `command-code`, `copilot`). An unsupported level also fails
with `UNSUPPORTED_EFFORT`; the error names the model, or the harness for
Copilot, and lists supported levels. Inherited effort is dropped for any
harness that cannot apply it. Empty `--effort ""` is a
usage error (exit 2).
`ao session get` shows resolved `model` and `effort` values in its table and
JSON output. When a session has no resolved model or effort, the `model:` and
`effort:` table rows and the `model` and `effort` JSON properties are omitted;
their absence means the agent's default.

Available harnesses: `claude-code`, `codex`, `aider`, `opencode`, `opencode-v2`, `grok`, `droid`, `amp`, `agy`, `crush`, `cursor`, `qwen`, `gemini`, `copilot`, `goose`, `auggie`, `continue`, `devin`, `cline`, `kimi`, `muse`, `kiro`, `kilocode`, `vibe`, `pi`, `kimchi`, `prime-agent`, `autohand`, `omp`, `fx`, `unreal-agent`, `mimo-code`, `deepseek-harness`, `openhands`, `command-code`. Check `ao agent ls --refresh` for readiness on the installed build. `unreal-agent` is Chat-only; Gemini, MiMo Code, and OpenHands are Terminal UI-only.

`fx` is experimental and Terminal UI only: spawn it with `--agent fx --mode tui`.

`command-code` is Terminal UI only: spawn it with `--agent command-code --mode tui`.

## Examples

```bash
# Spawn a worker for issue 142 in the agent-orchestrator project
ao spawn --project agent-orchestrator --issue 142 --name "fix-session-leak" --prompt "Fix the session leak described in issue 142. Branch off upstream/main."
```

```bash
# Spawn a worker to continue implementation on an existing PR
ao spawn --project agent-orchestrator --name "continue-pr-88" --claim-pr 88 --prompt "Continue implementation on PR 88."
```

```bash
# Spawn a normal worker to review someone else's PR without taking ownership
ao spawn --project agent-orchestrator --name "review-pr-88" --prompt "Review PR 88 and submit only the requested provider review. Do not claim or attach the PR."
```

```bash
# Spawn an orchestrator using the project's orchestrator configuration
ao spawn --project agent-orchestrator --kind orchestrator --name "coordinate-fix" \
  --prompt "Coordinate the fix and report the worker PR."
```

```bash
# Spawn a standalone worker whose deliverable is an artifact file, not a PR
ao spawn --standalone --agent claude-code --output artifact --name "q3-report" \
  --prompt "Write a one-page summary of Q3 incidents."
```

```bash
# Associate a GitLab issue with a worker
ao spawn --project my-gitlab-app --issue 42 --tracker-provider gitlab \
  --name "fix-issue-42" --prompt "Fix GitLab issue 42."
```

```bash
ao spawn --name "fix flaky test" --harness codex --model gpt-6-luna --effort xhigh --prompt "..."
```
