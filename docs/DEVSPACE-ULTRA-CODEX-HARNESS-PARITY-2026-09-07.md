# DevSpace Ultra v0.5 — Codex Harness Tool and Local Toolchain Parity Audit

> **Date:** 2026-09-07
> **Status:** P0 local-development tool substrate complete; wider host/runtime parity continues
> **DevSpace branch:** `v0.5-convergence`
> **Official comparison source:** a fresh shallow checkout of `https://github.com/openai/codex.git` under `~/.devspace/research/openai-codex-20260907`
> **Machine-readable gate:** `npm run verify:codex-parity:live`

## Scope and evidence rule

This audit compares the actual tool registrations in the current official open-source Codex checkout with DevSpace Ultra's real source and live local environment. The live gate records the exact official repository remote, commit hash, commit date and source path on every run. A remembered tool list, a UI label or a marketing feature name is not accepted as evidence.

Parity in this document means one of four explicit states:

- **Complete:** DevSpace exposes the same practical local-development capability and verifies it with executable tests.
- **Host-native:** ChatGPT already provides the capability outside the DevSpace MCP server; duplicating it would add risk without adding local capability.
- **Bridged:** DevSpace exposes the capability through the audited Capability Runtime or an exact compatibility alias.
- **Partial or missing:** the behavior is not yet equivalent and remains a named product task.

The audit deliberately does not call continuity rollover, a fresh conversation or a checkpoint restore "Auto Compact." True Auto Compact still requires a lower authoritative native context-usage value while preserving the same conversation ID.

## Official Codex tool contract observed

The current official Codex tool source contains the local-development contracts used as the comparison baseline, including:

```text
apply_patch
exec_command
write_stdin
update_plan
view_image
request_user_input
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
web_search
spawn_agent
send_input
wait
resume_agent
close_agent
js_repl
```

The exact set can change upstream. `scripts/codex-harness-parity-audit.mjs` therefore scans the checked-out Rust source instead of freezing this list as permanent truth. Any future loss of a P0 contract makes the live gate fail.

## P0 local-development parity

| Capability | Codex contract | DevSpace Ultra contract | Result |
|---|---|---|---|
| Workspace and file confinement | shell/file tools plus patching | `open_workspace`, `read`, `write`, `edit`, `grep`, `glob`, `ls`, `apply_patch` | Complete |
| Persistent process control | `exec_command`, `write_stdin` | `exec_command`, `write_stdin`, bounded process sessions | Complete |
| Native image inspection | `view_image` | exact `view_image` alias with confined path, 20 MiB limit and PNG/JPEG/WebP/GIF signature validation | Complete |
| Turn plan state | `update_plan` | durable conversation-bound `devspace_plan_start`, `devspace_update_plan`, `devspace_plan_status`, Plan Card projection | Complete semantically |
| MCP resources | three top-level MCP resource tools | exact `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` aliases | Complete |
| MCP tools/prompts/instances | configured MCP servers | Capability Runtime catalogue, inspect, calls, prompts, resources and isolated instances | Complete and extended |
| Existing Codex MCP catalogue | local `mcp_servers` configuration | audited `capability_import_codex` plus fingerprinted stdio bridge | Complete for safe local stdio entries |
| Required local executables | shell environment | `toolchain_status`, allowlisted `toolchain_install`, live machine verification | Complete |

All eight P0 rows are executable gates. `scripts/codex-harness-parity-audit.mjs` exits non-zero when any required source contract or DevSpace implementation marker is missing.

## Newly added exact compatibility tools

### `view_image`

`view_image` accepts only a path inside an already opened workspace. It reads a regular file, enforces a byte ceiling, verifies that the extension and binary signature agree, and returns native MCP image content. Supported formats are PNG, JPEG, WebP and GIF. SVG and arbitrary file/base64 injection are rejected.

### MCP resource aliases

The three Codex-compatible resource tools operate over enabled Capability Runtime MCP servers. An unqualified server name is accepted only when unique. Duplicate names fail closed and require `pluginId/serverId`, preventing an agent from reading from the wrong backend after another plugin is installed. Results use bounded cursor pagination.

### `js_repl`

DevSpace now exposes a top-level `js_repl` compatibility tool over the trusted imported `node_repl` MCP. The adapter discovers the real underlying tool and its code/timeout field names instead of hard-coding one private schema. The provider remains persistent across evaluations, while DevSpace still enforces the Capability Runtime trust boundary. The production smoke gate writes and reads an ephemeral marker across two evaluations.

## Audited Codex MCP catalogue import

The importer reads `~/.codex/config.toml` and creates one managed DevSpace plugin per safely importable stdio server. It never copies secret values into a DevSpace manifest or registry.

The generated plugin launches a DevSpace-owned bridge. At runtime the bridge:

1. reads the live Codex configuration;
2. selects the exact named server;
3. rejects disabled, remote-only, malformed or command-line-secret entries;
4. recomputes a SHA-256 fingerprint over the executable surface: server name, command, arguments, working directory and environment-variable names;
5. refuses to launch if that executable surface changed after approval;
6. injects configured secret environment values only into the child process memory;
7. relays MCP stdio without logging those values.

Secret rotation does not alter the executable fingerprint. Command, argument or working-directory changes do, and therefore require a new audit rather than silently inheriting old trust.

