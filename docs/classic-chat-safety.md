# ChatGPT Classic Chat Safety

DevSpace Ultra v0.5 adds three safety/continuity layers for user-facing ChatGPT Classic **Main** runtimes while keeping the older Worker Auto Compact path separate:

- **Classic Stream Recovery** repairs a stale foreground renderer after a real stream-status transport failure when the same server turn is already complete.
- **Context Guardian v2** protects long Main conversations before the next request would cross the active model's safe context boundary.
- **Classic Host Overlay** keeps the current backend Goal above the Chat composer and the current backend Plan in a compact top-right HUD even when transcript MCP cards scroll away or Context Guardian moves the work to a fresh Chat.
- **Worker Auto Compact** remains the separate v0.3.1 continuity mechanism for managed Chat Swarm Workers.

These features support **Chat mode only**. Work mode is intentionally outside the DevSpace Ultra Classic safety surface and is never used for product acceptance.

## Safe defaults

Classic Stream Recovery, Context Guardian, and Classic Host Overlay are enabled by default for supported ChatGPT Classic Main runtimes.

| Setting | Default | Persisted config key | Purpose |
| --- | --- | --- | --- |
| `DEVSPACE_CLASSIC_STREAM_RECOVERY` | `1` | `classicStreamRecoveryEnabled` | Enable/disable conservative foreground stream reconciliation. |
| `DEVSPACE_CONTEXT_GUARDIAN` | `1` | `contextGuardianEnabled` | Enable/disable model-aware Main context protection and rollover. |
| `DEVSPACE_CLASSIC_HOST_OVERLAY` | `1` | `classicHostOverlayEnabled` | Enable/disable the backend-authoritative Goal strip and compact Plan HUD projection. |

Disable any feature explicitly when troubleshooting:

```bash
DEVSPACE_CLASSIC_STREAM_RECOVERY=0 npx @waishnav/devspace serve
DEVSPACE_CONTEXT_GUARDIAN=0 npx @waishnav/devspace serve
DEVSPACE_CLASSIC_HOST_OVERLAY=0 npx @waishnav/devspace serve
```

The Stream Recovery grace, poll, and cooldown values are intentionally internal safe defaults rather than general-user tuning knobs. Exposing aggressive timing controls would make it easier to mistake a legitimately slow model for a stalled renderer.

## Classic Stream Recovery

Stream Recovery does **not** reload a page merely because generation is slow or the UI has been quiet for a while.

Recovery is armed only when all of the following safety conditions line up:

1. ChatGPT Classic reports a transport failure for `/backend-api/conversation/<conversationId>/stream_status`.
2. The failure belongs to the currently visible conversation on the same Main runtime.
3. The page remains in Chat mode.
4. The renderer does not make normal forward progress during the reconciliation grace period.
5. An authenticated same-conversation `stream_status` check subsequently returns authoritative `COMPLETE`.
6. The runtime is still on the exact same conversation URL.

Only then can DevSpace issue one same-URL soft reload. Normal renderer progress cancels recovery, a conversation change cancels recovery, Work mode cancels recovery, and a per-conversation cooldown prevents reload loops. No synthetic user message is created.

The adapter connects only to supported loopback-debuggable Classic Main runtimes. Main-01 uses the protected canonical Primary debug path; Main-02+ use their isolated Interactive debug ports. Worker runtimes are not part of this feature.

## Classic Host Overlay

Host Overlay solves a UI persistence problem rather than creating another Goal or Plan store. The backend remains authoritative:

- `GoalRuntime.projectableGoals()` supplies the newest active, paused, or blocked Goal for display;
- `PlanRuntime.activePlans()` supplies the newest active Plan;
- the initial owner is resolved from the real Classic Goal host and bound to the exact `goalId + runtimeKey + conversationId` tuple;
- the overlay reuses the existing Context Guardian loopback CDP sessions instead of opening another long-lived CDP pool;
- only the exact owner runtime receives the Goal/Plan projection; every other Main receives an empty projection, and the owner-side DOM script independently refuses a mismatched conversation URL;
- the projection uses DOM `textContent` for Goal/Plan text and never evaluates backend text as HTML;
- exactly one host overlay root is reused in place, so state revisions update without stacking duplicate cards;
- only the bounded owner pointer is persisted across backend reloads. Goal and Plan content remain solely in GoalRuntime/PlanRuntime;
- ordinary/manual navigation never transfers ownership. A verified Context Guardian hidden rollover can atomically move the owner pointer from the exact old conversation to the exact fresh conversation.

Placement follows stable ChatGPT Classic semantic anchors. The Goal strip tracks the active `#prompt-textarea` form / `#thread-bottom-container` and sits immediately above the composer. The Plan HUD is fixed to the conversation pane's top-right using `main#main` geometry. It is compact by default and exposes the full step list only through a disclosure control. Narrow windows keep a compact progress surface instead of a large panel.

