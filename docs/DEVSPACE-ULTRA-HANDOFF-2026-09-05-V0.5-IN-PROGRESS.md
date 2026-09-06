# DevSpace Ultra v0.5 In-Progress Handoff — 2026-09-05

> **Purpose:** Single rolling handoff for the v0.5 work now in progress. Update this file after every independently verified feature/gate so a fresh ChatGPT Classic conversation can continue without reconstructing the prior conversation.
>
> **Secondary recovery capsule:** `capsule_304f1fa23626e7cb` (`continuityKey=devspace-ultra-v0.5-goal-mode-2026-09-05`) captures the latest Goal Mode Host Bridge / Primary Debug Guard state if this chat ends before the next handoff update.
>
> **Current development order:**
> 1. Codex-style long-task Plan / Step Card — **implemented and production-live verified**
> 2. Goal Mode — **IMPLEMENTED + Main-02 and canonical Main-01 Chat-mode production acceptance PASS; Goal completed; visible-report persistence and Stream Recovery fixes production-loaded**
> 3. Main Context Window / Auto Compact v2 — **research findings captured; implementation is now the next development track after final visible Goal round closure**

---

## 0. Latest live acceptance checkpoint

### Goal Mode Main-02 production Host Bridge acceptance — PASS

Canonical current product evidence:

```text
conversation = 6a9b61f4-bfd4-83ee-be28-ee10b17fab4b
goal = goal_3398ed2100f72784
surface = Chat mode only
```

- Round 1 visible final: `HOSTBRIDGE-R1`; backend then remained `paused / round1 / reported / continuation=idle`.
- Bounded 4-second pause gate produced zero extra user/assistant turns.
- Goal Dock Resume was the sole user control needed to continue.
- Round 2 visible final: `HOSTBRIDGE-R2`; the fresh zero-visual Relay called app-only backend `action="dispatch"`.
- Backend `ClassicGoalHostBridge` located the exact Main-02 Chat-mode Goal widget by `goalId`, extracted the existing raw ChatGPT host API beneath the public widget authorization wrapper, and started Round 3 through the native hidden Tool follow-up transport.
- Round 3 visible final: `HOSTBRIDGE-R3-DONE`.
- Final transcript was exactly **1 user + 3 assistant messages**, with no synthetic user message.
- Final backend state: `completed / round3 / reported / revision=13 / continuation=idle`, with evidence for all three stored success criteria.
- One persistent Goal Dock remained; three expected 1px per-round Relay instances were present.
- Bounded 5-second completion-stop gate produced no Round 4.

Transport correction now considered authoritative:

- public background widget `window.openai.sendFollowUpMessage` is **not** a valid autonomous third-party transport in Chat mode because the public wrapper has `hostHandlesFollowUpMessageAuthorization=false` and requires synchronous user activation;
- the original successful CDP probe was misleading because it used `Runtime.evaluate(... userGesture=true)`;
- raw native ChatGPT host follow-up below that wrapper was live-proven with `userGesture=false` and preserves hidden Tool-message / `completionType=Next` semantics;
- production continuation is therefore Relay/Dock -> app-only backend `dispatch` -> lease -> `ClassicGoalHostBridge` raw native host follow-up -> ack.

### Canonical Main-01 closure gate — PASS

Canonical Main-01 was deliberately and safely restarted only after the rolling handoff/checkpoint was current. `ClassicPrimaryDebugGuard` established loopback CDP 9721 while preserving the canonical package and `chatgpt://` protocol ownership:

```text
Main-01 PID before = 3656
Main-01 PID after  = 11584
CDP               = 127.0.0.1:9721
ProtocolCanonical = true
```

Canonical acceptance Goal:

```text
goal = goal_0a5086a710226835
round = 3
status = completed
revision = 11
completedAt = 2026-09-05T02:05:44.161Z
continuation = idle
```

Main-01 frontend DOM was inspected after the user reported that a round summary appeared to disappear. The transcript still contained all three ordinary visible assistant reports: `MAIN1-GOAL-R1`, `MAIN1-GOAL-R2`, and `MAIN1-GOAL-R3-DONE`. This established a frontend synchronization/stale-render issue rather than backend deletion. The production Visible Report Commit Gate now blocks hidden continuation until Chat mode + `stream_status=COMPLETE` + non-generating + non-empty visible assistant text + post-`reportedAt` settle all hold. Stream Recovery Guard is also production-live and reconciles a completed server turn when the Classic renderer stalls.

Completion evidence for all three Goal criteria is now stored in GoalRuntime. Completing the Goal set continuation to `idle`, so no Round 4 is eligible. The only remaining action in this physical round is the final `devspace_goal_turn_report`, followed by the permanent user-visible final report; no further tool calls are allowed after that report tool.

---

## 1. Repository / release baseline

Primary package checkout:

```text
C:\Users\enwong\AppData\Roaming\npm\node_modules\@waishnav\devspace
```

Release baseline before v0.5 work:

```text
main / origin/main / v0.4.0 = 25b3bd43fd8cfc5efd1565ed501792cdf46f8b4d
```

v0.5 Plan / Step Card work has now been checkpoint-committed locally on top of v0.4.0 and is not yet pushed or published as a new release.

Current local checkpoint:

```text
5998b3a feat: add persistent plan progress card
```

Production fixed MCP identity remains:

```text
https://devspace-ultra-mcp-edge.enwong93.workers.dev
```

Fixed backend:

```text
127.0.0.1:7677
Scheduled Task: DevSpace-Fixed-Backend
```

Named tunnel task:

```text
DevSpace-Fixed-Edge-Tunnel
```

Last observed after the Plan Card deploy/live gate:

```text
fixed backend PID: 16348
fixed backend start time: 2026-09-05 04:27:10 +08:00
named tunnel PID: 33872
```

PIDs are operational observations, not durable configuration. Re-probe them after reboot/restart.

Fresh fixed-edge gate after backend reload passed:

```text
/healthz = 200
/mcp = 401 with OAuth challenge
/.well-known/oauth-protected-resource/mcp = 200
/.well-known/oauth-authorization-server = 200
private Browser Control surface through public edge = 404
```

The named tunnel was not restarted while the fixed backend was reloaded.

---

## 2. Feature #1 — Codex-style Plan / Step Card

### Status

**IMPLEMENTED + production-live verified in real ChatGPT Classic Main-02.**

This is not just a visual checklist. The backend owns structured plan state; the MCP App card is a view over that state.

### Core files

```text
dist/plan-runtime.js
dist/plan-runtime.test.js
dist/plan-tools.js
dist/plan-tools.test.js
dist/ui/plan-card.html
scripts/plan-server-static-gate.mjs
scripts/plan-card-static-gate.mjs
scripts/plan-resource-static-gate.mjs
scripts/plan-instructions-static-gate.mjs
scripts/plan-progress-live-gate.mjs
docs/superpowers/specs/2026-09-05-plan-progress-card-design.md
docs/superpowers/plans/2026-09-05-plan-progress-card.md
```

Modified integration files:

```text
dist/server.js
package.json
docs/chatgpt-coding-workflow.md
CHANGELOG.md
```

### Tool surface

```text
devspace_plan_start
devspace_update_plan
devspace_plan_status
devspace_plan_mount
```

Behavior contract:

- `devspace_plan_start` creates the authoritative plan and mounts the card.
- `devspace_update_plan` changes backend state only; it does **not** mount another card.
- `devspace_plan_status` is read-only and callable by model + MCP App so the widget can refresh itself.
- `devspace_plan_mount` is a read-only recovery/remount path for renderer reload / later turn / lost card.
- Active plan: exactly one step is `in_progress`.
- Existing `pending` step cannot jump directly to `completed`.
- Completed step cannot regress.
- All steps completed => terminal completed plan; terminal plan is immutable.
- Plan state persists in `stateDir/plan-state.json` and survives backend restart.
- Chat Swarm workers must not mount user-facing plan cards.

### UI architecture

Resource:

```text
ui://devspace/plan-card.html
```

It is independent of `DEVSPACE_WIDGETS`; ordinary per-tool cards remain off by default.

The card:

- mounts once from initial tool result;
- polls `devspace_plan_status` through `window.openai.callTool`;
- updates in place without creating a new iframe on every plan update;
- shows title, current step, `Step X / N`, elapsed time and expandable steps;
- uses ChatGPT host theme variables;
- opportunistically requests PiP while active, with safe inline fallback;
- stops polling when completed.

### Deterministic verification

`npm test` in the real package checkout passed after integration. `verify:plan` includes:

```text
plan-runtime
plan-tools
plan-server-static
plan-card-static
plan-resource-static
plan-instructions-static
plan-progress-live
```

The in-memory real MCP protocol gate verified:

- all four tools discoverable;
- resource readable with `text/html;profile=mcp-app`;
- update without render remount;
- backend restart with same `stateDir` restores revision;
- terminal completion.

Original v0.4 regression suites also stayed green: edge/OAuth, ContextBridge, runtime identity, Chat Swarm, Browser Control, capabilities and existing continuity tests.

### Real ChatGPT Classic live acceptance

Main-02 CDP port used for acceptance:

```text
9732
```

The fixed DevSpace Ultra plugin initially had an old host-cached tool schema. In the ChatGPT Classic plugin management dialog, before Refresh:

```text
devspace_plan_start = absent
devspace_update_plan = absent
devspace_plan_status = absent
devspace_plan_mount = absent
cached developer-mode tool text length ≈ 65,699 chars
```

After the official **重新整理 / Refresh** button:

```text
all four plan tools = present
cached developer-mode tool text length ≈ 69,366 chars
```

This is the correct way to refresh the installed plugin's tool snapshot after adding tools.

Acceptance conversation:

```text
https://chatgpt.com/c/6a9b3140-3690-83e8-beb7-5265b0b61f9e
```

Acceptance plan:

```text
plan_0daebd76f81770cb
```

Final backend state:

```text
status = completed
revision = 4
steps = 3/3 completed
```

The ChatGPT host mounted a real iframe:

```text
title = ui://devspace/plan-card.html
sandbox app = asdk_app_6a9acb1baab08191872d7b7e04ccdb43
width = 672
height = 59
```

Most important UX gate:

- after revision 1 -> 2, there was still exactly **one** plan-card iframe;
- after revision 2 -> 3 -> 4 and terminal completion, there was still exactly **one** plan-card iframe;
- no new widget was mounted for `devspace_update_plan`.

Direct inspection of the MCP App inner execution context at terminal state showed:

```text
Plan card live acceptance
Completed
3 / 3
```

while `window.openai.toolOutput` still contained the original revision 1 payload. Therefore the terminal UI was genuinely updated by the widget's subsequent `callTool(devspace_plan_status)` polling rather than by a remounted/new tool output.

### Main-02 operational note

`chat_main_runtime_manage(action=status, mainNumber=2)` produced an error during this work even though Main-02 itself was healthy. Direct probes showed:

```text
CDP 9732 = healthy ChatGPT page
composer = ready
login = valid
Main-02 process = running
```

Treat this as a separate manager-wrapper bug; do not confuse it with a Main-02 runtime or Plan Card failure.

---

## 3. Feature #2 — Goal Mode

### Status

**IMPLEMENTATION IN PROGRESS IN ISOLATED WORKTREE. TASK 1 GOAL CORE PASS.**

Current Goal Mode worktree:

```text
C:\Users\enwong\.devspace\worktrees\devspace-fd66e55d
base = 7b38a8f
Task 1 checkpoint = 3272219 feat: add goal runtime core
```

Task 1 verified behavior:

```text
GoalRuntime({ stateDir, now?, dispatchLeaseMs?, dispatchRecoveryMs? })
start({ objective, successCriteria })
status(goalId)
control({ goalId, action: pause | resume | stop })
close()
```

Fresh gate output:

```text
{"ok":true,"gate":"goal-runtime-core","persisted":true,"restartRecovered":true,"controls":["pause","resume","stop"],"terminalStopped":true}
```

Core state now includes round 1=`working`, immutable objective/criterion IDs, idle continuation placeholder, blocker placeholder, serialized persistence, clone-on-return and corrupt-state fail-open recovery.

Task 2 checkpoint:

```text
9e90c7b feat: add goal round reporting and audit
```

Task 2 verified APIs:

```text
turnReport({ goalId, summary, meaningfulProgress, blockerFingerprint? })
complete({ goalId, evidence })
markBlocked({ goalId })
```

Fresh combined gate output:

```text
{"ok":true,"gate":"goal-runtime-core","persisted":true,"restartRecovered":true,"controls":["pause","resume","stop"],"terminalStopped":true,"reportOnce":true,"completionCoverage":true,"blockerFoundation":true}
```

Verified Task 2 invariants: one report per round; active report creates pending continuation; completed final report creates none; completion evidence covers every criterion and rejects missing/unknown/empty evidence; blocker fingerprints normalize consistently; blocker below 3 rounds is rejected; meaningful progress resets blocker state; reported Pause clears continuation and Resume recreates it.

Task 3 checkpoint:

```text
7bafade feat: add goal continuation lease runtime
```

Task 3 verified APIs:

```text
continuation({ goalId, action: claim | ack | release, leaseId? })
roundBegin({ goalId, continuationId })
```

Fresh combined GoalRuntime gate includes:

```text
exclusiveLease=true
releaseRecovery=true
ackRace=true
roundBeginIdempotent=true
dispatchRecovery=true
blockedThreeRounds=true
```

Verified continuation rules: one live lease per pending continuation; release/45s lease expiry preserves the same continuation ID and returns it to pending; acknowledged dispatch uses a 120s recovery deadline; matching `roundBegin` increments exactly once and clears continuation; duplicate round-begin is idempotent; late ack after consume is harmless; a matching pending continuation may still be consumed after conservative expiry normalization; full public 3-round blocker flow reaches count 3 before `markBlocked` is allowed.

Task 4 checkpoint:

```text
529a051 feat: expose goal mode tools
```

Task 4 registered nine Goal tools. `devspace_goal_continuation` is app-only; start/mount are the only render tools; status/control are model+app; round-begin/report/complete/blocked are model-only mutations. Fresh gates: `goal-tools` PASS with `tools=9`, `continuationAppOnly=true`, `renderTools=2`; `goal-server-static` PASS. Server now owns one shared GoalRuntime, registers `ui://devspace/goal-dock.html` independently of `DEVSPACE_WIDGETS`, and closes GoalRuntime on shutdown.

Task 5 checkpoint:

```text
dcd64a8 feat: add goal continuation dock
```

Goal Dock files:

```text
dist/ui/goal-dock.html
scripts/goal-dock-static-gate.mjs
```

Task 5 design gates applied: OpenDesign canonical router, `frontend-design`, `linear-app`, craft `typography` / `color` / `anti-ai-slop`, `design-taste-frontend`, and the existing Plan Card as project-owned UI convention.

The Dock is self-contained and host-themed. It polls `devspace_goal_status`, exposes Pause/Resume/Stop by Goal state, uses a local `dispatchInFlight` guard, claims app-only continuation leases, dispatches through `window.openai.sendFollowUpMessage`, acknowledges explicit success, releases only explicit `{ok:false}` rejection, and leaves ambiguous send transport failures to lease-expiry/round-redemption recovery instead of risking duplicate assistant turns. It stops normal polling on completed/stopped Goals and keeps polling paused/blocked so user controls remain live.

Fresh Task 5 gates: Goal runtime PASS, Goal tools PASS, Goal server static PASS, Goal Dock static PASS, visible-copy forbidden dash gate clean, `git diff --check` PASS.

Task 6 checkpoint:

```text
c05a24f feat: teach agents goal mode rounds
```

Task 6 adds a separate Goal instruction block to both DevSpace tool modes. It enforces the visible-report-before-`devspace_goal_turn_report` invariant, makes that report tool the final action of each Goal turn, requires `devspace_goal_round_begin` first on hidden continuation turns, forbids CDP/composer/fake-user continuation, requires authoritative evidence for all success criteria, respects the 3-round blocker guard, limits pause/stop to explicit user control, and excludes Chat Swarm workers from user-facing Goal Mode. Fresh `goal-instructions-static` gate PASS.

Task 7 checkpoint:

```text
e82ae0d test: verify goal mode end to end
```

Task 7 added `verify:goal`, integrated it into `verify:ultra`, and added the real in-memory MCP protocol/restart gate `scripts/goal-mode-live-gate.mjs`.

Fresh Goal protocol result:

```text
{"ok":true,"gate":"goal-mode-live","tools":9,"resourceMimeType":"text/html;profile=mcp-app","finalRound":3,"finalStatus":"completed","restartRecoveredRevision":12,"duplicateRoundBeginBlocked":true,"pauseResumeContinuation":true}
```

The real MCP gate covers Goal tool discovery, Goal Dock resource read, round-1 report, continuation claim/ack, round-2 redemption, duplicate redemption idempotency, round-2 report, pause clearing continuation, paused claim rejection, resume with a fresh continuation, round 3, criterion-complete evidence, final report without continuation, mount recovery, and exact terminal-state recovery after backend restart.

Task 7 also found and fixed a protocol-level error-schema bug: an expected Goal tool error must return `isError + content` without success-shaped `structuredContent`; otherwise the MCP Client validates the error payload against the success output schema and upgrades it into protocol `-32602`.

### Task 8 integration status

Goal Mode executable/source files have now been synchronized from the detached worktree into the real main checkout with EOL-insensitive exact comparisons. The matched set includes Goal runtime/tests, Goal tools/tests, Goal Dock, four Goal gates, `dist/server.js`, `package.json`, Goal spec and Goal implementation plan.

Native main-checkout verification is GREEN:

```text
npm run verify:goal -> PASS
npm test -> PASS
git diff --check -> PASS
```

The full native regression still passes edge/OAuth, ContextBridge, Plan Card, Goal Mode, runtime identity, Chat Swarm, Browser Control, capability runtime and existing conversation-continuity/Auto Compact gates. Task 8 has not yet reloaded production 7677 or started the Main-02 live Goal acceptance.

Formal documents:

```text
docs/superpowers/specs/2026-09-05-goal-mode-design.md
docs/superpowers/plans/2026-09-05-goal-mode.md
```

The user explicitly corrected the continuation semantics: Goal Mode must work as normal visible ChatGPT turns, not an invisible endless backend loop.

### Required round semantics

For every Goal round:

```text
assistant does meaningful work
-> verifies current progress
-> performs completion audit
-> gives the user a complete visible round summary/report
-> marks that round reported through the Goal runtime gate
-> current assistant turn ends
-> Goal runtime audits authoritative goal state
-> if completed: stop Goal Mode
-> if active: automatically start the next assistant turn
```

The critical invariant is:

> **Never auto-continue before the current round has already given the user its visible summary.**

The user must receive a summary every physical Goal turn.

### Goal vs Plan separation

These are separate state machines:

```text
Goal = persistent final objective / why the agent keeps going
Plan = current execution route / how this phase is being worked
```

A Plan may change/rewrite many times under one Goal. Goal completion must not be inferred from Plan completion.

### Codex principles to borrow

Use the mature Codex Goal design principles:

- persistent objective across physical turns;
- do not silently shrink the original objective to an easier sub-goal;
- completion requires current authoritative evidence for every explicit requirement;
- weak/indirect/missing evidence means the Goal remains active;
- model cannot casually pause itself;
- blocked state should require repeated evidence of the same blocker rather than one failed attempt;
- Goal state is authoritative backend state, not UI state.

Relevant Codex concepts already researched:

```text
create_goal / get_goal / update_goal
persisted goal runtime
active goal + idle continuation
strict completion audit
user/system pause/resume authority separate from model completion/blocked authority
```

### Important live discovery: supported continuation transport exists

The Plan Card MCP App exposes:

```text
window.openai.sendFollowUpMessage = function
window.openai.callTool = function
window.openai.requestDisplayMode = function
```

A real Main-02 live probe called:

```text
window.openai.sendFollowUpMessage({
  prompt: "[DEVSPACE_GOAL_CONTINUATION_PROBE] Reply exactly: goal continuation probe received",
  scrollToBottom: false
})
```

Result:

- a new assistant turn started automatically;
- **no fake user message appeared in the transcript**;
- transcript only gained the assistant response `goal continuation probe received`.

