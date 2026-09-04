# Changelog

## Unreleased — v0.5 plan runtime

### Added

- Backend-authoritative Codex-style execution plans for long ChatGPT Classic tasks, with persistent ordered steps, strict `pending` / `in_progress` / `completed` transitions, restart recovery, and an immutable terminal state.
- A dedicated live MCP Apps plan card that mounts once, refreshes plan state without remounting on every update, expands to the full checklist, and opportunistically uses picture-in-picture with safe inline fallback.
- `devspace_plan_start`, `devspace_update_plan`, `devspace_plan_status`, and `devspace_plan_mount`, separating mutation/data tools from render tools so ordinary `DEVSPACE_WIDGETS=off` behavior remains unchanged.
- Codex-style model instructions that keep one current step in progress, update the plan before scope pivots, avoid duplicating the whole checklist in prose, and exclude Chat Swarm workers from user-facing plan cards.

### Verification

- Plan runtime persistence/transition unit gate, MCP registration gate, widget/resource/instruction static gates, and an in-memory real MCP protocol gate covering tool discovery, app resource reading, step advancement, backend restart recovery, remount, and terminal completion.

## 0.4.0 — 2026-09-04

### Added

- **Multi-Main ChatGPT Classic runtimes** for Windows. Canonical Main-01 remains the installed Primary, while Main-02+ use separate `OpenAI.ChatGPT-Desktop.InteractiveNN` package identities, independent ChatGPT profiles/processes, visible user-facing windows, and the dedicated `DevSpaceInteractive` Application Id.
- A reusable role-aware ChatGPT Classic provisioner shared by `worker` and `interactive` roles. Worker behavior remains backend-managed/hidden under `DevSpaceWorker`; Interactive runtimes are explicitly outside Worker lifecycle ownership.
- `chat_main_runtime_open`, `chat_main_runtime_manage`, `chat_main_runtime_status`, `chat_main_runtime_setup`, `chat_main_runtime_authenticate`, `chat_main_runtime_start`, and `chat_main_runtime_live_gate` MCP surfaces for secondary interactive runtimes. `chat_main_runtime_open` is the one-command UX and automatically chooses the lowest free Main when no number is supplied.
- Multi-Main identity audit output with separate `Interactives`, `InteractiveIsolationSafe`, dirty/running Interactive lists, and explicit Interactive protocol-owner classification without merging Main runtimes into Worker state.
- Zero-login Interactive Session Seed source pool: verified signed-in secondary Main CDP first, verified Worker CDP second, canonical Primary encrypted profile last. CDP seeding is allowlisted to ChatGPT/OpenAI cookies, records no values, and includes a bounded persistence-settle verification before first-use restart gates.
- Controlled canonical Main-01 snapshot fallback for the Windows case where its Chromium Cookies database is exclusively share-locked and no zero-interruption CDP source exists. DevSpace may close only canonical Primary, seed the new Main from the encrypted profile, relaunch Main-01 and require a signed-in visible restore before success. `chat_main_runtime_authenticate` remains only the bounded cold-start OAuth fallback.
- A fixed **Cloudflare Worker + Workers VPC + named Cloudflare Tunnel** MCP edge. The ChatGPT-facing `workers.dev` URL remains stable across reboots/backend restarts while an isolated fixed backend (port `7677` by default) carries the fixed OAuth/resource identity. The existing/default control backend keeps its own `publicBaseUrl`, port and state directory unchanged. Separate long-lived logon tasks own the fixed backend and named tunnel in the foreground, and upgrade startup cleans legacy duplicate wrappers only for the exact named tunnel ID.
- `devspace edge status`, `devspace edge cloudflare setup`, `devspace edge cloudflare verify`, and `devspace edge disable` plus deterministic/live edge gates. A generic public-origin Worker path remains optional, while Workers VPC is the default fixed-edge transport.
- Handover-safe OAuth authorization codes persisted in SQLite with one-time replay prevention, eliminating the process-local `/authorize`→`/token` restart race.
- Generic public Express error handling that returns bounded JSON errors instead of exposing body-parser stack traces or local filesystem paths.
- **Codex ContextBridge** with `context_bridge_codex_list`, `context_bridge_codex_import`, and `context_bridge_codex_capsule`, plus `devspace context codex ...` CLI commands. It resolves local Codex threads from the Codex state index, streams large rollout history, uses Codex compaction boundaries, imports only bounded user/assistant historical context, excludes hidden reasoning/developer/raw tool material, redacts obvious credentials, and persists only sanitized capsules in DevSpace state.

