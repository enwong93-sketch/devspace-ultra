# DevSpace Ultra Unified Agent Capability Runtime

Status: **released in DevSpace Ultra v0.3.0** (2026-08-20). The current release gate includes deterministic runtime regression, Git-installed capability verification, dual stateful MCP isolation, Codex-plugin compatibility scanning, package/security inspection, the Codex native browser gate, and Chat Swarm regressions. The earlier custom Browser Control regression remains historical only.

## Goal

DevSpace Ultra already gives every connected agent the same backend for local workspace operations, Chat Swarm routing, and Codex-native Computer Use. The Unified Agent Capability Runtime extends that backend into a reusable plugin host.

The design target is:

```text
Main Agent / Orchestrator ─┐
Worker Agent 01 ───────────┤
Worker Agent 02 ───────────┤
Other MCP client ──────────┤
                           ▼
                 DevSpace Ultra backend
                           │
                  capability_* tools
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
      Agent Skills     MCP servers     Command tools
      Instructions     Remote MCP      Local adapters
          │                │                │
          └──────── Installed capability packages ────────┐
                                                          ▼
                                              ~/.devspace/plugins
```

All MCP sessions connected to the same DevSpace backend receive the same twelve `capability_*` control tools. A plugin is installed once and can then be discovered and reused by the orchestrator or any worker. The backend remains the single trust and lifecycle boundary. Shared/stateless MCPs reuse one backend connection; stateful app MCPs can claim isolated named instances with separate processes/endpoints.

## Local directories

Default user-level layout:

```text
~/.devspace/
  config.json
  auth.json
  skills/                     # existing direct DevSpace skills
  agents/                     # existing local agent profiles
  plugins/
    registry.json             # metadata only; mode 0600
    packages/
      <plugin-id>/             # managed installed packages
```

Additional read-only/operator-managed plugin roots can be supplied with `DEVSPACE_PLUGIN_PATHS` or `pluginPaths` in `~/.devspace/config.json`.

Project-local `.agents/skills` remains supported independently. An enabled + trusted plugin's `SKILL.md` files are added to normal DevSpace workspace skill discovery without copying them into the project.

## Supported package shapes

The scanner is intentionally multi-format rather than requiring every repository to be rewritten.

