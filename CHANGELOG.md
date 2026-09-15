# Changelog

## Unreleased

## 0.5.8 — 2026-09-15

- Kept direct DevSpace tools bound to the active native ChatGPT turn across deferred calls, schema refreshes and Stable Gateway session resurrection. A stale MCP transport, previous tool call or prior conversation can no longer borrow the current turn, while the owning conversation keeps its writable tools without repeated correlation stalls.
- Added exact-page progress claims and a bounded relay so Agent-authored narration, Goal/Plan ownership and automatic Goal continuation survive renderer reloads without Runtime-only authority, foreground activation, page navigation or cross-conversation projection.
- Stabilized hidden Goal resume observation and completion recovery. A resumed round is accepted only from the exact owning conversation, duplicate recovery is suppressed, and normal completion or cancellation disarms the episode.
- Prioritized writable DevSpace workspace tools ahead of read-only or compatibility surfaces after tool-list refresh, preventing a refreshed host from selecting a weaker alias when the native mutation tool is available.
- Added the canonical Windows logon startup task for Stable Gateway plus Main-01 through Main-05. Secondary Mains start minimized with verified signed-in sessions; Worker runtimes are explicitly excluded from autostart.
- Hardened local ingress startup, canonical Main runtime recovery, progress-overlay remounting and MCP session persistence, with regression gates for exact claims, schema refresh, no-navigation recovery, Main/Worker isolation and canonical startup.
- Fixed cross-platform CI to install native dependencies with `npm ci`, so the real `better-sqlite3` OAuth/state boundary is tested instead of failing from an intentionally incomplete install.
- Added the white 26-second Traditional Chinese v0.5 launch video as a GitHub release asset.

## 0.5.7 — 2026-09-13

- Replaced reusable direct-session, direct-trace, Runtime-only, and deferred-placeholder ownership with an exact page-local tool-invocation join. DevSpace now observes the owning ChatGPT conversation response/WebSocket stream, hashes the canonical tool name and arguments, joins that evidence to one bounded Gateway request, re-verifies the unique live page, and discards the authority when that request ends.
- Removed `ClassicDirectRequestAuthorityRegistry`, durable verified direct-session lookup/write APIs, and the old progress authority fallback that could let one long-lived ChatGPT host session write another conversation's progress card or influence its rescue timing.
- Added bounded UTF-8-safe response-stream reconstruction for page-local tool invocations, including split multibyte characters, duplicate-frame suppression, a 512 KiB per-response tail, and a 16-response cap per Main Runtime. Raw arguments, message IDs, request IDs, traces, and session values are never persisted.
- Added versioned ownership proofs to Agent-authored progress. New direct reports require `exact-conversation-request-v1`; the compatibility bridge requires an independently exact page proof. Legacy rows without proof remain available only as diagnostic history and are no longer projected into any floating card or counted as rescue activity.
- Bumped conversation-progress liveness state to version 4 so pre-fix rescue episodes are disarmed on upgrade. The ten-minute policy remains an Agent-authored reporting ceiling with no synthetic reminder, while the twenty-minute rescue remains exact-conversation, interruption-only, one committed `- 繼續` per episode, and disarms on normal completion or cancellation.
- Added shared-host-session, identical-concurrent-call, page-route, response-stream, UTF-8 split, stale-row, rescue-migration, zero-zombie-waiter, memory-bound, and multi-conversation regression gates. Goal, Plan, Capability, Blender, Computer Use, and linked Codex MCP tools now share the same exact request-scoped authority boundary.

## 0.5.6 — 2026-09-12

- Deleted the obsolete custom Chrome-extension implementation, its tracked source bridge, retired runtime module, tests, and live gate instead of merely excluding them from npm. Current Agent instructions and the Computer Use skill no longer advertise the old tool names.
- Added a deterministic stale-session tombstone for the nine removed browser tools. A cached ChatGPT tool call now returns `retired_tool`, identifies `codex_computer_use` as the replacement, and explicitly states that the rest of the current DevSpace tool surface remains available.
- Added scoped downstream-to-upstream MCP form-elicitation relay so the official linked Codex `node_repl` can display and receive the native `@oai/sky` per-app Computer Use approval. Approval handlers are conversation-isolated, call-scoped, fail closed when absent, and reject concurrent borrowing.
- Added an exact-conversation fallback for MCP hosts that explicitly report form elicitation unsupported: only a low-risk read-only app observation can mint a five-minute grant, and exactly one subsequent mutation for the same app consumes it, preserving the required observe → one action cycle.
- High-risk app approval in that fallback is available only when the current tool call explicitly records that the user requested or confirmed control of that app in the current turn; the flag is accepted only on the observation that mints the one-action grant and is never inferred automatically.
- Added explicit Computer Use target boundaries for ChatGPT, Codex, terminals, shells, computer-audio prompts, connector mismatch, and app mismatch, while preserving the official observe → one action → re-observe flow for ordinary Chrome and Windows apps.
- Extended native browser, public package, Codex MCP bridge, and Computer Use regression gates to prove source removal, stale-schema diagnostics, official approval relay, and prohibited-app isolation.
- Made the public-error integration gate explicitly close keep-alive HTTP connections and retry Windows temporary-directory cleanup, preventing completed verification runs from leaving orphan test processes or accumulating stale test state.

