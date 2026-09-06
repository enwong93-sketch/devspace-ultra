# Conversation-Bound Goal / Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevSpace Goal Mode and Plan state belong to the exact ChatGPT Classic conversation, with runtime only acting as a projection host, and prove the result against the same real frontend the user is viewing without any automated refresh/reload.

**Architecture:** Reuse the already-proven MCP request identity path from Chat Swarm instead of inventing a DOM/runtime heuristic. Introduce a small shared peer-identity extractor plus a conversation-state binding layer; GoalRuntime and PlanRuntime store an exact conversation binding, while Host Overlay selects projection by each runtime's currently observed native conversation identity rather than a single persisted runtime owner. DOM remains a one-way renderer and acceptance surface only.

**Tech Stack:** Node.js ESM, MCP SDK `RequestHandlerExtra`, Zod v4, existing GoalRuntime / PlanRuntime / Classic Context CDP observer / Host Overlay, Node test runner + existing static/live gate scripts.

**Spec:** `docs/DEVSPACE-ULTRA-V0.5-CLASSIC-CONVERSATION-AUTHORITY-FRAMEWORK.md`

## Global Constraints

- Automated ChatGPT page refresh/reload/navigation-as-reload is forbidden in implementation and acceptance.
- UI/DOM may be inspected only for visual acceptance; it must never determine backend Goal/Plan ownership or lifecycle.
- Exact conversation binding must come from ChatGPT Classic native/backend/MCP request identity. Do not use URL/DOM as the authority for storing state.
- `runtimeKey` is projection topology only, never Goal/Plan identity.
- Goal identity is `{ conversationId, goalId }` and persists until terminal completion/stop/block handling.
- Plan identity is `{ conversationId, physicalTurnId/goalRound, planId }`; exactly one active plan is allowed per conversation turn/round, not globally across unrelated conversations.
- Existing continuation/round semantics and all prior Goal/Plan state must migrate fail-closed without silently deleting state.
- Real acceptance must compare backend state with the exact Classic frontend the user is viewing and must report mismatches rather than force reconciliation.

---

## File Structure

**Create**
- `dist/mcp-peer-identity.js` — one shared parser/classifier for MCP request identity metadata; exact conversation IDs are distinguished from session-only fingerprints.
- `dist/mcp-peer-identity.test.js` — unit coverage for exact conversation metadata, session fallback, malformed metadata and fingerprint stability.
- `dist/conversation-state-registry.js` — persistent mapping/index for conversation-bound Goal/Plan execution scope and migration from legacy unbound state.
- `dist/conversation-state-registry.test.js` — conversation A/B isolation, turn/round plan scope, legacy migration and restart persistence.
- `scripts/conversation-state-static-gate.mjs` — locks server/tool wiring to exact conversation binding and rejects runtime-owned identity regressions.

**Modify**
- `dist/chat-swarm.js` — consume shared peer-identity helper while preserving existing session-bound worker behavior.
- `dist/goal-runtime.js` / `dist/goal-runtime.test.js` — persist `conversationId` and bind start/status/projectable queries to conversation scope without changing continuation semantics.
- `dist/plan-runtime.js` / `dist/plan-runtime.test.js` — persist `conversationId` plus `turnScopeId`; enforce one active plan per scope instead of one global active plan.
- `dist/goal-tools.js` / `dist/goal-tools.test.js` — read exact conversation identity from MCP callback `extra`; start/mount/status/control calls enforce or carry conversation binding as appropriate.
- `dist/plan-tools.js` / `dist/plan-tools.test.js` — bind Plan start/mount/status/update to exact conversation; derive stable current turn/Goal-round scope from request/Goal context instead of global state.
- `dist/classic-host-overlay.js` / `dist/classic-host-overlay.test.js` — remove single `{goalId,runtimeKey,conversationId}` owner semantics; build per-conversation projection and send each runtime only the state for its current native conversation.
- `dist/server.js` — instantiate and wire ConversationStateRegistry/shared identity resolver; update instructions so conversation scope is authoritative.
- `package.json` — include new static/unit gates in verification.
- `docs/DEVSPACE-ULTRA-HANDOFF-2026-09-05-V0.5-IN-PROGRESS.md` — append each verified gate.
- `docs/DEVSPACE-ULTRA-V0.5-CLASSIC-CONVERSATION-AUTHORITY-FRAMEWORK.md` — only adjust if implementation reveals an ambiguity; invariants remain unchanged.

