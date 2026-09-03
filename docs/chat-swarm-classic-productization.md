# Chat Swarm Classic Runtime Clone — Productization Record

## Verified milestone — 2026-08-18

Environment used for the successful live gate:

- DevSpace package: `@waishnav/devspace` 1.0.5
- ChatGPT Classic: 1.2026.190.0
- Four independently registered Windows package clones:
  - `OpenAI.ChatGPT-Desktop.Worker01`
  - `OpenAI.ChatGPT-Desktop.Worker02`
  - `OpenAI.ChatGPT-Desktop.Worker03`
  - `OpenAI.ChatGPT-Desktop.Worker04`
- Each clone had its own package family, user-data directory, root Electron process, login/session state, and ChatGPT conversation.

### Live swarm result

Swarm: `4-worker-classic-live-test`

Verified outcomes:

1. 4/4 independently running ChatGPT Classic workers joined one swarm with labels Runtime-01 through Runtime-04.
2. Four different tasks were dispatched concurrently and targeted to four different workers.
3. All four workers acknowledged execution, completed reasoning independently, and submitted backend-only results.
4. A second task was then targeted back to each same worker conversation without repeating the prior context marker.
5. All four workers recalled their own prior context correctly:
   - Runtime-01: `ORCHID-41`
   - Runtime-02: `COBALT-27`
   - Runtime-03: `EMBER-63`
   - Runtime-04: `LANTERN-88`
6. Final backend count for the gate: 8 completed tasks, 4 active workers.

This proves the core architecture works end to end:

`main ChatGPT orchestrator -> DevSpace Chat Swarm -> independent ChatGPT Classic runtime/conversation workers -> targeted parallel reasoning -> backend-only submit -> same-worker context continuity`

## Important implementation discovery

Windows treats `chatgpt://` as one global URI protocol default. Registering Worker01-04 simultaneously does not give per-origin callback routing. Whichever ChatGPT package is selected as the Windows default receives the OAuth callback.

Therefore production setup must treat authentication as an exclusive provisioning operation:

1. provision one worker runtime;
2. temporarily route `chatgpt://` to that worker;
3. complete its login and verify persisted session state;
4. move to the next worker;
5. restore the normal ChatGPT Classic protocol owner when provisioning is complete.

Normal worker operation must not depend on repeated OAuth routing after initial provisioning.

## Existing prototype utilities

- `scripts/chat-swarm-classic-runtime-clone.ps1` — register independent ChatGPT Classic package clones.
- `scripts/chat-swarm-classic-worker-launcher.ps1` — start a registered worker runtime.
- `scripts/chat-swarm-classic-auth-protocol.ps1` — enable/disable worker `chatgpt://` registration for provisioning.
- `scripts/chat-swarm-classic-auth-deeplink-probe.ps1` — OAuth/deep-link diagnostic helper.
- `scripts/chat-swarm-classic-session-clone.ps1` — experimental session-clone/provisioning helper; do not treat as the primary production auth path until separately validated.
- `scripts/chat-swarm-classic-worker-preload.cjs` — earlier singleton/userData experiment; package-identity cloning is the verified runtime-isolation mechanism.

## Productization target

The finished user experience should require interaction only with the main ChatGPT conversation during normal use. Worker windows may exist as independent runtimes but should be launched/minimized/monitored automatically.

Desired normal workflow:

1. One-time setup wizard creates N worker runtimes and guides/automates first login provisioning.
2. `Start Workers` launches the required workers, restores their known conversations, minimizes them, and verifies health.
3. Main ChatGPT creates or resumes a swarm and workers join/park with no manual prompt copying.
4. Orchestrator dynamically dispatches generic or sticky/targeted tasks.
5. Failed/stale workers are detected and recovered without disturbing healthy workers.
6. `Stop Workers` closes the swarm cleanly and then shuts down worker runtimes.

## Productization progress — 2026-08-18 15:39–15:55

Stage 1 and Stage 2 prototypes were implemented without modifying the already-proven Chat Swarm coordinator path.

### Stage 1 — unified lifecycle controller

Added `scripts/chat-swarm-classic-controller.ps1` with these actions:

- `setup` — register the requested worker runtime range using the proven package-identity clone path;
- `start` — launch only missing worker roots and minimize worker windows by default;
- `status` — report package registration, root process, responding state, profile/login evidence, automation/CDP port, and title;
- `minimize` / `restore` — manage worker windows without touching the primary ChatGPT process;
- `repair` — restart one isolated worker without deleting its profile;
- `stop` — stop only isolated worker runtimes;
- `autojoin` — invoke the Stage 2 bootstrap helper for a supplied swarm invite.

Live checks passed against the existing four workers: status detected 4/4 registered/running/responding/logged-in, `minimize` succeeded for 4/4, and `start` was idempotent with no duplicate worker roots. A fifth sacrificial runtime was also created and repaired through the controller to validate the automation launch path without risking the proven four-worker package/session setup.

### Stage 2 — automatic worker join bootstrap

Added `scripts/chat-swarm-classic-cdp-bootstrap.mjs` and validated local Chromium DevTools Protocol control by launching an isolated ChatGPT Classic worker with a unique loopback debug port.

The helper can:

- discover the ChatGPT renderer for that worker only;
- verify login/composer state;
- insert the exact worker bootstrap prompt directly into the ChatGPT composer;
- click the actual send control;
- leave the model to call `chat_swarm_join -> chat_swarm_next` normally through DevSpace.

A sacrificial fifth runtime was used for the end-to-end proof. Its logged-in state was copied from an existing isolated worker while the source profile itself remained unchanged, then the sacrificial runtime was launched on its own loopback CDP port. The controller/helper injected the join request for a fresh one-slot swarm with **no user copy/paste and no manual join interaction**. Backend verification showed the runtime joined successfully, then a targeted proof task completed and returned exactly `AUTOJOIN-STAGE2-PASS`.

This proves the manual join copy/paste step can be removed. The intended normal flow is now technically viable:

`orchestrator creates swarm -> controller starts/minimizes workers -> controller injects bootstrap per runtime -> ChatGPT worker joins and parks -> orchestrator dispatches normally`

Architecture boundary: CDP/UI control is a lifecycle/bootstrap mechanism, not the task-routing layer. Once a worker has joined and is parked, DevSpace Chat Swarm backend tools remain responsible for dispatch, worker selection, task state, submission, and collection. Runtime UI automation is used only when a worker must be started/bootstrapped/recovered at the UI layer or when a blocking UI overlay such as `too many requests` needs to be dismissed.

### Stage 2 final four-worker zero-touch gate — PASS

A fresh four-slot swarm (`stage2-final-zero-touch-4`) was created and Runtime-01 through Runtime-04 were restarted with isolated loopback CDP ports. No user copied an invite code into any worker and no worker window required foreground interaction. The controller/CDP bootstrap injected the join request into all four runtimes and automatically dismissed the blocking `too many requests` acknowledgement overlay when it appeared.

Runtime-01 and Runtime-02 joined on the initial bootstrap. Runtime-03 joined after a new-chat retry. Runtime-04 exposed a separate ChatGPT-side safety-check failure on the verbose bootstrap wording; a reduced bootstrap prompt (`--minimal`) that only asks for `chat_swarm_join` followed by `chat_swarm_next` succeeded without changing the backend protocol. Backend status reached 4/4 active workers.

The orchestrator then dispatched four targeted final-gate tasks concurrently and received the exact expected results from every worker: `ZERO-TOUCH-W01-PASS`, `ZERO-TOUCH-W02-PASS`, `ZERO-TOUCH-W03-PASS`, and `ZERO-TOUCH-W04-PASS`. Stage 2 therefore passes at the user-experience boundary: startup/join can be completed without user interaction. The orchestrator still supervises missing-worker detection and retry/fallback selection; folding those retries into one controller command is packaging polish rather than an architectural blocker.

### Stage 3 reliability work — live evidence

The DevSpace backend was deliberately restarted while the Stage 2 swarm remained active. Persisted swarm state survived the restart. Runtime-02 and Runtime-03 resumed their waits automatically. Runtime-01 and Runtime-04 were stale after restart, so the CDP helper's new `--resume` path injected a continuation request into their existing worker conversations, instructing each conversation to reuse its already-held workerToken. Four post-restart targeted tasks then completed successfully as `RESTART-W01-PASS` through `RESTART-W04-PASS`. This proves interrupted waits can be recovered without storing raw worker tokens in the local controller.