## 0.5.5 — 2026-09-12

- Replaced the retired DevSpace Chrome-extension `browser_control_*` execution path with the installed OpenAI Codex Computer Use runtime. Ordinary Chrome, Edge, and Windows GUI work now routes through `codex_computer_use`, the persistent linked Codex `node_repl`, and bundled `@oai/sky`; the old bridge returns HTTP 410 and its runtime artifacts are excluded from release packages.
- Re-enabled Goal Recovery through the exact-conversation page-composer transport shared with interrupted-turn rescue. Recovery no longer runs Primary repair, activates or opens a window, navigates/reloads a page, selects by Runtime alone, or retries after a send has been committed.
- Fixed server-side direct MCP authority for long assistant turns. After one direct request is verified against the exact active conversation page, later requests in the same assistant turn reuse only bounded hashed request-trace aliases, re-verify the page on every call, fail closed on cross-conversation ambiguity, and revoke inherited authority when the conversation settles. This restores `devspace_progress_report`, Goal/Plan, Blender routing, and Codex Computer Use without zombie correlation waiters.
- Fixed reused ChatGPT session identity after a Main Runtime navigates to another conversation. A newly observed exact browser turn replaces the stale route only when either the conversation or physical Runtime is unchanged; unrelated conversation-plus-Runtime combinations remain ambiguous and fail closed.
- Reduced the verified twenty-minute interrupted-turn rescue to the exact visible message `- 繼續`. The backend still enforces the twenty-minute threshold, exact conversation ownership, interruption evidence, empty composer, normal-completion/cancellation disarm, and one committed rescue per episode.
- Hardened release packaging so timestamped `.before-*` and `.bak*` diagnostics cannot enter the npm archive, while the public package gate continues to reject retired Browser Control artifacts.

## 0.5.4 — 2026-09-10

- Fixed Stable Gateway quiet-boundary starvation when ChatGPT keeps long-lived replayable MCP event streams open. Pure SSE streams are now excluded from the non-stream in-flight counter, while real tool/HTTP requests still block handover until they finish.
- Added deterministic gates proving that four open event streams can hand over safely, while one remaining non-stream request continues to fail closed.
- Preserved the v0.5.3 Main tool bridge, isolated Blender routing, live `.blend` metadata correction, timestamped narration, system-managed heap, and disabled-by-default Goal Recovery/Auto Compact safety posture.

## 0.5.3 — 2026-09-10

- Fixed isolated Blender runtimes for the official Blender Lab MCP server by passing its required `BLENDER_MCP_HOST` / `BLENDER_MCP_PORT` variables while retaining the community aliases. Every runtime claim now also carries an explicit instance ID, so two conversations cannot collapse onto the default port.
- Successful live Blender MCP readback now refreshes the persisted runtime `.blend` path. Saving or switching the file inside an already-open Blender no longer leaves routing/status metadata advertising a stale filename.
- Added the public `devspace-conversation-bridge` compatibility entry point for ChatGPT turns where the host lazily omits deferred tools. It resolves the current Main conversation from native authority, enforces runtime ownership, preserves an already-open Blender process, routes calls through the same isolated CapabilityRuntime, and writes Agent-authored narration through the Stable Gateway serializer.
- Prioritized `devspace_progress_report`, `blender_runtime`, and `blender_mcp` at the front of the MCP tool catalogue while retaining the compatibility bridge as a deterministic fallback.
- Added a local timestamp to every progress-card message using the message's persisted `at` value. The Agent continues to write untemplated natural language; the floating UI adds `[YYYY-MM-DD HH:mm]` automatically.
- Added regression gates for the bridge, official Blender MCP port environment, per-conversation ownership, public package/bin inclusion, serialized progress writes, per-message timestamps, and no runtime termination.
- Made Stable Gateway handover rank identified/active MCP sessions first and boundedly skip expired 401/403 bearer snapshots instead of letting one stale session block a safe Core upgrade. The old Core remains active until a currently authorized baseline passes schema verification.
- Removed a timing race from the degraded-startup gate so the initial 503 listener state and later automatic Core recovery are tested deterministically on slower Windows hosts.
- Kept Goal Recovery and Auto Compact disabled by default; this patch changes neither safety gate nor navigation behavior.

