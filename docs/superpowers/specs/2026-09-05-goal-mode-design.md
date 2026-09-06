# DevSpace Ultra Goal Mode Design

## Goal

Add a Codex-style persistent Goal Mode to ChatGPT Classic through DevSpace Ultra. A Goal survives across ordinary assistant turns, requires a visible user report at the end of every physical turn, and automatically starts the next assistant turn only after that report is durably recorded and the Goal remains active.

## Scope

This feature implements the Goal state machine and its continuation transport.

In scope:

- Persistent Goal state separate from the Plan / Step Card runtime.
- Structured objective and success criteria.
- Ordinary visible ChatGPT turns as Goal rounds.
- Exactly one visible user-facing round report before every automatic continuation.
- Native hidden continuation through a backend `ClassicGoalHostBridge` that invokes ChatGPT Classic's raw host follow-up RPC; public background widget `window.openai.sendFollowUpMessage` is not used because Chat mode gates it on synchronous user activation.
- No synthetic/fake user message in the visible transcript for automatic continuation.
- Atomic continuation lease so renderer reloads, duplicate polls, the persistent Goal Dock, and per-round relay instances cannot dispatch duplicate next turns.
- Strict completion coverage against every stored success criterion.
- Repeated-blocker guard before a Goal can become blocked.
- User control for pause, resume, and stop.
- Small persistent Goal Dock MCP App plus a zero-visual fresh per-round Continuation Relay MCP App.
- Restart persistence and recovery.
- Real ChatGPT Classic Main acceptance.

Out of scope:

- Context-window accounting or compaction.
- Cross-conversation context rollover.
- Plan step semantics; Goal Mode may coexist with the already implemented Plan Runtime but does not own it.
- Hiding ChatGPT Classic native tool activity UI.
- Full-screen DevSpace Workbench.

## Supported ChatGPT surface

DevSpace Ultra Goal Mode is a **ChatGPT Classic Chat-mode-only** feature. Work mode is outside the supported product surface and must not be used to claim product acceptance. All live Goal Mode acceptance, host-queue ordering, Goal Dock controls, continuation, pause/resume, and completion-stop evidence must be collected in Chat mode. Earlier Work-mode probes are research-only evidence.

## Product semantics

### Goal and Plan are separate

A Goal answers **what final outcome must remain active until satisfied**. A Plan answers **how the current phase is being executed**.

One Goal may contain multiple physical ChatGPT turns and multiple Plan revisions or replacement Plans. Plan completion never implies Goal completion.

### One Goal round is one physical assistant turn

For every active Goal round:

1. The assistant performs meaningful work.
2. The assistant verifies current progress and audits the Goal against its original objective and all success criteria.
3. The assistant calls `devspace_goal_turn_report` immediately before the user-visible final report. It is the final tool call of the physical turn.
4. The report tool records durable `reported` state and instructs the assistant to emit one complete visible final report and call no more tools.
5. The assistant gives the user that complete visible final report as the final response of the current physical turn.
6. `devspace_goal_turn_report` mounts a fresh zero-visual per-round Continuation Relay. For an active reported Goal, that relay calls app-only `devspace_goal_continuation(action="dispatch")` exactly once.
7. The backend atomically claims the continuation lease and carries the current `lastRoundReport.reportedAt` into `ClassicGoalHostBridge`.
8. `ClassicGoalHostBridge` locates the exact Chat-mode Goal widget by `goalId`, then waits for a **visible-report commit boundary** on the matching ChatGPT page: Chat mode must still be active, ChatGPT `stream_status` must be `COMPLETE`, the page must no longer be generating, the latest visible assistant report must be non-empty, and a short post-`reportedAt` settle window must have elapsed. This prevents an earlier round's stale COMPLETE state or a temporarily stalled renderer from authorizing the next round.
9. Only after that visible-report commit gate succeeds does the bridge extract the existing raw ChatGPT host API beneath the public widget authorization wrapper and invoke the native hidden Tool follow-up RPC with no synthetic user message.
10. On confirmed raw-host dispatch the backend acknowledges the lease; definite pre-dispatch failures release it, while ambiguous post-RPC failures are left to expiry/round-redemption recovery to avoid duplicate assistant turns.
11. The next assistant turn begins by redeeming that continuation through `devspace_goal_round_begin`.
12. The persistent Goal Dock owns status and Pause/Resume/Stop. A user Resume arms one backend `dispatch`; ordinary round-to-round chaining is triggered by the fresh per-round Relay.
13. If the Goal had already become completed, paused, blocked, or stopped before the report gate, no automatic continuation is dispatched.

The invariant is absolute:

> Automatic continuation must never start before the current round's visible user report is committed and observable on the matching ChatGPT Classic Chat surface.

## Goal state contract

Persist a versioned Goal record under the configured DevSpace `stateDir`.

Representative public state:

```json
{
  "id": "goal_<opaque>",
  "objective": "Finish DevSpace Ultra Goal Mode and prove it in ChatGPT Classic",
  "status": "active",
  "round": 3,
  "roundState": "working",
  "revision": 12,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "completedAt": null,
  "pausedAt": null,
  "stoppedAt": null,
  "successCriteria": [
    { "id": "criterion_<opaque>", "text": "Every round visibly reports before continuation" },
    { "id": "criterion_<opaque>", "text": "Completion stops automatic continuation" }
  ],
  "lastRoundReport": {
    "round": 2,
    "summary": "Round 2 completed the continuation lease gate.",
    "meaningfulProgress": true,
    "blockerFingerprint": null,
    "reportedAt": "ISO-8601"
  },
  "continuation": {
    "state": "idle",
    "forRound": null,
    "continuationId": null,
    "leaseId": null,
    "leasedAt": null,
    "expiresAt": null,
    "dispatchedAt": null
  }
}
```

### Goal statuses

```text
active
paused
blocked
completed
stopped
```

Terminal statuses:

```text
completed
stopped
```

`blocked` is non-terminal so the user may resume after changing the environment or instructions.

### Round states

```text
working
reported
```

A Goal starts at round 1, `roundState=working`.

`devspace_goal_turn_report` changes the current round to `reported`. It may be called only once for that round.

`devspace_goal_round_begin` consumes an authorized continuation and starts the next round by incrementing `round` and setting `roundState=working`.

## Success criteria and completion audit

Goal creation requires 1-12 explicit success criteria. The objective and success criteria are immutable for the lifetime of this first-version Goal. Ordinary user steering may change the execution approach without changing the Goal. If the user explicitly changes the final objective itself, stop the old Goal and start a new Goal with new criteria rather than silently rewriting the active Goal.

`devspace_goal_complete` requires evidence covering **every** stored success-criterion ID. The backend rejects completion if:

- any criterion has no evidence entry;
- a supplied criterion ID is unknown;
- evidence text is empty;
- the Goal is paused, blocked, stopped, or already completed;
- the current round has not yet performed work (`roundState` is not `working`).

The backend can validate coverage and state, not the truthfulness of arbitrary external evidence. Server instructions therefore require the model to use current authoritative evidence such as tests, runtime state, artifacts, or observed UI and to keep the Goal active when evidence is weak, stale, indirect, or missing.

Completion is normally marked before the final round report gate. The assistant calls `devspace_goal_complete`, then `devspace_goal_turn_report` as the final tool call, then emits the completed result as the user-visible final response. Because Goal status is already `completed`, the report gate creates no continuation.

## Blocked guard

A Goal must not become blocked after one failed attempt.

Each `devspace_goal_turn_report` accepts:

```text
meaningfulProgress: boolean
blockerFingerprint?: string
```

The runtime tracks the latest normalized blocker fingerprint and consecutive no-progress rounds for that same blocker.

Rules:

- a report with meaningful progress resets the consecutive blocker count;
- a changed blocker fingerprint resets the count to 1;
- a same-fingerprint no-progress report increments the count;
- `devspace_goal_blocked` is rejected until the same blocker has been recorded for at least 3 consecutive reported rounds with no meaningful progress.

This guard prevents the agent from using `blocked` as an easy escape from the Goal.

## Continuation state machine

### States

```text
idle
pending
dispatching
dispatched
```

After `devspace_goal_turn_report`:

- active Goal -> `pending` continuation for the reported round;
- paused / blocked / completed / stopped Goal -> `idle` and no continuation.

### App-only continuation control

Expose one app-only tool:

```text
devspace_goal_continuation
```

Actions:

```text
dispatch
claim
ack
release
```

`claim` atomically changes `pending -> dispatching`, returns a private opaque `leaseId`, the public `continuationId`, the current `goalId`, the reported `round`, and the hidden continuation prompt.

Only one unexpired lease can exist for that continuation.

Normal product dispatch uses `action="dispatch"`. The backend performs:

```text
claim
-> ClassicGoalHostBridge.dispatch(raw native host follow-up)
-> ack
```

The Relay and Goal Dock never call public background `window.openai.sendFollowUpMessage`; live Chat-mode reverse engineering proved the public third-party wrapper has `hostHandlesFollowUpMessageAuthorization=false` and requires transient synchronous user activation. The raw host method below that wrapper does not impose the widget-side activation check and feeds ChatGPT's native hidden Tool-message / `completionType=Next` path.