### Safety / compatibility

- Only Main-01 may own the canonical `OpenAI.ChatGPT-Desktop` package, `Application Id="ChatGPT"`, `!ChatGPT` AUMID, `chatgpt://`, startup task, or Copilot-key extension.
- Main-02+ never enter Worker controller state, Worker autojoin, elastic scaling, update rollout, minimize/recovery, or managed Auto Compact.
- Existing v0.3.1 Worker identity/protected-runtime/Auto Compact behavior remains covered by the original regression gate after the Worker clone entry point was refactored onto the shared provisioner.

### Verified live gate

- Canonical Main-01 stayed on the exact same PID/window (`3656` / `657622`) while Main-02 was provisioned, authenticated and restarted; Main-01 was never stopped or restarted.
- Main-02 ran as `OpenAI.ChatGPT-Desktop.Interactive02` / `!DevSpaceInteractive`, remained user-visible and outside Worker controller/Auto Compact ownership, authenticated through the direct-alias OAuth relay, then passed independent restart persistence on a new root PID (`22472 -> 23144`) with `SessionVerified=true`.
- The live identity audit reported `InteractiveIsolationSafe=true`, `WorkerManaged=false`, no protocol/startup/Copilot ownership, and no Worker-controller listing for Main-02.
- Main-03 was created without manual sign-in by seeding from signed-in Main-02, then passed independent restart persistence after the bounded Chromium persistence-settle fix; Main-01 stayed on PID/window `3656` / `657622` and Main-03 remained outside Worker/Chat Swarm/Auto Compact ownership.
- The stale protected Windows `chatgpt://` UserChoice was repaired through the supported Windows Default Apps/OpenWith UI rather than registry hash manipulation. Final audit reported `ProtocolCanonical=true`, `WorkerIsolationSafe=true`, `InteractiveIsolationSafe=true`, and canonical Main-01 as `primary-current`.
- The fixed `workers.dev` edge reached local DevSpace through Workers VPC and returned real `/healthz` 200 plus `/mcp` 401 OAuth challenge. The prior Worker→Tailscale origin attempt was rejected after a live Cloudflare 525, and the implementation pivoted to the private named-tunnel VPC path instead of weakening OAuth.
- Control/fixed-plane isolation was exercised live: the control backend remained on the same PID while the isolated fixed backend was force-restarted under its Scheduled Task, the fixed connector reconnected without recreation, the named-tunnel task stayed `Running`, and legacy duplicate named-tunnel wrappers were reduced to one exact wrapper/cloudflared tree. Main-03 then passed a fresh restart-persistence gate with `SessionSourceLabel=Main-02`, `Main01Unchanged=true`, and `ProtocolCanonical=true` remained true in the identity audit.
- The production fixed ChatGPT connector itself executed DevSpace tools after the backend/task restart, and Codex ContextBridge imported/reopened a real local Codex thread through that fixed connector while reporting hidden reasoning/developer/raw tool output excluded.
- Codex ContextBridge live-imported a real ~89.7 MB compacted rollout by streaming 9,220 records, preserved the Codex compaction anchor, produced a bounded sanitized capsule, round-tripped the persisted capsule exactly, and reported hidden reasoning/developer/raw tool output all excluded.

## 0.3.1 — 2026-09-04

### Added