## 0.5.2 — 2026-09-09

- Stabilized the Local Gateway/Core lifecycle with system-managed heap sizing, zero-listener cold start, degraded-listener recovery, bounded client-session descriptors, lazy transport resurrection, no arbitrary work/startup deadlines, retryable Windows atomic writes, and bounded runtime logs.
- Replaced implicit backend-wide MCP connection sharing with per-conversation MCP client/session isolation. Stateful application connections are additionally bound to instance, runtime, process, and port; reconnect/reset/release operations cannot close another conversation's connection.
- Added `blender_runtime` and the real `blender_mcp` execution boundary, including safe adoption of an already-open Blender project without restarting it, plus future dual-runtime/dual-port isolation.
- Added request-scoped conversation authority for Capability, linked Codex MCP, JavaScript REPL, Computer Use, Goal/Plan, and Agent-authored progress operations.
- Added a conversation-scoped floating progress narration card driven only by `devspace_progress_report`. Timers, heartbeat rows, fixed tool counts, raw handler boundaries, and automatic program prose no longer write visible narration.
- Added proactive `notifications/tools/list_changed` and model-surface fingerprints so existing ChatGPT sessions can discard obsolete tool schemas after Core changes.
- Added a one-command Windows installer and the separately installable `devspace-ultra-setup` Agent Skill. DuckDNS/DDNS + Caddy is the recommended route; a stable Cloudflare named tunnel is the quota-governed fallback.
- Added DPAPI-protected DuckDNS/Cloudflare secret storage, public-path and package-content release gates, tagged release assets, and removal of machine-specific handoff data from the public tree.
- Kept automatic Main Goal Recovery and Auto Compact disabled by default pending their final production re-entry/transaction live gates.

## 0.5.1 — 2026-09-07

- Added Codex Computer Use routing/skill delegation with automatic visual-task routing through the shared persistent Codex `node_repl` and OpenAI bundled `@oai/sky` runtime, with no DevSpace fallback GUI driver.
- Replaced the optional Codex sandbox/permission-grant surface with one owner-selected `danger-full-access` / `never` approval policy.
- Added support for Codex `requires_local_executor` plugin metadata and 77/77 live manifest compatibility.
- Added a model-independent interactive progress contract for Thinking/XHi and Pro. Every observed Main conversation now receives one exact-conversation floating narration card with an idle placeholder before its first tracked event; verified successes are batched at roughly ten tool boundaries, while blockers and material approach changes remain immediate.
- Retired the old inline black Goal Dock and inline Plan Card as user-facing progress surfaces. Goal/Plan start and rebind tools no longer request those transcript apps, while existing legacy iframe shells and their `Failed to fetch template` placeholders are hidden in place without a reload, navigation, or synthetic turn.
- Added connector-level and root `AGENTS.md` routing that requires a conversation-bound Plan before non-trivial multi-tool work and Goal Mode plus a fresh turn Plan for autonomous multi-turn outcomes, ensuring every Main agent actually feeds the floating progress card instead of merely displaying an unused shell.
- Added a Codex-inspired plugin-layer Capability Routing Contract. `capability_route` performs bounded progressive-disclosure routing across plugin Skills, plugins, command adapters, and deferred MCP surfaces; `tool_search(workspaceId=...)` additionally routes project/user Agent Skills together with direct tools. Structured aliases, exclusions, `allow_implicit_invocation`, Skill `agents/openai.yaml` interface/default-prompt/dependency metadata, exact `nextAction`, ambiguity handling, and CJK matching are supported without loading every Skill body or MCP schema.
- Made routing updates live for existing MCP sessions through `notifications/tools/list_changed`. Stable Gateway model-surface fingerprints are versioned and now include tool titles/descriptions, input/output schemas, annotations, UI/routing metadata, the capability routing index, and model instructions; obsolete sessions are rejected for fresh initialize instead of retaining stale routing behavior.
- Added bounded append-only diagnostic log retention: per-file tail trimming without whole-file heap reads, total root quota, file-count cap, age expiry, and Gateway lifecycle integration; durable JSON authority/state files remain excluded.
- Productized Main selective Auto Compact as the built-in `devspace-auto-compact` capability. ChatGPT may assign a new backend conversation ID, but acceptance now requires a non-empty bounded capsule, all available source/carry ratios, a materially smaller target mapping/current branch/payload, continuity markers, and a guarded atomic rebind of native authority, Goal, Plan, progress narration, and Host Overlay. Full mapping inheritance and zero-context continuation fail closed.
- Added authenticated in-page structural conversation descriptors whose access token and raw mapping never leave the ChatGPT renderer; target continuation verification no longer races a previously completed network response.
- Added multi-paragraph Goal round reports to the progress narration history: title, up to eight bounded summary segments, and final round status, retained across the latest eight rounds with restart-safe deduplication.

