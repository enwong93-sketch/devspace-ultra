# Automatic Conversation Continuity

Status: **Worker continuity v0.3.1; Main selective continuation v0.5**.

DevSpace Ultra can keep a managed ChatGPT Classic worker or a user-facing Main task running across multiple backend conversation IDs instead of waiting for one context window to hit its hard limit. Worker identity continuity and Main UI/Goal/Plan continuity are separate transport paths but share the same bounded capsule store.

## Policy

The default model budget is configurable and currently defaults to `1,050,000` tokens with an Auto Compact threshold of `0.90` and a `32,000`-token hidden/system/tool reserve. The reserve is counted as estimated consumed context; it is not subtracted before the 90% threshold is calculated. The default absolute trigger is therefore `945,000` estimated tokens.

ChatGPT Classic does not expose a native exact context-token counter through this MCP connection. DevSpace therefore combines two conservative signals and exposes the result as an estimate: a live DOM estimate plus a monotonic backend context ledger for task prompts/results in the current continuation epoch. Pressure uses the larger of the two before adding the reserve, so ChatGPT UI virtualization cannot make old context disappear from the watchdog. Operators can override the context budget, threshold, reserve and polling interval in `~/.devspace/config.json` or the corresponding environment variables.

## Backend-driven compaction

Auto Compact is intentionally not dependent on the old conversation seeing a newly registered MCP tool. Long-running ChatGPT sessions can retain an older tool schema, so DevSpace performs managed handoff in the backend:

1. the watchdog observes the configured threshold;
2. Chat Swarm records `compactRequired` for that worker;
3. no rotation occurs while a task is in flight or the ChatGPT turn is generating;
4. at the next idle/safe boundary DevSpace builds a bounded capsule from authoritative Chat Swarm task history plus a bounded recent transcript excerpt;
5. credentials are redacted and raw worker/orchestrator tokens are never copied into the capsule;
6. the backend creates a short-lived one-time continuation ticket and opens a fresh ChatGPT conversation;
7. the fresh conversation redeems that ticket through the long-existing `chat_swarm_join` `inviteCode` field, preserving compatibility with cached MCP tool catalogs;
8. the backend invalidates the old token and binds the fresh ChatGPT MCP session fingerprint directly to the same `workerId`; no replacement raw worker token is exposed to ChatGPT. Cached schemas that still require the field can use the fixed non-secret `SESSION_BOUND_CONTINUATION` sentinel;
9. the saved conversation mapping is updated only after resume and only with a stable server conversation ID; transient `WEB:*`/local SPA routes are rejected. The new context ledger epoch starts from the bounded compact carry-forward estimate and the worker returns to `chat_swarm_next`.

A failed handoff does not overwrite the previous saved conversation mapping. Continuation tickets are stored only as hashes in Chat Swarm state and are one-time/expiring. Normal ChatGPT worker joins are session-bound by default for the same reason: browser/internal compatibility paths can still use token mode, but ordinary ChatGPT conversations do not need a raw worker credential in their transcript/tool results.

## Capsule contents

A managed capsule can preserve:

- active goal and user intent;
- constraints and routing identity;
- recent completed/failed Chat Swarm tasks and their results;
- bounded recent conversation context;
- current state, tests/tool state, blockers and next steps;
- memory references when supplied by a manual checkpoint.

The full prior transcript is not copied into the new prompt. Exact live state should be re-read from files/tools when correctness depends on it.

PowerMem integration is optional and fail-open: when a trusted local `powermem-shared` capability is installed, DevSpace can write a concise durable checkpoint to the shared PowerMem backend. Auto Compact itself does not require PowerMem.

## Main selective continuation

Main-01/Main-02+ never use the Worker ticket path. Context Guardian prepares a capsule from backend-authoritative Goal/Plan state and a sanitized native conversation descriptor, then waits for an authorized transport boundary. The next real user Send can be rewritten with one hidden capsule plus the unchanged visible user message; an already-authorized Goal Host Bridge follow-up can instead be rewritten as one hidden Goal continuation with no visible synthetic user bubble.

Backend conversation ID changes are allowed, but do not by themselves establish continuity. DevSpace requires one logical UI continuity key and a compression contract:

- non-empty Goal objective, constraints and current/next execution frontier;
- bounded carry size (`30,000` capsule characters and a conservative carry-token ceiling by default);
- no `mapping`, full transcript, raw messages, raw tool history, hidden reasoning, expired transport state or credentials;
- every available exact-token, payload-byte, mapping-count and current-branch-message ratio below the configured carry ratio;
- a target descriptor that independently proves the new mapping, current branch and payload are materially smaller;
- the hidden capsule fingerprint/source ID/UI continuity markers survive;
- a hidden capsule and assistant response exist, and a real visible user message exists for user-turn mode.

Only then does a guarded transaction rebind the native MCP conversation authority, Goal, Plan, progress narration and Host Overlay. A failed validation or partial transfer leaves the old authority intact. Trigger pressure may be conservative when exact native token telemetry is absent; `get_context_remaining` and any exact-usage claim remain unavailable rather than substituting the estimate. The built-in `devspace-auto-compact` capability exposes its Skill and a sanitized `auto-compact-status` command tool without returning raw capsule text or state paths.

## Protected interactive runtimes

A runtime marked in controller state as `protectedWorkers` is excluded from automatic rotation. This exists for identity-recovery situations where an interactive user conversation is temporarily running inside a worker package. Protected runtimes are also excluded from normal stop/repair/recover/scale/update paths until explicitly unprotected or automatically healed after they close.

## Verification

Run deterministic and 500-rotation stress gates:

```bash
npm run verify:auto-compact
```

The v0.3.1 release gate additionally exercised a real ChatGPT Classic A→B handoff with the context window temporarily reduced to `10,000` tokens so the same production watchdog path could be crossed quickly. The final pre-handoff sample was DOM `448` vs Backend Context Ledger `18,164`; the watchdog used the larger ledger signal, yielding an effective `19,164` estimate over the `9,000` test trigger. DevSpace automatically opened a new **project-scoped stable** conversation, preserved the same `worker-01` identity with `continuationCount=1`, bound the fresh MCP session without exposing a replacement worker token, reset the context epoch, and the new conversation correctly recalled a harmless marker/reference that was supplied only in conversation A/capsule. Production configuration was then restored to the `1,050,000` / `945,000` policy above.

Relevant environment variables:

- `DEVSPACE_AUTO_COMPACT=1`
- `DEVSPACE_AUTO_COMPACT_THRESHOLD=0.90`
- `DEVSPACE_AUTO_COMPACT_CONTEXT_TOKENS=1050000`
- `DEVSPACE_AUTO_COMPACT_RESERVE_TOKENS=32000`
- `DEVSPACE_AUTO_COMPACT_POLL_SECONDS=15`
- `DEVSPACE_AUTO_COMPACT_RESUME_TIMEOUT_SECONDS=150`