- Backend-driven **Automatic Conversation Continuity / Auto Compact** for managed ChatGPT Classic workers, with a configurable context budget, 90% default threshold, conservative multilingual estimator, hidden/tool reserve, safe-boundary rotation, and persistent compact capsules.
- Automatic capsules assembled from authoritative Chat Swarm task history plus bounded recent conversation context, so long-running workers do not depend on the old conversation seeing a newly registered MCP tool.
- One-time continuation tickets, same-worker identity preservation, private credential rotation, old-token invalidation, replay rejection, and **session-bound** ChatGPT worker authentication so fresh/continued ChatGPT conversations do not need a raw worker token in tool results or prompts.
- Backward-compatible continuation redemption through the existing `chat_swarm_join` `inviteCode` field, allowing cached/legacy MCP tool catalogs to survive cross-conversation compaction.
- Windows **Runtime Identity Safety** policy with persistent `protectedWorkers`, hard protection at the lowest stop path, authoritative production-pool planning, protocol-misroute detection, explicit Primary activation, and deferred migration for running legacy workers.
- Worker manifest isolation: worker clones remove Primary-only `chatgpt://`, startup-task and Copilot-key registrations, are hidden from the normal Windows app list, and retain only their explicit worker execution aliases.
- Worker **AUMID isolation**: worker packages now use the dedicated AppX `Application Id` `DevSpaceWorker`, so only Primary retains `!ChatGPT`. This invalidates stale Worker `!ChatGPT` taskbar/default-app activation identities after safe migration.
- Persistent logon identity guard plus low-frequency deferred self-heal task. Running dirty workers are never terminated for identity migration; their registration repairs automatically after they close naturally.
- CDP **Session Seed** authentication path: verifies actual source/target ChatGPT login UI state, replaces stale target ChatGPT/OpenAI cookies with an allowlisted source session in memory using CDP, never logs cookie values, and removes the old `IndexedDB exists == logged in` assumption from production lifecycle control.
- Runtime identity inspection/repair tools for agent-visible diagnostics, while destructive operations continue to fail closed for protected interactive runtimes.
- A monotonic per-conversation **Backend Context Ledger** combined with the DOM estimator using `max(DOM, ledger)`, preventing ChatGPT message virtualization from making long coding conversations appear artificially small.
- Canonical conversation persistence that rejects transient `WEB:*`/temporary SPA routes and waits for a stable server conversation ID before saving or recovering a worker.
- A self-contained DevSpace server handover helper that replaces only the old backend PID and survives long enough to start the replacement server.

### Fixed

- DevSpace no longer attaches per-tool Apps iframe cards by default. `DEVSPACE_WIDGETS` now defaults to `off`, removing repetitive `Ran command`, read, and edit cards from normal ChatGPT work while preserving `changes` and `full` as explicit opt-in modes.
- Legacy Worker 01–04 clones could retain the global `chatgpt://` protocol registration. Windows could consequently make a Worker package the default ChatGPT protocol handler after restart/deep-link activation, causing the user's apparent Primary ChatGPT window to actually be a worker runtime.
- Runtime identity audit no longer treats an unresolvable/stale Windows `UserChoice` ProgID as healthy. It classifies current Primary, current Worker, stale Worker, stale Primary and stale/unknown states explicitly, while respecting Windows' protected default-app setting instead of forging its hash.
- Worker identity migration now uses `Remove-AppxPackage -PreserveApplicationData` for loose-file registered clones, preserving isolated ChatGPT profile/session data during re-registration.
- Windows PowerShell child-process stderr can no longer abort the entire deferred-heal loop before the child exit code is inspected; one worker failure is isolated and reported without suppressing the rest of the repair pass.
- Elastic scale, auth provisioning, update rollout, recovery, minimize, Auto Compact and direct stop paths now share the same protected-runtime policy instead of independently deriving worker numbers or assuming every worker is disposable.
- Runtime login health no longer treats stale Chromium profile directories/IndexedDB as proof of a valid ChatGPT session.
- ChatGPT SPA new-conversation handoff waits for a genuinely fresh/stable composer and canonical server conversation URL instead of racing the old route/composer or persisting transient `WEB:*` IDs; exact-current conversation probes no longer reload an active tool turn unnecessarily.
- Compact capsule metadata is updated atomically in both the continuity index and the durable capsule record after resume/failure.
- DevSpace hot handover no longer uses `taskkill /T`, which could kill the detached replacement helper together with the old backend process and leave the connector offline.

### Verified for release