## 0.5.0 — 2026-09-05

### Added

- Backend-authoritative Codex-style execution plans for long ChatGPT Classic tasks, with persistent ordered steps, strict `pending` / `in_progress` / `completed` transitions, restart recovery, and an immutable terminal state.
- A dedicated live MCP Apps plan card that mounts once, refreshes plan state without remounting on every update, expands to the full checklist, and opportunistically uses picture-in-picture with safe inline fallback.
- `devspace_plan_start`, `devspace_update_plan`, `devspace_plan_status`, and `devspace_plan_mount`, separating mutation/data tools from render tools so ordinary `DEVSPACE_WIDGETS=off` behavior remains unchanged.
- Codex-style model instructions that keep one current step in progress, update the plan before scope pivots, avoid duplicating the whole checklist in prose, and exclude Chat Swarm workers from user-facing plan cards.
- **Goal Mode** as a separate persistent multi-turn harness: immutable objective/success criteria, ordinary visible ChatGPT rounds, strict criterion-evidence completion, repeated-blocker guard, pause/resume/stop control, restart recovery, and a compact Goal Dock.
- Native hidden Goal continuation through a backend **ClassicGoalHostBridge**. Each physical Goal turn calls `devspace_goal_turn_report` as its final tool call, then emits one visible final report. The zero-visual Relay/Goal Dock request app-only backend `dispatch`; the backend owns the lease and invokes ChatGPT Classic's raw hidden Tool follow-up transport. Public background widget `sendFollowUpMessage` is deliberately not used because Chat-mode third-party widgets require synchronous user activation. No synthetic user message or composer typing is introduced.
- **ClassicPrimaryDebugGuard** for canonical Main-01 host-bridge availability: protects an already-running long-lived primary when DevSpace starts, repairs only a fresh startup or later changed PID lacking loopback CDP 9721, uses an expected-PID race guard, preserves canonical package/protocol ownership, and falls back to normal Primary restore if a controlled debug restart fails.
- Atomic Goal continuation leases with release/expiry recovery, acknowledgement-race tolerance, idempotent round redemption, and an app-only continuation tool whose normal `dispatch` path performs claim -> Classic raw-host follow-up -> ack in the backend, preventing widget retries from normally creating duplicate assistant rounds.
- **Classic Stream Recovery** for supported Chat-mode Main runtimes. It arms only after a matching active-conversation `stream_status` transport failure, cancels on renderer progress/conversation change/Work mode, requires authoritative server `COMPLETE`, and performs at most one same-URL soft reload with cooldown protection. The feature is safe-on by default through `DEVSPACE_CLASSIC_STREAM_RECOVERY` / `classicStreamRecoveryEnabled`.
- **Context Guardian v2** for visible Main conversations, separate from Worker Auto Compact. It observes the active Classic-native model window, prefers fresh host usage when available, otherwise combines a CJK-aware conversation snapshot with a monotonic DevSpace ledger, and reserves prospective next-input/output/uncertainty headroom instead of using one fixed 90% Main threshold.
- Structured Main rollover checkpoints preserving Goal/Plan state, completed work, decisions, evidence, next steps, recent bounded visible context, and a do-not-redo frontier. Background Context Guardian polling is checkpoint-only and never navigates or sends a fresh Chat by itself; when an already-authorized Goal continuation actually requires rollover, DevSpace pairs a fresh Chat and starts through a native hidden Tool first turn with zero visible synthetic user messages. Hidden request rewriting fails closed rather than allowing a visible fallback.
- Explicit Chat-mode GPT-6 Pro compatibility from the live Classic-native model catalog (`gpt-6-pro`, `410000` tokens, `reasoning_type=pro`, not a Work-mode model), while new model variants continue to resolve from current native metadata rather than a hard-coded universal ceiling.
- A bounded Goal Round Completion Guard that re-drives the same working round only after Chat mode is non-generating and server `stream_status=COMPLETE`, preventing a hidden continuation that ended before `devspace_goal_turn_report` from silently stranding a long Goal.
- General-user Classic safety documentation covering Stream Recovery, Context Guardian, Main-vs-Worker continuity boundaries, configuration, privacy constraints, trigger rules, and deterministic/live verification.
- **Classic Host Overlay Projection** for the exact owning Chat-mode Main conversation: the newest projectable Goal is kept in a compact strip immediately above the Chat composer and the newest active Plan is kept in a compact top-right HUD. The host projection reuses the existing Context Guardian CDP sessions, reuses exactly one DOM root, binds ownership to `goalId + runtimeKey + conversationId`, hides on non-owner chats and in Work mode, persists only that bounded owner pointer across backend reloads, and transfers ownership only after verified Context Guardian rollover. GoalRuntime/PlanRuntime remain the sole state authorities and the transcript Goal Dock/Plan Card remain compatible fallback/control surfaces.