| Shape | Detection | Runtime behavior |
| --- | --- | --- |
| DevSpace universal plugin | `devspace-plugin.json` | Skills, instructions, MCP definitions, command tools |
| Agent Skills | Any bounded `SKILL.md` tree; common `skills/`, `.agents/skills/`, `.codex/skills/`, `.claude/skills/` layouts work | Surfaced through normal `open_workspace` skill discovery when enabled + trusted |
| Agent instructions | `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `GEMINI.md`, plus manifest-declared instruction files | Read progressively with `capability_read`; not injected blindly |
| MCP client config | `.mcp.json`, `mcp.json`, `.vscode/mcp.json`, manifest `mcpServers` / `mcp_servers` / `servers` | stdio, Streamable HTTP, legacy SSE |
| Official MCP Registry metadata | `server.json` | `remotes` supported; npm/PyPI/Docker stdio package metadata can be launched after trust; unsupported registry types are reported, never guessed |
| Claude-style plugin metadata | `.claude-plugin/plugin.json`, including nested plugin roots in a monorepo | Skills, command/agent markdown resources, hook metadata, explicit/default MCP configs; host-specific hooks are detected but not executed by DevSpace |
| Codex-style plugin metadata | `.codex-plugin/plugin.json`, including nested roots and bundled/curated/personal cache shapes | Preserves Skills, MCP configs, platform App dependencies, hook declarations, interface metadata, and bundled-content metadata. Skills/MCP are directly reusable; platform Apps and Codex lifecycle hooks remain explicit host dependencies rather than being silently emulated. |
| DevSpace command adapters | `tools` in `devspace-plugin.json` | Executed without a shell; JSON arguments are sent on stdin |

The scanner ignores `.git`, `node_modules`, virtual environments and Python cache folders and bounds traversal depth/file count.

## Universal manifest

The optional DevSpace-native manifest is `devspace-plugin.json`; its published JSON Schema is [`devspace-plugin.schema.json`](devspace-plugin.schema.json). Existing repositories do not need to adopt this manifest if their Skills/MCP/plugin files are already discoverable.

Example `devspace-plugin.json`:

```json
{
  "id": "memory-system",
  "name": "Memory System",
  "version": "1.0.0",
  "description": "Reusable memory for every DevSpace agent",
  "skills": ["skills"],
  "instructions": ["AGENTS.md"],
  "mcpServers": {
    "memory": {
      "command": "python",
      "args": ["-m", "memory_mcp"],
      "cwd": ".",
      "env": {
        "MEMORY_DB": "${MEMORY_DB:-./memory.db}"
      },
      "requiredEnv": []
    }
  },
  "tools": [
    {
      "name": "maintenance",
      "description": "Run a bounded plugin maintenance action",
      "command": "node",
      "args": ["tools/maintenance.mjs"],
      "cwd": ".",
      "input": "json-stdin",
      "inputSchema": {
        "type": "object",
        "properties": {
          "action": { "type": "string" }
        }
      },
      "timeoutMs": 60000
    }
  ]
}
```

This manifest is optional. A repository that already contains recognizable skills or MCP configuration can be installed and detected without it. The universal manifest is useful when a repository needs an explicit launch command or wants to expose a local CLI/script as an agent tool.

## Agent-facing tools

The backend registers these for **every MCP session**:

- `capability_list` — compact progressive-disclosure catalog (counts/names, not every full schema).
- `capability_search` — rank installed capabilities by plugin/skill/MCP/tool terms before loading details.
- `capability_inspect` — one plugin's full formats, skills, instructions, MCP servers, command tools, trust state, and optionally live MCP tool schemas.
- `capability_install` — clone a Git repository or copy a local directory into the managed store. It does **not** run package install hooks.
- `capability_enable` — enable a plugin; executable code requires explicit trust.
- `capability_disable` — stop live MCP clients and hide the plugin without deleting it.
- `capability_update` — fast-forward a managed Git install or move it to an explicit ref.
- `capability_uninstall` — remove only managed plugin directories.
- `capability_refresh` — rescan folders and optionally probe live MCP tools.
- `capability_read` — bounded, path-confined text read for plugin instructions/docs/skill references.
- `capability_instance` — claim/list/release an exclusive stateful stdio MCP instance with ephemeral per-instance environment overrides; useful for two Blender/IDE/game-engine projects using the same MCP type concurrently.
- `capability_call` — invoke a trusted MCP tool, read an MCP resource, retrieve an MCP prompt, or call a declared command adapter; pass `instanceToken` for a claimed stateful instance.

The stable generic `capability_call` is intentional: arbitrary installed MCP servers do not inflate every model turn with hundreds of native tool schemas. `capability_list` stays compact, `capability_search` narrows the catalog, and the agent loads complete schemas only for the selected plugin via `capability_inspect` before invoking it through the shared backend. MCP probing exposes server capabilities plus available tools, prompts, and concrete resources; calls use `kind=mcp`, `kind=mcp-prompt`, or `kind=mcp-resource` respectively.

### Codex plugin compatibility

DevSpace treats `.codex-plugin/plugin.json` as a first-class package shape. The current compatibility surface covers every manifest field observed across the local bundled, curated, remote-curated, personal, staging, archived, and source-tree Codex plugins: identity/version/description, author/homepage/repository/license/keywords metadata, `skills`, `mcpServers`, `apps`, `hooks`, `interface`, and `bundledContentVariant`. Declared paths are resolved inside the plugin root and nested Codex plugin roots are supported.

`apps` entries point at platform-managed OpenAI/ChatGPT app connectors. DevSpace preserves the app name/id dependency and exposes it during inspection/search, but a local backend does not impersonate that platform connector. Likewise Codex lifecycle hooks are preserved as host-hook metadata and are not auto-executed; automatic hook execution requires an equivalent trusted DevSpace lifecycle adapter. This distinction keeps manifest compatibility high without claiming behavior the local host cannot safely reproduce.

The repeatable `verify:capabilities:codex-live` gate scans every local `.codex-plugin/plugin.json`, fails on unknown manifest fields or missing declared component paths, and verifies that all declared portable components are discovered. On the 2026-08-20 development host the gate passed all 71 discovered Codex manifests.

## Trust model

Installing code and running code are separate actions.

1. `capability_install` downloads/copies files but defaults to `enabled=false`, `trusted=false`.
2. A plugin cannot execute MCP or command tools until it is trusted.
3. `capability_enable(... trust=true)` is the explicit execution trust boundary.
4. Plugin skills are also added to automatic workspace skill discovery only when the managed plugin is both enabled and trusted.
5. Disabling a plugin closes persistent MCP clients immediately.
6. Uninstall can delete only directories below `~/.devspace/plugins/packages`; configured external paths cannot be deleted by the runtime.

`DEVSPACE_PLUGIN_PATHS` is an operator configuration surface. Paths explicitly placed there are treated as operator-managed/trusted and are never copied or deleted by DevSpace.

## Secret handling

`registry.json` stores package identity, source, install path, enabled/trusted flags and timestamps. It does **not** cache MCP environment maps, header values, tool arguments or discovered tool responses.

Git HTTP install URLs containing embedded credentials are rejected instead of being persisted. Use the normal OS/Git credential helper.

For stdio MCP packages, required environment variable names can be declared without storing their values. For official MCP Registry remote definitions with URL variables or header descriptors, DevSpace derives deterministic environment-variable names:

```text
DEVSPACE_CAP_<PLUGIN>_<SERVER>_VAR_<VARIABLE>
DEVSPACE_CAP_<PLUGIN>_<SERVER>_HEADER_<HEADER>
```

`capability_inspect` returns the exact required environment names for the installed plugin.

## MCP behavior

### stdio

DevSpace uses the official MCP SDK client transport and starts the configured process without a shell. Working directories are confined to the plugin root. Only a conservative inherited environment plus explicitly configured values is passed; on Windows the minimal process environment also preserves `COMSPEC`, `PATHEXT`, and `WINDIR` because package managers such as `uv` may need them when launching Git/subprocesses. The shared MCP proxy supports tool calls as well as MCP prompt retrieval and resource reads. `connectTimeoutMs` (or compatible `startup_timeout_sec`) can extend cold-start time for large MCP packages.

### Streamable HTTP / SSE

Remote URL/header values may use `${ENV_VAR}` templates. Official MCP Registry `server.json` URL variables and header descriptors are mapped to the derived environment variables described above. Streamable HTTP is preferred; SSE remains a compatibility path.

### MCP package metadata

For trusted official `server.json` package entries, the first implementation supports:

- npm via `npx -y package@version`
- PyPI via `uvx package==version`
- Docker/OCI via `docker run --rm -i image:version`

If the required runtime is not installed, probing reports an error rather than modifying the machine. Other registry types remain metadata-only until an explicit adapter is implemented.

## Command adapter behavior

Declared command tools:

- use `spawn(..., shell=false)`;
- use a plugin-confined working directory;
- receive a single JSON object on stdin by default;
- have bounded stdout/stderr and execution timeout;
- return parsed JSON when stdout is valid JSON, otherwise text;
- never run npm/pip/postinstall hooks as a side effect of plugin installation.

## Multi-agent semantics

There is one `CapabilityRuntime` per DevSpace backend, not one per conversation. By default MCP clients are pooled by `pluginId + serverId` and can therefore be reused across Main Agent and Worker requests. This is the right behavior for shared services such as memory/search backends. Registry mutations issued through `capability_*` are serialized so two agents cannot concurrently corrupt install/enable/update/uninstall state.

Stateful application MCPs need a different rule. `capability_instance(action="claim")` adds an exclusive `instanceId` dimension, so the cache key becomes effectively `pluginId + serverId + instanceId`. Each claimed instance gets a private token, its own MCP process, and ephemeral environment overrides such as a project-specific port. Two agents therefore can run the same Blender MCP type against two different Blender projects without sharing process state. A second claim of the same instance ID is rejected until release/expiry. Cold-start of multiple instances of the same MCP template is serialized to avoid package-manager/cache races; after startup, the MCP processes and tool calls run independently.

Instance environment values are memory-only: list/status returns variable names, never values, and `registry.json` does not persist the instance token or environment overrides.

Example for two Blender projects using one Blender MCP template:

```text
Agent A: capability_instance(action="claim", pluginId="blender", serverId="blender", instanceId="project-a", env={BLENDER_MCP_HOST:"127.0.0.1", BLENDER_MCP_PORT:"9876"})
Agent B: capability_instance(action="claim", pluginId="blender", serverId="blender", instanceId="project-b", env={BLENDER_MCP_HOST:"127.0.0.1", BLENDER_MCP_PORT:"9877"})
       -> each receives a different private instanceToken
       -> capability_call(... instanceToken=<own token> ...)
       -> capability_instance(action="release", instanceToken=<own token>)