A kill-one-runtime test then stopped only the local Runtime-02 ChatGPT Classic process while Runtime-01/03/04 remained running. The three survivor workers continued normally. Runtime-02's already parked ChatGPT worker turn also continued server-side even though Controller status showed `Running=False`: it acknowledged and completed `RECOVERED-W02-PASS`. A later synthetic exact-string task reached execution but failed because the ChatGPT platform safety filter rejected that requested output; a subsequent natural arithmetic task completed successfully with result `323` while the Runtime-02 UI process was still closed. Runtime-02 was then relaunched and the four production runtimes were restored to running/logged-in/automation-ready state. A follow-up targeted continuity task after the relaunch asked Runtime-02 to recall its immediately previous arithmetic result without supplying the multiplication expression; it correctly returned `323` and identified the prior `17 × 19` task, proving same-conversation context continuity survived the local runtime kill/relaunch sequence.

This shows that an already parked worker execution can outlive its local UI process for multiple task/submit cycles. The later two-checkpoint lease soak also passed, but production should still launch/minimize each runtime and treat server-side continuation as resilience rather than as the primary lifecycle design.

The controller now persists a deterministic `worker number -> package/profile -> exact ChatGPT conversation URL` mapping in `%LOCALAPPDATA%\DevSpace\ChatSwarmClassic\controller-state.json` without persisting raw worker/orchestrator tokens. A state-merge bug was fixed so starting or updating a single runtime no longer erases mappings for the rest of the pool. `capture` records the current worker conversations, and `recover -Worker N` restarts only that runtime, navigates directly back to the saved conversation, dismisses blocking UI overlays, and sends a resume request only when the existing worker turn is not already active. Runtime-03 passed this targeted recovery path and immediately completed a post-recovery task (`37 + 58 = 95`) while Runtime-01/02/04 simultaneously completed survivor tasks.

A stronger interrupted-loop gate was then run against Runtime-04: the CDP helper deliberately stopped the parked worker turn, backend work was queued to that same worker, and the new recovery path reopened the exact saved conversation and resumed its existing workerToken. The queued task completed successfully with `44 + 27 = 71`. This proves deterministic recovery of an actually interrupted worker wait, not merely recovery of a hidden/minimized UI.

A cold recovery gate then stopped all four production runtimes simultaneously and recovered them only from saved controller mappings. Runtime-01/02/04 required a resume, while Runtime-03 initially restored an already-live server turn. Four targeted tasks were dispatched after recovery; Runtime-01 and Runtime-04 completed immediately. Runtime-02/03 exposed a separate ChatGPT renderer state (`connection interrupted / waiting for complete response`) that can appear while the UI still reports a generation in progress. The CDP probe now detects that state explicitly so `generating=true` is no longer treated as sufficient health evidence. Runtime-02/03 were recovered again and completed their original cold-gate tasks (`91` and `25 / +5 pattern`) without replacing their worker identities. The four-runtime cold-start/recovery gate therefore passes.

The genuine idle lease soak gate **PASSed**. Starting from checkpoint count zero at 2026-08-18T09:28:10Z, backend status later showed Runtime-01/02/03/04 checkpoint counts of `3 / 2 / 2 / 3`, so every worker crossed at least two real 20-25 minute lease boundaries. Four targeted post-soak tasks were then dispatched; after normal UI obstruction dismissal and deterministic resume of Runtime-01/03, all four completed successfully with `43`, `54`, `20 (+4 pattern)`, and `apple, banana, kiwi`. This closes the long-idle wake-up gate without relying on synthetic shortened checkpoint timing.

A coordinator fallback primitive, `recycleWorker`, was also added and unit-tested. It lets an orchestrator free a known-dead worker slot and safely requeue an unstarted claimed task; an execution-started task is protected unless the orchestrator explicitly uses `force=true`. The coordinator regression suite passes with normal recycle, guarded recycle, forced recycle, same-slot replacement, and the pre-existing routing/persistence tests. Client tool-catalog refresh still needs packaging verification before relying on this fallback in the current live ChatGPT conversation.

### Subagent project routing / recovery URL bug — FIXED

New worker conversations are now routed into the existing ChatGPT Project `sub-agents` instead of being created as ordinary top-level chats. Controller state v3 persists one validated `projectUrl` separately from per-worker conversation mappings, and `autojoin` navigates to that project before injecting the minimal join bootstrap. A live controller gate created a fresh worker conversation at a project-scoped route (`/g/g-p-...-sub-agents/c/...`) and the backend registered the worker successfully, proving the new subagent appears inside the `sub-agents` project.