---

### Task 1: Shared Exact MCP Conversation Identity

**Files:**
- Create: `dist/mcp-peer-identity.js`
- Create: `dist/mcp-peer-identity.test.js`
- Modify: `dist/chat-swarm.js`

**Interfaces:**
- Produces: `resolveMcpPeerIdentity(extra): { exactConversationId: string|null, identitySource: string, identityFingerprint: string|null, requestMetaKeys: string[] }`
- Produces: `isExactConversationIdentity(peer): boolean`
- Consumes: MCP callback `extra._meta`, `extra.sessionId`.
- Later tasks may bind Goal/Plan state only when `exactConversationId` is non-null; session-only identity remains usable by Chat Swarm but cannot masquerade as a conversation ID.

- [ ] **Step 1: Write failing identity tests**

Cover these exact cases:

```js
const exactA = resolveMcpPeerIdentity({
  _meta: { "openai/conversation_id": "6a9c-test-conversation" },
  sessionId: "session-a",
});
assert.equal(exactA.exactConversationId, "6a9c-test-conversation");
assert.equal(exactA.identitySource, "openai/conversation_id");

const exactB = resolveMcpPeerIdentity({
  _meta: { "openai/conversationId": "6a9c-test-conversation-b" },
});
assert.equal(exactB.exactConversationId, "6a9c-test-conversation-b");

const sessionOnly = resolveMcpPeerIdentity({
  _meta: { "openai/session": "opaque-session" },
});
assert.equal(sessionOnly.exactConversationId, null);
assert.equal(sessionOnly.identitySource, "openai/session");
assert.ok(sessionOnly.identityFingerprint);
```

Also assert malformed/blank conversation IDs do not become exact IDs and raw opaque session values are never returned.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```text
node --test dist/mcp-peer-identity.test.js
```

Expected: FAIL because `dist/mcp-peer-identity.js` does not exist.

- [ ] **Step 3: Implement the minimal shared identity helper**

Requirements:

```js
const EXACT_KEYS = ["openai/conversation_id", "openai/conversationId"];
const SESSION_KEYS = ["openai/session", "chatgpt/session"];
```

- exact keys return a sanitized raw conversation ID plus fingerprint;
- session keys and `extra.sessionId` return fingerprint only;
- SHA-256 fingerprint is truncated consistently with current Chat Swarm behavior;
- helper returns sorted request metadata keys for diagnostics but never raw session values.

- [ ] **Step 4: Switch Chat Swarm `peerInfo()` to the shared helper**

Keep all existing Chat Swarm output fields and session-bound semantics unchanged. This is a refactor-only compatibility step: `findSessionBoundWorker()` must continue matching `identitySource + identityFingerprint` exactly as before.

- [ ] **Step 5: Run identity + Chat Swarm regression**

Run:

```text
node --test dist/mcp-peer-identity.test.js dist/chat-swarm.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```text
git add dist/mcp-peer-identity.js dist/mcp-peer-identity.test.js dist/chat-swarm.js
git commit -m "refactor: share classic conversation peer identity"
```

---

### Task 2: Persistent Conversation State Registry and Legacy Migration

**Files:**
- Create: `dist/conversation-state-registry.js`
- Create: `dist/conversation-state-registry.test.js`
- Modify: `dist/goal-runtime.js`
- Modify: `dist/goal-runtime.test.js`
- Modify: `dist/plan-runtime.js`
- Modify: `dist/plan-runtime.test.js`

**Interfaces:**
- Produces: `ConversationStateRegistry({ stateDir })`
- Produces: `bindGoal({ conversationId, goalId })`, `goalBinding(goalId)`, `goalsForConversation(conversationId)`
- Produces: `bindPlan({ conversationId, planId, turnScopeId })`, `planBinding(planId)`, `activePlanForScope({ conversationId, turnScopeId })`
- Produces runtime additions: `GoalRuntime.start({ objective, successCriteria, conversationId })`; `PlanRuntime.start({ title, steps, conversationId, turnScopeId })`.

- [ ] **Step 1: Write RED registry tests for A/B isolation and restart persistence**

Minimum assertions:

```js
await registry.bindGoal({ conversationId: "conv-A", goalId: "goal_aaaaaaaaaaaaaaaa" });
await registry.bindGoal({ conversationId: "conv-B", goalId: "goal_bbbbbbbbbbbbbbbb" });
assert.deepEqual(await registry.goalsForConversation("conv-A"), ["goal_aaaaaaaaaaaaaaaa"]);
assert.deepEqual(await registry.goalsForConversation("conv-B"), ["goal_bbbbbbbbbbbbbbbb"]);