Low-level `claim | ack | release` remain app-only recovery/testing primitives. A definite failure before the native host follow-up is sent releases the lease. An ambiguous failure after raw RPC may have already started the next assistant turn, so the lease is not immediately released; bounded expiry and `round_begin` redemption remain the duplicate-prevention recovery path.

`ack` changes `dispatching -> dispatched`.

An unacknowledged `dispatching` lease expires after a bounded interval and becomes claimable again. A `dispatched` continuation also has a longer recovery deadline: if the next round never begins, it may become pending again. The timeout must be conservative to avoid duplicate live turns.

### Next-round redemption

The hidden continuation prompt contains only non-secret identifiers and explicit instructions to call:

```text
devspace_goal_round_begin(goalId, continuationId)
```

as the first Goal-control action of the next turn.

`devspace_goal_round_begin`:

- validates the Goal is active;
- validates the continuation belongs to the current reported round;
- accepts a matching continuation in `dispatching` or `dispatched` state to tolerate ack races, and also accepts the same matching ID if an expired lease was conservatively normalized back to `pending` before the already-started assistant turn redeemed it; atomic redemption immediately clears that continuation so a later claim cannot advance the round twice;
- increments `round` exactly once;
- records `lastConsumedContinuationId` for idempotent replay handling;
- clears continuation state back to `idle`;
- sets `roundState=working`.

If the same continuation ID is redeemed again after successful round begin, return the current Goal state idempotently rather than incrementing a second time.

This closes the most dangerous crash window: if the raw native host follow-up succeeds but backend acknowledgement is lost, the new assistant turn can still consume the continuation and prevent later lease retry from creating another round.

## MCP tool surface

### `devspace_goal_start`

Model-facing render tool.

Input:

```text
objective
successCriteria[]
```

Creates Goal round 1 in active/working state and mounts `ui://devspace/goal-dock.html`.

### `devspace_goal_status`

Read-only, model + app visible. Returns authoritative Goal state. Goal Dock polls this tool.

### `devspace_goal_round_begin`

Model-facing mutation. Redeems one hidden continuation at the start of a new Goal turn.

### `devspace_goal_turn_report`

Model-facing mutation and final **tool call** of every Goal turn. The user-visible final response follows after this tool returns, with no additional tool calls.

Input:

```text
goalId
summary
meaningfulProgress
blockerFingerprint?
```

Marks the current round reported and creates a pending continuation only when Goal status remains active.

### `devspace_goal_complete`

Model-facing mutation. Requires criterion-complete evidence coverage. Marks Goal completed but does not itself dispatch or suppress the current visible summary; final `turn_report` closes that round.

### `devspace_goal_blocked`

Model-facing mutation. Permitted only after the repeated-blocker guard is satisfied.

### `devspace_goal_control`

Model + app visible. Actions:

```text
pause
resume
stop
```

Model instructions restrict its use to explicit user control requests. Goal Dock buttons use the same tool.

Behavior:

- pause: active -> paused; pending continuation is cancelled;
- resume: paused or blocked -> active; if the most recent round is already reported, create a new pending continuation; if currently working, simply resume the same round;
- stop: any non-terminal Goal -> stopped; cancel continuation; no automatic restart.

### `devspace_goal_continuation`

App-only control tool. Normal UI flow uses `dispatch`; backend code performs claim -> native Classic host dispatch -> ack. Low-level `claim | ack | release` remain for bounded recovery/testing. It must not be model-visible.

### `devspace_goal_mount`

Read-only model-facing render recovery tool. Re-mounts the latest Goal Dock for an existing Goal after renderer reload or later-turn loss without changing Goal state.

## Goal Dock MCP App

Resource:

```text
ui://devspace/goal-dock.html
```

The Dock is deliberately smaller than the Plan Card and does not duplicate plan steps.

Visible content:

```text
Goal objective
status
Round N
elapsed time
continuation state
Pause / Resume / Stop controls as appropriate
```

The Dock:

- initializes from `structuredContent.goal`;
- polls `devspace_goal_status` while non-terminal;
- does **not** auto-dispatch ordinary pending continuations discovered by polling;
- arms one continuation dispatch only after a successful user `Resume` control action;
- calls app-only backend `action="dispatch"` once for that post-resume continuation with a local in-flight guard;
- continues displaying blocked/paused state so the user can Resume/Stop;
- stops normal polling on completed/stopped after rendering terminal state;
- stores only presentation preferences in widget state, never Goal business state.

## Per-round Continuation Relay MCP App

Resource:

```text
ui://devspace/goal-continuation-relay.html
```