This is a major architectural result: Goal continuation should use the ChatGPT host-supported `sendFollowUpMessage` path from a Goal Dock MCP App, not CDP typing into the composer.

### Proposed Goal tool/control surface

Initial approved direction:

```text
devspace_goal_start
devspace_goal_status
devspace_goal_turn_report
devspace_goal_complete
devspace_goal_blocked
devspace_goal_control
```

Authority split:

- model may start/read/report rounds and mark complete/blocked under strict validation;
- user-facing Goal Dock controls pause/resume/stop;
- model must not arbitrarily pause/stop the Goal to avoid work.

### Proposed Goal state

At minimum:

```text
goalId
objective
status: active | paused | blocked | completed | stopped
round
createdAt
updatedAt
completedAt
lastRoundReport
lastRoundReportedAt
continuation state
blocker fingerprint / consecutive blocker rounds
```

### Round-report gate

`devspace_goal_turn_report` must be called **after** the assistant has already produced the visible user summary for the round. Its tool result should instruct the model to end the turn and emit no additional visible summary text.

The Goal Dock then claims a one-time continuation lease and calls `sendFollowUpMessage` only after the round-report state is durable.

### Continuation de-duplication

Do not simply poll `active=true` and send repeatedly. Use an atomic one-time lease/state machine, e.g.:

```text
round N reported
-> continuation pending
-> Goal Dock claims lease
-> sendFollowUpMessage()
-> acknowledge dispatch
-> round N+1 begins
```

Renderer reload, duplicate poll, network retry or two mounted Goal Docks must not create duplicate next rounds. Leases must expire/recover safely when dispatch fails.

### Goal Dock UI

Keep it small. It is not a second Plan Card/checklist.

Suggested visible fields:

```text
Goal objective
Active / Paused / Blocked / Completed
Round N
Elapsed time
continuation state
Pause / Resume / Stop controls
```

Plan checklist remains in the Plan Card.

### Next implementation work

The formal spec and implementation plan are now written. Next:

1. checkpoint the Goal Mode design/spec/plan + this handoff update locally;
2. implement in an isolated worktree based on that checkpoint (which already includes Plan Card commit `5998b3a`);
3. TDD in this order:
   - GoalRuntime persistence/authority/state transitions;
   - round-report + one-time continuation lease;
   - MCP Goal tools;
   - Goal Dock MCP App;
   - host `sendFollowUpMessage` continuation loop;
   - pause/resume/stop user controls;
   - completion/blocked audit guards;
   - real MCP protocol gate;
   - Main-02 live multi-round acceptance proving each round visibly reports before auto-continuation and stops on completion.

Do not begin Context Guardian v2 until this is complete and verified.

---

## 4. Feature #3 — Main Context Window / Auto Compact v2

### Status

**ACTIVE under Goal `goal_deac9fadb6bc67dd` / Plan `plan_dfc1ea0e2b285119`. Step 1 live re-audit completed; dynamic model detection implementation is next.**

### 2026-09-05 live re-audit — authoritative findings

- Canonical Main-01 is running Chat mode with `data-message-model-slug="gpt-5-6-thinking"`.
- ChatGPT Classic's own authenticated/native `GET /backend-api/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true` response reports:
  - `gpt-5-6` => `max_tokens=137000`
  - `gpt-5-6-thinking` => `max_tokens=262144`
  - `gpt-5-6-pro` => `max_tokens=410000`
- The Work-mode-only `/backend-api/tpp/models/` catalog also reports 262144 for `gpt-5.6-sol-wm`, but Work mode is out of product scope and is not used for acceptance.
- A plain page `fetch()` to the same models endpoint can receive a reduced/different catalog (`max_tokens≈34834`) because it lacks ChatGPT's native host request context. Context Guardian must therefore observe the native Classic request/response or equivalent host state; it must not independently refetch and trust that result.
- Conversation GET, `/backend-api/f/conversation/prepare`, and the short conduit/resume handoff response do not expose a reliable exact input-token-used counter. Exact host usage therefore remains optional/highest-priority evidence when found, with the DevSpace ledger as required fallback.
- `context_truncation_continuation` exists in conversation records but is currently null in the live Main-01 conversation; no proven controllable same-conversation native compact path exists yet. Do not claim one until a live token-drop gate proves it.

### Soak-discovered fixed-backend OOM — root cause and fix

The long Goal/Plan/Stream-Recovery soak exposed a separate production liveness defect: fixed backend PID 32244 died at the V8 ~4 GB heap limit, causing the DevSpace Ultra connector to return 502 until backend restart.

Evidence:

- `fixed-backend.err.log`: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` around 4093 MB heap.
- accumulated log before the fix: `mcp_session_created=4233`, `mcp_session_closed=0`;
- the final old-process window created 819 stale sessions; a newly restarted old-code process reached ~1.17 GB private memory after ~154 seconds and ~2.2 GB after ~345 seconds.
- root cause: `McpSessionRegistry` retained abandoned OpenAI MCP reconnect sessions for 24 hours while ChatGPT/OpenAI MCP creates sessions at high frequency; each session owns a full MCP server/tool graph.

TDD fix now in the main working tree and production-loaded:

- `McpSessionRegistry.acquire/release` protects long in-flight calls from cleanup;
- idle stale sessions use a 30-second window instead of 24 hours;
- cleanup runs every 5 seconds;
- inactive sessions have a hard cap of 32;
- cleanup always calls `transport.close()` rather than only deleting Map entries;
- `verify:mcp-sessions` and `mcp-session-lifecycle-static` are part of full `npm test`;
- full regression passed before detached backend-only reload.

Continue to collect live memory/session-close samples during this Goal soak before declaring the leak closed.

### Root cause found in v0.4

Two architecture gaps explain why a long Main conversation could still hit the host context limit.

#### Gap A — wrong fixed context denominator

v0.4 continuity currently uses a hardcoded default near:

```text
1,050,000 tokens
```

for ChatGPT Classic pressure math.

Direct live inspection of ChatGPT Classic's own client model metadata showed model-specific `maxTokens` values instead:

```text
gpt-5-6 / Instant         137,000
gpt-5-6-thinking          262,144
gpt-5.6-sol-wm            262,144
gpt-5-6-pro               410,000
gpt-5-6-mini              137,000
gpt-5-6-t-mini            262,144
```

The user normally uses GPT-5.6 Sol Thinking and sometimes GPT-5.6 Pro, so the context budget must be selected from the **currently active ChatGPT Classic model variant**, never a single fixed constant.

#### Gap B — Main conversations are currently excluded

The existing v0.4 Auto Compact watchdog primarily supervises managed Chat Swarm workers. Protected interactive Main runtimes are explicitly skipped.

Therefore Main-01 / Main-02 / Main-03 — the conversations most likely to run for hours — are not protected by the current automatic continuity path.

### Step 2 dynamic model-window implementation — production live PASS

New product files:

```text
dist/context-guardian.js
dist/context-guardian.test.js
dist/context-guardian-cdp.js
dist/context-guardian-cdp.test.js
scripts/context-guardian-static-gate.mjs
```

Current behavior:

- `ContextGuardianRuntime` persists only safe model/runtime metadata under the fixed state directory;
- `ClassicContextMetadataCdpAdapter` observes Main-01..32 loopback CDP surfaces;
- native `/backend-api/models` responses are passively parsed to safe fields only (`slug`, `maxTokens`, title, reasoning type, Work-mode flag);
- outbound `/backend-api/f/conversation` requests contribute only model slug, thinking effort and conversation identity; prompt text, Authorization, cookies and conduit/resume tokens are discarded;
- DOM snapshots seed the active Main model before its next turn request;
- unknown models remain unresolved instead of falling back to 1.05M;
- `context_guardian_status` is a read-only MCP tool for the current model/window state;
- full `npm test` and `git diff --check` passed before fixed-backend reload.

Production live evidence after reload:

- persisted native catalog contains `gpt-5-6-thinking=262144`, `gpt-5-6-pro=410000`, `gpt-5-6=137000`;
- Main-01/02/03 were all seeded as Chat-mode `gpt-5-6-thinking`;
- a real harmless Main-03 turn was observed as `modelSource=native-turn-request`, `thinkingEffort=max`, window `262144`;
- Plan Card stayed live and updated in the real Main-01 frontend from `Step 1 / 7` to `Step 2 / 7`.

Step 3 accounting decision engine has also begun under TDD. `computeContextGuardianPressure` now prefers fresh host-measured usage when available, otherwise uses the higher snapshot/monotonic-ledger estimate, and calculates dynamic output + uncertainty headroom. It produces `normal/watch/prepare/rollover` plus `shouldRolloverBeforeNextRequest`; no blind fixed 90% trigger is used. Conversation snapshot/ledger CDP feeding remains the next implementation gate.

### MCP session OOM soak follow-up

Post-fix live samples show stale-session cleanup is active every 5 seconds, closing roughly 3-5 abandoned sessions per sweep and holding inactive registry size around 24-28. At ~86.7 seconds the repaired backend was ~379 MB private memory versus >1.1 GB by ~154 seconds on old code. A later post-Context-Guardian reload was ~656 MB at ~135 seconds while cleanup remained active; continue multi-minute samples before declaring the leak fully closed, but the prior unbounded 4 GB trajectory is no longer present.

### Required future architecture

Context Guardian v2 should follow Codex-harness principles:

1. determine current Classic model variant and its real client `maxTokens` dynamically;
2. obtain actual server usage if a reliable ChatGPT stream/message metadata signal can be found;
3. maintain a local monotonic DevSpace context ledger as an independent lower bound;
4. predict the **next** request size before injecting a large tool/browser/file payload;
5. preserve output/safety headroom rather than using one blind fixed 90% trigger;
6. cover interactive Main conversations, not just workers;
7. compact/roll over before the host hard limit is reached.

### Native in-place compact question remains open

The biggest research question is whether ChatGPT Classic exposes any supported/internal control that can truly replace/summarize prior server-side conversation context and reduce the host's actual input token usage in the same conversation.

Current supported MCP Apps APIs do **not** yet prove that ability.

If no reliable native compact control exists, the safe architecture is seamless conversation rollover:

```text
Main conversation A approaches safe limit
-> create canonical compact checkpoint
-> structured Goal / Plan / execution frontier / decisions / evidence / workspace state
-> create conversation B
-> restore checkpoint
-> continue the same logical Goal
```

This should feel like one continuing task even though the host conversation changes.

### Compaction content must be structured

Do not rely on a single prose summary. Preserve at least:

```text
Goal objective + success criteria + status
Plan completed/current/pending
execution frontier
last verified state
next action
blockers
do-not-redo list
workspace / branch / dirty state
important decisions
accepted evidence/tests/artifacts
relevant recent user constraints
loaded skills/instructions required to continue
```

This reduces the risk of a compacted conversation resurrecting already-completed work or treating old user corrections as new pending tasks.

### Trigger policy

Do not lock the final system to one unconditional 90% number. Codex can use aggressive thresholds because its harness owns request accounting; Classic may need earlier preparation until exact server usage is available.

Use staged protection, for example:

```text
normal
watch
prepare checkpoint
force safe rollover
```

plus a prospective overflow guard before injecting large payloads.

---

## 5. ChatGPT Classic / MCP App rendering discoveries

### Native `Called tools` UI

The small `已調用工具 / Called tools` row is ChatGPT Classic's host-native renderer UI, not the DevSpace per-tool widget. `DEVSPACE_WIDGETS=off` removes DevSpace's own old large `Ran command` cards but does not remove this host-native activity row.

No supported Plugin/MCP metadata flag has been found that disables the host-native row. Do not spend v0.5 time on a fragile DOM/CSS patch; the user said its impact is small.

### MCP App execution context

A ChatGPT MCP App card is an OOPIF target. The outer sandbox target can look empty, while the actual app executes in the inner frame/default execution context.

For debugging a widget with CDP:

1. list `/json/list` and find the `iframe` target for `*.web-sandbox.oaiusercontent.com`;
2. attach to that target;
3. inspect `Page.getFrameTree` / `Runtime.executionContextCreated`;
4. evaluate in the inner frame's default execution context.

This is how the Plan Card terminal DOM and `window.openai` methods were verified.

---

## 6. Agent instruction preference

User preference:

> When the user has already explicitly requested a non-destructive research / diagnosis / audit / read-only probe, DevSpace should begin immediately rather than ask a redundant `continue?` / `start?` question.

A package-root `AGENTS.md` was created for this policy, but simply having that file is not guaranteed to inject it into every MCP session. The real durable effect should ultimately be wired into DevSpace's server instructions or another guaranteed plugin instruction-loading path.

Do not add the rule to Codex global AGENTS just for this DevSpace behavior; Codex did not need this fix.

This instruction-wiring cleanup is not part of Goal Mode's core state machine, but should not be forgotten before v0.5 release.

---

## 7. Safety / development rules for the next conversation

### Product surface constraint — Chat Mode only

The user explicitly requires DevSpace Ultra to operate and be accepted only in ChatGPT Classic **Chat mode**. Work mode is out of scope and must not be used as a production/live acceptance surface. Any earlier Work-mode probes are research-only evidence and do not count as product acceptance. Plan Card, Goal Mode, and future Context Guardian live gates must be run in Chat mode.


- Keep #1 Plan Card, #2 Goal Mode, and #3 Context Guardian as separate features/state machines.
- Do not re-enable noisy per-tool `workspace-app.html` cards; `DEVSPACE_WIDGETS=off` remains the normal default.
- Do not change or restart the named tunnel unless the edge itself is being tested; fixed backend 7677 and tunnel lifecycle are intentionally separate.
- Do not use the temporary old CF Canary / Quick Tunnel as the production path.
- Do not restart/stop canonical Main-01 for ordinary v0.5 feature tests; use Main-02/03 for live acceptance when possible.
- Do not treat tool/unit tests as enough for UI/harness features; require real ChatGPT Classic acceptance.
- Goal Mode must report visibly once per physical turn before any automatic next turn.
- Context Guardian must use the active Classic model's actual `maxTokens` metadata, not 1.05M.
- Do not claim native in-place compaction exists until a live supported/internal control actually proves host token usage drops.

---

## 8. Fast resume checklist for a fresh conversation

1. Open the package checkout:

```text
C:\Users\enwong\AppData\Roaming\npm\node_modules\@waishnav\devspace
```

2. Read this file first:

```text
docs/DEVSPACE-ULTRA-HANDOFF-2026-09-05-V0.5-IN-PROGRESS.md
```

3. Inspect:

```text
git status --short --branch
git log -6 --oneline --decorate
node dist/cli.js edge status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/devspace-edge-startup.ps1 -Action status
```

4. Goal Mode core + native Classic Host Bridge + Main-02 Chat-mode production acceptance + Primary Debug Guard are in the main working tree. Fresh `npm run verify:goal`, full `npm test`, and `git diff --check` PASS.

5. Continue Goal Mode closure only: checkpoint the current green work, reload fixed backend 7677 so production picks up Primary Debug Guard, verify current Main-01 remains protected/unchanged, then schedule the one remaining canonical Main-01 9721 live acceptance at a safe restart boundary. Do not start Context Guardian v2 before that gate closes.

6. Keep updating this same handoff file after each Goal Mode gate.

---

## Chat-mode continuation discovery — per-round relay required

Final product acceptance is Chat mode only. A clean Chat-mode acceptance conversation `6a9b4c89-0d20-83ee-83d9-ac6352c73838` created Goal `goal_3402e1c67f91adff`.

Verified in Chat mode:

- pre-send mode state: `對話=true`, `工作=false`;
- Round 1 visible final: `CHAT-GOAL-R1 — goal_3402e1c67f91adff`;
- paused 4-second gate: zero new user/assistant turns; backend `paused / round1 / reported / continuation=idle`;
- Goal Dock Resume successfully generated hidden Round 2 with no new user message;
- Round 2 visible final: `CHAT-GOAL-R2 — goal_3402e1c67f91adff`;
- transcript after Round 2 remained exactly one user message plus two assistant messages;
- exactly one visible Goal Dock iframe remained mounted.

New live bug: the same long-lived Goal Dock's second `sendFollowUpMessage` was accepted/acked and backend became `round2 / reported / continuation=dispatched`, but Chat mode did not start Round 3 within the bounded observation window. Dock showed `Waiting for next round` with no error. This suggests Chat mode does not reliably support indefinite recursive continuation from the same long-lived component instance.

Required transport correction: keep the persistent Goal Dock for status and user Pause/Resume/Stop, but normal automatic chaining after each `devspace_goal_turn_report` must be dispatched by a fresh per-round Continuation Relay MCP App resource attached to that round-report tool. Each relay sends at most one host follow-up. Resume may still use the Goal Dock for the first post-pause continuation; subsequent rounds use fresh relays. Continuation lease remains the backend duplicate guard.

## Critical correction — background `sendFollowUpMessage` is user-activation gated

The later Chat-mode relay acceptance disproved an earlier assumption. The successful CDP `sendFollowUpMessage` probe used the helper's `Runtime.evaluate(..., userGesture:true)`, so it artificially supplied transient user activation. It therefore did **not** prove that an MCP App can autonomously call `sendFollowUpMessage` in the background.

Real Chat-mode evidence now shows the widget bridge warns/guards on `Method sendFollowUpMessage called without synchronous user event`. A fresh Relay can reach backend `claim` and may incorrectly treat an undefined/non-explicit rejection as accepted, causing backend state to become `dispatched` even though ChatGPT never starts the next assistant turn. The current Goal `goal_ac6aaf9070ce0572` is a concrete example: Round 1 and Round 2 are visibly present with one user message, but Round 2's relay is backend-acked/dispatched and no Round 3 appeared.

Important reverse-engineering result: ChatGPT Classic itself has a native hidden follow-up transport. Loaded production code builds a `role=Tool` prompt message with `metadata.chatgpt_sdk_followup_prompt=true`, `metadata.is_visually_hidden_from_conversation=true`, and `completionType=Next`. This is exactly the semantic transport Goal Mode needs. The next research target is the parent-side Classic dispatcher (`sendFollowUpMessage: <minified handler>`) so DevSpace can reuse the native hidden Tool follow-up without the iframe's synchronous-user-event wrapper. Do not fall back to visible composer/user-message automation unless this native path is proven inaccessible.

Until that transport is live-proven in Chat mode, Goal Mode automatic continuation is **not yet product-complete**, despite deterministic MCP/runtime gates being green.

## Raw Classic host follow-up transport — live proof PASS

The parent/native transport has now been live-proven in ChatGPT Classic **Chat mode**.

Chat-mode acceptance conversation:

```text
6a9b5296-bcac-83ee-9937-572125109d03
```

Goal:

```text
goal_ac6aaf9070ce0572
```

Important bridge findings:

- public `window.openai.sendFollowUpMessage` wraps a raw host API and rejects background calls without transient user activation;
- the wrapper closure has `hostHandlesFollowUpMessageAuthorization=false` for DevSpace third-party widgets;
- the MCP Apps sandbox exposes that capability parameter internally, but the installed ext-apps SDK and current ChatGPT parent/widget bundles expose no supported metadata switch that sets it true for DevSpace;
- the raw host API underneath the wrapper has `sendFollowUpMessage` and uses ChatGPT's native MessagePort RPC (`CALL / RESOLVE / REJECT / ABORT`) without the widget-side user-activation check;
- the parent handler creates a hidden Tool-authored follow-up (`chatgpt_sdk_followup_prompt=true`, `is_visually_hidden_from_conversation=true`) with `completionType=Next`.

A live A/B probe claimed the pending Round 2 continuation, then invoked the existing raw host `sendFollowUpMessage` RPC directly with CDP `userGesture=false`. Result:

- raw call returned with no exception;
- Round 3 started automatically;
- visible transcript remained exactly **1 user + 3 assistant messages**;
- markers were `RELAY-GOAL-R1`, `RELAY-GOAL-R2`, `RELAY-GOAL-R3-DONE`;
- no synthetic/fake user message appeared;
- Goal finished at `round=3`, `status=completed`, `roundState=reported`, `continuation=idle`;
- all three success criteria contain backend-authoritative completion evidence;
- exactly one persistent visible Goal Dock remained; one 1px Relay existed per reported round.

Therefore the correct product transport is a **Classic Host Bridge** that dispatches pending Goal continuations through the raw native host follow-up RPC, not background `window.openai.sendFollowUpMessage` from the widget.

## Main runtime coverage requirement

Current local Main roots:

- canonical Main-01 PID 3656: no remote-debugging argument / no 9721 listener;
- Main-02 PID 23144: CDP 9732;
- Main-03 PID 38452: CDP 9733.

A CDP-backed Classic Host Bridge would therefore work for Main-02+ today but would not cover canonical Main-01. Goal Mode is not product-complete until Main-01 also has a durable 9721 host-bridge path (or an equivalent non-CDP native attachment). This requirement belongs to Goal Mode itself, not Context Guardian v2.

## ClassicGoalHostBridge implementation gate GREEN

The first four implementation layers for the native transport are now in the main working tree and deterministic/full-repo verification is green.

Implemented:

- new `dist/goal-host-bridge.js` + test;
- `defaultMainDebugPorts()` covers canonical Main-01 `9721` plus Main-02..Main-32 `9732..9762`;
- bridge probes local `/json/list`, rejects obvious `surface=work`, reads Goal IDs from sandbox tool output, finds the matching Chat-mode Goal widget, extracts the existing raw host API from the public wrapper closure without relying on the minified `r` variable name, then invokes raw `sendFollowUpMessage` through `Runtime.callFunctionOn(... userGesture:false)`;
- no matching Chat-mode Goal widget is a definite failure; an exception after raw RPC begins is treated as ambiguous rather than immediately retrying and risking a duplicate assistant turn;
- `devspace_goal_continuation` now supports app-only `action="dispatch"`; it atomically claim -> hostBridge.dispatch -> ack, releasing only definite failures;
- Goal Dock and per-round Relay no longer call public `window.openai.sendFollowUpMessage` and no longer own claim/ack/release. They call only app-only backend `action="dispatch"`;
- server creates one shared `ClassicGoalHostBridge` and injects it into every Goal tool registration;
- `verify:goal` now includes the Host Bridge test;
- real read-only module discovery on Main-02 port 9732 found the active Goal Dock/Relay targets for `goal_ac6aaf9070ce0572` without the throwaway helper;
- `npm run verify:goal` PASS;
- full `npm test` PASS;
- `git diff --check` PASS.

Current Main-01 coverage discovery:

- canonical Main-01 PID 3656 has no remote-debugging args and its whole process tree has no TCP listener;
- the profile contains a stale `DevToolsActivePort` (9390) that is not live;
- therefore Main-01 currently needs a durable debug-enabled launch/attach path before Goal Mode can be called product-complete there;
- existing controlled-primary helper already knows how to restore Main-01 with `--remote-debugging-port=9721`, but normal future launches do not yet guarantee that argument. Do not claim Main-01 support until that lifecycle is solved and live-accepted.

## Main-02 production Host Bridge acceptance PASS

Clean Chat-mode-only acceptance conversation:

```text
6a9b61f4-bfd4-83ee-be28-ee10b17fab4b
```

Goal:

```text
goal_3398ed2100f72784
```

Production proof after loading `ClassicGoalHostBridge` into fixed backend 7677:

- fresh backend PID after reload: 348; both fixed backend/tunnel Scheduled Tasks remained Running and fixed edge stayed healthy;
- Plugin Refresh loaded the new Goal schema;
- new conversation was explicitly switched to `對話=true / 工作=false` before the acceptance prompt;
- Round 1 visible final: `HOSTBRIDGE-R1 — goalId: goal_3398ed2100f72784`;
- authoritative backend state after Round 1: `paused / round1 / reported / continuation=idle`;
- bounded 4-second pause gate produced zero new user/assistant messages;
- Goal Dock Resume was the only user-control action;
- hidden Round 2 appeared automatically with visible final `HOSTBRIDGE-R2` and no new user message;
- Round 2's per-round Relay called app-only backend `dispatch`; `ClassicGoalHostBridge` located the correct Main-02 Chat-mode Goal widget by `goalId`, used the raw native host RPC, and hidden Round 3 started automatically;
- Round 3 visible final: `HOSTBRIDGE-R3-DONE`;
- final transcript was exactly **1 user + 3 assistant messages**;
- final backend state: `completed / round3 / reported / continuation=idle`, revision 13;
- all three stored success criteria have backend completion evidence;
- one persistent Goal Dock remained; three expected 1px per-round Relay instances were mounted;
- bounded 5-second completion-stop gate produced no Round 4.

This is the first full product-level Chat-mode PASS for Goal Mode continuation without CDP-generated user input or a manual raw-followup probe.

Remaining Goal Mode closure item is now narrowed to **canonical Main-01 live acceptance**. The durable Main-01 host-bridge lifecycle has been implemented and deterministic/safety-gated, but the currently active Main-01 conversation is intentionally protected and has not yet been restarted to 9721.

### Primary Debug Guard implementation + safety gate PASS

Implemented:

- `dist/primary-debug-guard.js` + deterministic tests;
- `scripts/chat-classic-primary-debug.ps1` with `status | repair`;
- `scripts/primary-debug-static-gate.mjs`;
- server lifecycle: one `ClassicPrimaryDebugGuard`, asynchronous non-blocking `start()`, `close()` on shutdown;
- `ClassicGoalHostBridge.beforeDispatch` calls `primaryDebugGuard.pollOnce()` to close the just-restarted-primary timing race.

Guard semantics:

- a long-running Main-01 that already existed when DevSpace starts is marked `protected-existing-primary` and is **not restarted**;
- a fresh startup Main-01 within the startup window, or a later changed/new PID lacking 9721, is repaired to loopback CDP 9721;
- absent Main-01 is observed until it appears;
- canonical `OpenAI.ChatGPT-Desktop` only;
- expected-PID race guard prevents killing a replacement process;
- debug flags are loopback-only;
- Windows UserChoice / `chatgpt://` protocol ownership is not edited;
- failed debug restart has a normal canonical-app restore fallback.