Risk classes are explicit:

- **standard:** eligible for safe bulk enabling after audit;
- **stateful-app:** Blender, ComfyUI, Unreal, Eagle, Gaea and MiniMax-style application bridges; they require application-specific readiness and instance discipline;
- **high-impact:** Windows, Docker, shell, computer-use and REPL bridges; they require an explicit named enable operation;
- **privileged:** elevated/admin/root entries; these remain disabled and untrusted unless a separate explicit privileged approval is supplied.

The existing Codex catalogue was imported to the production DevSpace registry. Non-privileged entries already trusted by the user's Codex setup were explicitly enabled after import. `windows-mcp-elevated` remains quarantined. Production probing checks the core development set and a separate all-nonprivileged schema gate checks the wider application catalogue without confusing an MCP schema being present with the external GUI application currently being open.

## Local developer toolchain

DevSpace now has a first-class doctor and an allowlisted Windows installer rather than relying on an agent to discover missing executables halfway through a task.

### Core

```text
git
bash
node
npm
PowerShell
ripgrep
curl
tar
```

### Recommended

```text
Python
uv
jq
fd
GitHub CLI
7-Zip
Git LFS
pnpm
```

### Media and document workflows

```text
FFmpeg
ImageMagick
Poppler / pdftoppm
```

### Native and multi-language build workflows

```text
MSVC C++ Build Tools and Windows SDK workload
CMake
Ninja
Rust / Cargo
Go
.NET SDK
Java
```

The installer accepts only catalogue IDs compiled into DevSpace source. Windows packages use exact Winget IDs, silent/non-interactive mode and package/source agreement flags. The MSVC entry is verified through `vswhere` and the VC x86/x64 component, not by assuming that CMake implies a compiler exists. Installing the Visual Studio Build Tools entry requests the VCTools workload with recommended Windows SDK components.

After installation, a fresh registry-derived Windows PATH probe confirmed the complete core, recommended, media and build tiers. The currently running Core inherits its process environment from before these installations; the controlled Core deployment phase is therefore responsible for activating the refreshed PATH without restarting or refreshing ChatGPT.

## P1 capability mapping

| Capability | DevSpace state |
|---|---|
| Multi-agent orchestration | Complete semantically through Chat Swarm membership, leases, submission, elastic scaling, protected runtimes and update canaries |
| Structured user input | ChatGPT conversation is the host-native user channel; Goal pause/resume provides durable waits. A duplicate form tool is optional, not a local execution blocker |
| Web research | Host-native web search plus DevSpace signed-in Browser Control |
| JavaScript REPL | Exact top-level alias directly reusing the existing linked Codex `node_repl`, with imported Capability fallback only when necessary |
| Windows Computer Use | Official Codex `computer-use` skill routed through the same `node_repl` and bundled `@oai/sky` service; no second CUA backend or helper protocol |
| Diff/review | `apply_patch`, per-operation diffs, review checkpoints and aggregate `show_changes` |
| Artifact intake | Host-native attachment adapter and confined `download_artifact` |
| Skills | User, workspace and trusted plugin `SKILL.md` discovery |
| Durable memory | Shared PowerMem capability using the existing `codex-global/global` backend |

## P2 execution and desktop routing

### Windows desktop Computer Use — bridged complete

DevSpace does not implement another desktop automation engine. It loads the installed official Codex `computer-use` plugin as a trusted capability, routes Windows desktop intents to its skill and guidance, and uses the existing linked Codex `node_repl` to import `@oai/sky`. A live read-only acceptance called `sky.list_apps()` through that exact path and observed the current Windows app inventory. Browser work continues to prefer Browser Control, while desktop tasks use the official Computer Use skill's prohibited-surface and confirmation rules.

### Local execution policy — full access only

The earlier DevSpace sandbox-permission bridge has been removed from the exposed server surface. `request_permissions`, `codex_sandbox_status`, and `exec_sandboxed` are not registered. Normal commands use `exec_command`, and linked Codex MCP calls use a single `full-access` local execution policy. Codex tool allow/deny lists, plugin trust for downloaded code, and higher-priority host safety or action-time confirmation rules remain enforced independently; there is no second local authorization round-trip that can block development.

### True same-conversation Auto Compact — missing

Capsules, worker rotation and fresh-conversation continuity exist. None meet the accepted contract. Completion still requires authoritative evidence that the same conversation ID remains active and exact native usage decreases, with zero automated reloads and zero synthetic visible user messages.

## Verification commands

```text
npm run verify:tool-surface
npm run verify:capabilities
npm run verify:capabilities:codex-live
npm run verify:toolchain
npm run verify:codex-parity
npm run verify:full-access
npm run verify:stable-gateway:real-core
npm run verify:codex-harness-parity:live
npm test
```

The live gates are deliberately separate from deterministic package tests because they depend on this machine's Codex configuration, installed applications and official source checkout.

## Release boundary

The P0 local workspace/tooling substrate is no longer a blocker for the remaining v0.5 work. The next isolated phase is controlled production deployment of the newest Core and refreshed environment while preserving the same Stable Gateway/public MCP/OAuth/App session. Native conversation binding, frontend lifecycle, delivery recovery, exact usage and true Auto Compact remain later isolated phases.