- Deterministic Auto Compact gate covers the exact 90% policy, CJK-heavy estimation, Backend Context Ledger fallback, credential redaction, Windows BOM controller state, protected-runtime exclusion, one-time tickets, session-bound normal joins/continuations, cached-schema sentinel compatibility, token rotation/replay prevention, mid-task rotation refusal, and automatic-handoff debounce.
- 500 consecutive backend continuation rotations preserve one worker identity while producing 501 unique internal token hashes and 500 unique one-time tickets; old tokens are invalidated, raw continuation credentials are not exposed/persisted, and state remains bounded.
- Production policy is `1,050,000` estimated tokens with a 90% trigger at `945,000`. The real ChatGPT Classic end-to-end gate used a temporary `10,000`-token test window to exercise the identical watchdog/handoff path quickly: Backend Context Ledger `18,164` vs DOM estimate `448`, effective estimate `19,164`, automatic A→B project-scoped handoff, same `worker-01`, `continuationCount=1`, new context epoch, and successful recall of a harmless marker that existed only in conversation A/capsule.
- Session Seed live gates moved a signed-out worker to a verified signed-in session and also repaired an expired worker by clearing only stale allowlisted target cookies before in-memory transfer; the protected source interactive runtime kept the same PID/window throughout.
- Current Codex-plugin structural compatibility scan passes **72/72** manifests (up from the 71-manifest v0.3 release environment) with Skills/MCP directly reusable and platform Apps/host hooks preserved as explicit host dependencies.
- Reboot-style identity simulation verified that a legacy running protocol-owner worker is protected rather than terminated, the explicit Primary app can be activated separately, and inactive workers self-heal to sanitized AppX registrations.
- AUMID migration live gate preserved exact worker profile file-count/byte baselines, kept the active Primary on the same PID/window, proved an old `Worker32!...!ChatGPT` AUMID no longer launches while `Worker32!...!DevSpaceWorker` does, and separately proved the former Worker04 `!...!ChatGPT` activation path no longer launches Worker04.

## 0.3.0 — 2026-08-20

### Added

- Shared **Unified Agent Capability Runtime** instantiated once per DevSpace backend and exposed identically to orchestrator and worker MCP sessions.
- User-level plugin store at `~/.devspace/plugins` with managed packages, metadata-only registry, enable/disable, Git update, and safe managed uninstall lifecycle.
- Twelve progressive-disclosure `capability_*` agent tools for compact catalog/search, inspection, install, trust/enable, disable, update, uninstall, refresh, resource reading, stateful MCP instance claims, and tool invocation.
- Multi-format discovery for Agent Skills (`SKILL.md`), agent instruction files, DevSpace universal manifests, Claude-style and Codex-style plugin roots/components, MCP client configs, nested `*.mcp.json` profiles, and official MCP Registry `server.json` metadata/remotes.
- Shared MCP client proxy supporting stdio, Streamable HTTP, and legacy SSE transports, with bounded connect/call timeouts, connection deduplication across agents, progressive discovery/use of MCP tools/prompts/resources, and isolated exclusive stateful instances for project-bound MCPs such as Blender.
- Explicit command-tool adapter format using shell-free process execution, JSON stdin, bounded output, plugin-confined cwd, and execution timeouts.
- GitHub/Git/local-directory installation without package install hooks; newly downloaded executable code remains disabled/untrusted until explicitly trusted.
- Secret-safe MCP configuration using environment-variable names rather than persisted values, including official MCP Registry URL variables and header descriptors; remote transports reject non-HTTP(S) URLs.
- Plugin skills join normal `open_workspace` skill discovery only after the plugin is enabled and trusted; resource/cwd resolution blocks lexical and symlink escapes from the plugin root.
- Nested/monorepo plugin discovery so one Git repository can contain multiple plugin roots and reusable MCP profiles.
- Stateful MCP `instanceId` leases with private in-memory instance tokens, ephemeral per-instance environment overrides, isolated MCP processes, same-instance exclusion, and serialized same-template cold-start to avoid package-manager/cache races.
- Windows stdio compatibility preserves the minimal `COMSPEC`/`PATHEXT`/`WINDIR` process context needed by package managers such as `uv` without inheriting the full parent environment.

### Verified for release

- Deterministic fixture exercises install-without-execution, trust gate, two independent MCP-session catalogs, compact search, Agent Skill discovery, bounded/symlink-safe instruction reads, shared MCP connection dedupe/refresh invalidation, real stdio MCP tools/prompts/resources, command tools, official Registry metadata/remotes, secret non-persistence, disable/re-enable, and uninstall.
- Real GitHub install gate clones the current `oceanbase/powermem` repository into an isolated temporary plugin store, detects its nested Claude plugin/Agent Skills/instructions/MCP profile, performs no plugin execution, and removes the package cleanly afterward.
- Codex plugin compatibility gate scans every local `.codex-plugin/plugin.json`, fails on unknown manifest fields/missing declared paths, and currently passes 71/71 manifests across bundled, curated, remote-curated, personal, staging, archived, and source-tree packages. Skills/MCP are directly reusable; platform App connector IDs and Codex lifecycle hooks are preserved as explicit host dependencies rather than silently emulated.
- Real dual-Blender gate uses the user's installed Blender 5.1 extension plus Blender Lab MCP v1.0.0 through the Capability Runtime: two isolated Blender processes/projects expose the same complete 26-tool catalog, accept simultaneous project-specific calls, and pass cross-project marker isolation plus high-level object/datablock summary checks.