Real safety probe against the current conversation:

```text
state=protected-existing-primary
protectedPid=3656
pid=3656
debugReady=false
port9721=false
```

Main-01 PID/command line remained unchanged after the real default-adapter guard probe.

Latest deterministic/static outputs include:

```text
goal-host-bridge: PASS (32 ports; Main-01=9721; Main-32=9762; Chat-mode-only)
primary-debug-guard: PASS (protect existing / repair fresh startup / repair new PID)
primary-debug-static: PASS (9721 / protocol owner protected / expected PID / restore fallback)
goal-mode-live: PASS (finalRound=3 / finalStatus=completed / restartRecoveredRevision=13)
```

Fresh `npm run verify:goal`, full `npm test`, and `git diff --check` all PASS after Primary Debug Guard server wiring.

The Goal Mode design/spec/workflow/changelog are being updated to the final architecture: widgets call only backend `dispatch`; `ClassicGoalHostBridge` owns the raw native hidden follow-up; public background widget `sendFollowUpMessage` is explicitly not the production transport.

Next exact steps:

1. checkpoint the final Host Bridge + Primary Debug Guard implementation/docs while excluding unrelated `AGENTS.md`;
2. reload only fixed backend 7677 so production picks up the Guard lifecycle; verify current Main-01 remains PID3656 and named tunnel remains untouched;
3. perform canonical Main-01 live acceptance only at a deliberate safe restart boundary that enables 9721;
4. close #2 Goal Mode, then start #3 Context Guardian v2.

## Relay / Host Bridge implementation gate completed

The Chat-mode continuation transport correction is implemented and production-live verified.

Current implementation:

- persistent `ui://devspace/goal-dock.html` owns status and Pause/Resume/Stop;
- Goal Dock ordinary polling never auto-dispatches; a successful user Resume arms exactly one app-only backend `dispatch`;
- every `devspace_goal_turn_report` renders fresh `ui://devspace/goal-continuation-relay.html`;
- each Relay is 1px/zero-visual, one-shot, and calls only app-only backend `action="dispatch"`;
- Relay/Dock never call public background `sendFollowUpMessage` and never own low-level lease claim/ack/release;
- backend performs claim -> `ClassicGoalHostBridge` raw native hidden Tool follow-up -> ack;
- definite pre-dispatch failures release; ambiguous post-RPC failures remain lease/redeem recoverable;
- Goal tools remain 9 and render tools remain 3 (`start`, `mount`, `turn_report` relay);
- `verify:goal` includes Host Bridge, Primary Debug Guard, relay/static, instruction, and real MCP protocol gates;
- Main-02 full product acceptance PASS is recorded above.

## ChatGPT Classic stalled-stream reproduction — root cause proven

The user-reported `連線中斷 / 正在等待完整回覆` class of interruption was reproduced safely on isolated Main-03 (Chat mode, CDP 9733) without touching Main-01.

Reproduction conversation: `6a9b6d6d-5638-83ee-9349-a96e8ae2fcc2`.

A harmless long response was started, Main-03 network was forced offline for 8 seconds through CDP, then restored. The renderer remained stuck for more than 40 seconds with `generating=true` and only the prefix `1. What an`, while the server already had the full assistant final. Capturing ChatGPT's own authenticated conversation reload response proved the current assistant node had `status=finished_successfully` and `end_turn=true`. Reloading the same conversation immediately restored the full ten-section response and cleared `generating`.

A second trace identified the exact transport:

- generation request: `POST /backend-api/f/conversation`, MIME `text/event-stream`;
- after canonical conversation creation ChatGPT polls `GET /backend-api/conversation/<conversationId>/stream_status`;
- during the forced disconnect that `stream_status` request failed with `net::ERR_INTERNET_DISCONNECTED`;
- after network recovery, direct same-page `stream_status` returned HTTP 200 `{"status":"COMPLETE"}` even while the DOM still contained only a short partial answer.

Therefore this is a client stream/reconciliation failure, not DevSpace work stopping. Server-side model/tool work can continue and finish while Classic's foreground renderer stays stale.

Approved recovery design: implement a conservative `ClassicStreamRecoveryGuard`. Never reload just because a turn is slow. Arm recovery only after a relevant active-conversation `stream_status` transport failure. After connectivity returns, query the same conversation's `stream_status`; if it is `COMPLETE` and the renderer has not reconciled/progressed, perform at most one same-URL soft reload. Cancel on normal progress, enforce per-turn cooldown/one-shot semantics, Chat-mode-only, and never synthesize user messages. This should run only where a loopback CDP port is available (Main-02+ now; Main-01 after the safe 9721 acceptance).

Next immediate work before Main-01 Goal acceptance: RED/GREEN this Stream Recovery Guard, wire it into the server lifecycle, rerun the isolated Main-03 offline reproduction and prove automatic recovery without manual reload, then update this handoff and proceed to the final Main-01 safe-restart acceptance.

## Classic Stream Recovery Guard — implemented + production live PASS

The stalled-stream recovery fix is now implemented and loaded by fixed backend 7677.

Implementation:

- `dist/classic-stream-recovery-guard.js` + deterministic tests;
- `dist/classic-stream-recovery-cdp.js` + adapter tests;
- `scripts/classic-stream-recovery-static-gate.mjs`;
- `verify:stream-recovery` is part of `verify:ultra` / `npm test`;
- `dist/server.js` starts one persistent CDP adapter plus conservative recovery guard and closes both on shutdown;
- adapter monitors available Classic Main loopback ports, currently Main-02/03 and Main-01 after safe 9721 enablement.

Recovery policy is deliberately fail-safe: no recovery merely because a model is slow. It arms only after a matching `/backend-api/conversation/<id>/stream_status` transport failure. Renderer progress cancels recovery. The same conversation must survive the grace period and `stream_status` must subsequently return `COMPLETE`; only then can one same-URL soft reload occur, with per-conversation cooldown and no synthetic user message. Work mode is never touched.

Fresh dedicated and full regression PASS:

```text
classic-stream-recovery-guard: PASS (conservative / Chat-mode-only / COMPLETE required / one-shot)
classic-stream-recovery-cdp-adapter: PASS
classic-stream-recovery-static: PASS
npm test: PASS
git diff --check: PASS
```

Production backend reload evidence:

```text
fixed backend PID after reload: 40280
named cloudflared tunnel PID remained: 36128
fixed-edge live gate: PASS
backend PID 40280 held established loopback CDP sessions to Main-02:9732 and Main-03:9733
```

Production deterministic Main-03 live recovery gate PASS on conversation `6a9b70ce-eaac-83ee-9fac-4d0b0e8b255b`: after a fully completed server answer was deliberately represented in the renderer as `STALLED-PARTIAL`, a real blocked `stream_status` fetch produced `TypeError: Failed to fetch`. Without any manual reload, the production guard observed the failure, waited for authoritative `COMPLETE`, and reloaded the same conversation. Ten seconds later `navigationType=reload`, `generating=false`, and the complete ten-section server response was restored; `STALLED-PARTIAL` was gone.

This validates the user observation: a Classic foreground stream can be stale while server/model/tool work has already completed. DevSpace now repairs that stale renderer state automatically on supported CDP-enabled Chat-mode Mains.

Next exact step: perform the final canonical Main-01 deliberate safe restart/9721 acceptance. Before restart, this handoff is authoritative. After restart verify the same signed-in Primary is restored, `chatgpt://` ownership remains canonical, loopback 9721 is ready, the Stream Recovery adapter connects Main-01, and a harmless Chat-mode Goal/host-bridge acceptance succeeds. Then close Goal Mode and begin Context Guardian v2.

## 2026-09-05 — Goal visible-report persistence fix

A Main-01 frontend UX issue was reproduced/observed during the canonical Goal acceptance: after hidden continuation started, the user could temporarily see the previous round report disappear/not yet appear even though backend Goal state had advanced. Direct Main-01 CDP inspection later showed `MAIN1-GOAL-R1`, `MAIN1-GOAL-R2`, and `MAIN1-GOAL-R3-DONE` all still persisted in the ChatGPT transcript, so this was a frontend/stream synchronization problem rather than backend deletion.

Fix now implemented and loaded into the fixed 7677 production backend:

- `ClassicGoalHostBridge` no longer dispatches hidden continuation immediately after finding the Goal widget;
- every continuation now passes `lastRoundReport.reportedAt` from GoalRuntime through `goal-tools.js` into the Host Bridge;
- `waitForVisibleReportBoundary()` requires Chat mode, `stream_status=COMPLETE`, `generating=false`, and a non-empty latest visible assistant report before raw hidden continuation can dispatch;
- a short post-`reportedAt` settle window prevents a stale previous-round COMPLETE state from being mistaken for the current report;
- the default production inspector uses the matching Main page CDP target and the authenticated ChatGPT `/backend-api/conversation/<id>/stream_status` endpoint;
- a new `goal-visible-report-static` gate locks ordering so the visible-report commit check must occur before raw host RPC;
- full `npm test` and `git diff --check` passed after the change;
- added a tested backend-only maintenance action `restart-backend` plus `npm run reload:fixed-backend`; it schedules a detached delayed restart so the current MCP tool response completes before 7677 is restarted, and it never stops the named tunnel;
- production reload completed successfully: `DevSpace-Fixed-Backend=Running`, `DevSpace-Fixed-Edge-Tunnel=Running`, tunnel PID remained `33872`, and fixed edge health remained HTTP 200 / MCP OAuth challenge present.

Frontend acceptance practice is also tightened: for Goal/Plan UX claims, inspect the actual Classic DOM (and screenshot when practical) in addition to backend state. Do not treat backend-only progress as sufficient evidence that the user-visible report is present.

## 2026-09-05 — Context Guardian v2 Round 3: GPT-6 Pro + hidden Main rollover transport

New live/model evidence:

- Microsoft Store reported no newer ChatGPT Desktop package than the currently installed 1.2026.190.0 family, so the user's GPT-6 availability is a server/account rollout rather than a required Desktop binary upgrade.
- Isolated Main-03 was safely relaunched; canonical Main-01 stayed untouched.
- Main-03's fresh Classic-native model catalog contains `gpt-6-pro` with `max_tokens=410000`, `reasoning_type=pro`, `is_work_mode_model=false`; `gpt-6-astra-wm` remains a 262144-token Work-mode model.
- `dist/context-guardian.test.js` now has an explicit GPT-6 Pro regression proving `gpt-6-pro -> 410000`, native-catalog source, Chat-mode supported.

Step-4 fresh Main rollover transport is now proven end to end without a synthetic user bubble:

- Classic bundle source for `getWidgetFollowupMessageParams` confirmed native hidden follow-up schema: Tool author, text content, `chatgpt_sdk_followup_prompt=true`, `is_visually_hidden_from_conversation=true`, completion type Next.
- Fresh Main-03 hidden-first-turn probe created conversation `6a9b967e-855c-83e8-9bf2-5c348b039728` with zero visible user messages and final assistant `HIDDEN-ROLLOVER-OK`.
- Fresh Chat DevSpace pairing was reverse engineered through the exact `data-composer-plugin-impression-id=asdk_app_6a9acb1baab08191872d7b7e04ccdb43` suggestion row; Main-02 proved a fresh paired Chat could call the formal `devspace_plan_status` tool.
- Combined paired + hidden rollover probe created conversation `6a9b98a2-6aa0-83e8-bc40-a58477b07488`: zero visible user messages, placeholder absent, `api_tool.call_tool` present, final assistant `PAIRED-HIDDEN-OK`.
- Product code now includes conservative conversation snapshot estimation, `buildClassicHiddenRolloverBody`, CDP `refreshSnapshot/recentVisibleMessages/startHiddenRollover`, active Goal/Plan backend snapshots, and `ContextGuardianRolloverCoordinator`.
- Goal Host Bridge now has a pre-raw-dispatch Context Guardian hook: after the prior visible Goal report is committed, a prospective rollover can carry the original Goal continuation directly into a fresh paired hidden Chat instead of first advancing the old near-limit conversation.
- Automatic background rollover refuses Work mode, generating turns, and any non-empty composer text. Reported Goals are prepared only and handed to Goal Host Bridge; working Goals continue the same round and explicitly forbid `devspace_goal_round_begin`.
- `verify:context-guardian`, Goal Host Bridge regression, full `npm test`, and `git diff --check` all pass with the new rollover code.

UI redesign research is complete but production UI code is intentionally not started yet because the Superpowers architectural UI approval gate remains pending. Proposed/previously presented design: Host Overlay Projection; Goal strip directly above `form.group/composer`, Plan HUD fixed at the conversation pane top-right, white/translucent OpenAI-style surface, compact/collapsible, backend authoritative. Main-01 anchor probe confirmed stable semantic anchors: `#prompt-textarea`, `form.group/composer`, `#thread-bottom-container`, `main#main`, and `data-scroll-root`. Do not implement this host-overlay architecture until the user explicitly approves the presented technical design (e.g. replies `可以`).

## Current handoff state

As of the creation of this rolling handoff:

```text
#1 Plan / Step Card: IMPLEMENTED + real Main-02 production acceptance PASS
#2 Goal Mode: IMPLEMENTED + MAIN-02 PASS + CANONICAL MAIN-01 PASS; GOAL goal_0a5086a710226835 COMPLETED ROUND3 REV11; CONTINUATION IDLE; VISIBLE-REPORT COMMIT + STREAM RECOVERY PRODUCTION-LIVE
#3 Context Guardian v2: research findings captured; NEXT implementation track after the final Goal visible report
```

Goal Mode core, Host Bridge transport, Main-02 Chat-mode acceptance, canonical Main-01 Chat-mode acceptance, Primary Debug Guard, Visible Report Commit Gate, Stream Recovery Guard, and detached fixed-backend reload are all production-live. Fresh verification passed `npm run verify:goal`, full `npm test`, and `git diff --check`; fixed edge remained healthy (`health=200`, MCP OAuth challenge present), both fixed Scheduled Tasks remained Running, and the named tunnel PID remained `33872`. Canonical Main-01 currently runs PID `11584` with loopback CDP `9721` and canonical `chatgpt://` ownership preserved. Goal `goal_0a5086a710226835` is completed at round 3/revision 11 with criterion-complete evidence and continuation `idle`. Main-01 DOM confirms all three round summaries persist. After the final `devspace_goal_turn_report`/visible closure, begin #3 Context Guardian v2; do not reopen Goal Mode architecture work unless a new regression is observed.

## 2026-09-05 11:39 +08 — Context Guardian v2 Round 2 / Step 3 complete