`devspace_goal_turn_report` attaches this resource on every physical Goal round. The relay is visually inert and each mounted instance attempts at most one dispatch. It only acts on `active + reported + pending` and calls app-only `devspace_goal_continuation(action="dispatch")`; it never calls public `sendFollowUpMessage` and never owns lease claim/ack/release itself. Because every report mounts a fresh relay, Chat mode does not depend on recursively reusing the same long-lived Goal Dock instance for autonomous chaining.

## Classic Goal Host Bridge

`ClassicGoalHostBridge` is the backend transport boundary for Chat-mode automatic continuation.

It:

- probes local Main CDP endpoints only;
- supports Main-01 on canonical port 9721 and Main-02..Main-32 on 9732..9762;
- refuses obvious Work-mode pages;
- reads the widget's authoritative `toolOutput.goal.id` and selects only a widget matching the requested `goalId`;
- carries the durable round `reportedAt` timestamp into dispatch and waits for the matching page's visible-report commit boundary (`stream_status=COMPLETE`, not generating, visible assistant text present, short settle window elapsed) before any hidden continuation can be sent;
- locates the raw ChatGPT host API generically from the public follow-up wrapper closure rather than depending on a minified variable name;
- invokes raw `sendFollowUpMessage` with `Runtime.callFunctionOn(... userGesture:false)` so the native host creates a hidden Tool-authored follow-up rather than a fake user message;
- fails closed if no matching Chat-mode Goal widget exists.

The public widget follow-up wrapper must not be used for autonomous continuation. Live closure inspection proved third-party DevSpace widgets receive `isFirstParty=false` and `hostHandlesFollowUpMessageAuthorization=false`; background calls therefore trigger the host warning for missing synchronous user activation.

## Canonical Main-01 debug availability

The raw host bridge requires a local CDP endpoint. Secondary Mains already launch with deterministic debug ports. Canonical Main-01 uses port 9721 when debug-enabled.

`ClassicPrimaryDebugGuard` runs inside the fixed backend and deliberately protects an already-running long-lived Main-01 when DevSpace first starts, so enabling Goal Mode cannot unexpectedly terminate the user's current conversation. It repairs only a fresh startup Main-01 or a later changed/new PID that lacks 9721. The repair adapter:

- targets canonical `OpenAI.ChatGPT-Desktop` only;
- uses an expected-PID race guard;
- restarts canonical Main-01 with loopback-only `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9721`;
- verifies a visible primary plus the debug listener;
- does not edit Windows UserChoice or change `chatgpt://` ownership;
- attempts a normal canonical-app restore if the debug restart fails.

Before every Goal host dispatch, the bridge asks the guard to poll once so a just-restarted primary cannot lose a timing race.

Optional PiP may be requested while active only as a progressive enhancement. Inline operation must remain fully functional because Plan Card may also be present and hosts may reject PiP.

## Hidden continuation prompt

Backend-generated continuation prompt must be concise, non-secret, and preserve the original Goal semantics. Representative content:

```text
[DEVSPACE_GOAL_CONTINUATION]
Continue active DevSpace Goal <goalId> after reported round <N>.
This prompt is a runtime continuation, not a new user request.
First call devspace_goal_round_begin with goalId=<goalId> and continuationId=<continuationId>.
Then read current Goal state, preserve the full original objective and success criteria, perform meaningful next work, and verify progress. Call devspace_goal_turn_report before the visible final report for this round. After it returns, give the user one complete visible final report and call no more tools in that turn. Do not silently shrink the Goal to an easier sub-goal. If the Goal is already completed/paused/blocked/stopped, do not continue work.
```

Do not place credentials, tokens, workspace secrets, or hidden chain-of-thought in this prompt.

## Server instructions

Interactive/Main agents must be told:

- Goal Mode is for persistent multi-turn outcomes, not every trivial request.
- Preserve the original objective and success criteria across all rounds.
- A Plan is optional execution structure under the Goal, not the Goal itself.
- Every physical Goal turn must end with a full visible final report to the user.
- `devspace_goal_turn_report` comes immediately before that visible final report and is the final tool call of the turn; after it returns, emit the visible final report and call no more tools.
- The next hidden continuation begins with `devspace_goal_round_begin`.
- Do not manually fabricate user messages or use CDP composer typing for Goal continuation.
- Completion requires current authoritative evidence for every success criterion.
- Do not mark blocked until the runtime permits it after repeated identical no-progress blocker reports.
- Do not call pause/stop unless explicitly requested by the user.
- Chat Swarm worker loops do not start user-facing Goal Mode.

## Persistence and corruption behavior

