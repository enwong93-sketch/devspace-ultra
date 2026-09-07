# DevSpace Ultra v0.5 — ChatGPT Classic Conversation Authority Framework

> **Status:** AUTHORITATIVE / superseding contract
> **Date:** 2026-09-06
> **Scope:** ChatGPT Classic Chat mode — Goal Mode, Plan Card / Host Overlay, Context Guardian / Auto Compact, safety-state handling and frontend projection.
> **Supersedes:** any earlier v0.5 assumption that permits automated page refresh/reload, DOM/token estimation as authority, fresh-conversation rollover as Auto Compact, or runtime-owned Goal/Plan state.

---

## 1. Product invariant

DevSpace Ultra must treat the **ChatGPT Classic conversation** as the durable product scope. A Main runtime is only a projection host for whichever conversation is currently active in that runtime.

The architecture is:

```text
ChatGPT Classic native/backend transport
                │
                ├── exact conversation identity
                ├── exact model metadata
                ├── exact actual context usage metadata
                ├── native turn / stream / safety state
                └── native same-conversation compaction events
                              │
                              ▼
                 Conversation State Registry
                              │
             ┌────────────────┼─────────────────┐
             ▼                ▼                 ▼
          Goal state       Plan state      Compact state
             │                │                 │
             └────────────────┼─────────────────┘
                              ▼
                     Host Projection Layer
                              │
                              ▼
                    current runtime renderer
```

The renderer never becomes an authority for backend decisions.

---

## 2. Hard rules

### 2.1 Automated page refresh/reload is forbidden

DevSpace Ultra must not invoke page refresh/reload as recovery, fallback, degraded behavior, lifecycle repair or validation.

Forbidden automated actions include, but are not limited to:

```text
Page.reload
same-URL Page.navigate used as reload
location.reload()
location.assign(currentURL)
window.location=currentURL
host/plugin refresh used by an automated recovery path
```

This prohibition applies to:

- Stream Recovery;
- Context Guardian / Auto Compact;
- Goal Mode;
- Plan Card / Host Overlay;
- startup / reconnect;
- authentication/session recovery;
- snapshot capture;
- frontend acceptance.

A human may still use ChatGPT's own explicit UI controls manually when they choose. DevSpace must not depend on, trigger, or automate them for the v0.5 core architecture.

### 2.2 UI / DOM is non-authoritative

DOM may be used only for **visual acceptance** and renderer projection checks after backend truth is already known.

DOM must not determine:

- context usage;
- token pressure;
- compaction eligibility;
- conversation ownership;
- authoritative generating/completed state;
- safety state;
- recovery decisions;
- Goal continuation eligibility;
- Plan lifecycle state.

No token estimator, visible-message counter, stop-button probe or DOM text length may be used as an authoritative control input.

### 2.3 Context usage must be exact Classic-native actual usage

The only accepted context-usage authority is the real ChatGPT Classic native/backend metadata already known to expose current actual usage.

The previous exact field/endpoint evidence was not durably recorded and must be re-derived from the Classic protocol. A bounded research-only native evidence collector now records only numeric usage/token/context-related key paths and values from real request headers, response headers and completed turn responses; it never persists raw prompt/assistant content or credentials. These candidates are **not** Context Guardian authority until one exact field is semantically re-verified. Until it is re-derived:

- no field name may be guessed;
- `devspace-ledger` is not an authority;
- conversation snapshot token estimates are not an authority;
- DOM estimates are not an authority;
- CJK/ASCII estimators are not an authority;
- `max(estimate, ledger)` is not an authority;
- Auto Compact must remain fail-closed rather than silently using an estimate.

Required authority chain:

```text
Classic native actual-usage metadata
              ↓
      Exact Usage Authority
              ↓
 currentUsed / contextWindow
```

### 2.4 Auto Compact means true same-conversation compaction

A fresh conversation is **not** Auto Compact.

True Auto Compact acceptance requires:

```text
conversationId_before == conversationId_after
actualUsage_after < actualUsage_before
visible Chat room remains the same conversation
no visible synthetic user message
no automated refresh/reload
```

A structured checkpoint/fresh-conversation continuation may exist later as a separately named emergency continuity mechanism, but it must not be reported or marketed as Auto Compact.

### 2.5 Goal and Plan state are conversation-bound

The persistent key is `conversationId`, not `runtimeKey`.

Target identity:

```text
Goal identity       = { conversationId, goalId }
Plan identity       = { conversationId, physicalTurnId, planId }
Projection location = { runtimeKey, currentConversationId }
```

`runtimeKey` is transport/projection topology only. Switching from conversation A to conversation B inside the same Main runtime must immediately remove/hide A's projection and show only B's conversation-bound state. Returning to A restores A's state without ownership migration or remount semantics.