- Active Goal: `goal_deac9fadb6bc67dd`; active Plan: `plan_dfc1ea0e2b285119`.
- Plan progressed to revision 4 with Step 4 / 7 in progress. Steps 1-3 are completed.
- Dynamic model-window detection is production-live from ChatGPT Classic native metadata: GPT-5.6 Sol Thinking = `262144`, GPT-5.6 Pro = `410000`, default GPT-5.6 = `137000`. Main-01/02/03 are observed in Chat mode; Work-mode models remain unsupported by this plugin surface.
- Context Guardian prospective pressure engine is implemented: host-measured usage has precedence when available; otherwise the latest conversation snapshot / DevSpace monotonic ledger is used. Headroom is computed from output reserve + uncertainty reserve + prospective next input rather than a blind fixed 90% threshold.
- Production ledger feeding is now live. A real Main-03 native turn (`gpt-5-6-thinking`, effort `max`) advanced `ledgerTokens` from `0` to `22`. Persisted Context Guardian state did NOT contain the probe prompt text; only safe token/model/conversation metadata is stored.
- For the live Thinking window, the default calculation produced output reserve `20971`, uncertainty reserve `26214`, and rollover boundary `214959` tokens. Current live stage remained `normal`.
- CJK-aware conservative estimator is in `context-guardian-cdp.js`; it avoids bytes/4-style undercounting and only emits a numeric estimate. Prompt/postData/auth/cookies are not persisted.
- Full `verify:context-guardian`, full `npm test`, and `git diff --check` passed after ledger feeding integration.
- Goal Mode soak found a real reliability gap: an automatically continued round could begin successfully but the model could end its assistant turn before `devspace_goal_turn_report`, leaving `roundState=working` and requiring a user `continue`. This is now fixed with `ClassicGoalRoundCompletionGuard` + bounded `roundRecovery` state. The guard re-drives the SAME working round only when Chat mode is active, UI is not generating, and server `stream_status=COMPLETE`; no new round and no synthetic user message are created. Failed recovery dispatches release the claim; recovery has cooldown/attempt bounds and clears on report/pause/stop/complete. Dedicated unit/static gates and full regression pass.
- The existing Context Guardian Goal was migrated in place and hidden same-round recovery has already fired automatically multiple times without a user message. The current recovered Round 2 is being properly finished now; after `devspace_goal_turn_report`, normal Goal continuation must start Round 3 automatically.

Next exact work in Round 3: Plan Step 4 — protect Main conversations with a structured compact checkpoint plus verified rollover/continuation preserving Goal + Plan execution frontier, decisions, evidence, and do-not-redo state.

## 2026-09-05 13:xx +08 — Context Guardian v2 Round 3 release closure

Active Goal/Plan remain `goal_deac9fadb6bc67dd` / `plan_dfc1ea0e2b285119`. The Plan advanced through Step 6 and is now on the final acceptance/release step.

### Step 4 — structured Main rollover: production-live PASS

- Context Guardian can build a bounded structured capsule from the current Goal, Plan, completed-step frontier, latest reports, current context pressure, bounded recent visible messages and tool state.
- Fresh Chat rollover pairs DevSpace Ultra and sends the continuation as a native hidden Tool first turn; the acceptance conversation contains zero visible user messages.
- A product live gate returned `CONTEXT-ROLLOVER-LIVE-OK STEP-4` after calling the backend-authoritative Plan status tool in the fresh Chat.
- Goal Host Bridge integrates the prospective rollover before raw continuation so a near-limit reported Goal can move directly to the fresh paired Chat.
- Work mode, an active generation, or non-empty composer text refuses automatic rollover.

### GPT-6 Pro compatibility

- Isolated Main-03 was used for the live model investigation; canonical Main-01 was not updated/restarted for the probe.
- Microsoft Store showed no newer Desktop package than the installed `1.2026.190.0` family, so GPT-6 availability is an account/server rollout rather than a required Desktop-binary update.
- The real Classic-native model catalogue observed `gpt-6-pro` with `max_tokens=410000`, `reasoning_type=pro`, `is_work_mode_model=false`.
- `gpt-6-astra-wm` remains a Work-mode model and is outside this Chat-mode-only product surface.
- `dist/context-guardian.test.js` contains an explicit GPT-6 Pro regression. The `410000` value is native observed metadata, not a universal hard-coded fallback.
- A plain independent page `fetch()` can still receive a reduced model catalogue (for example `34834` tokens); this is not authoritative and does not override the native-request observation path.

### Step 5 — Stream Recovery productization: PASS

General-user product documentation is now in `docs/classic-chat-safety.md`, linked from `README.md` and `docs/configuration.md`.

Safe defaults:

- `DEVSPACE_CLASSIC_STREAM_RECOVERY=1` / `classicStreamRecoveryEnabled=true` by default;
- `DEVSPACE_CONTEXT_GUARDIAN=1` / `contextGuardianEnabled=true` by default;
- Work mode is unsupported and never used for acceptance;
- Stream Recovery does not expose aggressive grace/cooldown tuning as normal-user knobs.

Recovery stays conservative: a matching active-conversation `stream_status` transport failure is required; renderer progress or conversation change cancels recovery; server `COMPLETE` is mandatory; only the same URL can be softly reloaded; cooldown/one-shot semantics prevent loops; no synthetic user message is created.

Fresh deterministic verification passed `verify:stream-recovery`, `verify:classic-safety`, `verify:context-guardian`, and `git diff --check`.

### Step 6 — sustained Chat-mode multi-Main soak: PASS

- Main-03: a completed server answer was deliberately replaced in the DOM with `STALED_SOAK_R3`; a real blocked same-conversation `stream_status` request then failed. Production Stream Recovery restored the same server final through one soft reload, removed the stale marker, kept `generating=false`, and created no user message.
- Main-02: the same live recovery gate passed independently, restoring `CONTEXT-ROLLOVER-LIVE-OK STEP-4` after `STALED_SOAK_R2` plus a real `stream_status` failure.
- Main-02 negative gate: `SLOW_NO_FAILURE_SOAK` was left in the DOM for eight seconds, longer than the five-second reconciliation grace. Because no matching transport failure was recorded, production Stream Recovery correctly did not reload the page.
- Main-02 and Main-03 remained isolated Interactive runtimes, outside Worker controller/Auto Compact/Chat Swarm ownership; both runtime status checks reported canonical Main-01 unchanged with PID `11584`.
- Current Main-01 is itself a real Context Guardian same-Goal hidden rollover continuation. Goal state stayed Round 3/revision 24 and Plan state stayed on the same execution frontier during the cross-runtime exercises; no duplicate Goal round or Plan transition was observed.
- ChatGPT Classic simultaneously displayed the host `too many requests` protection banner. This was treated as an external host condition and was not misclassified as a DevSpace stall/recovery failure.
- A later Main-03 homepage observation was investigated instead of counted as a failure: the prior temporary conversation endpoint returned unavailable under the host-limited session and Context Guardian state showed only normal low token use, not a pressure-triggered rollover. No product fix was made without a reproducible DevSpace root cause.

### Step 7 — release verification and frontend evidence

Fresh full regression:

```text
npm test: PASS (exit 0)
Context Guardian gates: PASS
Goal / Goal Host Bridge / Round Completion / Visible Report gates: PASS
Plan gates: PASS
Stream Recovery + Classic safety gates: PASS
MCP session lifecycle + Worker continuity + runtime identity gates: PASS
```

Fresh fixed-edge live gate:

```text
healthStatus=200
mcpStatus=401 with OAuth challenge
protected-resource metadata=200
private surface=404
secretValuesLogged=false
```

Direct Main-01 frontend DOM audit on the fresh rollover conversation measured viewport `1080x1849`, composer form at `y=1773`, `#thread-bottom-container` at the same bottom boundary, and `main#main` from `y=45.5` to the viewport bottom. Before explicit re-mount, the fresh rollover conversation had zero Goal/Plan iframes even though backend state remained intact. This is direct evidence of the user's reported UX problem: the existing MCP cards belong to transcript/tool turns rather than a host-persistent surface, so a fresh conversation or long transcript can leave the live Goal/Plan UI offscreen or absent.

`devspace_goal_mount` and `devspace_plan_mount` were then called read-only in the current fresh conversation and returned the authoritative Round 3 / Plan revision 7 state; ChatGPT reported both embedded UIs displayed. A same-turn DOM probe still sees zero committed iframes while the assistant turn is generating, consistent with tool UI being committed with the transcript turn rather than existing as a host overlay.

A direct CDP `Page.captureScreenshot` attempt was refused by the host safety layer (`OpenAI could not determine the request's safety state`). No bypass was attempted. The frontend acceptance therefore uses current live DOM geometry plus the already-observed real Classic screenshots/DOM from earlier Plan/Goal acceptance. This limitation is environmental, not represented as a screenshot PASS.

### UI redesign status — approval gate still pending

The user's requested new placement is fully specified but production code is intentionally not started because the required Superpowers architectural approval gate has not yet received an explicit post-design approval.

Proposed **Host Overlay Projection** design:

- Goal strip: attached directly above `form.group/composer` / `#thread-bottom-container`, compact, always visible with the composer, backend-authoritative.
- Plan HUD: fixed to the conversation pane's top-right, compact/collapsible, white or translucent neutral ChatGPT-style surface, never a large black modal.
- Existing transcript MCP Apps remain a compatibility/fallback surface; the host overlay projects the same Goal/Plan backend truth instead of creating parallel state.
- Stable Main-01 anchors already live-probed: `#prompt-textarea`, composer form, `#thread-bottom-container`, `main#main`, and the scroll root.
- Direction: preserve ChatGPT/OpenAI visual language, low visual density, minimal motion, no decorative glass/slop; OpenDesign `design-review` + downstream `design-taste-frontend` gates are loaded for the eventual implementation/visual acceptance.

Do not implement this host-overlay redesign until the user explicitly approves the presented design (for example replies `可以`). All backend Context Guardian/Stream Recovery/Goal/Plan work can be released independently of this pending UI redesign approval.

### Release metadata

- `package.json` version advanced from `0.4.0` to `0.5.0` and description now includes Goal/Plan UX, Stream Recovery, and model-aware long-context continuity.
- `CHANGELOG.md` v0.5 section now records Context Guardian v2, Stream Recovery, structured Main rollover, GPT-6 Pro compatibility, Goal Round Completion recovery, safety documentation, multi-Main soak, and release verification.
- The release bump exposed one useful stale-contract RED gate: `scripts/interactive-runtime-static-gate.mjs` still asserted that the package must be exactly `0.4.0`, while the MCP server identity in `dist/server.js` also reported `0.4.0`. The gate was converted to require current `0.5.0` release metadata and, more importantly, to assert that the MCP server identity version matches `package.json`. The targeted gate failed first against the stale server identity, then passed after the server version was advanced to `0.5.0`.
- `docs/runtime-identity.md` now describes the package-identity layer as introduced in v0.4.0 and maintained in current v0.5.0 rather than incorrectly calling v0.4.0 unreleased.
- Final post-bump verification is fresh: `npm test` PASS on `devspace-ultra@0.5.0`, `npm run verify:edge-live` PASS, and `git diff --check` PASS (Windows line-ending warnings only).
- The fixed 7677 backend was then reloaded through the existing detached `reload:fixed-backend` path so the live MCP process loads the v0.5.0 tree; the scheduled reload returned before process replacement, and a fresh post-reload fixed-edge gate again passed health 200, MCP 401 OAuth challenge, protected-resource metadata 200, private surface 404, and `secretValuesLogged=false` without replacing the fixed public URL.

## 2026-09-05 — Round 3 startup/reconnect fix + Host Overlay production integration (current)

This section supersedes the earlier Host Overlay **approval-pending** notes above. The user subsequently approved the Goal-strip-above-composer + compact top-right Plan HUD design. Production implementation and deterministic integration are now complete; final real Classic frontend acceptance remains the active release gate.

### Startup/reconnect release blocker

The reported failure was reproduced architecturally: Context Guardian background pressure handling could be eligible to create a fresh Chat during reconnect/startup, and any hidden first-turn rewrite must never fail open into the originally prepared visible plugin turn. The current contract is stricter than the initial proposed repair:

- **All background Context Guardian polling is checkpoint-only.** `prepare` / `rollover` pressure can capture the native conversation state and persist a structured capsule, but background polling never calls the fresh-Chat rollover transport, never navigates to a new conversation, and never sends `@DevSpace Ultra`. This applies on startup/reconnect and across multiple Main runtimes.
- A fresh hidden rollover remains available only through `beforeGoalContinuation(...)`, where an already-authorized Goal Host Bridge continuation supplies the authorization and the prospective guard proves rollover is required.
- Hidden first-turn rewriting is fail-closed. A transform error aborts the intercepted request with `Fetch.failRequest`; failure to observe the rewritten request refuses any visible fallback.
- Fresh hidden rollover success still requires zero visible user messages in the new conversation.

Dedicated Context Guardian tests/static gates now lock `prepared-rollover-awaiting-authorized-turn`, `backgroundRolloverCheckpointOnly=true`, hidden transform fail-closed behavior, Chat-mode/composer/generating guards, structured checkpoints, and the authorized Goal continuation path.

### Host Overlay production architecture

The approved Host Overlay has been integrated into the v0.5 production server without introducing another Goal/Plan state machine:

- Host Overlay **reuses the existing `ClassicContextMetadataCdpAdapter` sessions** through `ClassicHostOverlayContextAdapter`; production no longer creates a separate long-lived Host Overlay CDP connection pool.
- Initial ownership is resolved from the real Goal Host Bridge and bound to the exact `goalId + runtimeKey + conversationId` tuple.
- Only that exact runtime receives the Goal/Plan projection. Other Main runtimes receive an empty projection, and the owner-side DOM script independently hides if the current URL conversation ID no longer matches the owner pointer. Ordinary/manual navigation therefore cannot steal the Goal overlay.
- `ContextGuardianRolloverCoordinator` calls `hostOverlayProjection.noteVerifiedRollover(...)` only after the hidden rollover transport returns verified success. The owner transfer is rejected unless goal ID, runtime key, and old conversation ID all match exactly.
- Backend reload continuity stores only the bounded owner pointer in `classic-host-overlay-owner.json` under the configured state directory, using an atomic temp-write + rename. Goal/Plan content is not duplicated; GoalRuntime and PlanRuntime remain authoritative.
- Existing Goal Dock and Plan Card MCP Apps remain the fallback/control surfaces.

Independent gates now cover shared-CDP lifecycle, exact runtime/conversation ownership, verified-rollover-only transfer, persisted owner-pointer reload behavior, single-root projection, DOM `textContent` safety, Chat-only refusal, and composer/top-right anchor contracts.

### Verification immediately before final frontend gate

Fresh verification on the current v0.5 tree:

```text
npm run verify:context-guardian  PASS
npm run verify:host-overlay     PASS
npm run verify:classic-safety   PASS
npm test                        PASS (full verify:ultra)
```

The full regression includes Goal three-round live protocol tests, Stream Recovery, Context Guardian, Host Overlay owner-transfer tests, MCP session lifecycle/OOM regression, Plan persistence, edge static gates, worker continuity, browser control and capability runtime tests.

**Remaining release gate:** update this handoff after reloading fixed backend 7677 with the current tree, re-running the fixed-edge live gate, and directly accepting the Host Overlay/startup behavior in real ChatGPT Classic Main-01/02/03 Chat mode. Do not mark the Goal complete before that frontend evidence exists.

## 2026-09-06 — Local Gateway recovery, Stable Gateway cutover, UI lifecycle hardening, and runtime login regression repair

This section is the new authoritative resume point and supersedes the old fixed-edge/Tailscale production assumptions above where they conflict.

### Public ingress / MCP transport — local self-hosted path PASS

The user required a self-hosted path with no Cloudflare/ngrok/Tailscale Funnel request quota in the normal hot path. The working production route is now:

```text
DuckDNS: devspace-enwong.duckdns.org
Router WAN IPv4: 223.19.13.253
Router UPnP TCP 80/443 -> current Windows LAN host
Windows Caddy 2.11.4 -> 127.0.0.1:7678
Stable Gateway public listener: 127.0.0.1:7678
Core A/B private slots: 7688 / 7689
ChatGPT Custom App: DevSpace Local Gateway
MCP URL: https://devspace-enwong.duckdns.org/mcp
OAuth scopes: devspace offline_access
```

External 5G acceptance passed `https://devspace-enwong.duckdns.org/healthz`; Caddy allowlisting returns 404 for `/browser-control/bridge/next`, so the private Browser Control surface is not exposed through the public ingress. OAuth metadata and protected-resource metadata advertise only the DuckDNS origin; `/mcp` returns the expected 401 Bearer challenge before authentication.

The new ChatGPT Custom App connected through OAuth/DCR and immediately read the DevSpace package as version `0.5.0`. The same App session survived the subsequent Stable Gateway migration without changing URL or redoing OAuth.

### Stable Gateway migration — production PASS

The old migration failure was rooted in two assumptions: the script treated an absent 7678 listener as fatal and hard-coded the prior Tailscale public identity. `scripts/migrate-tailscale-stable-gateway.mjs` is now provider-neutral and accepts the current stable public base, treats an already-down 7678 direct Core as a recoverable migration state, validates public identity through the actually exposed `/healthz + OAuth + /mcp` surface, validates private Stable Gateway health only on localhost, and restores a direct Core on rollback even when the original listener had already disappeared.

Fresh migration result:

```text
state=migrated
port=7678
coreAPort=7688
coreBPort=7689
taskName=DevSpace-Stable-Gateway
taskState=Running
publicBaseUrl=https://devspace-enwong.duckdns.org
publicIdentityVerified=true
localStableGatewayVerified=true
bootstrapOauthClients=2
bootstrapRefreshTokens=2
bootstrapWorkspaceSessions=5
rollback=false
```

Old Goal/Plan state migrated successfully into the new Local Gateway state store without creating a replacement Goal/Plan:

```text
goal_deac9fadb6bc67dd = paused / round 3 / revision 31 / continuation idle
plan_dfc1ea0e2b285119 = active / revision 12 / final frontend-acceptance step in_progress
```

### Plan Card / Host Overlay lifecycle — current contract

The user refined the Plan/Goal UI lifecycle after the earlier persistent-card design:

- Goal/Goal Mode is cross-turn persistent and disappears naturally only when the full Goal reaches a terminal completed/stopped state.
- Plan is **physical-turn / Goal-round scoped**. A completed Plan disappears in that turn; the next physical turn/Goal round starts a fresh Plan rather than carrying the completed card forever.
- Backend plan runtime now refuses a second concurrent active Plan, so retries/reconnects cannot stack duplicate Plan cards.
- Agent/server instructions now require the current turn Plan to finish before `devspace_goal_turn_report` (Goal Mode) or before the ordinary final response.
- Host Overlay projection now fingerprints `goal revision + plan revision + exact owner + runtime topology`; unchanged polling performs zero projection work.
- The DOM projection has its own content fingerprint and returns `contentWrites=0` on identical state; nodes are retained and visibility transitions use short opacity/translate exits instead of remove/recreate flicker.
- The old page-wide MutationObserver/global scroll churn was removed in favor of bounded ResizeObserver-based repositioning.
- Goal strip remains directly above the composer; Plan HUD remains compact at conversation top-right; exact `goalId + runtimeKey + conversationId` ownership remains fail-closed.

Dedicated Plan/Host Overlay tests and full `npm test` are GREEN after these changes.

### Refresh / reload remains a required product capability

Do not remove or bypass ChatGPT Custom App **Refresh / 重新整理**. Earlier real acceptance proved host-cached MCP schemas can remain stale after tools change; the official plugin Refresh action is the supported schema refresh path. Stream Recovery soft reload is also an intentional product feature: it is conservative, Chat-mode-only, requires a matching `stream_status` transport failure plus authoritative server `COMPLETE`, and reloads only the same conversation URL once. Future Computer Use support should make these existing supported UI actions easier to drive; it must not replace their semantics.

### Worker/Main zero-login inheritance regression — root cause found and live repaired

The user reported many Worker windows on the desktop showing signed-out state even though DevSpace had previously established single-login propagation from Main-01. Live evidence showed canonical Main-01 CDP 9721 remained signed in (`composer=true`, `loginVisible=false`), while Worker 01-04 and 30 reported `LoggedInState=False`.