## 0.2.0 — 2026-08-19

### Added

- DevSpace Browser Control Bridge for Google Chrome / Chromium with local one-time pairing.
- Exclusive per-tab claim leases so multiple agents can safely share one browser without racing the same tab.
- Visible claimed-tab UI: compact bottom-right **AGENT CLAIMED THIS TAB** control strip, claim-owner/current-action labels, Codex-like black agent pointer, and click pulse.
- Claim an existing user-approved Chrome tab or open/claim a new managed work tab on demand.
- Semantic accessibility snapshots with ephemeral element refs for click/fill/type/press/select/check/focus/hover/scroll/drag actions.
- Screenshot, console, network, and download inspection surfaces.
- Explicit Developer mode for supported Chrome DevTools Protocol commands with destructive browser-wide clearing/crash methods blocked.
- Automatic claim revocation on unshare/disconnect, managed-tab cleanup on attach failure, debugger detach on release/expiry, and Chrome restart/reconnect recovery.
- Programmatic password-field fill blocking; credentials stay in the user-controlled browser UI.
- Browser-control state persists token hashes/claims but keeps live tab URLs/titles memory-only.
- Deterministic Browser Control regression suite and isolated Chrome-for-Testing live extension gate.

### Verified for release

- One-time pair and bridge reconnect across Chrome restart.
- New-tab claim and exclusive competing-claim rejection.
- Visible claim banner + black pointer, semantic snapshot, focus/fill/type/key press, checkbox/select, hover/double-click, drag/scroll, submit/page-state transition, screenshot, console/network/download capture, navigation, and wait conditions.
- Release/expiry detach, unshare revocation, re-pair claim invalidation, and failed managed-tab attach cleanup.
- Three independent MCP sessions (orchestrator + two worker-style sessions) can hold simultaneous exclusive claims on three different Chrome tabs.
- Existing Chat Swarm regression remains green under `npm run verify:ultra`.

## 0.1.0 — 2026-08-18

Initial DevSpace Ultra public distribution, based on DevSpace 1.0.5.

### Added

- Chat Swarm coordinator and worker lifecycle for independent ChatGPT Classic conversations.
- Targeted and first-available routing, idempotent task keys, submit/repark, cancellation, persistence, and recovery.
- Long parked worker leases with checkpoint renewal.
- Windows isolated ChatGPT Classic runtime cloning by package identity.
- Controller actions for setup, start, ensure, status, minimize, recovery, capture, auto-join, stop, and elastic scale.
- Automatic worker creation inside a configured `sub-agents` ChatGPT Project.
- Exact project/top-level conversation URL capture and recovery.
- UI obstruction dismissal and interrupted-connection detection.
- Elastic runtime expansion/shrink with operator-configurable reserved runtime numbers; the public default reserves none.
- Safe live Swarm resize with tail-only shrink invariants.
- ChatGPT Classic version drift detection and canary/rolling-update/rollback tooling.
- `devspace-ultra` CLI alias while retaining `devspace` compatibility.
- Cross-platform installation scripts and explicit platform capability matrix.

### Verified on the development machine

- 4-worker zero-touch join and parallel dispatch.
- Same-worker context continuity.
- DevSpace restart persistence.
- Runtime kill/relaunch recovery.
- Cold close/reopen of all production runtimes.
- Multi-checkpoint long-idle soak followed by 4/4 dispatch.
- Elastic provisioning of Runtime-06 and Runtime-07, successful worker joins/tasks, and scale-down.
- Chat Swarm regression covering 9-worker waves, sparse wake-up, retry idempotency, persistence, recycle, and resize safety.

### Platform notes

The core DevSpace/Chat Swarm layer is portable across supported Node platforms. Autonomous ChatGPT Classic desktop package cloning/recovery and the package update manager are Windows-specific in 0.1.0.