### 2.6 Safety-check freezes are protocol problems, not reload problems

A Classic frontend may freeze while backend work continues. DevSpace must not treat that as permission to reload.

The target subsystem must identify the native request/response/control sequence that enters the problematic safety state and then:

1. prevent DevSpace from emitting a request sequence known to create the bad state; or
2. stop/pause additional DevSpace automation while the Host is in that native state and wait for a native terminal/authoritative transition.

DevSpace must not bypass a legitimate ChatGPT safety decision. The purpose is to avoid creating a pathological interaction sequence and to keep frontend/backend state coherent.

---

## 3. Authoritative subsystem boundaries

### 3.1 Classic Protocol Observer

Responsibilities:

- observe native ChatGPT Classic network/control metadata;
- bind exact `conversationId` to the active runtime transport;
- observe native model catalogue/window metadata;
- observe exact actual-usage metadata;
- observe native stream/safety/compaction events.

It must not depend on DOM.

Conversation identity transport contract:

- Classic native `POST /backend-api/f/conversation` supplies the authoritative request-body `conversation_id`;
- the same native request's `x-openai-session` is hashed locally and the raw value is never persisted;
- MCP-side `_meta["openai/session"]` / `x-openai-session` is hashed with the same function and may resolve to a conversation **only after** a native turn established the mapping;
- generic `mcp-session-id`, runtime number, DOM URL and renderer state are never conversation identity substitutes;
- unknown session fingerprints fail closed;
- if one fingerprint is ever observed against more than one distinct `conversation_id`, that fingerprint is permanently ambiguous for authority purposes until explicitly re-derived and may not bind Goal/Plan state.

This makes conversation identity a native-transport correlation problem rather than a runtime ownership or renderer parsing problem.

### 3.2 Exact Usage Authority

Responsibilities:

- accept only verified Classic actual-usage metadata;
- preserve provenance: request/event, conversation ID, model slug, observed timestamp;
- expose current actual usage to Context Guardian;
- reject stale/cross-conversation usage.

No estimator fallback is allowed.

### 3.3 Classic Safety-State Guard

Responsibilities:

- classify native safety/stream states from protocol events;
- block duplicate or unsafe DevSpace automation while Host state is unresolved;
- prevent known problematic DevSpace request sequences;
- never reload;
- never synthesize a user message;
- preserve backend work already in flight.

### 3.4 True Compact Engine

Responsibilities:

- operate only on the same conversation;
- invoke or cooperate with ChatGPT Classic's native same-conversation compaction mechanism;
- capture exact usage immediately before compaction;
- verify the same conversation ID after compaction;
- re-read exact native actual usage after compaction;
- declare success only if usage genuinely falls.

If Classic exposes no supported same-conversation mechanism, the engine must report `unsupported/unproven`; it must not substitute fresh-conversation rollover.

### 3.5 Conversation State Registry

Target data model:

```text
ConversationRegistry
└── conversationId
    ├── GoalState[] / active Goal
    ├── PlanState for current physical turn / Goal round
    ├── physicalTurnId / round binding
    ├── compact state
    ├── safety state
    └── projection revision
```

Rules:

- Goal persists across physical turns/rounds until terminal.
- Plan is current physical-turn / Goal-round scoped.
- Completed Plan disappears naturally and is never reused in the next physical turn.
- State survives runtime switching because it is not owned by the runtime.
- A runtime never "steals" state; it projects state for its current conversation.

Current implementation checkpoint (2026-09-06): Plan and Goal persistence now include optional `conversationId` with legacy `null` compatibility. New production Plan/Goal creation receives a resolver backed by `ClassicConversationAuthorityRegistry`; if native identity is unresolved, new state fails closed instead of becoming global/unbound. Active legacy Goals may bind once when unique native authority becomes available; a bound Goal cannot move to another conversation. Legacy unbound Plans remain readable but are not auto-bound.

### 3.6 Host Projection

One-way flow only:

```text
Conversation Registry → Projection Snapshot → DOM renderer
```

The Goal strip and Plan HUD remain valid visual surfaces, but they are projections only.

Desired placement:

- Goal strip: directly above the active composer;
- Plan HUD: compact conversation-pane top-right;
- no duplicate state machine;
- no runtime-bound ownership;
- unchanged projection revision = zero content writes;
- short natural terminal transitions;
- visual state must be checked against the user's real frontend during acceptance.

Current implementation checkpoint (2026-09-06): bound Goal/Plan rows are grouped into `{conversationId -> {goal,plan}}` and the whole bounded projection map is sent to every connected Main. The renderer uses its current `/c/<conversationId>` route only to select which already-authoritative projection to display. This route check is visual gating only and cannot write backend identity. The legacy `{goalId,runtimeKey,conversationId}` owner pointer remains only as an unbound migration fallback and is cleared when conversation-bound mode is active. The existing projection/content fingerprint fast path remains the DOM-write authority, so unchanged conversation+revision performs zero card content writes.

