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
- Host-supported continuation through MCP App `window.openai.sendFollowUpMessage`.
- No synthetic/fake user message in the visible transcript for automatic continuation.
- Atomic continuation lease so renderer reloads, duplicate polls, or multiple Goal Docks do not normally dispatch duplicate next turns.
- Strict completion coverage against every stored success criterion.
- Repeated-blocker guard before a Goal can become blocked.
- User control for pause, resume, and stop.
- Small persistent Goal Dock MCP App.
- Restart persistence and recovery.
- Real ChatGPT Classic Main acceptance.

Out of scope:

- Context-window accounting or compaction.
- Cross-conversation context rollover.
- Plan step semantics; Goal Mode may coexist with the already implemented Plan Runtime but does not own it.
- Hiding ChatGPT Classic native tool activity UI.
- Full-screen DevSpace Workbench.

## Product semantics

### Goal and Plan are separate

A Goal answers **what final outcome must remain active until satisfied**. A Plan answers **how the current phase is being executed**.

One Goal may contain multiple physical ChatGPT turns and multiple Plan revisions or replacement Plans. Plan completion never implies Goal completion.

### One Goal round is one physical assistant turn

For every active Goal round:

1. The assistant performs meaningful work.
2. The assistant verifies current progress and audits the Goal against its original objective and all success criteria.
3. The assistant gives the user a complete visible report for that round.
4. After the visible report, the assistant calls `devspace_goal_turn_report` as the final action of the turn.
5. The tool result tells the assistant to end the turn and emit no further user-visible text.
6. The Goal Dock observes the durable reported state.
7. If the Goal is still active, the Goal Dock claims a continuation lease and invokes `window.openai.sendFollowUpMessage`.
8. The hidden follow-up prompt starts the next assistant turn without adding a fake user message to the visible transcript.
9. The next assistant turn begins by redeeming that continuation through `devspace_goal_round_begin`.
10. If the Goal had already become completed, paused, blocked, or stopped before the report gate, no automatic continuation is dispatched.

The invariant is absolute:

> Automatic continuation must never start before the current round has already produced its visible user report.

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

Completion is normally marked before the final visible round report. The assistant then reports the completed result to the user and finishes the turn with `devspace_goal_turn_report`. Because Goal status is already `completed`, the report gate creates no continuation.

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
claim
ack
release
```

`claim` atomically changes `pending -> dispatching`, returns a private opaque `leaseId`, the public `continuationId`, the current `goalId`, the reported `round`, and the hidden continuation prompt.

Only one unexpired lease can exist for that continuation.

The Goal Dock then calls:

```js
window.openai.sendFollowUpMessage({
  prompt: <backend-generated hidden continuation prompt>,
  scrollToBottom: false
})
```

On success it calls `ack`. On an explicit host rejection such as `{ ok: false }`, it calls `release` so the continuation becomes claimable again. An ambiguous transport exception after claim must not immediately release because the host may already have started the next assistant turn; leave that lease to the bounded expiry / round-redemption recovery path instead of risking a duplicate continuation.

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

This closes the most dangerous crash window: if `sendFollowUpMessage` succeeds but widget ack is lost, the new assistant turn can still consume the continuation and prevent later lease retry from creating another round.

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

Model-facing mutation and final action of every Goal turn.

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

App-only control tool. `claim | ack | release` for the continuation lease. It must not be model-visible.

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
- when state is `active + roundState=reported + continuation=pending`, attempts an app-only continuation claim;
- dispatches the returned hidden prompt through `sendFollowUpMessage`;
- acknowledges/release the lease based on send result;
- uses one in-flight dispatch promise locally so a fast polling interval cannot concurrently claim twice;
- stops automatic continuation when paused, blocked, completed, or stopped;
- continues displaying blocked/paused state so the user can Resume/Stop;
- stops normal polling on completed/stopped after rendering terminal state;
- stores only presentation preferences in widget state, never Goal business state.

Optional PiP may be requested while active only as a progressive enhancement. Inline operation must remain fully functional because Plan Card may also be present and hosts may reject PiP.

## Hidden continuation prompt

Backend-generated continuation prompt must be concise, non-secret, and preserve the original Goal semantics. Representative content:

```text
[DEVSPACE_GOAL_CONTINUATION]
Continue active DevSpace Goal <goalId> after reported round <N>.
This prompt is a runtime continuation, not a new user request.
First call devspace_goal_round_begin with goalId=<goalId> and continuationId=<continuationId>.
Then read current Goal state, preserve the full original objective and success criteria, perform meaningful next work, verify progress, give the user a complete visible report for this round, and finish with devspace_goal_turn_report. Do not silently shrink the Goal to an easier sub-goal. If the Goal is already completed/paused/blocked/stopped, do not continue work.
```

Do not place credentials, tokens, workspace secrets, or hidden chain-of-thought in this prompt.

## Server instructions

Interactive/Main agents must be told:

- Goal Mode is for persistent multi-turn outcomes, not every trivial request.
- Preserve the original objective and success criteria across all rounds.
- A Plan is optional execution structure under the Goal, not the Goal itself.
- Every physical Goal turn must end with a full visible report to the user.
- `devspace_goal_turn_report` comes after that visible report and is the final tool/action of the turn.
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
- if a reported active Goal still has pending continuation, the new Dock may claim and continue it.

## Acceptance gates

### Deterministic runtime gates

Prove:

- Goal start persistence and restart recovery;
- success-criterion IDs stable;
- one report per round;
- report-before-continuation invariant;
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

- discover Goal tools and Goal Dock resource;
- start Goal;
- report round 1;
- app-only claim continuation;
- ack continuation;
- round begin -> round 2 exactly once;
- pause/resume;
- complete Goal with criterion evidence;
- final report produces no next continuation;
- restart stack with same stateDir and recover exact state.

### Widget static/DOM gates

Prove the Goal Dock contains:

- `devspace_goal_status` polling;
- app-only continuation claim/ack/release calls;
- `sendFollowUpMessage` transport;
- in-flight dispatch guard;
- pause/resume/stop controls;
- terminal stop behavior;
- host theme variables;
- no external third-party scripts/styles.

### Real ChatGPT Classic Main acceptance

Use Main-02 or Main-03, not canonical Main-01.

A live Goal must run at least 3 physical assistant rounds and prove:

1. round 1 gives a visible summary;
2. only after that summary, Goal Dock dispatches hidden continuation;
3. transcript contains no synthetic user message between round 1 and round 2;
4. round 2 begins by redeeming the continuation and later gives another visible summary;
5. one pause/resume cycle prevents/restarts continuation correctly;
6. final round completes all criteria and reports visibly;
7. completed Goal produces no further automatic assistant turn;
8. Goal Dock remains one logical card rather than creating a fresh render card every round.

## Design evidence already proven before implementation

A real Main-02 Plan Card MCP App showed:

```text
window.openai.sendFollowUpMessage = function
window.openai.callTool = function
window.openai.requestDisplayMode = function
```

A harmless live probe invoked `sendFollowUpMessage` and started a new assistant turn without adding a fake user message to the visible transcript. Therefore Goal Mode should use this supported host path rather than CDP composer automation.
