# Chat Swarm Classic — On-Demand Operator Contract

DevSpace Ultra uses an on-demand ChatGPT Classic worker pool. Four workers are the convenience default for direct ensure/status operations, but elastic scaling may choose a different pool size. Automatic Windows startup is intentionally not required.

## Stable roles

- Production runtime numbers: selected from Runtime-01..32 according to `desiredWorkers` and any operator-configured `reservedWorkers`.
- Reserved runtime numbers: optional standalone/private slots excluded from elastic production scaling. The public default is no reservation.
- Protected runtime numbers: stronger fail-closed safety for a currently interactive/misrouted runtime. Stop/repair/recover/minimize/autojoin/scale/update/managed Auto Compact must not mutate a protected runtime.
- Main ChatGPT conversation: orchestrator.
- DevSpace Chat Swarm backend: task routing, worker selection, queue state, submission, collection, continuity routing.
- CDP/UI automation: lifecycle only (open/restore worker conversation, bootstrap join, resume interrupted loop, dismiss blocking UI overlays, minimize).

## Normal main-agent flow

1. Make the production pool healthy with `chat_swarm_runtime_ensure` (default 4 workers). In a cached MCP session where the packaged runtime tools are not yet visible, use:
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/chat-swarm-classic-controller.ps1 -Action ensure -Count 4`
2. Inspect `chat_swarm_status` for the active swarm when one already exists.
3. Dispatch work through `chat_swarm_dispatch`; never route normal work by typing into worker UIs.
4. Collect through `chat_swarm_collect`.
5. If a claimed/execution-started task stalls and the mapped worker UI is idle or interrupted, recover only that worker with `chat_swarm_runtime_recover` (or controller `-Action recover -Worker N`), then collect again.
6. Never operate on runtime numbers the operator has placed in `reservedWorkers`; never attempt to override `protectedWorkers` merely to reach a desired pool size.

## Starting a fresh swarm

1. Ensure the desired production runtime range is available; use explicit `reservedWorkers` when standalone/private runtimes must remain untouched.
2. Create the new swarm with `chat_swarm_create`.
3. Bootstrap the desired worker range with `chat_swarm_runtime_autojoin` using the returned invite code. The controller automatically uses the configured `sub-agents` ChatGPT Project so new subagent conversations are created there rather than in top-level chat history.
4. Confirm the expected worker count with `chat_swarm_status` before dispatch.

## Recovery rules

- `too many requests` overlay: dismiss/acknowledge it only. Do not infer scheduler failure solely from that overlay; backend task/worker state is authoritative.
- `connection interrupted / waiting for complete response`: treat as unhealthy even if the UI still exposes a stop/generating control; recover the mapped worker conversation.
- Runtime process missing: on-demand ensure/recover starts the correct isolated package and navigates back to its saved exact conversation URL.
- Signed-out worker: login health is verified through the actual ChatGPT UI/CDP state, not profile-file existence. The controller may Session Seed the target from another verified signed-in runtime with allowlisted in-memory cookies; the source runtime is not stopped or navigated.
- Context pressure: managed Auto Compact marks the worker before its configured hard limit, waits for a safe idle boundary, then performs the A→B conversation handoff in the backend. Do not manually duplicate the worker when this happens.
- DevSpace restart: persisted swarm/task state survives; ensure/recover can resume the existing conversation-held workerToken without writing raw workerToken to controller state.
- Claimed task whose worker UI has become idle without submit: recover the same worker conversation, then collect again. Do not create a duplicate logical task unless backend state proves retry is required.
- Retry dispatch should use the same `taskKey` for idempotency.

## Persisted local state

`%LOCALAPPDATA%\DevSpace\ChatSwarmClassic\controller-state.json`

Contains worker/package/profile/debug-port/exact-conversation mappings, protected-runtime policy, and the configured `sub-agents` Project URL. It must not contain raw workerToken, orchestratorToken, continuation-ticket or cookie values.

## Packaged runtime MCP tools

- `chat_swarm_runtime_status`
- `chat_swarm_runtime_ensure`
- `chat_swarm_runtime_recover`
- `chat_swarm_runtime_autojoin`
- `chat_swarm_runtime_setup`
- `chat_swarm_runtime_stop`
- `chat_swarm_runtime_identity_status`
- `chat_swarm_runtime_identity_repair`

The convenience defaults for direct status/ensure/stop operations are scoped to Runtime-01..04, but protected runtimes are skipped/refused even when selected explicitly. Elastic scale has no reserved runtime number by default and always excludes protected runtimes through the controller's authoritative plan. A current ChatGPT MCP session can retain a cached older tool catalog after a DevSpace server restart; Auto Compact therefore redeems fresh-conversation continuation through the existing `chat_swarm_join` schema rather than requiring the old conversation to see a new tool name.

## Current validated boundary

The four-worker production path has live evidence for parallel dispatch, targeted routing, same-conversation continuity, zero-touch join, real multi-checkpoint idle soak, DevSpace restart, runtime kill/relaunch, interrupted-loop recovery, all-runtimes-closed recovery, `sub-agents` Project routing, and idempotent pool ensure. Internal validation also proved that an explicitly reserved standalone runtime can remain untouched while the production pool is operated.