await registry.bindPlan({ conversationId: "conv-A", planId: "plan_aaaaaaaaaaaaaaaa", turnScopeId: "round:1" });
assert.equal((await registry.activePlanForScope({ conversationId: "conv-A", turnScopeId: "round:1" })).planId, "plan_aaaaaaaaaaaaaaaa");
assert.equal(await registry.activePlanForScope({ conversationId: "conv-B", turnScopeId: "round:1" }), null);
```

Recreate the registry from the same temporary `stateDir` and assert bindings survive restart.

- [ ] **Step 2: Run focused registry tests and confirm RED**

Run:

```text
node --test dist/conversation-state-registry.test.js
```

Expected: FAIL because the registry is not implemented.

- [ ] **Step 3: Implement registry schema v1**

Persist only bounded identity/scope data:

```json
{
  "version": 1,
  "conversations": {
    "conv-A": {
      "goalIds": ["goal_..."],
      "planScopes": {
        "round:1": "plan_..."
      }
    }
  },
  "goalBindings": { "goal_...": "conv-A" },
  "planBindings": { "plan_...": { "conversationId": "conv-A", "turnScopeId": "round:1" } }
}
```

Use atomic temp-write + rename. Reject cross-conversation rebinding of an already bound Goal/Plan unless an explicit migration method is invoked for legacy data.

- [ ] **Step 4: Add GoalRuntime conversation binding**

Add `conversationId` to new Goal state. Persisted legacy goals without it remain loadable as `conversationId:null` until claimed by exact current-conversation migration; do not reset/delete them.

Add conversation-aware query:

```js
projectableGoals({ conversationId, limit = 12 })
```

When `conversationId` is supplied, return only goals bound to it. Existing continuation/round report/complete/control semantics remain unchanged.

- [ ] **Step 5: Add PlanRuntime conversation + turn scope**

Add `conversationId` and `turnScopeId` to Plan state.

Replace global active-plan rejection with:

```js
const activePlan = plans.find(
  p => p.status === "active"
    && p.conversationId === conversationId
    && p.turnScopeId === turnScopeId
);
```

Therefore an old active Plan in conversation A cannot block a fresh Plan in conversation B. A second active Plan in the same `{conversationId,turnScopeId}` must still fail.

Legacy unbound plans stay loadable and require exact migration before reuse; they must not become visible in an unrelated conversation.

- [ ] **Step 6: Run Goal/Plan runtime tests**

Run:

```text
node --test dist/conversation-state-registry.test.js dist/goal-runtime.test.js dist/plan-runtime.test.js
```

Expected: PASS, including legacy state migration tests and no regression in Goal continuation/Plan step invariants.

- [ ] **Step 7: Commit**

```text
git add dist/conversation-state-registry.js dist/conversation-state-registry.test.js dist/goal-runtime.js dist/goal-runtime.test.js dist/plan-runtime.js dist/plan-runtime.test.js
git commit -m "feat: bind goal and plan state to conversations"
```

---

### Task 3: Bind Goal / Plan MCP Tools to Exact Current Conversation

**Files:**
- Modify: `dist/goal-tools.js`
- Modify: `dist/goal-tools.test.js`
- Modify: `dist/plan-tools.js`
- Modify: `dist/plan-tools.test.js`
- Modify: `dist/server.js`

**Interfaces:**
- Consumes: `resolveMcpPeerIdentity(extra)` from Task 1.
- Consumes: ConversationStateRegistry from Task 2.
- Produces: fail-closed tool behavior when a mutating Goal/Plan start/mount cannot resolve an exact current conversation.

- [ ] **Step 1: Write RED tool tests for exact conversation propagation**

Call registered handlers with a fake MCP callback `extra` containing:

```js
{ _meta: { "openai/conversation_id": "conv-A" }, sessionId: "opaque-session" }
```

Assert:

- `devspace_goal_start` calls runtime with `conversationId:"conv-A"`;
- `devspace_plan_start` calls runtime with `conversationId:"conv-A"`;
- a status/update/mount request from conversation B for a plan bound to A is rejected as conversation mismatch;
- an opaque session-only identity cannot create a conversation-bound Goal/Plan and returns an explicit unresolved-conversation error rather than using runtime/DOM fallback.

- [ ] **Step 2: Run tool tests and confirm RED**

Run:

```text
node --test dist/goal-tools.test.js dist/plan-tools.test.js
```

Expected: FAIL because handlers currently ignore callback `extra`.

- [ ] **Step 3: Update tool callbacks to accept `(args, extra)`**

For `devspace_goal_start` and `devspace_plan_start`, resolve exact conversation ID from MCP metadata before mutation.

For status/control/update/mount:

- read the entity's stored binding;
- compare with exact current conversation when the operation is user-facing or mutating;
- refuse cross-conversation use;
- preserve app polling for the same bound conversation.

- [ ] **Step 4: Derive turn scope without DOM**

For Goal Mode plans use the bound Goal round as scope:

```text
goal:<goalId>:round:<round>
```

For ordinary non-Goal physical turns use an MCP request/turn identity only when Classic exposes a stable exact request metadata field. If no exact physical-turn identity is present, use a server-issued scope created on `devspace_plan_start` and keep it attached to that Plan; do not infer it from DOM or runtime.

This step must remain fail-closed and documented in tests.

- [ ] **Step 5: Wire registry/identity into server registration**

Instantiate one ConversationStateRegistry in `server.js`, pass it to Goal/Plan tool registration, and close/flush it during server shutdown.

Update server instructions to say conversation-bound identity is authoritative and completed Plans are scoped to the bound conversation turn/round.

- [ ] **Step 6: Run focused tool/server gates**

Run:

```text
node --test dist/goal-tools.test.js dist/plan-tools.test.js
npm run verify:goal
npm run verify:plan
```

Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add dist/goal-tools.js dist/goal-tools.test.js dist/plan-tools.js dist/plan-tools.test.js dist/server.js
git commit -m "feat: bind goal and plan tools to current conversation"
```

---

### Task 4: Replace Runtime Owner with Per-Conversation Host Projection