```

The local Blender gate uses Blender Lab MCP v1.0.0 and the installed Blender 5.1 add-on. That upstream tag declares `mcp[cli]>=1.2.0` while still using the pre-2.0 FastMCP import path, so the repeatable gate adds the compatibility solver constraint `mcp[cli]<2` without changing Blender MCP source or reducing its tool catalog. Both isolated instances must expose all 26 tools with identical full schemas, write different scene markers, and pass cross-project object/datablock isolation checks.

## Installation flow

A safe GitHub flow is:

```text
capability_install(source="https://github.com/ORG/REPO.git")
  -> capability_inspect(pluginId="...")
  -> review detected launch surfaces + required environment variables
  -> capability_enable(pluginId="...", trust=true)
  -> capability_refresh(pluginId="...", probeMcp=true)
  -> capability_call(...)
```

A plugin can be disabled without uninstalling it, which preserves its files for later reuse.

## Configuration

```text
DEVSPACE_PLUGINS=1
DEVSPACE_PLUGINS_DIR=~/.devspace/plugins
DEVSPACE_CAPABILITY_REGISTRY=~/.devspace/plugins/registry.json
DEVSPACE_PLUGIN_PATHS=/opt/company/agent-plugins,~/my-agent-plugins
```

Equivalent persisted keys:

```json
{
  "pluginsEnabled": true,
  "pluginsDir": "~/.devspace/plugins",
  "capabilityRegistryPath": "~/.devspace/plugins/registry.json",
  "pluginPaths": ["~/my-agent-plugins"]
}
```

## Verification gates

The deterministic test suite must cover at least:

- install without execution;
- explicit trust boundary;
- identical tool registration for two independent MCP sessions;
- enabled plugin skills entering normal skill discovery;
- path-confined resource reading;
- real stdio MCP `listTools` + `callTool` through the backend runtime;
- command tool JSON stdin/stdout;
- official MCP Registry `server.json` detection;
- no raw plugin secret values in `registry.json`;
- disable closes execution access;
- managed uninstall;
- Git source installation into an isolated temporary store;
- the Codex native browser gate + Chat Swarm regressions remain green.