The same fix closes an important recovery bug: project-scoped conversation URLs use `/g/g-p-.../c/...`, while the earlier canonicalizer and CDP safety validator only accepted top-level `/c/...` chats. Both controller capture/storage and CDP recovery navigation now explicitly accept validated project-scoped conversation URLs, so a worker created inside `sub-agents` can later be captured, restarted, and recovered without being rejected or accidentally converted back to a general chat.

The controller now uses the shorter `--minimal` join bootstrap by default because this already passed the live Stage 2 gate and reduces the ChatGPT-side safety-check failures seen with the verbose bootstrap. The `too many requests` overlay remains UI-only policy: dismiss it and continue; backend worker/task state remains authoritative.

Live project-routing evidence used Runtime-04 only as a temporary gate. After verification the test swarm was closed, Runtime-04 was returned to its original Stage 3 conversation, its production mapping was re-captured, and the persistent `sub-agents` project URL remained configured for future new workers.

### Final on-demand packaging / debug gate — PASS

The product lifecycle is now explicitly **on-demand** rather than Windows-startup-driven. The main ChatGPT/DevSpace agent can call one pool-level `ensure` operation whenever subagents are needed. `ensure` is idempotent: its convenience default starts any missing Runtime-01..04 instance with isolated local CDP, navigates each runtime back to its saved exact worker conversation, dismisses UI-only obstruction notices, detects interrupted renderer state, resumes the existing worker loop only when needed, and minimizes the windows. Elastic scaling separately supports operator-configured reserved runtime numbers, with no reservation in the public default.

A full cold pool gate was run against this packaged path: Runtime-01..04 were all stopped simultaneously while a separately reserved standalone runtime remained running. The first `ensure -Count 4` recreated all four production runtimes and restored their saved conversations; a second immediate `ensure -Count 4` was safe/idempotent. Controller status then showed 01..04 `Running=True / Responding=True / LoggedIn=True / Automation=True` while the reserved runtime remained outside automation.

That gate exposed one real final-debug bug: rapid sequential CDP helper processes could trigger a Node/Windows libuv assertion during WebSocket shutdown (`UV_HANDLE_CLOSING`). The helper previously called `process.exit(0)` while the built-in WebSocket close was still asynchronous. It now exits through normal async control flow and awaits a bounded graceful WebSocket close. An eight-run rapid CDP probe stress loop passed after the fix, and the complete stop-all -> ensure -> ensure sequence then completed without the assertion.

Four targeted post-cold-ensure tasks were dispatched. Runtime-02/03/04 completed normally (`96`, `13 / +3`, `alpha, charlie, delta`). Runtime-01 hit an intermittent OpenAI tool safety checker while submitting a synthetic short task; the backend recorded the failure with the correct computed result. A natural-language retry immediately completed successfully (`32`). This is treated as an upstream per-turn submit filter event rather than a lifecycle/routing failure; Runtime-01 remained healthy and reusable.

DevSpace now also registers a first-class runtime management tool surface for future MCP sessions: `chat_swarm_runtime_status`, `chat_swarm_runtime_ensure`, `chat_swarm_runtime_recover`, `chat_swarm_runtime_autojoin`, `chat_swarm_runtime_setup`, and `chat_swarm_runtime_stop`. The direct-tool convenience defaults target Runtime-01..04; elastic scaling accepts an explicit `reservedWorkers` list and reserves nothing by default in the public package. A ChatGPT conversation may retain a cached pre-restart MCP tool catalog, so the same operations remain available through the controller fallback in that session; a fresh/reconnected MCP session receives the packaged tool registrations directly.

### v0.3.1 runtime identity + long-context continuity hardening — PASS

A reboot/default-app failure mode was found during v0.3.1 work: legacy Worker-01..04 AppX registrations still advertised the global `chatgpt://` protocol even though the newer clone generator had already learned to remove it. Windows `UserChoice` on the validation machine was positively resolved to `ChatGPT Worker 04`, and the active user conversation was also positively identified as running inside Worker-04. This was treated as a runtime-identity bug, not as a one-off registry problem.

