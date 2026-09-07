# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell aliases are hidden. |
| `ultra` | Recommended DevSpace Ultra production surface. Exposes the full legacy workspace/search set **and** the Codex aliases `apply_patch`, `exec_command`, and `write_stdin`, so cached ChatGPT schemas and Codex-style agents remain compatible during migration. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
`codex` and `ultra` must be selected through `DEVSPACE_TOOL_MODE` or the persisted
`toolMode` config key. Both use fixed Codex alias names regardless of
`DEVSPACE_TOOL_NAMING`; `ultra` keeps the legacy names available but agents must
not execute the same operation through two aliases.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `off` | Default. Disables DevSpace widget UI, preventing per-tool iframe cards such as `Ran command`. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI only to `open_workspace` and `show_changes`. |
| `full` | Opt-in. Widget UI is attached to exposed workspace, file, edit, and shell tools. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Unified Agent Capability Plugins

DevSpace Ultra v0.3 adds a shared capability/plugin runtime. One installation is visible to the orchestrator and every worker MCP session connected to the same DevSpace backend.

Default storage:

```text
~/.devspace/plugins/
  registry.json
  packages/
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_PLUGINS` | `1` | Set to `0` to hide/disable the capability runtime. |
| `DEVSPACE_PLUGINS_DIR` | `~/.devspace/plugins` | Managed plugin package directory. |
| `DEVSPACE_CAPABILITY_REGISTRY` | `~/.devspace/plugins/registry.json` | Metadata-only registry file. |
| `DEVSPACE_PLUGIN_PATHS` | empty | Comma-separated operator-managed plugin roots. These paths are treated as explicitly trusted configuration and are never deleted by DevSpace. |

Persisted equivalents in `~/.devspace/config.json` are `pluginsEnabled`, `pluginsDir`, `capabilityRegistryPath`, and `pluginPaths`.

Managed downloads are separate from execution trust: `capability_install` defaults to disabled/untrusted, while `capability_enable(... trust=true)` explicitly permits executable MCP/command surfaces. Enabled + trusted plugin `SKILL.md` files join normal workspace skill discovery automatically. Shared MCP services are backend-pooled; stateful stdio MCPs can use `capability_instance` for separate exclusive instances with ephemeral per-project environment values such as a Blender bridge port. See [Unified Agent Capability Runtime](capability-runtime.md).

## ChatGPT Classic Main safety — v0.5

User-facing ChatGPT Classic Main runtimes have three separate Chat-mode safety/continuity layers enabled by default:

| Variable | Default | Persisted config key | Purpose |
| --- | --- | --- | --- |
| `DEVSPACE_CLASSIC_STREAM_RECOVERY` | `1` | `classicStreamRecoveryEnabled` | Repair a stale foreground renderer only after a matching active-conversation `stream_status` transport failure and authoritative server `COMPLETE`. |
| `DEVSPACE_CONTEXT_GUARDIAN` | `1` | `contextGuardianEnabled` | Enable native-model-aware Main context accounting, prospective safety guard, selective compact checkpoints, and authorized user-turn/hidden-Goal continuation when required. Background polling only prepares or arms the next authorized request; it never sends a synthetic visible user message or reloads/navigates ChatGPT. |
| `DEVSPACE_CLASSIC_HOST_OVERLAY` | `1` | `classicHostOverlayEnabled` | Project the backend-authoritative Goal directly above the owning Classic Chat composer and the current Plan as a compact top-right HUD. The projection reuses Context Guardian CDP sessions and is bound to the exact owner conversation. |