The runtime controller auth source must remain:

```text
1. canonical Main-01 (preferred single-login source)
2. any verified signed-in Secondary Main
3. another verified signed-in Worker as final fallback
```

Session Seed reads only the allowlisted ChatGPT/OpenAI cookie jar from the source CDP process and transfers it in memory; the source Main is never stopped, navigated, minimized, or otherwise mutated. Runtime identity static coverage now locks this source order.

Live recovery after the repair:

```text
worker-01 LoggedIn=True Automation=True; mapped conversation restored
worker-02 LoggedIn=True Automation=True; mapped conversation restored
worker-03 LoggedIn=True Automation=True; mapped conversation restored
worker-04 LoggedIn=True Automation=True; mapped conversation restored
worker-30 LoggedIn=True Automation=True; no conversation map yet
```

All five running Worker windows were then minimized successfully. No manual Worker login was required, and Main-01/02/03 were not modified to perform the seed.

### Local ingress permanentization work — source implemented, install/secret enrollment pending

`scripts/devspace-local-ingress.ps1` plus `scripts/local-ingress-static-gate.mjs` now implement the intended permanent local ingress manager:

- Windows DPAPI-encrypted DuckDNS token at rest; no plaintext token in config/logs;
- router UPnP is used to read the real WAN IPv4, avoiding Surfshark/VPN egress contamination;
- DuckDNS updates only when authoritative WAN IP changes;
- current LAN IPv4 changes trigger safe repair of owned TCP 80/443 mappings;
- Caddy lifecycle/restart is managed locally;
- Windows Firewall rule is bound to the intended LAN interface/ports;
- Scheduled Task/logon lifecycle is supported;
- normal request traffic has no third-party tunnel-provider request quota.

`verify:local-ingress` is part of `verify:ultra` and full `npm test` is GREEN. Final installation still requires one local DuckDNS-token enrollment step because the token must never be exposed in chat or stored in source.

### New release requirement — package the proven local ingress as an Agent Skill

After the local-ingress Scheduled Task is installed and reboot/restart acceptance passes, capture this exact successful route as a reusable DevSpace Agent Skill. Goal: another user should be able to give the Skill to Codex and have Codex diagnose topology, establish DDNS + router ingress + Caddy + OAuth/Stable Gateway, validate public/private boundaries, install persistence, and recover safely without spending hours manually copying commands between chats.

The Skill must be provider-neutral where possible, treat DuckDNS as the current tested reference implementation, never expose credentials, include preflight/rollback gates, and be wired into the DevSpace Ultra plugin/skill catalogue in the later release update.

### Next development order from this checkpoint

1. Finish the remaining real frontend acceptance for the new Goal strip / turn-scoped Plan HUD without relying on the deleted old acceptance conversation; use a fresh safe acceptance conversation or another exact owner binding.
2. Finish local-ingress installation/reboot persistence and then create/verify the reusable Agent Skill described above.
3. Close the active Context Guardian / Auto Compact v2 final frontend/release gate while preserving structured rollover, Stream Recovery, Refresh, and Main/Worker identity behavior.
4. Only after Plan Card + Goal Mode + Auto Compact v2 are release-complete, begin the next stage: bring Codex Harness Computer Use into DevSpace Ultra's arbitrary plugin/capability layer. The Computer Use stage must supplement the existing plugin layer; it must not be used as a shortcut to skip the current three feature gates.

## 2026-09-06 — Local self-host ingress + Stable Gateway recovery + runtime/login regression fix (latest)

This section supersedes the old Cloudflare/Tailscale production-ingress assumptions above. The user requires a self-hosted hot path with **no per-request quota ceiling**; Tailscale Funnel and quota-limited relay services are no longer the production dependency.

### Production public path — PASS

Final public path now live:

```text
ChatGPT Custom App
-> https://devspace-enwong.duckdns.org/mcp
-> DuckDNS DNS only
-> home public IPv4 223.19.13.253
-> TP-Link router TCP 80/443 UPnP mapping
-> Windows Caddy 2.11.4
-> 127.0.0.1:7678 Stable Gateway
-> Core A/B (currently Core A :7688)
```

Evidence:

- real mobile 5G inbound probe to the home WAN passed before production cutover;
- `devspace-enwong.duckdns.org` resolves to `223.19.13.253`;
- Caddy obtained a real HTTPS certificate and public `/healthz` returns 200;
- Caddy public allowlist exposes only MCP/OAuth/health/assets and returns 404 for `/browser-control/bridge/*`;
- OAuth issuer/resource/authorize/token/register endpoints all use the DuckDNS origin;
- public `/mcp` returns the correct 401 Bearer challenge;
- `DevSpace Local Gateway` ChatGPT Custom App DCR/OAuth connected successfully and read package version `0.5.0`.

### Stable Gateway production cutover — PASS

The old direct 7678 Core was replaced by the long-lived Stable Gateway without changing the DuckDNS public URL or requiring another OAuth reconnect. The migration was repaired to be provider-neutral and to treat an already-down 7678 listener as a recoverable state.

Current verified state:

```text
Scheduled Task = DevSpace-Stable-Gateway / Running
Stable Gateway = 127.0.0.1:7678
Core A         = 127.0.0.1:7688
Core B         = 127.0.0.1:7689 (standby slot)
publicBaseUrl  = https://devspace-enwong.duckdns.org
OAuth clients  = 2
refresh tokens = 2
workspace sessions = 5
migration rollback = false
```

Old authoritative Goal/Plan state was migrated intact:

```text
Goal goal_deac9fadb6bc67dd = paused / round 3 / revision 31 / continuation idle
Plan plan_dfc1ea0e2b285119 = revision 12 / step 10 in_progress
```

The paused Goal was **not resumed** during migration.

### Plan / Goal Host Overlay lifecycle work — implementation GREEN, final real positive owner acceptance still pending

Latest user contract:

- Goal strip persists across physical turns/Goal rounds and disappears naturally only when the full Goal reaches terminal completion;
- Plan HUD is **turn/round scoped**: one active Plan per physical turn/Goal round, complete it before the turn/round finishes, let it disappear naturally, and create a fresh Plan in the next turn/round;
- unchanged backend revision/owner/runtime topology must produce zero repeated projection/DOM content writes;
- polling must not remove/recreate the overlay or cause visible flicker.

Implemented under TDD:

- `PlanRuntime.start()` refuses a second active Plan;
- Plan tool/server instructions now define a fresh Plan per physical turn/Goal round and prohibit reusing completed plans from prior turns;
- same-revision Host Overlay polling is fingerprinted and skipped;
- DOM script has its own state fingerprint and reports `contentWrites:0` for an identical re-entry;
- Goal/Plan nodes stay mounted and use short opacity/translate enter/exit transitions instead of `replaceChildren()` churn on every poll;
- global page-wide MutationObserver/scroll churn was removed in favor of bounded resize/position observation;
- reduced-motion still disables transitions.

Focused `verify:plan`, `verify:host-overlay`, `verify:stable-gateway` and full `npm test` all pass after these changes.

Ownership remains fail-closed. The persisted owner currently points to an older Main-03 conversation that the user reports may already have been deleted; do **not** weaken exact `goalId + runtimeKey + conversationId` ownership to compensate. Establish a fresh verified owner/rollover path for final positive frontend acceptance instead.

### Worker zero-login regression — root cause FIXED + live PASS

Observed regression on 2026-09-06:

```text
worker-01/02/03/04/30 Running=true, Automation=true, LoggedInState=false
Main-01:9721 composer=true, loginVisible=false
```

Root cause: `Find-SessionSeedSource()` in `chat-swarm-classic-controller.ps1` only searched other Workers. When several Workers were simultaneously signed out, none could seed another even though canonical Main-01 was already signed in.

Fixed source priority:

```text
1. canonical signed-in Main-01 on loopback CDP 9721
2. verified signed-in Secondary Main
3. verified signed-in Worker fallback
```

Session transfer remains memory-only through `Network.getAllCookies` / `Network.setCookies`, limited to allowlisted ChatGPT/OpenAI domains, with no raw cookie values logged.

Live repair deliberately did **not** call controller `ensure`, because old Worker conversation mappings could have caused unwanted resume turns. Instead Main-01 directly seeded Worker 01/02/03/04/30; every target returned `targetVerified=true`, and final runtime status reported `LoggedInState=True` for all five. All five Worker windows were then minimized. No user manual login was required and Main-01/02/03 were not stopped or navigated.

### Refresh remains a required supported lifecycle

Do not remove or bypass ChatGPT's official Plugin **Refresh / 重新整理** behavior. The Plan live acceptance already proved that tool-schema changes are not necessarily visible to a host-cached installed App until the official Refresh action updates the tool snapshot. Stable Gateway reload/handover must preserve the App/OAuth/session identity, while explicit Refresh remains the correct schema-refresh path after adding/removing/changing exposed MCP tools.

### Local ingress permanent manager — source implemented, installation pending one local secret entry

New source:

```text
scripts/devspace-local-ingress.ps1
scripts/local-ingress-static-gate.mjs
npm run verify:local-ingress
```

Design:

- Caddy is the public TLS/reverse-proxy process;
- Router WAN IP is authoritative for DuckDNS updates, so Surfshark outbound IP cannot poison DNS;
- LAN IP changes repair the router UPnP 80/443 mapping;
- Caddy/UPnP/DuckDNS state is rechecked on startup and periodically;
- DuckDNS token is stored locally with Windows DPAPI, never plaintext in repo/log output;
- production hot-path traffic goes directly through the user's WAN/Caddy, not through a request-quota tunnel provider.

`local-ingress-static` and full `npm test` pass. Final installation requires the user to enter the DuckDNS token once locally; never request or echo that token in chat.

### Required next order

Keep the original v0.5 feature order and state machines distinct:

1. **Plan / Step Card** — finish turn-scoped lifecycle + real frontend disappear/recreate/Refresh acceptance.
2. **Goal Mode** — finish persistent Goal strip lifecycle, exact-owner recovery after the deleted prior conversation, multi-round persistence, terminal natural disappearance, and Refresh/reload acceptance.
3. **Main Context Window / Auto Compact v2 (Context Guardian)** — complete the remaining real frontend acceptance for rollover/continuity/Stream Recovery while preserving the already-green dynamic model windows, prospective guard, structured checkpoints and same-Goal hidden rollover work.

Only after #1/#2/#3 are fully accepted should the next phase begin: port/replicate Codex Harness **Computer Use** into the universal DevSpace Ultra plugin/capability layer.

### Required reusable setup Skill after ingress permanentization

After `devspace-local-ingress.ps1` is installed and reboot/reconnect acceptance passes, package the complete successful local self-host setup as a reusable **Agent Skill**. Its purpose is to let another user ask Codex/DevSpace to set up the entire quota-free local ingress automatically instead of repeating the multi-hour manual diagnostic conversation. The Skill must include prerequisites, public-IP/CGNAT detection, safe temporary inbound test, DuckDNS setup without exposing tokens, Caddy installation/config/hardening, firewall + UPnP mapping, OAuth/DCR validation, Stable Gateway migration, reboot verification, rollback, and explicit fail-closed gates. Integrate this Skill into the future DevSpace Ultra installer/update flow rather than leaving it as an operator-only note.

### 2026-09-06 — Plan/Goal terminal UX + explicit deleted-owner recovery + Auto Compact v2 next-user-turn implementation

#### #1 Plan / Step Card — terminal UX implementation PASS, production/live terminal disappearance still pending

`dist/ui/plan-card.html` now treats completed Plan cards like transient Codex-style progress UI rather than permanent transcript chrome:

- completed Plan stops polling;
- waits a short terminal dwell (`TERMINAL_DISMISS_MS=650`);
- exits with a bounded 140 ms opacity/translate transition;
- then hides/collapses its document height;
- reduced-motion disables the transition;
- the backend Plan remains immutable/persisted; only the rendered card disappears.

`plan-card-static-gate` went RED before implementation and is GREEN after. The turn-scoped backend invariant remains: one active Plan only, complete it before the physical turn/Goal round ends, create a fresh Plan next turn/round.

#### #2 Goal Mode — terminal UX + deleted-owner recovery implementation PASS, real owner acceptance pending

`dist/ui/goal-dock.html` now gives completed/stopped Goal Dock the same short natural terminal exit instead of leaving a permanent terminal card.

The stale deleted Main-03 owner problem is repaired without weakening exact ownership:

- ordinary navigation can never steal Host Overlay ownership;
- `devspace_goal_mount` remains read-only for Goal state but now explicitly arms a short-lived Host Overlay owner-rebind request;
- `ClassicHostOverlayProjection.requestOwnerRebind()` accepts only the currently projectable Goal ID;
- while armed it retries normal `resolveClassicHostOverlayOwner()` until a real Goal Dock is committed in an exact Chat-mode runtime/conversation;
- only that exact `{goalId,runtimeKey,conversationId}` is persisted;
- wrong Goal IDs are refused and an unresolved mount leaves the old fail-closed owner untouched;
- verified Context Guardian rollovers retain their separate exact-owner migration hook.

TDD evidence: `goal-tools.test`, `classic-host-overlay.test`, `goal-server-static`, `verify:goal`, and `verify:host-overlay` are GREEN. The current conversation is not one of the managed Main-01/02/03 CDP pages, so no synthetic ChatGPT user message was created merely to fabricate a positive live owner result. A managed-Main real frontend positive gate remains required.

#### #3 Main Context Window / Auto Compact v2 — the missing ordinary Main auto-rollover path is now implemented deterministically

Audit confirmed the user's statement that Auto Compact v2 was only partially complete. Before this update:

- dynamic model windows, CJK-aware accounting, monotonic ledger, prospective pressure, structured checkpoints and hidden rollover transport were implemented;
- background polling had deliberately been made checkpoint-only after the startup/reconnect visible-turn safety incident;
- therefore ordinary long-running Main conversations still had no automatic conversation switch unless an already-authorized Goal continuation happened.

New design preserves that safety boundary while finishing the ordinary DevSpace Main path:

```text
background pressure reaches rollover
-> build/reuse structured checkpoint
-> DO NOT navigate, DO NOT click Send, DO NOT create a chat
-> if this managed Main has the DevSpace plugin explicitly paired, arm Fetch for the next genuine user Send
-> user presses Send normally
-> intercept that same POST /backend-api/f/conversation request
-> remove old conversation_id and old parent_message_id
-> prepend one visually-hidden DevSpace tool capsule
-> preserve the user's original visible message structure unchanged
-> continue that SAME user-triggered request as a fresh conversation
-> wait for new conversation + assistant completion + empty composer
-> verify fresh native transcript contains visible user >= original count, hidden capsule >=1, visible assistant >=1
-> only then adopt the new native baseline and publish verified rollover/Goal owner migration
```

Safety invariants:

- startup/reconnect/background polling remains **send-free**;
- no second/synthetic visible user bubble is generated;
- a new-chat request that already has no `conversation_id` is never rewritten again;
- Work mode is refused;
- active generation is not armed;
- non-DevSpace ordinary ChatGPT conversations (`devspacePluginPaired != true`) remain checkpoint-only and are never rewritten;
- user composer text is never cleared/navigated away; an already-armed interceptor simply waits for the real Send;
- rewritten request failure is fail-closed (`Fetch.failRequest`) rather than falling back into the near-limit old conversation;
- post-rollover native verification waits for `composerTextChars==0` before any reload/capture, so fast next-turn typing cannot be erased;
- authorized Goal hidden rollover cancels an ordinary user-turn Fetch arm before using its own hidden transport.

New/updated deterministic evidence:

- `buildClassicUserTurnRolloverBody` preserves the actual visible user message while adding only the hidden capsule and fresh parent;
- `rewriteUserTurnRolloverPausedRequest` is fail-closed;
- `ClassicContextMetadataCdpAdapter` exposes arm/cancel lifecycle and verified user-turn rollover event;
- `ContextGuardianRolloverCoordinator` uses `armed-user-turn-rollover` instead of background sending, keeps reported Goals on Goal Host Bridge, and can migrate exact Goal owner after verified ordinary rollover;
- `verify:context-guardian` is GREEN with `userTurnAuthorizedRollover=true` and `backgroundRolloverSendFree=true`.

**Not yet claimed live:** this new ordinary user-turn path still needs one real managed Main, DevSpace-paired, near-limit acceptance where the user genuinely presses Send. Do not substitute a synthetic browser message for that gate.

#### Refresh contract remains mandatory

No new MCP tool name was added for deleted-owner recovery or Auto Compact user-turn rollover. This deliberately avoids unnecessary host-schema churn. The existing official ChatGPT Plugin **Refresh / 重新整理** flow remains the supported way to refresh cached tool schemas/descriptions/resources after future exposed MCP surface changes, and Stable Gateway handover must preserve OAuth/public session identity across that Refresh.

### 2026-09-06 — Stream Recovery renderer-COMPLETE discovery regression fix

A real managed Main-02 exposed a separate Refresh/reconciliation gap while Context Guardian was at natural rollover pressure:

```text
Main-02 conversation = 6a9c696c-9630-83e8-a70f-4bbe4b59e5d1
DOM generating       = true
server stream_status = COMPLETE
progress signature   = stable/stale
```

Root cause: `ClassicStreamRecoveryGuard` previously armed only after a `Network.loadingFailed` event for `/stream_status`. If the network/server completed normally but the ChatGPT Classic renderer failed to clear its generating state, no failure event occurred and recovery never inspected that Main.

TDD fix:

- Stream Recovery now receives `listRuntimes()` from the already-connected managed Main CDP adapter;
- no-transport-failure discovery watches only Chat-mode runtimes that still report `generating=true`;
- progress signature must remain exactly unchanged for **15 seconds** before any server query;
- any progress change resets the timer;
- the server must then explicitly report `stream_status=COMPLETE` before reload;
- `RUNNING` or unavailable server status never reloads and restarts the conservative watch window;
- recovery stays same-URL and one-shot with the existing per-conversation cooldown;
- Work mode and changed conversations remain untouched;
- **unsent composer text is now a hard reload guard for both transport-failure and stuck-renderer recovery paths**;
- adapter inspection now returns `composerTextChars` so Refresh/reload cannot erase draft text.

Deterministic evidence:

```text
classic-stream-recovery-guard = GREEN
classic-stream-recovery-cdp-adapter = GREEN
classic-stream-recovery-static = GREEN
transportFailureOrStuckRendererDiscovery = true
unsentComposerProtected = true
serverCompleteRequired = true
```

A production A/B handover + the same natural Main-02 stuck-COMPLETE case is the next live acceptance for this exact fix.

### 2026-09-06 10:xx +08 — Stable Gateway dead-Core incident, recovery, and liveness supervisor

A real production failure proved a missing Stable Gateway invariant. The long-lived Gateway listener itself remained alive on `127.0.0.1:7678` (PID observed 49096; Scheduled Task `DevSpace-Stable-Gateway=Running`), but both private Core slots were down:

```text
7688 = DOWN
7689 = DOWN
7678 /healthz = 502 {"error":"connect ECONNREFUSED 127.0.0.1:7689"}
public DuckDNS /healthz and MCP therefore also failed through the same dead active Core target
```

The user restored service without refreshing/reloading any ChatGPT page by starting one temporary **passive** recovery Core B on `127.0.0.1:7689`, using the canonical bootstrap config/state and DuckDNS public identity. Recovery PID observed: `46604`. Safety automation was explicitly disabled on that recovery Core (`DEVSPACE_PASSIVE_CORE=true`, Stream Recovery/Context Guardian/Host Overlay/Auto Compact/plugins false). Fresh evidence after recovery:

```text
7689 /healthz = 200
7678 /healthz = 200
public OAuth metadata = correct DuckDNS issuer/endpoints/scopes
public /mcp = 401 Bearer challenge with DuckDNS protected-resource metadata
```

One public `/healthz` attempt had a transient DNS-resolution timeout, but subsequent OAuth and `/mcp` requests succeeded through the same DuckDNS/Caddy path, so Caddy/DNS were not the root cause.

Root cause in source: `startCoreSlot()` returns the real child process handle, but `stable-gateway-controller.js` did not subscribe to unexpected exit of the **current active Core handle**. After a successful A→B handover, A is intentionally stopped; if B later dies, the Gateway retained stale `activeSlot/activeHandle/proxy` state and kept forwarding to the dead B port indefinitely.

