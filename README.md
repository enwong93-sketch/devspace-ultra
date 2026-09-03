# DevSpace Ultra

**DevSpace Ultra** is an MIT-licensed distribution of DevSpace with an elastic ChatGPT Classic multi-agent runtime layer.

It keeps the original DevSpace local MCP workspace capabilities — local files, code search, editing, terminal execution, artifacts, skills, and secure self-hosting — and adds a production-oriented Chat Swarm control plane for running multiple independent ChatGPT Classic worker conversations on one computer.

> Upstream project: [Waishnav/devspace](https://github.com/Waishnav/devspace). DevSpace Ultra preserves the upstream MIT license and attribution and adds the Ultra runtime/orchestration layer.

## What Ultra adds

- **Elastic worker pool** — the main agent can scale workers up or down according to the current workload instead of using a fixed worker count.
- **Live Swarm resize** — backend capacity can grow or shrink without replacing the orchestrator or losing completed work. Shrink is safety-first and refuses to evict busy/tail workers.
- **Independent ChatGPT Classic runtimes** — on Windows, worker packages use isolated package identities, profiles, sessions, and conversations.
- **Same-worker context continuity** — a worker can be reopened at its exact saved ChatGPT conversation; ChatGPT workers are session-bound by the backend so fresh joins/continuations do not need to expose raw worker credentials in the transcript.
- **Zero-copy bootstrap** — workers can be launched, minimized, sent into a configured `sub-agents` ChatGPT Project, joined to a Swarm, and parked without manual invite-code copy/paste.
- **Backend-first routing** — normal work is always dispatched through the DevSpace Chat Swarm backend. UI/CDP automation is lifecycle/bootstrap/recovery only.
- **Recovery** — detects missing runtimes, interrupted connections, stale worker loops, and blocking UI notices; can reopen the exact worker conversation and resume it.
- **Update compatibility manager** — detects ChatGPT Classic version drift, supports a canary runtime, profile backup, rolling worker update, exact-conversation restore, verification, and rollback.
- **Configurable runtime reservation** — operators can reserve any runtime numbers for standalone/private use; no runtime number is reserved by default in the public package.
- **Automatic long-context continuity** — managed workers compact before the configured hard context limit (90% by default), rotate into a fresh ChatGPT conversation, preserve the same worker identity, and continue without requiring the old conversation to know a newly added MCP tool name.
- **Runtime identity safety** — worker packages never own Primary-only global launch surfaces; persistent logon/deferred-heal guards protect a misrouted interactive worker instead of terminating it and repair legacy registrations once they are safely stopped.
- **Memory-only Session Seed** — signed-out/expired workers can replace only stale ChatGPT/OpenAI cookies from a verified signed-in runtime through CDP, without copying raw cookie databases, logging cookie values, or stopping the source runtime.

### Browser Control

DevSpace Ultra 0.2.0 adds a local-first **DevSpace Browser Control** layer.

After a one-time local Chrome extension setup, any DevSpace-connected orchestrator or subagent can:

- discover user-approved existing Chrome tabs;
- claim one tab with an exclusive lease so two agents cannot race the same page;
- show a compact bottom-right **AGENT CLAIMED THIS TAB** control strip plus a visible black agent pointer/click pulse while control is active;
- open and claim a new managed work tab;
- inspect a semantic accessibility snapshot with stable short refs such as `e1`, `e2`;
- click, fill, type, press keys, scroll, hover, drag, select, check, navigate, and wait;
- capture screenshots plus console/network/download diagnostics;
- opt into a separate Developer mode for supported CDP commands;
- release/expire claims safely, with automatic detach and recovery after Chrome restart.

The default tab policy is **selected tabs only**. Programmatic password-field filling is blocked; users enter credentials directly in Chrome, so agents can reuse an authenticated session without receiving the password. Every MCP-connected orchestrator or worker conversation receives the same `browser_control_*` tool surface and can claim a different tab concurrently. See the [Browser Control setup guide](browser-control-bridge/README.md) and [Browser Control architecture](docs/browser-control-architecture.md).

### Unified Agent Capability Runtime — v0.3

DevSpace Ultra 0.3 adds a shared **universal agent capability/plugin layer** on top of the same backend used by the orchestrator and every worker.

The runtime exposes a compact progressive-disclosure `capability_*` surface for discovering, installing, inspecting, enabling, updating, isolating, and calling reusable capabilities. It understands Agent Skills, instruction packs, MCP tools/prompts/resources, DevSpace manifests, Claude-style and Codex-style plugin metadata, nested MCP profiles, official MCP Registry metadata, and explicitly declared local command tools. Managed packages live under `~/.devspace/plugins/packages`; enabled + trusted plugin `SKILL.md` files join normal workspace skill discovery automatically.

Shared MCP services reuse one backend connection. Stateful application MCPs can instead claim isolated named instances with private tokens and ephemeral per-instance environment, allowing the same MCP type to serve independent projects without sharing process state. Git/local installation is separated from execution trust: downloading a repository does not execute it, executable surfaces stay disabled until explicitly trusted, and plugin secrets remain environment-driven instead of being copied into the registry. See [Unified Agent Capability Runtime](docs/capability-runtime.md).

### Automatic Conversation Continuity — v0.3.1

DevSpace Ultra 0.4 adds a coding-harness-style **Auto Compact** path for managed ChatGPT Classic workers. The default policy estimates a `1,050,000`-token model budget, triggers at 90% (`945,000` estimated tokens), and counts a configurable hidden/system/tool reserve as already-consumed context. ChatGPT does not expose a native exact context counter through this MCP connection, so the watchdog reports its value as a conservative estimate rather than pretending it is host-native telemetry.

At a safe idle boundary the backend builds a bounded capsule from authoritative Chat Swarm history plus bounded recent conversation context, opens a fresh project-scoped ChatGPT conversation, and uses a short-lived one-time continuation ticket to preserve the same worker identity. ChatGPT workers are session-bound to the backend-observed MCP conversation identity, so no raw replacement worker token needs to cross the ChatGPT tool-result surface; cached schemas can use a fixed non-secret compatibility sentinel. A monotonic Backend Context Ledger is combined with the DOM estimate using the larger value, preventing virtualized old messages from hiding accumulated context. Protected interactive runtimes are never auto-rotated. See [Automatic Conversation Continuity](docs/conversation-continuity.md).

### Runtime identity + session safety — v0.3.1

Windows worker clones no longer register the global `chatgpt://` protocol, ChatGPT startup task or Copilot-key provider, and are hidden from the normal app list. Workers also use the dedicated AppX `Application Id` **`DevSpaceWorker`** instead of Primary's `ChatGPT`, so only Primary owns an AUMID ending in `!ChatGPT`; legacy taskbar/default-app worker activation identities therefore become invalid after migration. Legacy clones are audited against both their manifest and Windows' registered AppX state. A running dirty worker is marked `pending-running` and protected instead of being killed; a repeating deferred-heal task completes the migration only after it closes naturally, preserving loose-package application data. The audit also flags stale/unknown Windows `chatgpt://` `UserChoice` ProgIDs rather than reporting a false healthy state; DevSpace never forges Windows' protected default-app hash. New/signed-out workers use verified CDP **Session Seed** from an already signed-in runtime, first removing only stale allowlisted target cookies and then transferring the verified ChatGPT/OpenAI session in memory without logging values. The logon guard separately ensures Primary ChatGPT has a visible window even if Windows restores a legacy worker first. See [Runtime Identity Safety](docs/runtime-identity.md).

### Demo videos

- [DevSpace Ultra v0.3 — Universal Plugin Layer (Chinese)](https://github.com/enwong93-sketch/devspace-ultra/releases/download/v0.3.0/DevSpace-Ultra-v0.3-Universal-Plugin-Layer-ZH.mp4)
- [DevSpace Ultra — Chrome Browser Control demo](https://github.com/enwong93-sketch/devspace-ultra/releases/download/v0.3.0/DevSpace-Ultra-Browser-Control-Demo.mp4)

The MP4s are attached to the GitHub release instead of committed into Git history, keeping clones small while leaving both demos directly reachable from the repository.

## One-click install

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/main/install.sh | bash
```

Or install directly from GitHub with npm:

```bash
npm install -g github:enwong93-sketch/devspace-ultra#main
```

Then initialize and run:

```bash
devspace-ultra init
devspace-ultra serve
```

`devspace` remains available as a compatibility alias.

## Minimum requirements and compatibility

### DevSpace core

- Windows 10/11 x64, macOS, or a mainstream Linux distribution supported by Node/native dependencies
- Node.js `>=22.19 <27` (Node 22 LTS recommended)
- npm (included with Node.js)
- Git for installation directly from this GitHub repository
- Network access for the initial install and for the ChatGPT/MCP connection path you configure
- Tailscale is optional; DevSpace Ultra does not require it

### ChatGPT Classic elastic desktop workers

- Windows 10/11 x64 only for automatic isolated desktop runtime cloning/recovery
- ChatGPT Classic Windows Desktop app installed and signed in
- A ChatGPT account able to use the worker conversations
- RAM sized to the worker count: **16 GB is a practical starting point for 2–4 workers; 32 GB+ is recommended for larger pools.** These are operational recommendations, not hard limits.
- No GPU is required by DevSpace Ultra or the ChatGPT Classic worker runtimes themselves

macOS/Linux users still receive the DevSpace coding/MCP core and Chat Swarm backend, but **do not currently receive the Windows package-identity worker-cloning path**.

## Platform support

| Capability | Windows | macOS | Linux |
|---|---:|---:|---:|
| Base DevSpace MCP workspace | ✅ | ✅ | ✅ |
| Chat Swarm backend / routing | ✅ | ✅ | ✅ |
| Manual/browser worker conversations | ✅ | ✅ | ✅ |
| Elastic backend worker-slot resize | ✅ | ✅ | ✅ |
| Automatic isolated ChatGPT Classic desktop runtime cloning | ✅ | — | — |
| Automatic desktop worker recovery by package/profile identity | ✅ | — | — |
| ChatGPT Classic canary/rolling package update manager | ✅ | — | — |
| Managed ChatGPT Classic Auto Compact / cross-conversation continuation | ✅ | — | — |
| Runtime identity guard + deferred AppX self-heal + CDP Session Seed | ✅ | — | — |

DevSpace Ultra installs and runs the base DevSpace/Chat Swarm layer on supported Node platforms. The Windows-only rows depend on Windows AppX package identity and the current ChatGPT Classic desktop distribution model. Ultra feature-detects those capabilities rather than pretending they exist on platforms where the same desktop package mechanism is unavailable.

## Production flow

A normal main-agent session can operate at this level:

```text
assess workload
  -> choose desiredWorkers
  -> elastic scale runtime + Swarm capacity
  -> dispatch independent or targeted tasks
  -> collect / synthesize
  -> shrink idle tail workers when no longer needed
```

The main agent does not have to keep all workers open. Existing worker conversations are reused whenever possible.

### Runtime lifecycle tools

The Ultra server registers runtime tools such as:

- `chat_swarm_runtime_status`
- `chat_swarm_runtime_ensure`
- `chat_swarm_runtime_scale`
- `chat_swarm_runtime_recover`
- `chat_swarm_runtime_autojoin`
- `chat_swarm_runtime_setup`
- `chat_swarm_runtime_stop`
- `chat_swarm_runtime_identity_status`
- `chat_swarm_runtime_identity_repair`
- `chat_swarm_elastic_scale`
- `chat_swarm_update_status`
- `chat_swarm_update_rollout`

The Chat Swarm backend includes:

- create / join / status
- dispatch / collect / cancel
- long parked worker waits and submit/repark
- targeted or first-available routing
- idempotent `taskKey` retries
- persistence across DevSpace restart
- worker recycle fallback
- safe live capacity resize

## Elastic scaling policy

Ultra deliberately separates **runtime capacity** from **task routing**.

- The main agent may choose a small worker count for simple work and expand for parallelizable work.
- `reservedWorkers` can exclude any operator-chosen runtime numbers from elastic production scaling; the public default is an empty reservation list.
- `protectedWorkers` are a stronger safety boundary used for interactive/misrouted runtimes: controller stop/repair/recover/scale/update and managed Auto Compact all fail closed for them until protection is safely removed.
- Scaling down only removes safe idle tail capacity; it does not interrupt a busy worker merely to reach a number immediately.
- Existing worker conversations and saved context are preferred over creating throwaway conversations.
- Normal tasks are never typed into worker UI by the controller. They travel through the shared Chat Swarm backend.

## `sub-agents` Project routing

When configured with a ChatGPT Project URL, new worker conversations are created inside the `sub-agents` Project instead of cluttering the general chat list. Project-scoped conversation URLs are persisted and accepted by the recovery path.

## Update safety

`chat-swarm-classic-update-manager.ps1` is designed around a canary-first rollout:

1. detect primary ChatGPT Classic version and worker drift;
2. refuse any protected runtime as a canary or rollout target;
3. prepare a free canary runtime from the new primary package;
4. start the canary with CDP and verify its actual login/composer state;
5. if needed, Session Seed it from a currently verified signed-in runtime without stopping the source;
6. run a real worker task at the orchestration layer;
7. update production workers one at a time, stopping each target before taking its rollback profile snapshot so Chromium databases are consistent;
8. reopen the exact saved conversation and verify the worker after update;
9. rollback the affected worker if verification fails.

If there is no version drift, no rollout is needed.

## Security model

DevSpace Ultra inherits DevSpace's self-hosted MCP model. Keep the server bound and exposed only through a transport you control, use authentication, and avoid exposing the local MCP endpoint directly to the public Internet.

Worker tokens and orchestrator tokens are not intentionally written to normal controller logs. Runtime state stores package/profile/conversation mappings, not raw Swarm tokens.

Browser Control uses one-time pairing plus exclusive per-tab claims. DevSpace persists only hashes of bridge/claim tokens and keeps live tab URLs/titles memory-only; the extension defaults to explicitly shared tabs rather than exposing the whole Chrome profile.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Verification

Distribution-level verification:

```bash
npm run verify:ultra
```

The Chat Swarm regression covers multi-worker fan-out, targeted routing, submit/repark, sparse wake-up, retry idempotency, persistence, close wake-up, recycle safety, resize invariants, session-bound ChatGPT joins, and legacy token compatibility. Browser Control regression covers multi-session tab claims, semantic actions, restart continuity, and credential boundaries. Capability Runtime regression covers install/trust separation, shared connection deduplication, stateful instance isolation, MCP tools/prompts/resources, command adapters, plugin path confinement, and secret non-persistence. Auto Compact regression covers the 90% gate, DOM + Backend Context Ledger pressure, capsule redaction, cached-tool-schema continuation through `chat_swarm_join`, protected-runtime exclusion, one-time tickets, session-bound continuation, replay rejection, and a 500-window rotation stress test. Runtime Identity regression verifies worker global-launch isolation, protected stop/update boundaries, authoritative pool planning, deferred self-heal, stale-cookie-safe CDP Session Seed, canonical conversation persistence, and safe backend handover.

Release-specific live gates additionally exercise real Chrome Browser Control, a real GitHub-installed capability package, dual stateful MCP instances, and Codex-plugin compatibility. The v0.3 release environment scanned 71 Codex plugin manifests with 71/71 structural compatibility; platform-managed App connector IDs and Codex host lifecycle hooks are preserved as explicit host dependencies rather than silently emulated.

Windows lifecycle testing additionally covers isolated runtime startup, minimized CDP control, worker recovery, long lease soak, same-conversation continuity, elastic provisioning, a real ChatGPT A→B Auto Compact handoff using a temporary reduced test window through the same production watchdog path, post-handoff semantic recall, fresh/expired-worker Session Seed recovery, canonical project-scoped conversation mapping, repeated DevSpace backend hot handovers, and reboot-style runtime identity recovery while a protected interactive worker remains on the same PID/window.

## Documentation

- [Classic operator guide](docs/chat-swarm-classic-operator.md)
- [Productization and verification record](docs/chat-swarm-classic-productization.md)
- [Browser Control architecture and local verification](docs/browser-control-architecture.md)
- [Unified Agent Capability Runtime](docs/capability-runtime.md)
- [Automatic Conversation Continuity](docs/conversation-continuity.md)
- [Runtime Identity Safety](docs/runtime-identity.md)
- [Configuration](docs/configuration.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

DevSpace Ultra is an independent community fork/distribution and is not an official OpenAI product. ChatGPT and OpenAI product names are trademarks of their respective owners.
