# Extra agent asset sources

Settings → General → Extra agent asset sources supplies live, machine-local
directories to supported harnesses at launch. Project Settings → General can
override the list for workers and orchestrators, including restore and switching.

Use a directory containing `.claude/` and/or `.agents/`, or those folders
directly. Absolute paths are recommended. Relative paths resolve against the
registered project's source directory. Missing, unreadable, or non-directory
sources produce daemon warnings and are skipped. Relative sources without a
project root are skipped.

Project `agentAssetSources` has replacement semantics: unset or `null` inherits
global defaults, `[]` disables extras, and a list replaces the global list.
Changes apply on the next provider launch, including restore. Reconnecting to a
surviving provider does not change its configuration. The workspace's own assets
remain discoverable under native precedence and trust rules.

## Native support

| Asset | Claude Code Terminal / Chat | Codex Terminal | Codex Chat |
|---|---|---|---|
| Instructions / rules | CLAUDE.md, .claude/rules, CLAUDE.local.md | Unsupported from extra paths | Unsupported from extra paths |
| Skills | .claude/skills | Unsupported from extra paths | .agents/skills |
| Commands | .claude/commands | Unsupported | Unsupported |
| Agents | .claude/agents | No extra Claude agent-directory loader | No extra Claude agent-directory loader |
| Settings | enabledPlugins / extraKnownMarketplaces only | Unsupported from extra paths | Unsupported from extra paths |

Other harnesses do not consume this setting. Unsupported assets are not copied,
converted, or injected into instructions.

Claude receives repeated `--add-dir` roots and
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. Chat passes roots through ACP's
native additional-directories capability to the Claude SDK. Skills, commands,
and agents require the `project` setting source; local instructions also require
`local`. Only skills support live reload; commands and agents need a new launch.
`permissions.additionalDirectories` in settings grants access without discovery.

Codex Chat uses its session-owned app-server's `skills/extraRoots/set` method.
A provider without that method reports a clear launch error. Codex `--add-dir`
grants write access rather than promising asset discovery; `skills.config`
enables/disables already-discovered skills. Neither registers extra roots.
`model_instructions_file` replaces built-in instructions and is not used here.

Native permissions can allow edits to the live source files. Sessions using the
source observe those edits according to their harness's reload behavior. Managed
policy, native permissions, plugin allowlists, and skill execution restrictions
continue to apply. AO does not bypass them.

For a direct `.claude` source, Claude receives its parent as the added root.
Native file access therefore covers the entire parent directory, not only the
asset folder. Use a dedicated asset root when that access would be too broad.

This feature does not change workspace asset folders, Git indexes, excludes, or
worktree config. It creates no symlinks or source copies, so workspace removal
requires no extra source cleanup.

## CLI and API

```sh
ao settings get
ao settings agent-asset-sources --source /path/to/live-workspace
ao settings agent-asset-sources --source /path/to/live-workspace/.claude --source /path/to/live-workspace/.agents
ao settings agent-asset-sources --clear
```

`project set-config` field flags preserve unnamed saved fields. `--config-json`
replaces the **entire** project config; preserve other fields when using these examples:

```sh
ao project set-config my-project --config-json '{"agentAssetSources":["/path/to/live-workspace"]}'
ao project set-config my-project --config-json '{"agentAssetSources":[]}'
ao project set-config my-project --config-json '{"agentAssetSources":null}'
```

`GET /api/v1/settings` includes `agentAssetSources`.
`PATCH /api/v1/settings/agent-asset-sources` accepts
`{"agentAssetSources":["/path/to/live-workspace"]}`; `[]` clears global defaults.
Project configuration uses the existing project settings/config endpoints.

References: [Claude added-directory behavior](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration),
[Codex skills](https://learn.chatgpt.com/docs/build-skills),
[Codex config](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex extra-root tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/host_skills.rs).