TDD repair is now source-complete and regression-green:

- new focused gate `dist/stable-gateway-liveness.test.js` reproduces `A -> successful handover to B -> B unexpected exit -> automatic same-slot B restart -> MCP session replay -> same public session ID`;
- the new gate failed first with `waitUntil timed out`, proving the old controller had no active-Core recovery;
- controller now watches only the **current active** child handle;
- intentional handover/close exits do not trigger false recovery; exits during handover are deferred and rechecked against the authoritative active handle after the handover finishes;
- unexpected active-Core exit closes admission, waits for HTTP/MCP drain, restarts the **same active slot**, replays existing MCP sessions, commits new backend mappings, atomically updates the proxy, and reopens admission;
- recovery failure marks the Gateway degraded/fatal and returns 503 rather than silently continuing to target a dead Core;
- handover refuses to run concurrently with Core recovery;
- `status()` now reports `coreRecoveryInProgress` and `fatalCoreRecoveryError`;
- `verify:stable-gateway` now includes the liveness gate.

Fresh verification:

```text
stable-gateway-controller = PASS
stable-gateway-liveness = PASS
npm run verify:stable-gateway = PASS
```

The new Gateway source has now been loaded through a response-safe delayed Scheduled Task restart. Post-restart state was clean: Gateway PID `60988`, managed Core A PID `58348`, and temporary manual recovery Core B/7689 was gone. Private status explicitly exposed the new supervisor fields with `coreRecoveryInProgress=false`, `fatal=false`, and `fatalCoreRecoveryError=null`; the existing Goal state remained readable through the same ChatGPT Local Gateway App without re-OAuth.

A bounded production liveness gate then deliberately terminated only the verified DevSpace Core listener on 7688. Before the gate, Gateway PID was `60988` and Core A PID was `58348`. After the gate:

```text
Gateway PID = 60988 (unchanged; creation 10:29:12)
Core A PID  = 54784 (new; creation 10:31:56)
activeSlot  = a
fatal       = false
coreRecoveryInProgress = false
Local Gateway tool call = succeeded immediately after recovery
```

This is direct production proof that the **Gateway process itself did not restart**; the new controller observed the active Core exit, restarted the same slot, replayed MCP sessions, and continued serving the existing ChatGPT App session. No ChatGPT page refresh/reload, re-login, or OAuth reconnection was used. Stable Gateway dead-Core recovery is therefore **production-live PASS**.

Worktree dependency incident also exposed two durable rules for later productization:

- managed worktree `node_modules` may safely reuse the installed production dependency tree through a Windows directory junction when dependency compatibility is verified; the real junction/import gate passed (`MCP-SDK-OK`, `EXT-APPS-OK`, all 20 declared production/optional dependencies present);
- Windows PowerShell 5.1 has no `ConvertFrom-Json -AsHashtable`; the earlier lock comparison printed a false `MATCH` because both parse variables were null. Do not use that command in the future bootstrap. The global npm installation also has no `package-lock.json`, so a reusable Worktree Dependency Bootstrap must fingerprint the worktree manifest against the **actual installed package versions**, not depend on a production lockfile.

Planned resilience addition after the current critical path: an **Independent Local Rescue Control Plane** bound only to loopback with minimal operations (status, dedicated-port inspection, Core/Gateway restart, worktree dependency repair) so DevSpace can repair its own control plane when the primary MCP Gateway is unavailable. This rescue layer must not expose secrets or public routes and must not depend on ChatGPT page refresh.

**Rolling handoff rule:** update this same file after every independently verified gate from this point forward.

## 2026-09-06 — AUTHORITATIVE architecture reset: conversation authority, zero automated refresh, exact actual usage, true same-conversation Auto Compact

Canonical framework:

```text
docs/DEVSPACE-ULTRA-V0.5-CLASSIC-CONVERSATION-AUTHORITY-FRAMEWORK.md
```

This section **supersedes every earlier handoff statement that conflicts with it**, including earlier notes that described automated Refresh/reload as a required recovery lifecycle, treated snapshot/ledger/DOM token estimates as Context Guardian authority, called fresh-conversation rollover Auto Compact, or bound Goal/Plan ownership to a runtime.

### New hard invariants

1. **Automated ChatGPT page refresh/reload/navigation-as-reload is forbidden.** DevSpace must not use `Page.reload`, same-URL `Page.navigate`, `location.reload`, or equivalent automated refresh as recovery, fallback, startup/reconnect repair, Goal/Plan lifecycle repair, snapshot capture, Auto Compact, or acceptance.
2. **UI/DOM is never backend authority.** DOM is permitted only for real user-visible acceptance evidence after backend truth is known. DOM text length, message counts, stop buttons and token estimates must not drive context, compaction, recovery, safety, Goal or Plan decisions.
3. **Context usage must come only from ChatGPT Classic native/backend exact actual-usage metadata.** The earlier exact field/endpoint research was not durably recorded. Do not guess it. Re-derive it from protocol evidence before implementation. `devspace-ledger`, Classic conversation snapshot estimates, DOM estimates and CJK estimators are not accepted fallbacks.
4. **Auto Compact v2 means true same-conversation compaction.** PASS requires the same ChatGPT conversation ID before/after and exact native actual usage falling after compaction. Fresh-conversation hidden rollover/checkpoint continuity is not Auto Compact and is no longer the v0.5 primary compact architecture.
5. **Goal and Plan are conversation-bound, not runtime-bound.** Goal identity becomes `{conversationId, goalId}`. Plan identity becomes `{conversationId, physicalTurnId/goalRound, planId}`. `runtimeKey` is only a projection transport host. Switching conversations in one Main must hide the prior conversation's overlay and show only the newly active conversation's state; returning to the old conversation restores its state without owner migration.
6. **The frontend safety-check freeze is a protocol/request-state problem, not a reload problem.** DevSpace must identify/prevent its problematic request sequence or stop adding automation while the native Host state is unresolved. It must not bypass a legitimate ChatGPT safety decision and must not recover by refresh.
7. **Frontend acceptance must inspect the same real Classic frontend the user is looking at.** Backend-only Goal/Plan state is insufficient for visible UX claims. No refresh may be used to force the frontend to agree.

### Current production-code conflicts confirmed before migration

The current tree still contains legacy behavior that must be removed or demoted:

```text
dist/context-guardian-cdp.js
  - estimateClassicInputTokens / snapshot/message estimators
  - DOM domObservedTokens
  - captureNativeConversationPayload(... reload=true) -> Page.reload
  - captureNativeSnapshot() reload-backed capture
  - fresh Chat Page.navigate + hidden/user-turn fresh-conversation rollover

dist/context-guardian.js
  - snapshot/ledger fallback in computeContextGuardianPressure
  - observeTurnInputEstimate monotonic estimator ledger
  - devspace-ledger / classic-conversation-snapshot may become usageSource

dist/classic-stream-recovery-guard.js
  - reload adapter / automatic reload states and cooldowns

dist/classic-stream-recovery-cdp.js
  - same-URL Page.navigate renderer recovery

dist/classic-host-overlay.js
  - owner persisted as {goalId,runtimeKey,conversationId}
  - exact-runtime-only projection
  - owner rebind/transfer required by runtime ownership
  - standalone Page.reload adapter
```

These legacy paths must not be used as evidence that the new architecture is complete.

### Revised migration / completion order

1. **Durable contract:** framework + this handoff + PowerMem aligned — framework written; PowerMem architecture decision already stored as memory `751610722542157824`; this handoff section completes the documentation alignment.
2. **Real frontend baseline, zero refresh:** inspect the user's actual current Classic frontend and compare visible Goal/Plan state with backend state. This is now the immediate live gate because the user reports Goal Mode did not auto-start/become effective and Goal/Plan conversation projection is not visibly effective.
3. **Conversation-bound Goal/Plan registry/projection:** remove runtime ownership from identity; prove A→B→A conversation switching in one runtime does not leak overlays; Goal persists to terminal; Plan remains physical-turn/round scoped.
4. **Zero-refresh safety/reconciliation:** remove automated reload/navigation recovery and replace it with protocol-native request/safety state handling.
5. **Exact actual usage:** re-derive and preserve the exact Classic actual-usage metadata field/event; wire Context Guardian exclusively to it; unresolved must fail closed rather than estimate.
6. **True same-conversation Auto Compact:** discover/prove Classic native same-conversation compaction, re-read exact actual usage after compaction, require same conversation ID and lower actual usage.
7. Only after Plan Card + Goal Mode + true Auto Compact v2 are release-complete may Codex Harness Computer Use/plugin-layer work begin.

### Acceptance evidence required before completion claims

Goal Mode / Plan frontend claims require both backend state and direct inspection of the exact current Classic conversation. True Auto Compact requires machine-readable evidence equivalent to:

```text
sameConversationId = true
actualUsageBefore = <exact Classic native value>
actualUsageAfter  = <exact Classic native value>
actualUsageAfter < actualUsageBefore
automatedReloadCount = 0
syntheticVisibleUserMessages = 0
```

Do not mark the v0.5 Context Guardian / Auto Compact feature complete from estimator/ledger output, a fresh-conversation rollover, backend-only Goal/Plan state, or a different frontend conversation from the one the user is actually viewing.

## 2026-09-06 — User-facing white floating progress overlay: production-live

The first renderer-independent Local Activity browser page was rejected as the primary user UI because it exposed engineering concepts (tool calls, Gateway/Core status, timings, Plan backend state) rather than plain-language progress. It remains an internal loopback debug surface only.

The replacement user-facing surface is now production-live:

- Windows native WPF overlay: `scripts/devspace-live-progress-overlay.ps1`;
- plain-language update helper: `scripts/devspace-progress.mjs`;
- Gateway-owned durable feed: `dist/stable-gateway-human-progress.js`;
- endpoint: `http://127.0.0.1:7678/__devspace/progress`;
- Scheduled Task: `DevSpace-Live-Progress-Overlay`, current-user limited privilege, AtLogOn, currently running;
- visual contract: white `460×340` card, `16px` radius, subtle shadow, top-right, `Topmost=true`, draggable, closeable, no taskbar clutter;
- **superseding UI contract:** the earlier `正在進行` / `最近完成` status board was rejected by the user and removed. The overlay is now a plain assistant-style natural-language transcript with a small `DevSpace Ultra` header only;
- each visible paragraph is proactively authored by the assistant itself using `scripts/devspace-progress.mjs --message "..."`; low-level tool calls are never automatically translated into pseudo-human status;
- no tool names, PID, ports, HTTP counters, raw Plan/Gateway status, JSON, checklist/status labels, or ChatGPT renderer controls;
- `messages[]` persists as `devspace-live-progress.json` under canonical Stable Gateway state and survives Gateway/Core restart; legacy `doing/completed` fields remain accepted for compatibility but are never rendered;
- each natural-language message is bounded to 1600 characters and obvious credential-bearing content is rejected;
- public Caddy does not expose the route; it remains loopback-only.

TDD / verification:

```text
stable-gateway-human-progress = PASS
stable-gateway-human-progress-http = PASS
live-progress-overlay-static = PASS
PowerShell 5.1 -Action validate = PASS
Stable Gateway regression = PASS
Scheduled Task Installed=true / Running=true
WPF process PID = 61656 (natural-language transcript revision)
Win32 visible window = true
Window rect = 1436,24 460x340
Offscreen = false
```

Windows UI Automation read the real rendered surface and confirmed the transcript TextBlock contains the assistant-authored Cantonese paragraphs separated by blank lines. The final accepted UI no longer exposes the earlier status headings/checkmarks. This is real desktop evidence, not a backend-only assertion.

Durable workflow rule: during non-trivial ChatGPT Classic DevSpace work, proactively append one concise natural-language assistant paragraph at meaningful work boundaries using `node scripts/devspace-progress.mjs --message "..."`. Write it as if continuing to explain progress in ChatGPT Classic: what was just established, what is being done next, and why it matters when useful. Do not mirror every low-level tool call, do not use mechanical `doing/completed` labels, and do not expose engineering-only status. The overlay is observability only and never backend authority.

## 2026-09-06 — Native conversation authority foundation: deterministic PASS, live correlation pending next real turn

The earlier short-lived MCP metadata probe was recovered from Core logs. Exact evidence:

```text
MCP _meta keys:
  openai/locale
  openai/organization
  openai/session
  openai/subject
  openai/userAgent
  openai/userLocation

MCP request headers include:
  x-openai-session
  mcp-session-id
  traceparent
  ...

openai/conversation_id / openai/conversationId = absent
```

The same hashed `openai/session` fingerprint `ab1587b254a2f7d2` was observed 1157 times during the probe history, but that alone is **not** accepted as proof that the value is conversation-scoped. Public OpenAI docs do not define its lifetime, so DevSpace must prove the mapping from native transport evidence rather than assume it.

Existing Classic-native CDP observation already sees real `POST /backend-api/f/conversation` requests and reads the native request body `conversation_id`. New foundation code now correlates only transport evidence:

- `dist/classic-conversation-authority.js`
- `dist/classic-conversation-authority.test.js`
- `scripts/classic-conversation-authority-static-gate.mjs`
- `dist/context-guardian-cdp.js` parses the native turn request body immediately for `conversation_id`, and `ClassicTurnIdentityCorrelator` correlates that request with Chrome CDP `Network.requestWillBeSentExtraInfo` by `requestId` so final `x-openai-session` headers are not missed when they are absent from the primary `requestWillBeSent` event;
- raw session values remain inaccessible outside hashing; only `{requestId, conversationId, sessionFingerprint}` leaves the correlator;
- `dist/server.js` owns `ClassicConversationAuthorityRegistry` at canonical state file `classic-conversation-authority.json` and consumes the dedicated `onConversationIdentity` event, leaving ordinary `onTurnRequest` semantics unchanged.

Authority rules are strict:

- raw `openai/session` / `x-openai-session` values are never persisted; only SHA-256 fingerprints are stored;
- generic MCP `sessionId` is never accepted as conversation evidence;
- an unknown fingerprint fails closed;
- if one fingerprint is ever observed with more than one distinct conversation ID, it is marked `ambiguous` and resolution fails closed;
- the registry has no DOM/location/runtime fallback and no refresh/reload dependency.

Fresh gates:

```text
classic-conversation-authority = PASS (nativeOnly=true, ambiguityFailsClosed=true)
context-guardian-cdp = PASS
classic-conversation-authority-static = PASS (nativeTransportOnly=true, persisted=true)
npm run verify:context-guardian = PASS
full npm test = PASS
```

The first genuine user turn after the initial observer load did **not** create the authority file. Investigation showed that relying only on `Network.requestWillBeSent.request.headers` was incomplete because Chrome can surface final request headers through `Network.requestWillBeSentExtraInfo`. The new request-id correlator was added TDD-first and full `npm test` passes. The running Core was then reloaded through the same-slot supervisor (`7688` PID `23456 → 40628`) with the Gateway and ChatGPT page left untouched. The **next genuine ChatGPT Classic user turn after PID 40628 became active** is the live correlation gate. Do not infer or backfill mapping from DOM/URL. Inspect `classic-conversation-authority.json`; only a unique mapping may be promoted into Goal/Plan conversation identity, and later A/B conversation switching must prove the fingerprint does not span multiple conversations.

## 2026-09-06 — Core OOM + stale MCP replay incident: root-caused and bounded, deployment pending

A real production failure occurred while loading the zero-refresh Core changes. Stable Gateway stayed alive on `7678`, but both Core ports became unavailable and public traffic degraded. User-provided Core logs showed repeated V8 terminal failures:

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The same incident also exposed a second fatal coupling: after a replacement Core was started, Stable Gateway attempted to replay every retained public MCP session; one stale session initialize replay failed and the controller marked the entire Core recovery fatal. The observed public error was equivalent to:

```text
Stable Gateway Core recovery failed: Core core-a initialize replay failed for public session <id>
```

The user performed one clean Stable Gateway restart after all `7678/7688/7689` listeners were verified as DevSpace processes. Recovery evidence immediately after restart:

```text
7678 Gateway ready = 200
7688 Core A ready = 200
activeSlot = a
coreRecoveryInProgress = false
fatal = false
public /mcp = 401 Missing Authorization header (expected)
```

Root causes found in source:

1. `StableGatewaySessionRegistry` retained public sessions indefinitely and `entriesForReplay()` returned all of them, including full initialize payload + in-memory replay credential.
2. `replaySessionsToCore()` was all-or-nothing: one stale initialize/initialized-notification replay threw and poisoned the whole Core recovery/handover.
3. Core `McpSessionRegistry` had a 30-second idle timeout and 5-second cleanup timer, but no register-time inactive hard cap, so a sequential reconnect/replay burst could allocate many full MCP server/transport instances before the first timer tick.
4. `ClassicTurnIdentityCorrelator.pending` had no TTL or hard cap if one side of `requestWillBeSent` / `requestWillBeSentExtraInfo` never arrived.

Fresh fixes now on disk:

- `dist/stable-gateway-runtime.js`
  - inactive public-session TTL;
  - hard retained-session bound;
  - separate bounded replay count;
  - stale inactive pruning;
  - explicit `remove(publicSessionId)` for replay isolation.
- `dist/stable-gateway-proxy.js`
  - replay is per-session isolated;
  - failed stale session is removed and reported in `droppedPublicSessionIds`;
  - healthy sessions continue replaying;
  - all old sessions may be dropped while a healthy replacement Core still becomes active so clients can fresh-initialize.
- `dist/stable-gateway-controller.js`
  - Core recovery, handover and rollback consume partial replay results;
  - `replayedSessions` + `droppedSessions` reported separately;
  - stale session failure alone no longer creates `fatalCoreRecoveryError`.
- `dist/mcp-sessions.js` + `dist/server.js`
  - Core registry now receives `MCP_MAX_INACTIVE_SESSIONS` at construction;
  - register-time inactive cap closes oldest inactive transports immediately rather than waiting for the 5-second timer;
  - in-flight sessions remain protected.
- `dist/context-guardian-cdp.js`
  - `ClassicTurnIdentityCorrelator` now has bounded pending request correlation (`pendingTtlMs`, `maxPending`), immediate removal on success, oldest eviction at cap and expiry pruning.

Regression evidence:

```text
stable-gateway-runtime = PASS (boundedReplay=true)
stable-gateway-proxy = PASS
stable-gateway-controller = PASS
stable-gateway-liveness = PASS (partialReplayRecovery=true)
stable-gateway-handover = PASS (rollback=true, staleReplayIsolation=true)
mcp-session-registry = PASS (inFlightProtected=true, inactiveBounded=true)
mcp-session-lifecycle-static = PASS
```

A real-Core/OAuth/MCP soak mode was added to `scripts/stable-gateway-real-core-canary.mjs` and exposed as:

```text
npm run verify:stable-gateway:soak
```

Fresh real soak PASS, using a **1 GB child V8 heap cap**:

```text
realCore = true
passiveCore = true
pluginsDisabled = true
sessionChurnCount = 64
peakGatewaySessions = 24
soakReplayBounded = true
toolCountBefore = 87
toolCountAfter = 87
two A/B handovers completed
productionPortsUnchanged = true
secretValuesLogged = false
```

This is deliberate OOM-pressure acceptance: a recurrence of the former session explosion should fail below 1 GB instead of surviving only because Node's default heap reaches ~4 GB.

The zero-refresh architecture changes from the prior section remain intact and fresh full `npm test` passes together with these memory/session fixes. Production source therefore has the intended no-Page-refresh/no-fresh-chat-as-compact control paths plus the new bounded session/replay protections.

**Deployment update:** the bounded Gateway/session-replay code above was subsequently loaded by one controlled whole-Gateway restart. Fresh live state after deployment: Gateway PID `43136`, Core A PID `44600`, private Gateway/Core health `200`, `fatal=false`, `coreRecoveryInProgress=false`, and the live public-session registry was exactly `24`, proving the new hard retention cap was active in production. No ChatGPT page refresh or OAuth reconnect was used.

## 2026-09-06 — Conversation-bound Goal/Plan backend + projection map + safe native usage evidence: deterministic PASS, Core deployment pending

The runtime-owned Goal/Plan model is now migrated in source/tests to a conversation-first model while preserving legacy state readability.