The v0.3.1 controller now persists `protectedWorkers` and enforces that policy at the lowest destructive stop path plus setup/ensure/recover/minimize/autojoin/scale/update/Auto Compact surfaces. A protected interactive runtime cannot be sacrificed to reach a worker-count target. Worker manifest migration audits both on-disk XML and Windows registered AppX state; inactive legacy workers are re-registered cleanly, while a running dirty worker is left alive as `pending-running` and a repeating deferred-heal task finishes the migration only after it closes naturally. Workers now use the dedicated AppX `Application Id` `DevSpaceWorker`, so only Primary retains `!ChatGPT`; stale Worker taskbar/default-app AUMIDs become non-activatable after migration. Loose-package re-registration explicitly preserves application data, and stale/unknown Windows `UserChoice` ProgIDs are reported as unhealthy instead of being misclassified as safe. The logon identity guard detects a running identifiable legacy protocol-owner worker, protects it, and activates the explicit Primary ChatGPT app without terminating the worker. A reboot-style live simulation preserved the exact Worker-04 PID/window while separately restoring a Primary window. A later live AUMID gate kept the active Primary on the same PID, preserved worker profile byte/file baselines, proved old Worker32/Worker04 `!ChatGPT` activation fails, and proved the new Worker32 `!DevSpaceWorker` activation succeeds.

The earlier filesystem-auth heuristic was also invalidated by live evidence: workers with `IndexedDB` could still show an expired session. v0.3.1 replaces that production path with CDP Session Seed. A completely fresh worker profile was confirmed signed out, then received only allowlisted ChatGPT/OpenAI cookies in memory from a verified signed-in source via CDP and became verified signed-in. A separate expired-worker gate proved that stale allowlisted target cookies must be deleted before applying the source session; after that replacement the worker recovered immediately. Cookie values were never logged/persisted and the protected source runtime kept the same PID/window.

Finally, managed Auto Compact was exercised end-to-end on a real ChatGPT Classic Runtime-07 conversation. Production policy remains `1,050,000` estimated tokens with a `945,000` trigger; for the live gate only, the configured window was temporarily reduced to `10,000` so the identical watchdog/handoff path could be crossed quickly. At the final pre-handoff sample the DOM estimator saw only `448` tokens while the monotonic Backend Context Ledger held `18,164`; the watchdog correctly used the larger value, producing an effective `19,164` estimate above the `9,000` test trigger. The backend built the capsule at an idle boundary, opened a new stable project-scoped conversation, redeemed through the existing `chat_swarm_join` schema, preserved the same `worker-01` identity with `continuationCount=1`, bound the fresh MCP session without exposing a replacement raw worker token, reset the context epoch, and the new conversation recalled the phase-1 marker/reference correctly. Production configuration was restored after the gate. The deterministic stress gate separately completed 500 ticket/credential rotations without identity drift or raw credential persistence.

### Safety / rollback observations

- The proven coordinator, runtime-clone, task-routing, submit, and continuity implementation was not replaced or rewritten; the controller and CDP bootstrap are additive layers.
- The original four-worker live-test swarm was closed cleanly after the productization experiment so stale lease loops do not keep consuming requests.
- The fifth validation runtime demonstrated that an operator-chosen reserved standalone runtime can remain isolated from production-swarm operations. This was a validation topology, not a hard-coded public reservation.
- A `too many requests` UI overlay was observed during rapid development. Product decision: treat this as a UI obstruction only unless the Chat Swarm backend itself proves the worker/task failed. The CDP helper should detect the overlay and click its dismiss/acknowledge control, then continue the bootstrap flow; it must not convert the overlay into scheduler throttling/failover policy by itself. Backend worker/task state remains the source of truth.
- During rollback testing, the first controller implementation exposed one local bug: PowerShell `Start-Process -ArgumentList` rejects an empty argument array on a normal non-automation start. The already-proven `chat-swarm-classic-worker-launcher.ps1` was used immediately to restore Worker01/02, then the controller was fixed to omit `-ArgumentList` when no launch flags are present. The repaired path was re-tested on the sacrificial fifth runtime and passed normal repair/status/stop.
- After rollback, the production four-worker set was verified again as 4/4 registered, running, responding, logged-in, non-CDP/normal launch mode and minimized. The earlier live-test swarm was intentionally closed cleanly; no package/profile/login rollback was required.

## Remaining release gates

### P0 — usable local product status