Work mode is explicitly refused. When there is no projectable Goal/Plan, the page is in Work mode, the Main runtime is not the owner, or the current conversation ID differs from the persisted owner binding, the host projection hides itself. Existing Goal Dock and Plan Card MCP Apps remain compatible transcript fallback/control surfaces and still read the same backend truth.

## Context Guardian v2

Context Guardian protects visible Main conversations prospectively rather than waiting for a fixed percentage such as 90%.

### Model window source

The active ChatGPT Classic model and its context window come from the best available **Classic-native** model/turn metadata observed from the real host request path. DevSpace does not trust a separately fetched reduced model catalogue when it differs from the native host request.

Known live examples observed during v0.5 acceptance include:

- GPT-5.6 Sol Thinking: `262144` tokens
- GPT-5.6 Pro: `410000` tokens
- GPT-5.6 default Chat model: `137000` tokens
- GPT-6 Pro: `410000` tokens

These are regression examples, not hard-coded universal ceilings. New model variants are expected to use the current client-reported native metadata whenever available.

### Usage accounting

Context Guardian uses the strongest available signal in this order:

1. fresh host-measured usage when Classic exposes it;
2. conservative current-conversation snapshot estimate;
3. DevSpace's monotonic per-conversation ledger.

The fallback estimator is CJK-aware and intentionally conservative. Persisted Context Guardian state contains numeric usage/model/conversation metadata only; it does not persist prompt text, cookies, authorization headers, transient transport tokens, or equivalent credentials.

### Prospective safety guard

Before allowing another request, Context Guardian reserves space for:

- the prospective next input;
- expected output headroom;
- uncertainty/hidden-overhead headroom.

It reports `normal`, `watch`, `prepare`, or `rollover` pressure and can request rollover **before** the next request would be unsafe. This avoids both a fixed token ceiling and a blind fixed-percentage trigger.

### Main rollover

Context Guardian separates **pressure detection/checkpointing** from **authorization to create a fresh Chat**.

Background polling is checkpoint-only. At `prepare` or `rollover` pressure it can capture a bounded Classic-native conversation snapshot and write a structured compact capsule containing Goal/Plan state, decisions, completed work, evidence, next steps, and the do-not-redo frontier, but background polling never navigates to a fresh Chat and never sends `@DevSpace Ultra`. This remains true on startup/reconnect and with multiple Main runtimes.

A fresh hidden rollover is allowed only on an already-authorized Goal Host Bridge continuation when the prospective guard says the continuation itself cannot safely fit. That path:

1. verifies an idle Chat-mode boundary with no unsent composer text;
2. creates the structured compact checkpoint;
3. opens and pairs a fresh ChatGPT Classic Chat;
4. intercepts the first turn request and replaces it with a native hidden Tool message;
5. fails the intercepted request closed if rewriting cannot be proven, rather than allowing a visible fallback;
6. verifies the fresh conversation has zero visible user messages before returning success;
7. transfers Host Overlay ownership only after that verification succeeds.

The fresh conversation contains no synthetic visible user bubble. Work mode, an actively generating turn, or non-empty unsent composer text refuses the rollover path. A reported Goal continuation can be carried directly through the fresh hidden rollover path; the Goal continuation instructions decide the new round state rather than inventing a user turn.

## Relationship to Worker Auto Compact

Do not confuse Context Guardian v2 with the older Worker Auto Compact watchdog.

| Runtime | Long-context mechanism |
| --- | --- |
| Main-01 / Main-02+ | Context Guardian v2 |
| Managed Chat Swarm Worker | Worker Auto Compact / Conversation Continuity |

Worker Auto Compact keeps its explicit `DEVSPACE_AUTO_COMPACT_*` estimator settings because Workers are backend-managed and use a different continuation lifecycle. Context Guardian uses live Classic model metadata and a prospective safety guard instead.

## Verification

Deterministic product gates:

```bash
npm run verify:stream-recovery
npm run verify:context-guardian
npm run verify:host-overlay
npm run verify:classic-safety
```

Full regression:

```bash
npm test
```

Real Classic acceptance additionally verifies:

- Chat mode only;
- Stream Recovery ignores normal slow generation and repairs only a matching failed/COMPLETE stale stream;
- Main-01/02/03 remain on the intended conversations without reload loops;
- Context Guardian uses the current native model window;
- rollover creates no visible synthetic user message;
- Goal and Plan backend state survives the fresh conversation;
- exactly one Goal strip remains above the composer and one compact Plan HUD remains at the conversation pane top-right across state updates and reloads;
- Work mode is never used as an acceptance surface.