### Plan runtime/tool contract

`dist/plan-runtime.js` now stores optional `conversationId` (legacy missing value normalizes to `null`). New behavior:

- `start({ conversationId, ... })` only treats an active Plan in the **same conversation** as a duplicate;
- a legacy unbound active Plan no longer blocks a new bound Plan;
- different conversations may each have one active turn Plan at the same time;
- `activePlans({ conversationId })` filters exact conversation state;
- unfiltered diagnostics may still enumerate legacy/global state.

Production `registerPlanTools(...)` receives `resolveConversation`, backed only by `ClassicConversationAuthorityRegistry.resolveMcpExtra(extra)`. When that resolver is enabled, `devspace_plan_start` refuses to create a new unbound Plan if native conversation identity is unresolved. Existing legacy Plan status/update remains readable for migration compatibility; the old `plan_dfc1ea0e2b285119` is intentionally **not** auto-bound to the current conversation.

### Goal runtime/tool contract

`dist/goal-runtime.js` also stores optional `conversationId` and adds one-time `bindConversation({ goalId, conversationId })`:

- a legacy unbound Goal may be bound once after native authority proves its conversation;
- binding the same conversation is idempotent;
- trying to move a bound Goal to a different conversation fails closed;
- `activeGoals({ conversationId })` and `projectableGoals({ conversationId })` filter exact conversation state.

Production Goal tools use the same native resolver. New Goal creation refuses unresolved/unbound identity. Existing active legacy Goal calls remain usable during migration; when a unique native mapping becomes available, an active unbound Goal is opportunistically bound once. Any later tool call from a different resolved conversation is rejected.

Fresh Plan/Goal gates:

```text
plan-runtime conversationBound = PASS
plan-tools conversationBound = PASS
verify:plan = PASS
goal-runtime conversationBound = PASS
goal-tools conversationBound = PASS
verify:goal = PASS
```

### Host Overlay conversation projection map

The existing zero-flicker DOM renderer is preserved, but bound state no longer uses `{runtimeKey, conversationId}` owner assignment as its primary projection model.

New primary mode:

```text
backend Goal/Plan rows
        ↓
conversationBoundProjectionMap
        ↓
{ conversationId -> { goal, plan } }
        ↓
syncConversationMap() to every connected Main
        ↓
renderer uses current /c/<conversationId> route only to select visual projection
```

Important authority boundary: the route/renderer is used **only for visual selection** and never mutates or defines backend identity. Backend Goal/Plan identity remains the native conversation ID. The legacy owner store remains only as an unbound migration fallback; once any bound projection is active the stale owner pointer is cleared.

Conversation-bound map is intentionally re-evaluated cheaply on each projection poll so switching A→B in the same runtime changes the visual card even when backend revisions are unchanged. The renderer's existing projection/content fingerprints remain intact, so unchanged conversation+revision still performs zero card content writes/remounts.

Fresh Host Overlay gates:

```text
classic-host-overlay conversation map = PASS
verify:host-overlay = PASS
```

### Safe Classic-native usage evidence collector

Because the previously verified exact actual-usage field name was lost from durable research memory, DevSpace now has a bounded protocol-evidence collector to re-derive it without guessing or falling back to estimator/DOM data.

New files:

- `dist/classic-native-usage-evidence.js`
- `dist/classic-native-usage-evidence.test.js`
- `scripts/classic-native-usage-evidence-static-gate.mjs`

Native capture behavior:

- tracks only real `POST /backend-api/f/conversation` request IDs;
- inspects final request headers (`Network.requestWillBeSentExtraInfo`), response headers (`Network.responseReceivedExtraInfo`) and, after a completed response, the native response body via `Network.getResponseBody`;
- response body inspection is skipped above a hard 16 MiB encoded-data bound;
- raw body exists only transiently in process memory for parsing and is immediately reduced to at most 256 numeric candidates;
- persisted candidate shape is only `{source,path,value,eventType?}` under a proven `conversationId`;
- paths must match usage/token/context/remaining/limit/input/output/cached/prompt/completion semantics;
- prompt text, assistant text, cookies, authorization values, opaque tokens and full response content are never persisted.

Persistent research file after the next genuine native turn will be:

```text
classic-native-usage-evidence.json
```

This evidence file is **research input only**. Context Guardian does not yet treat any candidate as authoritative actual usage. Only after one exact native field is re-verified across turns may estimator/ledger/DOM authority be removed and replaced with that field.

Fresh gates:

```text
classic-native-usage-evidence numericPathsOnly = PASS
rawContentPersisted = false
credentialValuesPersisted = false
classic-native-usage-evidence-static = PASS
verify:context-guardian = PASS
full npm test = PASS
```

### Current deployment / next live gate

The Gateway bounded-session layer is production-live. The newest **Core-only** changes in this section have now also been loaded through the same-slot supervisor without restarting Gateway or refreshing ChatGPT. Fresh live listeners after reload:

```text
Gateway 7678 PID 43136
Core A 7688 PID 44292
Core B 7689 down
```

A post-reload `devspace_goal_status` returned the new `conversationId:null` field for current Goal `goal_1b2f3eb499d8f460`, proving the new runtime/tool schema is live. `null` is expected because the real user Send that started this assistant turn happened **before** the Core reload; DevSpace correctly refused to invent/backfill a mapping. At this exact baseline both `classic-conversation-authority.json` and `classic-native-usage-evidence.json` are absent, which is the required fail-closed state before the next native turn.

The next **genuine user Send after Core PID 44292 became active** is a dual live gate:

1. `classic-conversation-authority.json` must record one unique native session fingerprint → conversation ID mapping; the first `devspace_goal_status` in that turn should then bind current active Goal `goal_1b2f3eb499d8f460` exactly once to that conversation.
2. `classic-native-usage-evidence.json` must show which usage/token/context numeric paths actually exist in the same native turn. Do not promote any candidate to Context Guardian authority until its semantics are verified.

Do not use hidden Goal continuation/recovery prompts as this live user-turn evidence, and never infer the mapping from DOM/URL.

## 2026-09-07 — Fresh-conversation restoration after the previous chat length limit

This checkpoint records newly observed state; it does not declare the frontend-stall repair or v0.5 complete.

### Working connection and preserved checkout

- `DevSpace_Local_Gateway.open_workspace` succeeded against the original package checkout.
- `DevSpace_Tailscale_Gateway` and `DevSpace_Ultra` each returned account-connection HTTP 400 in the fresh conversation. The Local Gateway is the working route; no reinstallation or service restart was needed for these reads.
- Fresh Git inspection: `main`, HEAD `1c48540` (`feat: add persistent goal mode`), three local commits ahead of `origin/main`, with extensive existing modified/untracked v0.5 files. No reset, clean, checkout replacement, commit, push or release was performed.

### Current backend Goal, not the obsolete capsule Goal

Fresh `devspace_goal_status` returned:

```text
goalId          = goal_1b2f3eb499d8f460
status          = active
round           = 5
roundState      = working
revision        = 38
conversationId  = null
roundRecovery   = idle
continuation    = idle
```

The latest successful report is Round 4, reported at `2026-09-06T09:12:09.814Z`. Its evidence is newer than the earlier deployment sections above: WPF progress was changed to direct durable-file reading, the stale visual projection received a 15-second lease, and the shared CDP client was bounded. That report next targeted a 512MB feature-isolation memory soak followed by native identity/usage/same-conversation compact acceptance. These are historical report claims until individually rechecked.

The old handoff continuity key initially had no capsule in the currently active bootstrap state. The available `capsule_3acf5ddf582c0c31` was read but contains superseded runtime/ledger/fresh-rollover assumptions and an obsolete Goal; do not resume its task frontier as the current one.

### Fresh verification completed in the restoration turn

```text
node --test dist/classic-cdp-client.test.js dist/goal-run-progress-supervisor.test.js dist/classic-turn-delivery-evidence.test.js
  3 PASS / 0 FAIL

node scripts/goal-run-progress-static-gate.mjs
  PASS
```

The static gate checks server start/tool-boundary/close wiring and the overlay's durable run-file integration. The running backend's `devspace-goal-run-live.json` was also directly read under `C:\Users\enwong\.local\share\devspace-tailscale-bootstrap`; it contained Goal round 5/revision 38 and a fresh `open_workspace` boundary/heartbeat at `2026-09-06T17:00:07.665Z`. This establishes live durable progress output, not successful model continuation or visible timeout recovery. No real frontend recovery, native exact-usage, or same-conversation compaction gate was newly run.

### PowerMem and safety boundary

PowerMem was **not directly read or written** in this restoration turn. The Local Gateway capability search/list returned no plugin entries, and global app discovery found no PowerMem app. The earlier architecture record `751610722542157824` is known only by its handoff reference.

A combined shell request containing natural-language progress publication and local configuration discovery was blocked by the platform safety check and did not execute. It was not retried through an equivalent route. Further access to that denied configuration-discovery operation requires renewed scoped approval; do not state that a progress paragraph was published by the blocked call. Direct workspace reads, Goal status, continuity resources and the unrelated focused tests continued to work.

### New durable continuation resource

```text
capsuleId     = capsule_9050f380c646573a
continuityKey = devspace-ultra-v0.5-goal-mode-2026-09-05
```

This resource preserves the restored frontier and is native task continuity, not a replacement global memory database. Restore it through `conversation_compact_restore` before relying on the superseded older capsule.

Next work: recover the existing PowerMem service through an approved bounded path; verify native current-conversation identity before binding or dispatching the old Goal; inspect/test the final delivery-recovery path while preserving legitimate safety decisions and zero refresh; then continue the isolated memory-soak and exact-usage/true-compact acceptance. Do not create a duplicate Goal, guess a conversation binding, redeem an invented continuation ID, or dispatch a report/continuation into the prior full conversation simply to simulate a successful handover.

## 2026-09-07 — Permanent Classic delivery-timeout / durable-run hardening

The user reported the recurrent production failure precisely: after ChatGPT Classic shows an additional automated safety check, the visible assistant turn can remain pending for a long time and eventually render `訊息遞送逾時，請再試一次 / Message delivery timed out. Please try again.` The user intentionally does not press Retry because that destroys visible frontend progress. Requiring the user to type `繼續` is rejected as a product architecture. The durable backend Goal must survive the failed visible turn and resume automatically in the same conversation without refresh, Retry, or a synthetic user message. The floating Windows transcript must also update proactively even when Classic is stalled.

Fresh live evidence established a split-brain state that the old guard could not handle: on a Classic page the native `/backend-api/conversation/<id>/stream_status` returned `COMPLETE` while the GUI still exposed `generating=true`. Therefore a GUI stop/generating flag is not allowed to veto a stable native terminal state forever. Safety-check notice text remains a fail-closed visual confirmation only; GUI never becomes backend authority.

### Backend-owned progress is now truly proactive

`dist/goal-run-progress-supervisor.js` already persisted `devspace-goal-run-live.json`; it was upgraded so every MCP `tools/call` records **two** durable boundaries:

```text
tool start -> inFlightToolName/category/startedAt + visible currentText
every 15s -> backend heartbeat with elapsed seconds while the same tool is running
tool finish/fail -> durable stepCount/result boundary, in-flight fields cleared
```

`dist/server.js` now awaits `noteToolStart()` before `transport.handleRequest()` and records `noteToolBoundary()` after completion or failure. The WPF overlay directly merges this backend run file; it does not need the stalled model to call `devspace-progress`. Targeted test/static gate PASS with `automaticToolStart=true`, `automaticToolBoundary=true`, `autonomousHeartbeat=true`, and `heartbeatIndependentOfClassicUi=true`.

### Always-on native turn transport authority

New files:

- `dist/classic-turn-transport-observer.js`
- `dist/classic-turn-transport-observer.test.js`
- `scripts/classic-turn-transport-observer-static-gate.mjs`

The observer is deliberately smaller than Context Guardian and starts independently of Context Guardian/Host Overlay/Stream Recovery feature flags. It opens only bounded CDP `Network` observation; it does **not** enable Runtime/Page, evaluate DOM, navigate/reload, or capture response bodies. It records only:

- real `POST /backend-api/f/conversation` conversation ID;
- hashed `x-openai-session` correlation;
- request/response/loadingFinished/loadingFailed lifecycle.

Pending request IDs have TTL/hard cap. Raw session values never leave the observer. Server feeds native identity into `ClassicConversationAuthorityRegistry` and transport lifecycle into `ClassicTurnDeliveryEvidenceStore`. Test/static gate PASS with `networkOnly=true`, `nativeIdentity=true`, `deliveryLifecycle=true`, `bounded=true`, and `rawSessionPersisted=false`.

At every MCP tool start, `dist/server.js` now hashes the incoming `x-openai-session`, resolves it only through the native registry, and—only when exactly one active Goal is unbound and the mapping is unique—calls `goalRuntime.bindConversation`. Missing or ambiguous native mapping remains fail closed. The durable run record receives the resolved conversation/runtime hint; raw session data is never persisted.

### Delivery-timeout state machine no longer trusts stale GUI generating state

`dist/goal-round-completion-guard.js` now tracks how long a native `stream_status=COMPLETE` state remains stable per `{goalId,round}`. Recovery is eligible when:

```text
Chat mode
+ round remains working
+ round settle window passed
+ safetyCheckVisible != true
+ (GUI generating=false OR native COMPLETE stable >= 5s)
```

The existing second recovery path remains stricter for transport failure: native `loadingFailed` evidence plus explicit GUI delivery-timeout/Retry confirmation and no active safety-check notice. GUI timeout alone still cannot trigger recovery. New tests verify stable native COMPLETE overrides a stale GUI generating flag after grace while an active safety-check notice still fails closed.

### Goal Dock disappearance no longer destroys recovery transport

`dist/goal-host-bridge.js` now supports a conversation-bound relay fallback:

1. exact Goal widget remains preferred;
2. if the Goal widget is missing, recovery may use any DevSpace web-sandbox iframe exposing `window.openai.sendFollowUpMessage` **only on a page whose conversation ID exactly matches an already authoritative backend conversation ID**;
3. without an authoritative conversation ID it fails closed.

`inspectWorkingRound()` accepts a Goal object and `dispatchRoundRecovery()` accepts conversation/runtime hints. Server may use the persisted Host Overlay owner only as a legacy migration hint when `owner.goalId` exactly matches the active Goal; the candidate still has to resolve to the same open conversation. Goal Host Bridge tests prove generic relay recovery after the Goal Dock iframe disappears.

Reported-round delivery failure is covered too: `waitForVisibleReportBoundary()` may unblock pending continuation when the native stream is COMPLETE, the safety notice is gone, and the GUI explicitly shows delivery-timeout + Retry. This result is marked `deliveryFailed=true, committed=false`; it permits hidden continuation without clicking Retry or re-running the completed round. `goal-tools.js` now passes the bound conversationId into host dispatch so the same conversation relay fallback is available.

### Public MCP identity survives Core transport churn

Earlier timed-out work had already implemented the correct two-layer Gateway architecture; its stale tests were updated and the behavior was re-verified:

- lightweight public session descriptors persist independently of live Core mappings;
- descriptor persistence contains no Authorization/Bearer secret;
- failed replay invalidates only the live mapping, not the ChatGPT-held public session ID;
- an exact downstream unknown-session/404 triggers single-flight lazy resurrection using the current request Authorization;
- initialize + `notifications/initialized` are replayed once, mapping is atomically restored, and the original public session ID remains unchanged;
- auth failures, 5xx and timeouts never trigger blind replay.

Gateway runtime/proxy/controller/liveness/handover/static tests all PASS under the new transparent-resurrection contract.

### OOM hardening evidence

Core `McpSessionRegistry` now has both `maxInactiveSessions=32` and `maxEventStreams=40`. It tracks standalone GET SSE streams separately and closes the oldest heavy stream when the global event-stream cap is exceeded, while the lightweight public descriptor remains available for later resurrection.

Fresh real-Core tests:

```text
64 long SSE streams, child V8 heap limit 1GB
  immediate heap ~= 456.6 MB
  after 40s      ~= 252.7 MB
  mcpEventStreams after idle = 0
  mcpActiveRequests after idle = 0
  Core sessions after idle = 32
  PASS

Context Guardian + Stream Recovery network observers
+ 2 waves x 32 real MCP tool calls, child heap 1GB
  wave1 idle heap ~= 258.2 MB
  wave2 idle heap ~= 273.2 MB
  mcpSessions/active/eventStreams after idle = 0
  PASS
```

This distinguishes lightweight Gateway descriptors (bounded separately, default 256) from heavy Core transports. The older canary assertion `peakGatewaySessions <= 24` was a stale contract and was corrected to validate lightweight descriptor retention independently from Core transport/SSE limits.

### Current verification before deployment

Fresh complete `npm test` PASS together with the permanent delivery/session/memory changes. The current runtime is still the temporary passive recovery Gateway/Core until a controlled active production restart is completed. No ChatGPT page refresh/navigation is permitted during that deployment.

## 2026-09-07 — Shared PowerMem location recovered; progress evidence integrity implemented and verified

### Shared memory is the existing local service, not a new database

The user explicitly reconfirmed that **Codex and ChatGPT Classic share the same local PowerMem service**. A bounded, sanitized inspection of the existing Codex configuration succeeded and recovered the loopback MCP endpoint `http://127.0.0.1:8848/mcp`. Only endpoint/command metadata and environment key names were printed; no credentials were read out. Continue using `user_id=codex-global`, `metadata.namespace=global`. Do not install a second store or treat an empty DevSpace capability catalogue as proof that PowerMem does not exist.

A subsequent direct MCP `listTools` discovery attempt against that service was blocked by the platform before execution. It was not retried or rerouted. Therefore **no PowerMem record was read or written in this turn**. The endpoint is established; service health and record contents are not. The preceding configuration-discovery blocker is resolved, while the separate memory-interface read remains blocked.

### Reproduced defects, not just a new heartbeat

The original supervisor reported work and promised automatic continuation merely because a Goal remained active. New RED tests reproduced these defects before fixing them:

- a heartbeat fabricated a completed-work timestamp even with no tool event;
- conversation A's tool was credited to the newest Goal B;
- an unidentified completion could clear a different operation and increment progress;
- parallel operations overwrote one in-flight slot;
- restart resurrected a saved tool as still executing;
- legacy HTTP-derived counters were accepted as verified progress;
- SDK output validation could fail while a callback-only observer reported success;
- a delayed observation could create a ghost in-flight operation after the actual tool had already returned.

### Implemented backend corrections

`dist/goal-run-progress-supervisor.js` now separates service heartbeat from execution evidence. It exposes waiting/pending/stale/interrupted states without claiming that model work or automatic continuation is happening. Native conversation identity selects the Goal; unidentified calls cannot modify a bound Goal. An explicit legacy Goal ID may be observed without inventing a conversation binding. Operation IDs correlate concurrent starts/results and duplicate completions do not increment counters. Runtime hints remain non-authoritative.

Saved progress has `evidenceVersion=2` while retaining the outer version-1 UI-compatible shape. Old step counts are preserved separately as unverified legacy data; they are not promoted to verified work. Original Goal/Plan engine state is not reset or replayed. Restart clears in-flight execution claims and preserves the interrupted/unknown outcome.

Progress persistence now has one serial writer and one latest pending snapshot, rather than retaining one full snapshot/promise link per event. Completed counters advance before render snapshots coalesce. Runtime/operation registries are bounded. Write errors remain non-fatal to actual work and are not treated as success evidence.

New `dist/goal-tool-progress.js` instruments the **complete SDK tools/call request handler**, including input/output validation and `isError` results. It uses the SDK's public request-handler registration API, not an HTTP-success heuristic or DOM. Status polling is excluded. The entire result/argument payload is never persisted. Observation has bounded waits; its own abort signal cannot cancel the real tool or change native safety handling. A timed-out/late start observer cannot resurrect a completed operation.

`dist/server.js` installs this instrumentation before tool registration and removes old HTTP-level start/completion counting. Native conversation correlation/binding remains intact. No ChatGPT page operation, recovery dispatch, tool schema change, new public route, or credential change was introduced.

### Fresh verification

