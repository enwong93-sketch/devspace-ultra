# Changelog

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