`GoalRuntime` stores a versioned JSON state file under DevSpace `stateDir`, separate from Plan Runtime and Conversation Continuity state.

Use a serialized persist queue to prevent interleaved writes.

Corrupt/unsupported Goal state must fail open with a fresh Goal store and a bounded warning; it must not prevent DevSpace boot.

Do not persist secret continuation material. Goal/continuation IDs and lease IDs are opaque but not authentication credentials. The hidden prompt contains no secrets.

## Restart and renderer recovery

Backend restart:

- active Goal and current round survive;
- reported/pending continuation survives;
- unexpired dispatch lease survives and remains exclusive;
- expired dispatch lease becomes safely claimable after runtime load/normalization;
- consumed continuation remains idempotently consumed.

Renderer reload:

- business state remains backend-owned;
- re-mounted Goal Dock uses `devspace_goal_mount` and latest Goal state;
- if a reported active Goal still has pending continuation, the remounted Dock/Relay may request backend `dispatch`; the backend remains the sole owner of lease + host transport.

## Acceptance gates

### Deterministic runtime gates

Prove:

- Goal start persistence and restart recovery;
- success-criterion IDs stable;
- one report per round;
- queued-continuation ordering invariant: report tool may make continuation pending before the visible final response, but backend Host Bridge dispatch is additionally gated on the matching Chat page proving `stream_status=COMPLETE`, non-generating state, and a visible assistant report after the report gate;
- no continuation for completed/paused/blocked/stopped states;
- pause/resume/stop transitions;
- completion requires evidence for every criterion;
- blocked guard requires 3 consecutive same-fingerprint no-progress reports;
- continuation claim exclusivity;
- lease expiry/release recovery;
- ack race tolerance;
- `round_begin` idempotency;
- backend restart during pending/dispatching/dispatched states.

### MCP protocol gate

Using real in-memory MCP protocol:

- discover Goal tools, Goal Dock resource, and per-round continuation relay resource;
- start Goal;
- report round 1;
- app-only backend `dispatch` through a fake/test Classic Host Bridge;
- round begin -> round 2 exactly once;
- pause/resume;
- complete Goal with criterion evidence;
- final report produces no next continuation;
- restart stack with same stateDir and recover exact state.

### Widget static/DOM gates

Prove the Goal Dock contains status polling, pause/resume/stop controls, a Resume-only backend-dispatch arm, terminal stop behavior, host theme variables, no public `sendFollowUpMessage`, and no external third-party scripts/styles. Prove the per-round Relay contains app-only `action="dispatch"`, a one-shot dispatch guard, no public `sendFollowUpMessage`, no low-level claim/ack/release calls, no controls, and no external resources. Prove Host Bridge and Primary Debug Guard deterministic/static gates separately.

### Real ChatGPT Classic Main acceptance

First use Main-02 or Main-03 and assert **Chat mode** before sending the acceptance prompt. Canonical Main-01 is accepted only after its durable 9721 lifecycle is safely enabled without breaking protocol ownership or an existing conversation.

A live Goal must run at least 3 physical assistant rounds and prove:

1. round 1 gives a visible final report;
2. pause suppresses continuation, then Goal Dock Resume starts exactly one hidden next round;
3. transcript contains no synthetic user message between round 1 and round 2;
4. round 2 calls turn-report, its fresh relay requests backend `dispatch`, `ClassicGoalHostBridge` starts round 3 through the raw native hidden Tool follow-up, and round 2 still gives a visible final report first;
5. round 3 begins by redeeming the Host Bridge continuation;
6. final round completes all criteria and reports visibly;
7. completed Goal produces no further automatic assistant turn;
8. one persistent visible Goal Dock remains; per-round relays are zero-visual ephemeral dispatchers.

## Design evidence and corrected transport conclusion

A real Main-02 MCP App exposed `window.openai.sendFollowUpMessage`, but deeper Chat-mode testing corrected the initial interpretation. The earlier successful CDP probe used `Runtime.evaluate(... userGesture:true)`, which artificially supplied transient user activation.

Live closure inspection then proved the public third-party wrapper has `hostHandlesFollowUpMessageAuthorization=false` and blocks autonomous background follow-up. Beneath that wrapper, the existing raw host API performs the native MessagePort RPC without the widget-side activation guard. A Chat-mode A/B probe invoked that raw method with `userGesture=false` and produced the required hidden assistant continuation with no synthetic user message.

The final architecture therefore keeps ChatGPT's native hidden Tool follow-up semantics while moving authorization/dispatch into the local `ClassicGoalHostBridge`; it does not automate the composer and it does not rely on background public widget `sendFollowUpMessage`.