```text
npm run verify:goal-progress
  15 PASS / 0 FAIL
  actual SDK MCP client/server over InMemoryTransport
  static server/progress/overlay wiring PASS

npm test
  full repository regression PASS after final code changes
  existing corrupt-Goal-state warning comes from its temporary test fixture

npm run verify:goal-progress:memory
  actual V8 heap_size_limit = 512 MiB
  real GoalRuntime + real temporary disk persistence
  2 waves, 4096 total operations, 64 simultaneous operations per batch
  baseline heap = 4.8 MiB
  sampled peak heap = 7.8 MiB
  post-GC heap after wave 1 = 5.1 MiB
  post-GC heap after wave 2 = 5.1 MiB
  persisted progress = 1840 bytes
  production state touched = false
  network/CDP access = false
```

Memory-test correction: on the installed Node v25.4.0, `--max-old-space-size=512` actually produced a **704 MiB total V8 heap limit**. The canary correctly refused that setup. It now uses `--max-old-space-size=464 --max-semi-space-size=16` and verifies `getHeapStatistics().heap_size_limit <= 512 MiB` before running. This is a **progress-component isolation soak, not a full-Core or whole-process RSS cap**. Do not relabel older old-space-only gates as total-heap caps. Source: Node CLI documentation distinguishes old-space and semi-space sizes; young-generation heap is three times semi-space size (`https://nodejs.org/api/cli.html`). Node fs/promises serialization guidance was also consulted (`https://nodejs.org/api/fs.html`).

### Deployment and remaining work

The new source/tests are on the original working tree, with no reset, commit, push or release. **This turn did not restart or switch the production Gateway/Core, modify the Classic UI, or validate real frontend timeout recovery.** Human-authored progress paragraphs were successfully appended to the existing loopback progress feed during the work.

Fresh Goal status still returned `goal_1b2f3eb499d8f460`, active, round 5, working, revision 38, `conversationId=null`, continuation idle. No duplicate Goal was created, no invented continuation was redeemed, and no report/dispatch was sent into the old full conversation.

Next frontier: safely deploy the validated source while preserving the existing passive/automation safety boundary; prove the current genuine native conversation binding before enabling continuation; perform real no-refresh timeout/Goal/Plan acceptance; finish full-Core memory attribution and exact native usage/true same-conversation compact gates. PowerMem record read/write remains a separately identified blocked operation, not a reason to discard this verified source work.

Execution plan: `docs/superpowers/plans/2026-09-07-progress-evidence-integrity.md`.
Latest continuation capsule: `capsule_9c68087d3dac4e24`, under `continuityKey=devspace-ultra-v0.5-goal-mode-2026-09-05`. This supersedes the previous restoration-only capsule for the current task frontier.

## 2026-09-07 — Blocking tool-substrate root cause and Codex-compatible Ultra mode

The user corrected the release ordering: missing execution tools are a first-class blocker, Main Auto Compact remains unimplemented, and the large untracked tree must be converged before more feature work. The product mainline is now explicit: DevSpace Ultra is the durable local execution/control substrate intended to provide ChatGPT Classic with a Codex-grade workspace, process, capability, memory, browser, multi-agent and continuity layer. Goal/Plan/Context are milestones on that mainline, not the whole product.

### Root cause: the production Core was running as the recovery Core

A sanitized live environment inspection of the Core serving the current Local Gateway showed all of the following simultaneously:

```text
DEVSPACE_PASSIVE_CORE=true
DEVSPACE_PLUGINS=false
DEVSPACE_SKILLS=false
DEVSPACE_ARTIFACTS=false
DEVSPACE_SUBAGENTS=false
DEVSPACE_CONTEXT_GUARDIAN=false
DEVSPACE_CLASSIC_HOST_OVERLAY=false
DEVSPACE_CLASSIC_STREAM_RECOVERY=false
DEVSPACE_AUTO_COMPACT=false
```

This explains the missing tool catalogue. The Stable Gateway child launcher copied the entire parent environment into every new Core. A temporary passive recovery/canary Gateway had therefore promoted a Core that permanently inherited recovery-only feature-off flags. Empty `capability_list` output did not mean PowerMem was absent.

The existing PowerMem adapter was inspected directly:

```text
plugin = C:\Users\enwong\.devspace\local-plugins\powermem-shared
endpoint = http://127.0.0.1:8848/mcp
registry = enabled=true, trusted=true
```

A temporary isolated real `CapabilityRuntime` successfully connected and reported the service online with 13 tools: add/search/get/update/list memory, profile-aware add/search/profile reads, and the destructive delete surfaces. No replacement database or adapter was installed.

The live workspace tool mode was also only `minimal`, so `apply_patch`, `exec_command`, `write_stdin`, `grep`, `glob` and `ls` were unavailable even though the source already contained most underlying implementations.

### TDD implementation

New source/gates:

```text
dist/tool-mode.js
dist/tool-mode.test.js
scripts/devspace-core-slot-env.test.mjs
scripts/tool-surface-static-gate.mjs
```

Implemented `DEVSPACE_TOOL_MODE=ultra` as a compatibility superset:

```text
legacy/cached-schema tools:
  open_workspace, read, write, edit, bash, grep, glob, ls

Codex-style tools:
  apply_patch, exec_command, write_stdin
```

Agents are instructed to prefer the Codex aliases for new work while never duplicating one operation through both families. Keeping the old aliases prevents a ChatGPT host with a cached tool snapshot from losing its current execution surface during migration.

`dist/config.js` now accepts persisted `toolMode` and `skillsEnabled`. Both the Stable Gateway bootstrap config and standalone config now persist:

```json
{
  "toolMode": "ultra",
  "pluginsEnabled": true,
  "skillsEnabled": true,
  "artifactsEnabled": true,
  "subagents": false
}
```

`buildCoreEnvironment()` now strips all transient Core feature/tool/plugin flags inherited from the parent before applying canonical paths. Active Cores therefore use persisted config as authority. Candidate Cores remain explicitly passive for Classic automation, while retaining schema/tool/plugin compatibility. Canary scripts now pass explicit per-run overrides instead of relying on accidental parent-environment inheritance.

### Verification

Initial RED evidence was exact:

- `dist/tool-mode.js` did not exist;
- `buildCoreEnvironment` was not exported;
- persisted `toolMode: ultra` loaded as `minimal`.

Fresh GREEN evidence:

```text
npm run verify:tool-surface = PASS
npm run verify:stable-gateway = PASS
npm run verify:capabilities = PASS
npm run verify:classic-safety = PASS
npm test = PASS
```

Adding the third instruction branch initially caused the old Goal static gate to fail because it hard-coded exactly two branches. The gate was updated to require all three current branches—strict Codex, Ultra compatibility superset and legacy—and `verify:goal` plus full regression passed.

A real ephemeral Stable Gateway/Core A→B canary then used `toolMode=ultra` and the existing PowerMem external plugin path. It preserved one public session across handover, kept production ports unchanged, exposed 93 tools before and after, verified all eleven workspace/process tools, and confirmed `powermem-shared` enabled/trusted/online:

```text
ultraToolSurface = true
powermemCapabilityOnline = true
publicSessionStable = true
productionPortsUnchanged = true
```

### Current boundary

These changes are source/config green but **not yet live in the current production Core**. A normal Core-only handover is insufficient because the old running Gateway process has already loaded the defective child environment builder. The next action in this same isolated phase is one response-safe whole Stable Gateway Scheduled Task restart, with Classic automation kept at the current safe/off state for this tool-only deployment. After restart, verify the public MCP/OAuth session survives and the real ChatGPT connector exposes Ultra tools, Capability Runtime, Skills and PowerMem. Only then perform the bounded PowerMem read/write phase.

The canonical release order was rewritten at `docs/superpowers/plans/2026-09-07-v0.5-release-completion-order.md`. It now places tool substrate first, PowerMem synchronization second, dirty-tree convergence third, then full-Core memory/deployment/conversation/Goal/timeout/exact-usage/true-compact/release work. Main Auto Compact is explicitly marked not implemented or accepted. The post-v0.5 mainline records audited Codex MCP catalogue bridging, a formal tool-parity matrix, Computer Use and installer productization.

## 2026-09-07 — Canonical v0.5 completion order established

The user requested one consolidated, time-ordered remaining-work sequence so unrelated failures are no longer mixed in the same development round. The new authoritative execution plan is:

```text
docs/superpowers/plans/2026-09-07-v0.5-release-completion-order.md
```

The plan supersedes mechanical use of unchecked boxes in older implementation documents. Current live observations used to set the order:

- Goal `goal_1b2f3eb499d8f460` remains active at round 5/revision 38 with `conversationId=null` and no pending continuation;
- the running Context Guardian still reports `usageSource=devspace-ledger` and `hostMeasuredTokens=null`, so production does not satisfy the exact-native-usage contract;
- Main Auto Compact remains disabled/unproven and host-native same-conversation compaction is false;
- the current Core sample showed high retained memory/session pressure and zero connected Context/Stream CDP observers, while the latest source/progress fixes have not yet been production-deployed;
- README, CHANGELOG, configuration and safety docs still contain superseded soft-reload, estimator/ledger, runtime-owner and fresh-conversation-as-compact claims;
- the working tree remains deliberately dirty and unpublished, so release convergence is a separate final phase.

Mandatory remaining order:

1. restore the existing shared PowerMem path with one bounded read/write only;
2. full-Core 512 MiB feature-isolation/memory attribution;
3. controlled Stable Gateway/Core production deployment with rollback;
4. genuine native conversation authority and one-time Goal binding;
5. real no-refresh Goal/Plan conversation A→B→A and lifecycle acceptance;
6. delivery-timeout/safety-state recovery acceptance;
7. exact Classic-native actual-usage authority;
8. true same-conversation Auto Compact v2;
9. full regression, documentation correction, coherent commits/tag/public v0.5 release.

Each phase is isolated to one Goal round, must define its own exit gate, and updates the rolling handoff plus PowerMem immediately after passing. Estimated remaining focused work is 17–31 hours across roughly 3–5 controlled sessions, with native same-conversation compaction carrying the largest uncertainty. DuckDNS/Caddy local-ingress installation/Skill packaging, Computer Use replication and unrelated capability expansion are explicitly deferred from the v0.5 critical path unless a release gate proves they are required for stability.

## 2026-09-07 — Tool substrate production-live; shared PowerMem synchronized

The isolated tool phase passed its production boundary without changing or refreshing any ChatGPT page. A delayed whole `DevSpace-Stable-Gateway` restart was required because the old Gateway process had already imported the defective child-environment inheritance code. The public listener and Core came back on new processes:

```text
before: Gateway 7678 PID 44796; Core A 7688 PID 35312
after:  Gateway 7678 PID 55852; Core A 7688 PID 54948
```

The existing connector resumed without re-OAuth. Fresh live configuration from the actual Core environment:

```text
toolMode                     = ultra
pluginsEnabled               = true
skillsEnabled                = true
artifactsEnabled             = true
subagents                    = false
passiveCore                  = false
contextGuardianEnabled       = false
classicHostOverlayEnabled    = false
classicStreamRecoveryEnabled = false
autoCompactEnabled           = false
```

The last four Classic automation features remain deliberately disabled for this isolated deployment and must not be described as complete. They will be enabled only after the later full-Core memory/deployment phases.

Live `capability_list(... probeMcp=true)` now reports both installed capability packages. `powermem-shared` is `enabled=true`, `trusted=true`, `status=online`, and exposes all 13 expected PowerMem tools. HyperFrames and its five Skills are also visible. A real ephemeral A→B canary had already shown the release candidate exposes 93 tools before and after handover, including both the legacy workspace/search family and the Codex aliases `apply_patch`, `exec_command`, and `write_stdin`, with the public session unchanged.

The current ChatGPT conversation may still retain the host-cached tool schema from before the restart; therefore the newly added aliases may not appear in this already-open tool snapshot until the supported one-time App tool-schema Refresh. This is schema cache maintenance, not a ChatGPT page refresh, and current work remains possible through the preserved compatibility aliases. Backend/Core tool availability is independently proven by the real protocol canary.

PowerMem Phase 2 then completed through the production connector:

1. one bounded `search_memories_with_profile` call used `user_id=codex-global`, `metadata.namespace=global`, `limit=5`, `threshold=0.0`, `add_profile=true`;
2. the authoritative architecture decision memory `751610722542157824` was recovered, confirming zero automated refresh, UI/DOM non-authority, exact native actual usage only, conversation-bound Goal/Plan and true same-conversation compact;
3. one concise `add_memory(... infer=false)` checkpoint was written as memory **`751878241521762304`**.

No replacement memory database was created. Tool substrate and shared-memory synchronization are now complete. The only active phase is careful retained-worktree convergence: classify every modified/untracked file, preserve uncertain work, secret-scan and test coherent groups, then create reviewable commits. Auto Compact, Goal binding, frontend lifecycle and Context work remain out of scope until that tree is durably converged.

## 2026-09-07 — Interrupted worktree convergence complete

The retained tree from interrupted agent sessions has now been converted from an unsafe working-directory-only state into an audited, recoverable branch. No destructive cleanup command was used.

Initial inventory:

```text
branch before convergence = main
base HEAD                 = 1c48540
modified tracked paths    = 41
untracked paths           = 118
total unresolved paths    = 159
staged paths              = 0
```

The files were not random cache debris: most were live source, tests, resources, operational gates or durable architecture records referenced by the current server/package. All newly retained JavaScript/ESM passed `node --check`; all newly retained PowerShell passed parser validation. No changed binary artifact or credential-like filename was present. A bounded changed-file scan found no private-key header, common cloud key, GitHub/OpenAI token, Bearer token or JWT-shaped value.

Before modifying history, complete trees were stored under independent local checkpoint refs:

```text
checkpoint/v0.5-pre-convergence-20260907
  adc2e26e1f991cab926956c4fdf8b5540911abdb

checkpoint/v0.5-audited-20260907
  4f2158705df02294a9a5b9753c7dc31a65ef57ab
```

The active work moved to `v0.5-convergence`. The temporary all-files checkpoint was then split into coherent source commits:

```text
f2dcee0  feat: add bounded stable gateway and tool substrate
55ed6ba  feat: make Classic goals and context conversation-safe
```

Two superseded recovered mechanisms were deliberately neutralized rather than silently deleted:

- direct MCP `openai/conversation_id` metadata can no longer bind conversation authority; only native request/session correlation is accepted;
- the old fresh-conversation rollover live gate is now a fail-closed tombstone and explicitly states that rollover is continuity, not true same-conversation Auto Compact.

Previously orphaned tests for shared CDP cleanup, direct-MCP identity rejection, delivery-evidence persistence, workspace LRU and public-session descriptors are now normal `verify:ultra` gates.

During commit separation, full regression exposed a timing race in the Stable Gateway liveness test: it inspected descriptors after replacement Core creation but before the recovery transaction finished. The test now waits for `coreRecoveryInProgress=false`, the expected active slot and `status.ok=true`. Five consecutive focused runs passed, followed by a complete `npm test` PASS. Production behavior was not weakened to satisfy the race.

Detailed classification and recovery instructions are recorded in:

```text
docs/DEVSPACE-ULTRA-V0.5-WORKTREE-AUDIT-2026-09-07.md
```

The accompanying `docs: record v0.5 architecture and convergence evidence` commit is now present. After that commit, `git status` was clean on `v0.5-convergence`. Phase 3 is therefore complete. The next and only active phase is full-Core memory/lifecycle isolation under a verified total V8 heap ceiling. Classic Context Guardian, Host Overlay, Stream Recovery and Main Auto Compact remain production-disabled; no Goal binding or frontend work begins before the memory phase passes.

## 2026-09-07 — Full-Core memory/lifecycle isolation complete; production deployment still pending

Phase 4 is now independently complete at source/canary level. This section does **not** claim that the newest Core has been promoted into production or that Classic automation/front-end recovery is live.

### Reproduced lifecycle owners and fixes

The Core already bounded inactive sessions and event streams, but it did not enforce one global transport ceiling. Under reconnect pressure an initialize request could therefore receive a session ID that was not durably admitted after the registry reached capacity. The runtime now has three distinct protections:

```text
maxInactiveSessions = 32
maxEventStreams      = 40
maxSessions          = 40
```

`McpSessionRegistry.register()` first evicts only safe inactive entries and pure idle SSE streams. If every remaining transport protects active tool work, registration fails closed. `dist/server.js` now checks that return value inside `onsessioninitialized`; a rejected initialize throws before an untracked session can be reported. Existing in-flight tool work is never evicted merely to admit another reconnect.

Memory diagnostics were expanded without storing prompt, response or credential content. The loopback-only snapshot now includes the actual V8 `heap_size_limit`, MCP/process/workspace registry counts, bounded Capability Runtime connection/startup/instance counts, and every Classic CDP observer's connected/pending state. Capability diagnostics expose only bounded keys/counts and never environment values or authorization material.

The first Capability profile exposed a separate **test-harness** defect rather than a Core OOM: Streamable HTTP returned an empty SSE priming event before the real JSON-RPC result, and the canary parser treated the first `{}` as completion. `parseMcpResponseText()` now ignores priming/non-response frames and selects the matching JSON-RPC ID. A focused RED→GREEN test locks this behavior. The capability gate also distinguishes compact `capability_list` discovery from full `capability_inspect(probeMcp=true)` status.

### Verified 512 MiB total-heap profile matrix

The gate verifies V8's real total heap limit before starting; it does not mislabel `--max-old-space-size` as the total ceiling. On the installed Node runtime it uses:

```text
--max-old-space-size=464
--max-semi-space-size=16
--expose-gc
actual heap_size_limit <= 512 MiB
```

Each profile used temporary state/config/OAuth/ports, real MCP initialize/tool traffic and SSE churn, and did not connect to production Classic ports:

```text
baseline      PASS
context       PASS
stream        PASS
overlay       PASS
capability    PASS — existing shared PowerMem endpoint online
full-product  PASS — all bounded observers and capability runtime together
```

After each 30-second profile, active requests, SSE streams, process sessions and CDP pending calls returned to zero. Retained Core sessions settled at the configured inactive bound; Capability Runtime connecting/startup/instance registries returned to zero, with only the expected pooled PowerMem connection retained in capability/full-product modes.

A higher-pressure full-product run then exercised the previous production boundary directly:

```text
sessionCount          = 40
longSseStreams        = 40
extraInitializeBursts = 32 per wave
waves                 = 4
actualHeapLimit       = 512 MiB
heap after waves      ≈ 282.9, 294.1, 303.1, 292.0 MiB
final heap            ≈ 273.5 MiB
final RSS             ≈ 412.1 MiB
final Core sessions   = 32
active requests       = 0
SSE streams           = 0
process sessions      = 0
Context/Stream pending= 0
PowerMem connections  = 1 pooled
production ports      = unchanged
```

This is evidence of bounded lifecycle recovery under the agreed heap ceiling; it is not a claim that RSS must return to the initial cold-start value after V8 has expanded its heap.

### Verification and phase isolation

New normal gates:

```text
npm run verify:memory-isolation       PASS
npm test                              PASS
npm run verify:goal                   PASS
npm run verify:context-guardian       PASS
node scripts/mcp-session-lifecycle-static-gate.mjs PASS
```

Several static gates still encoded constructors from before the configured Classic-port option was introduced. They were tightened to require the shared `classicCdpOptions` derived from `config.classicMainDebugPorts`, rather than weakened to accept arbitrary wiring.

Four later-phase model-audit prototypes were not mixed into Phase 4. Their utility tests and syntax checks passed, then the files were preserved in a named path-limited stash:

```text
stash@{0}: phase9-classic-model-audit-research-2026-09-07
```

One prototype invokes `Page.reload`; it remains superseded by the zero-refresh architecture and must not be executed or restored as production logic without redesign. The stash exists only to prevent lost work while keeping the memory phase coherent.

PowerMem checkpoint **`751892648050032640`** records the same Phase 4 evidence under `user_id=codex-global`, namespace `global`, without creating a second memory store.

**Phase 4 exit gate: PASS.** The next and only active phase is **Phase 5 — controlled full-feature production deployment**. That phase must use an inactive-slot candidate, compare OAuth/tool schema/state, preserve the public Gateway/App session, promote atomically with rollback, and perform no ChatGPT page refresh or re-OAuth. Goal binding, frontend A→B→A acceptance, delivery-timeout recovery and Main Auto Compact remain later isolated phases.