**Files:**
- Modify: `dist/classic-host-overlay.js`
- Modify: `dist/classic-host-overlay.test.js`
- Create: `scripts/conversation-state-static-gate.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: exact runtime→conversation snapshots from the existing Classic native context observer for projection routing only.
- Consumes: ConversationStateRegistry to find Goal/Plan state for each exact conversation.
- Produces: `syncAllConversationProjections({ projectionsByConversation })` or equivalent adapter contract; each runtime receives only the projection matching its active exact conversation.

- [ ] **Step 1: Write RED overlay tests for A→B→A projection isolation**

Mock two runtimes and conversation transitions:

```text
main-01 -> conv-A  => Goal-A + Plan-A visible
main-01 -> conv-B  => Goal-A/Plan-A hidden; Goal-B/Plan-B only
main-01 -> conv-A  => Goal-A + Plan-A restored
main-02 -> conv-B  => only conv-B state
```

Assert no persisted/runtime owner migration is required and no projection payload includes state from another conversation.

- [ ] **Step 2: Run Host Overlay tests and confirm RED**

Run:

```text
node --test dist/classic-host-overlay.test.js
```

Expected: FAIL against the existing single-owner architecture.

- [ ] **Step 3: Remove single-owner projection selection**

Eliminate control dependence on:

```text
{ goalId, runtimeKey, conversationId }
requestOwnerRebind()
noteVerifiedRollover() as the normal ownership model
```

Persisted old owner data may be ignored/migrated for backward compatibility; it must not select current state.

For every connected runtime:

1. obtain exact current native conversation ID from the shared Classic observer;
2. read conversation-bound Goal/Plan projection from registry/runtime state;
3. inject only that projection into that runtime;
4. send an empty projection when no state exists for that conversation.

The DOM script may still verify its own current URL conversation for fail-safe hiding, but backend selection must already be conversation-scoped.

- [ ] **Step 4: Preserve zero-write/flicker contract**

Keep current projection fingerprinting and DOM `contentWrites:0` behavior for unchanged state. Keep short opacity/translate terminal transitions. Do not add page-wide MutationObserver churn.

- [ ] **Step 5: Add static gate against runtime ownership/reload regression**

`conversation-state-static-gate.mjs` must assert:

- Goal/Plan tool wiring imports the shared MCP peer identity helper;
- Host Overlay no longer stores an authoritative runtime owner tuple;
- no Host Overlay method named `reload` or `Page.reload` remains in its active projection adapter;
- projection routing keys by conversation ID;
- no DOM token/message heuristic is used to select Goal/Plan backend state.

- [ ] **Step 6: Run focused verification**

Run:

```text
node --test dist/classic-host-overlay.test.js
node scripts/conversation-state-static-gate.mjs
npm run verify:host-overlay
```

Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add dist/classic-host-overlay.js dist/classic-host-overlay.test.js scripts/conversation-state-static-gate.mjs package.json
git commit -m "feat: project goal and plan by conversation"
```

---

### Task 5: Migrate Current Legacy Goal / Plan State Without False Completion

**Files:**
- Modify only if needed: `dist/conversation-state-registry.js`, its tests, and handoff.
- Runtime state: existing `goal-state.json`, `plan-state.json`, registry state through supported code paths only.

**Interfaces:**
- Consumes exact current conversation identity from the current MCP request/native observer.
- Produces explicit migration receipts: legacy entity ID → exact conversation ID; never silently closes/completes legacy state.

- [ ] **Step 1: Add RED migration tests**

Given a legacy active Goal/Plan with `conversationId:null`, assert:

- first explicit exact-current-conversation claim can bind it once;
- a later different conversation cannot claim it;
- migration does not alter Goal round/status, Plan step/status or revision except a dedicated binding revision/receipt if used;
- no entity is automatically marked completed to make room for a new Plan.

- [ ] **Step 2: Implement exact one-time legacy claim**

Expose a registry method such as:

```js
claimLegacyEntity({ type: "goal"|"plan", entityId, conversationId })
```

It succeeds only for an unbound legacy entity and persists a migration receipt with timestamp and old/new binding.

- [ ] **Step 3: Bind the newly created Goal for this work and resolve the stale active Plan correctly**

Current known IDs at plan creation:

```text
Goal = goal_1b2f3eb499d8f460
Legacy active Plan = plan_dfc1ea0e2b285119 (revision 12, final old acceptance step in_progress)
```

Do not falsely complete `plan_dfc1ea0e2b285119`. Bind/migrate it only to its actual legacy conversation if that exact identity can be proven; otherwise leave it quarantined/unbound so it cannot block a fresh current-conversation Plan.

- [ ] **Step 4: Start a fresh Plan in the current conversation/Goal round**

Once per-conversation scoping is live, create the current Round-1 Plan under:

```text
goal:goal_1b2f3eb499d8f460:round:1
```

and verify it does not conflict with the quarantined/other-conversation legacy Plan.

- [ ] **Step 5: Run migration + Plan gates**

Run focused registry/runtime tests and `npm run verify:plan`.

Expected: PASS with both legacy state preservation and fresh current-conversation Plan eligibility.

- [ ] **Step 6: Commit**

Commit only code/tests/doc changes; persisted live runtime state is not committed to source control.

---

### Task 6: Real No-Refresh Frontend Acceptance on the User's Actual Classic View

**Files:**
- Update: `docs/DEVSPACE-ULTRA-HANDOFF-2026-09-05-V0.5-IN-PROGRESS.md`
- Update: PowerMem verified checkpoint through existing `powermem-shared` capability.

**Interfaces:**
- Consumes backend Goal/Plan state and real managed Classic frontend inspection.
- Produces machine/handoff evidence comparing exact conversation ID, Goal/Plan revisions and visible projection.

- [ ] **Step 1: Capture pre-change real frontend baseline without refresh**

Record on the exact Classic Main/conversation the user is looking at:

```text
runtimeKey
conversationId
Goal visible? text/revision
Plan visible? text/revision
number of Goal/Plan projection roots
composer anchor geometry
```

This is acceptance evidence only. Do not use DOM to decide ownership.

- [ ] **Step 2: Compare with backend state**

Read `goal_1b2f3eb499d8f460` and the current Plan from backend. If frontend differs, record the mismatch before changing it.

- [ ] **Step 3: Verify current conversation projection**

Without reload, allow normal projection polling/update to converge. Confirm:

- Goal strip belongs to current conversation;
- fresh Plan HUD belongs to current Goal round;
- exactly one projection root exists;
- unchanged polling produces zero content writes/flicker.

- [ ] **Step 4: Verify A→B→A switching in the same runtime**

Use a safe existing second conversation in the same Main runtime; do not create a synthetic user message and do not refresh.

Expected:

```text
A: Goal/Plan A visible
B: A overlay absent; only B state if B has state
A: Goal/Plan A restored
```

- [ ] **Step 5: Verify terminal/transient lifecycle when naturally reached**

- complete the current Plan before Goal round report;
- confirm Plan HUD exits naturally;
- Goal strip remains because Goal is still active;
- next Goal round starts a fresh Plan if multi-step work remains.

- [ ] **Step 6: Run full regression before declaring this sub-project complete**

Run:

```text
npm run verify:goal
npm run verify:plan
npm run verify:host-overlay
npm test
git diff --check
```

Expected: all PASS.

- [ ] **Step 7: Update durable state**

Append exact acceptance evidence to the rolling handoff and PowerMem. Include any mismatch found and the exact final behavior. Do not claim exact Context Guardian usage or true Auto Compact yet; those belong to later plans.

- [ ] **Step 8: Commit**

```text
git add docs/DEVSPACE-ULTRA-HANDOFF-2026-09-05-V0.5-IN-PROGRESS.md docs/DEVSPACE-ULTRA-V0.5-CLASSIC-CONVERSATION-AUTHORITY-FRAMEWORK.md docs/superpowers/plans/2026-09-06-conversation-bound-goal-plan.md
git commit -m "docs: record conversation-bound goal plan acceptance"
```

---

## Self-Review Result

- Spec coverage for this sub-project: conversation-bound Goal/Plan identity, runtime-as-projection-only, real same-frontend acceptance, no-refresh constraint and legacy state preservation are all mapped to Tasks 1-6.
- Intentionally deferred to separate follow-up plans: zero-refresh Classic Safety-State Guard implementation, exact actual-usage protocol re-derivation, and true same-conversation Auto Compact. This prevents authority migrations from being coupled into one unreviewable change.
- No estimator/ledger/DOM authority is introduced by this plan.
- No step asks for refresh/reload or synthetic user input.
- Legacy active Plan is explicitly quarantined/migrated rather than falsely completed.