### 3.7 Renderer-independent progress surfaces

ChatGPT Classic may enter a frontend safety-check/rendering state where the visible transcript stops advancing even though DevSpace backend work continues. DevSpace therefore separates **engineering observability** from the **user-facing progress surface**.

Engineering-only debug surface:

```text
MCP tools/call traffic ──> sanitized bounded Activity Journal ──> loopback debug UI
Goal/Plan state JSON ──────────────────────────────────────────> loopback debug UI
Stable Gateway/Core liveness ─────────────────────────────────> loopback debug UI
```

The debug surface at `http://127.0.0.1:7678/__devspace/live` is for agent/developer diagnosis only. It may contain tool names, timings and backend state that are useful to the agent but are not suitable as the primary human interface.

User-facing progress surface:

```text
Agent reaches a meaningful work boundary
        │
        └─ proactively writes one natural-language assistant message
        │
        ▼
Gateway-owned durable messages[] transcript
        │
        ▼
Windows always-on-top white floating transcript
```

The user-facing Windows overlay is intentionally minimal: a `460×340` white card in the desktop top-right containing only a small `DevSpace Ultra` header and the recent natural-language assistant transcript. There is **no** `正在進行` / `最近完成` status board, no green state dot, no checklist, and no automatic translation of tool calls into pseudo-human status. Interactive Main conversations use one reasoning-mode-independent progress contract: Thinking/XHi and Pro both emit a concise visible objective before substantive tool use and concise operational summaries after meaningful verified milestones, approach changes, genuine blockers, or roughly five minutes of continued work. These messages are observable-work summaries, never raw chain-of-thought. The normal target is the in-conversation assistant stream; when the host/model does not render intermediate commentary, the same bounded natural-language update is retained in the Gateway-owned human-progress transcript without a synthetic user message, new ChatGPT turn, or refresh/navigation. The agent appends fallback messages with `scripts/devspace-progress.mjs --message "..."`; the overlay renders the bounded `messages[]` history as plain paragraphs separated by whitespace.

Hard boundaries:

- both surfaces are **observability only**, never conversation/context/safety authority;
- neither surface may read ChatGPT DOM to infer backend truth;
- neither surface may refresh, reload, navigate, stop, or repair the ChatGPT page;
- the human-progress feed is persisted under canonical local state so the recent natural-language transcript survives Gateway restart;
- each assistant progress message is bounded to 1600 characters and rejects obvious credential-bearing content;
- legacy `doing/completed` fields remain accepted only for compatibility and are never rendered by the user-facing overlay;
- no new ChatGPT/MCP tool schema is required, so progress UI changes never require an App refresh;
- the human feed and debug UI remain loopback-only and absent from the public Caddy allowlist;
- the floating overlay is independently movable/closable and starts at user logon through `DevSpace-Live-Progress-Overlay`.

These surfaces exist so the user can still see concrete progress when the ChatGPT renderer is stale. They do **not** mirror raw hidden reasoning or uncommitted assistant prose, because the Host does not expose that stream to DevSpace.

---

## 4. Current implementation conflicts to remove

The 2026-09-06 production tree still contains legacy behavior that is explicitly superseded by this framework.

### 4.1 `dist/context-guardian-cdp.js`

Legacy conflicts currently present:

- `estimateClassicInputTokens(...)` and conversation/message estimators;
- DOM-derived `domObservedTokens`;
- `captureNativeConversationPayload(... reload=true)` invoking `Page.reload`;
- `captureNativeSnapshot()` invoking reload-backed capture;
- fresh-surface navigation and plugin pairing;
- hidden fresh-conversation rollover;
- user-turn fresh-conversation rewrite;
- `Page.navigate` in fresh rollover.

These paths must not remain authoritative Auto Compact behavior.

### 4.2 `dist/context-guardian.js`

Legacy conflicts currently present:

- `computeContextGuardianPressure()` falls back to snapshot/ledger estimates;
- `observeRuntimeSnapshot()` stores estimated snapshot/ledger usage;
- `observeTurnInputEstimate()` increments a monotonic estimator ledger;
- status may report `devspace-ledger` or `classic-conversation-snapshot` as usage source.

Target state: exact native actual usage or unresolved; no estimate fallback.

### 4.3 `dist/classic-stream-recovery-guard.js` and `dist/classic-stream-recovery-cdp.js`

Legacy conflicts currently present:

- recovery accepts a `reload` adapter;
- automatic reload states/cooldowns/failure latches;
- `Page.navigate(currentHref)` as renderer recovery.