All three features support **Chat mode only**. Stream Recovery never reloads merely because a model is slow: normal renderer progress cancels recovery, the same conversation must remain active, server status must be `COMPLETE`, and recovery is one-shot/cooldown protected. Context Guardian uses the active Classic-native model window plus the strongest explicitly labelled host/snapshot/ledger pressure signal rather than a fixed global ceiling. At rollover pressure it creates a bounded selective capsule and arms either the next real user request or an already-authorized hidden Goal continuation. ChatGPT may assign a new backend conversation ID, but UI continuity is accepted only after source/carry/target reduction, hidden capsule markers, Goal/Plan frontier, native authority, progress narration, and Host Overlay transfer all verify. Exact token fields remain unavailable rather than falling back silently. Host Overlay is a projection only: GoalRuntime and PlanRuntime remain the sole state authorities. It persists only a bounded `goalId + runtimeKey + conversationId` owner pointer, hides on other chats/Main runtimes, and transfers that pointer only after a verified rollover. The original transcript MCP Apps remain compatible fallback/control surfaces.

For the complete trigger rules, privacy boundaries, Main-vs-Worker split, rollover behavior, and verification commands, see [ChatGPT Classic Chat Safety](classic-chat-safety.md).

## Automatic Conversation Continuity

DevSpace Ultra v0.3.1 can automatically rotate managed Windows ChatGPT Classic workers into fresh backend conversations before the configured context budget is exhausted. DevSpace Ultra v0.5 adds the separate Main selective-continuation path described above; both reuse the same capsule store and built-in `devspace-auto-compact` capability, but only the Main path transfers Goal/Plan/Host Overlay authority.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_AUTO_COMPACT` | `0` unless enabled in config | Enable the managed Classic watchdog/continuation runtime. |
| `DEVSPACE_AUTO_COMPACT_THRESHOLD` | `0.90` | Estimated utilization at which compaction becomes required. |
| `DEVSPACE_AUTO_COMPACT_CONTEXT_TOKENS` | `1050000` | Configured model context budget used by the local estimator. |
| `DEVSPACE_AUTO_COMPACT_RESERVE_TOKENS` | `32000` | Hidden/system/tool overhead counted as estimated already-consumed context. |
| `DEVSPACE_AUTO_COMPACT_POLL_SECONDS` | `15` | Managed-runtime watchdog interval. |
| `DEVSPACE_AUTO_COMPACT_RESUME_TIMEOUT_SECONDS` | `150` | Maximum wait for the fresh conversation to redeem its one-time continuation ticket. |

Persisted equivalents are `autoCompactEnabled`, `autoCompactThreshold`, `autoCompactContextWindowTokens`, `autoCompactReserveTokens`, `autoCompactPollSeconds`, and `autoCompactResumeTimeoutSeconds` in `~/.devspace/config.json`.

The 90% threshold is applied to the full configured window. With the defaults the absolute trigger is `945000`; the reserve is added to estimated consumption rather than subtracted from the window before the percentage calculation. This trigger is deliberately reported as a conservative pressure estimate when ChatGPT exposes no exact native counter. It is not the acceptance proof: Main Auto Compact additionally requires a non-empty selective capsule, every available source/carry ratio below the configured limit, and a measurably smaller verified target mapping/branch/payload before authority moves. See [Automatic Conversation Continuity](conversation-continuity.md).

Windows runtime protection and Session Seed are controller state/policy rather than general DevSpace environment settings. See [Runtime Identity Safety](runtime-identity.md).

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `0` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_LOG_MAX_BYTES` | `8388608` (8 MiB per active file) |
| `DEVSPACE_LOG_BACKUPS` | `2` |
| `DEVSPACE_LOG_MAX_AGE_DAYS` | `7` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Core stdout/stderr use a backpressure-aware rotating writer. Each active log is capped by `DEVSPACE_LOG_MAX_BYTES`, only the configured number of generations is retained, and expired generations are removed. The writer does not keep an in-memory history of output. The fixed-backend launcher applies the same policy before each service start.

Full per-request and MCP session lifecycle logs are intentionally not written at normal `info` level. Set `DEVSPACE_LOG_REQUESTS=1` or `DEVSPACE_LOG_LEVEL=debug` only for a bounded diagnostic window. Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging and `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