- **PASS:** One controller/runtime-tool surface provides Setup / Start / Ensure / Status / Recover / Stop.
- **PASS:** Manual per-worker join copy/paste was replaced by automatic bootstrap.
- **PASS:** Worker windows are automatically minimized and the primary ChatGPT UI is not targeted.
- **PASS:** runtime login is verified from live ChatGPT UI/CDP state rather than profile-file presence; fresh and stale-expired runtimes were restored through memory-only allowlisted Session Seed from a verified source without stopping that source.
- **PASS:** Worker-number -> package -> profile -> exact conversation mapping is persisted without raw worker/orchestrator tokens in normal controller state.
- **PASS:** Runtime closed, worker wait interrupted, DevSpace restart, renderer connection interruption, UI obstruction, and stale-but-resumable worker-loop recovery all have live evidence.
- **PASS:** package/version migration remains canary-first and now refuses protected runtimes; legacy worker identity registrations have a deferred self-heal path that never kills a running interactive worker.
- **DEFERRED MAINTENANCE:** Explicit uninstall/cleanup command for removing worker packages/profiles.

### P0 verification matrix

- **PASS:** Cold start from all worker runtimes closed -> saved conversation mappings restored all four worker runtimes and their targeted tasks completed.
- **PASS:** All four workers crossed at least two genuine 20-25 minute lease checkpoints and subsequently completed targeted work.
- **PASS:** Kill one worker runtime while the other three stay healthy -> isolated runtime relaunch/recovery completed without disturbing survivor workers; same-conversation continuity also survived.
- **PASS:** Restart DevSpace while workers exist -> persisted swarm state survived, interrupted waits were resumed, and four targeted post-restart tasks completed.
- **PASS for reboot-style identity simulation:** a legacy Worker protocol owner remained on the same PID/window while the logon guard protected it and explicitly restored a separate Primary window. A full physical OS reboot remains an optional release-soak check rather than a prerequisite for controller correctness.
- **PASS:** Close/recover and canonical-conversation gates reject transient `WEB:*` routes; only a stable server conversation ID is persisted. When an isolated session is signed out/expired, Session Seed can restore it from another verified signed-in runtime instead of trusting stale profile files.
- Targeted task goes only to its requested worker; generic tasks wake only as many workers as required.
- Cancel queued task and cancel claimed task; late submit from cancelled work must be rejected.
- Retry dispatch with the same `taskKey` -> no duplicate logical task.
- Worker failure/recovery must not leak task result/progress/idle messages into the user-facing worker chat.

### P1 — robustness / scale before wider use

- Run 4 workers for 1-2 hours with mixed short and long tasks.
- Run 10 workers and measure startup time, RAM, CPU, scheduling latency, and failure rate.
- Burst fan-out: 10-20 tasks with a mix of generic and targeted routing.
- Long-result and near-limit prompt tests.
- Multiple rounds of same-worker context continuity, including long intervening tasks.
- Verify no cross-worker context leakage by giving each worker unique hidden test facts and querying another worker.
- Test primary ChatGPT normal use while all workers are minimized and active.
- Test sleep/resume, Wi-Fi drop/reconnect, Tailscale reconnect, and ChatGPT renderer reload.
- Test ChatGPT Classic auto-update and DevSpace restart/update independently.

### P2 — polish

- Tray/controller status: worker count, Online / Parked / Busy / Recovering / Needs Login.
- One-click `Start 4`, `Start 10`, `Minimize All`, `Repair Worker`, `Stop All`.
- First-run onboarding that asks for worker count and walks through login only when necessary.
- Friendly diagnostics with exact remediation instead of raw PowerShell/package errors.
- Optional per-worker labels/specializations without forcing round-robin routing.
- Exportable sanitized diagnostic report for troubleshooting.

## Definition of done

Call the Classic multi-subagent mechanism a finished local product only when a normal session can be run as follows without manually arranging worker windows or copying join prompts:

`main agent requests subagents -> runtime ensure -> workers become healthy/parked in background -> backend parallel/sticky work succeeds -> recover only when needed -> stop on demand`

The 2026-08-18 Windows validation gates establish the usable local product path: four production workers can be created/restored on demand, run in the background, survive real lease boundaries and DevSpace/runtime interruption, retain same-conversation continuity, auto-bootstrap new workers inside a configured `sub-agents` Project, and remain isolated from any explicitly reserved standalone runtime. Automatic Windows startup is intentionally out of scope. Remaining work is optional hardening/scale/maintenance rather than a blocker for normal four-worker use.