Target state: convert to protocol-only safety/reconciliation guard with zero page navigation/reload.

### 4.4 `dist/classic-host-overlay.js`

Legacy conflicts currently present:

- owner state is `{ goalId, runtimeKey, conversationId }`;
- projection is sent only to the exact stored runtime owner;
- owner transfer/mount recovery exists because state is runtime-owned;
- standalone adapter still exposes `Page.reload`.

Target state: conversation-bound registry; runtime only resolves its current conversation and projects that conversation's state.

---

## 5. Migration order

Do not mix old and new authority models. Migrate in this order:

### Gate A — documentation / durable state

1. this framework is authoritative;
2. rolling handoff records the supersession;
3. PowerMem contains the same hard invariants.

### Gate B — real frontend baseline, no refresh

Using the user's actual Classic frontend:

- identify active runtime + conversation;
- record what the user actually sees for Goal strip / Goal Dock / Plan HUD / Plan Card;
- compare it with backend Goal/Plan state;
- confirm whether Goal auto-start/continuation and Plan projection are visibly effective;
- no refresh/reload during the gate.

### Gate C — conversation-bound Goal/Plan projection

- introduce the conversation registry/binding layer;
- remove runtime ownership from Goal/Plan identity;
- switch conversations in one runtime and prove no overlay leaks across conversations;
- return to the original conversation and prove its state reappears;
- keep Goal persistent; keep Plan physical-turn/round scoped.

### Gate D — zero-refresh safety/recovery

- remove automated reload/navigation recovery adapters;
- convert Stream Recovery into native protocol safety/reconciliation state handling;
- reproduce the renderer/backend divergence without relying on UI as the authority;
- prove zero reload calls.

### Gate E — exact actual usage

- re-derive and document the exact ChatGPT Classic actual-usage metadata field/event;
- add machine-readable protocol evidence;
- wire Context Guardian only to that source;
- delete/disable estimator fallback as authority.

### Gate F — true same-conversation Auto Compact

- discover Classic native same-conversation compaction;
- prove exact usage before/after;
- prove same conversation ID;
- prove no synthetic visible message and zero refresh;
- only then call the feature Auto Compact v2 complete.

---

## 6. Acceptance gates

### 6.1 Goal Mode

PASS only when:

- Goal state is bound to conversation ID;
- hidden continuation automatically begins when authorized by Goal state without a new synthetic user message;
- switching away from the conversation hides the Goal projection;
- switching back restores it;
- terminal Goal disappears naturally;
- backend and the user's visible frontend agree.

### 6.2 Plan Card / Plan HUD

PASS only when:

- current Plan is bound to conversation + physical turn/Goal round;
- exactly one active Plan exists for that turn/round;
- completed Plan disappears naturally;
- a new physical turn/round creates a fresh Plan;
- no Plan from conversation A appears in conversation B even on the same runtime;
- backend and the user's visible frontend agree.

### 6.3 Safety-state handling

PASS only when:

- problematic safety-state reproduction has protocol evidence;
- backend can continue without DevSpace forcing refresh;
- automated refresh/reload/navigation count is zero;
- no unsent user input is destroyed;
- no synthetic user message is created.

### 6.4 Exact Usage Authority

PASS only when:

- one captured Classic native metadata value is persisted as raw evidence;
- DevSpace reports exactly the same actual usage for that conversation/turn;
- provenance binds it to the exact conversation/model/event;
- estimator/ledger fallback is not consulted.

### 6.5 True Auto Compact

PASS only when machine-readable evidence proves:

```text
sameConversationId = true
actualUsageBefore = exact native value
actualUsageAfter  = exact native value
actualUsageAfter < actualUsageBefore
automatedReloadCount = 0
syntheticVisibleUserMessages = 0
```

---

## 7. Verification discipline

Backend tests alone are not sufficient for Goal/Plan user-visible claims.

For user-visible acceptance:

1. read backend-authoritative Goal/Plan/conversation state;
2. inspect the exact real Classic frontend the user is looking at;
3. compare conversation ID and visible projection;
4. report discrepancies instead of assuming either view matches;
5. do not refresh to force agreement.

DOM inspection/screenshot is allowed here strictly as **acceptance evidence**, not as an authority for backend decisions.

---

## 8. Durable development rule

After every independently verified gate:

- update `docs/DEVSPACE-ULTRA-HANDOFF-2026-09-05-V0.5-IN-PROGRESS.md`;
- update this framework if an invariant changes;
- write the verified result to PowerMem;
- preserve the exact protocol evidence needed to avoid re-discovering successful work.

Do not mark a feature complete from memory, estimator output, backend-only state, or a different frontend conversation than the user is actually viewing.
