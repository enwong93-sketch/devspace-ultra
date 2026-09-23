import assert from "node:assert/strict";
import test from "node:test";
import { applyVerifiedAutoCompactRollover } from "./auto-compact-authority-transaction.js";

const OLD = "conversation-old";
const NEXT = "conversation-new";

function harness({ authority = OLD, goal = OLD, plan = OLD, progress = OLD, overlay = OLD, overlayFails = false } = {}) {
  const state = { authority, goal, plan, progress, overlay };
  const calls = [];
  const move = (key, from, to) => {
    calls.push(`${key}:${from}->${to}`);
    if (state[key] === to) return false;
    if (state[key] !== from) throw new Error(`${key} unexpected owner ${state[key]}`);
    state[key] = to;
    return true;
  };
  const deps = {
    conversationAuthority: {
      async acceptVerifiedRollover({ oldConversationId, newConversationId }) {
        const changed = move("authority", oldConversationId, newConversationId);
        return { ok: true, updatedSessions: changed ? 1 : 0, alreadyApplied: !changed };
      },
    },
    goalRuntime: {
      async status() { return { id: "goal-1", conversationId: state.goal }; },
      async rebindConversation({ oldConversationId, newConversationId }) {
        move("goal", oldConversationId, newConversationId);
      },
    },
    planRuntime: {
      async status() { return { id: "plan-1", conversationId: state.plan }; },
      async rebindConversation({ oldConversationId, newConversationId }) {
        move("plan", oldConversationId, newConversationId);
      },
    },
    goalRunProgress: {
      async rebindConversation({ oldConversationId, newConversationId }) {
        const changed = move("progress", oldConversationId, newConversationId);
        return { rebind: { changedRuns: changed ? 1 : 0, changedInFlight: 0, activeChanged: false } };
      },
    },
    hostOverlayProjection: {
      async noteVerifiedRollover({ oldConversationId, newConversationId }) {
        if (overlayFails) return false;
        move("overlay", oldConversationId, newConversationId);
        return true;
      },
    },
  };
  const event = {
    oldConversationId: OLD,
    newConversationId: NEXT,
    goalId: "goal-1",
    planId: "plan-1",
    runtimeKey: "main-06",
    rollover: { observedAt: "2026-09-23T02:00:00.000Z" },
  };
  return { state, calls, deps, event };
}

test("fresh verified rollover moves every authority exactly once", async () => {
  const h = harness();
  const result = await applyVerifiedAutoCompactRollover({ event: h.event, ...h.deps });
  assert.equal(result.ok, true);
  assert.deepEqual(h.state, { authority: NEXT, goal: NEXT, plan: NEXT, progress: NEXT, overlay: NEXT });
  assert.equal(result.recoveredAfterRestart, false);
});

test("restart after partial migration converges without rolling prior committed steps back", async () => {
  const h = harness({ authority: NEXT, goal: NEXT, plan: NEXT, progress: OLD, overlay: OLD });
  const result = await applyVerifiedAutoCompactRollover({ event: h.event, ...h.deps });
  assert.equal(result.recoveredAfterRestart, true);
  assert.equal(result.authorityAlreadyApplied, true);
  assert.deepEqual(h.state, { authority: NEXT, goal: NEXT, plan: NEXT, progress: NEXT, overlay: NEXT });
  assert.equal(h.calls.includes(`goal:${NEXT}->${OLD}`), false);
});

test("fully applied transaction replay is idempotent", async () => {
  const h = harness({ authority: NEXT, goal: NEXT, plan: NEXT, progress: NEXT, overlay: NEXT });
  const before = structuredClone(h.state);
  const result = await applyVerifiedAutoCompactRollover({ event: h.event, ...h.deps });
  assert.equal(result.ok, true);
  assert.deepEqual(h.state, before);
  assert.equal(result.progressMoved, false);
});

test("late overlay rejection rolls back only changes made by this invocation", async () => {
  const h = harness({ authority: NEXT, goal: NEXT, plan: NEXT, progress: OLD, overlay: OLD, overlayFails: true });
  await assert.rejects(
    () => applyVerifiedAutoCompactRollover({ event: h.event, ...h.deps }),
    /Host Overlay owner/,
  );
  assert.equal(h.state.authority, NEXT, "preexisting authority move must not be rolled back");
  assert.equal(h.state.goal, NEXT);
  assert.equal(h.state.plan, NEXT);
  assert.equal(h.state.progress, OLD, "progress changed by this invocation is compensated");
});

test("unexpected third owner fails before any migration", async () => {
  const h = harness({ goal: "conversation-third" });
  await assert.rejects(
    () => applyVerifiedAutoCompactRollover({ event: h.event, ...h.deps }),
    /source or target/,
  );
  assert.equal(h.calls.length, 0);
});

console.log(JSON.stringify({
  ok: true,
  gate: "auto-compact-authority-transaction",
  freshMigration: true,
  partialRestartConverges: true,
  fullReplayIdempotent: true,
  rollbackOnlyCurrentInvocation: true,
  unexpectedOwnerFailsClosed: true,
}));
