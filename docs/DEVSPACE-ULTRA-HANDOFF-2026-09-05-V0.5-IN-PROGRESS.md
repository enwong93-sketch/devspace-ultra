# DevSpace Ultra v0.5 In-Progress Handoff — 2026-09-05

> **Purpose:** Single rolling handoff for the v0.5 work now in progress. Update this file after every independently verified feature/gate so a fresh ChatGPT Classic conversation can continue without reconstructing the prior conversation.
>
> **Current development order:**
> 1. Codex-style long-task Plan / Step Card — **implemented and production-live verified**
> 2. Goal Mode — **design approved; implementation is next**
> 3. Main Context Window / Auto Compact v2 — **research findings captured; implementation intentionally deferred until Goal Mode is complete**

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

**DESIGN APPROVED BY USER. FORMAL SPEC + IMPLEMENTATION PLAN WRITTEN. IMPLEMENT NEXT.**

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

**Research partially complete. Implementation intentionally deferred until Goal Mode is finished.**

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

4. Plan Card checkpoint is already committed locally at `5998b3a`; use this commit as the Goal Mode worktree base.

5. Continue **Goal Mode only** from section 3. Do not restart Context Guardian work yet.

6. Keep updating this same handoff file after each Goal Mode gate.

---

## Current handoff state

As of the creation of this rolling handoff:

```text
#1 Plan / Step Card: IMPLEMENTED + real Main-02 production acceptance PASS
#2 Goal Mode: APPROVED DESIGN, implementation next
#3 Context Guardian v2: research findings captured, implementation deferred
```

The Plan Card checkpoint is complete at `5998b3a`, and the Goal Mode spec/implementation plan are written. The immediate next action is to checkpoint those design documents + this handoff update, create an isolated Goal Mode worktree from that new checkpoint, and start TDD with GoalRuntime persistence/state-transition tests.