### Fixed

- Interactive Session Seed source discovery no longer treats a temporarily disabled composer as proof that a Main/Worker is signed out. A busy signed-in runtime remains a valid read-only CDP source; live Main-04 reseed acceptance selected Main-02 with `cdp-session-seed`, `PrimaryRestarted=false`, and an unchanged Main-01 PID, avoiding the unnecessary canonical Primary snapshot/restart fallback exposed during final v0.5 acceptance.

### Verification

- Plan runtime persistence/transition unit gate, MCP registration gate, widget/resource/instruction static gates, and an in-memory real MCP protocol gate covering tool discovery, app resource reading, step advancement, backend restart recovery, remount, and terminal completion.
- Goal runtime deterministic gates cover one-report-per-round, strict completion evidence, 3-round repeated blocker protection, exclusive continuation leases, release/timeout recovery, late-ack races, and idempotent round begin.
- A real in-memory MCP protocol/restart gate discovers all nine Goal tools, reads the Goal Dock and zero-visual Relay resources, runs three Goal rounds through an injected Host Bridge with pause/resume and terminal completion, rejects continuation after completion, and restores the exact final Goal from the same state directory after backend restart.
- Host Bridge + Primary Debug Guard deterministic/static gates cover 32 Main debug endpoints (Main-01 9721 plus Main-02..32 9732..9762), Chat-mode/goalId target selection, one raw dispatch, protection of a long-running existing Main-01, fresh/new-PID repair, expected-PID race safety, loopback-only debug flags, and protocol-owner preservation.
- Real Chat-mode production acceptance on Main-02 conversation `6a9b61f4-bfd4-83ee-be28-ee10b17fab4b` completed Goal `goal_3398ed2100f72784` with exactly one user message and three visible assistant rounds (`HOSTBRIDGE-R1`, `HOSTBRIDGE-R2`, `HOSTBRIDGE-R3-DONE`), pause/Resume behavior, automatic Round 2 -> 3 through ClassicGoalHostBridge, final `continuation=idle`, and no Round 4 during the bounded stop gate.
- Canonical Main-01 and isolated Main-02/Main-03 Chat-mode soak covered Goal/Plan continuity, same-round Goal recovery, context-pressure rollover, and repeated stale-renderer recovery without Work mode, synthetic continuation user messages, duplicate Goal rounds, or reload loops. Main-02 additionally proved the negative case: a deliberately stale DOM remained stale beyond the recovery grace period when no matching transport failure was recorded.
- Fresh hidden rollover acceptance created a new paired Chat with zero visible user messages and successfully called the backend-authoritative Plan tool before returning `CONTEXT-ROLLOVER-LIVE-OK STEP-4`.
- Main-03 Classic-native metadata observed GPT-6 Pro at a `410000`-token context window; deterministic Context Guardian model tests lock the compatibility behavior without making that value a global fallback.
- Host Overlay unit/static gates cover single-root projection, Chat-only refusal, DOM `textContent` safety, paused Goal visibility, current Plan-step derivation, composer/top-right anchor contracts, shared Context Guardian CDP lifecycle, exact runtime/conversation ownership, persisted owner-pointer reload recovery, and verified-rollover-only owner transfer.
- Dedicated Context Guardian, Stream Recovery, Classic safety, Goal, Plan, Host Overlay, MCP-session and continuity gates plus full `npm test`, `git diff --check`, and the fixed Cloudflare edge live gate pass on the v0.5 release tree.

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
