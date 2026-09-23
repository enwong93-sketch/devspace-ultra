import assert from "node:assert/strict";
import * as overlayModule from "./classic-host-overlay.js";
import { ClassicHostOverlayProjection } from "./classic-host-overlay.js";

assert.equal(typeof overlayModule.resolveClassicHostOverlayOwner, "function", "Host Overlay must expose a conservative initial-owner resolver");

const goal = {
  id: "goal_owner_test_1234",
  objective: "Keep the overlay attached only to the verified owner conversation.",
  status: "active",
  round: 3,
  roundState: "working",
  revision: 12,
};
const plan = {
  id: "plan_owner_test_1234",
  title: "Owner rollover test",
  status: "active",
  revision: 7,
  steps: [
    { id: "step_a", text: "Implement", status: "in_progress" },
    { id: "step_b", text: "Accept", status: "pending" },
  ],
};

const owners = [];
let resolveCalls = 0;
const manager = new ClassicHostOverlayProjection({
  goalRuntime: {
    async projectableGoals() { return [goal]; },
  },
  planRuntime: {
    async activePlans() { return [plan]; },
  },
  adapter: {
    async syncAll(_projection, { owner = null } = {}) {
      owners.push(owner ? { ...owner } : null);
      return { connected: 2, synced: 2, results: [] };
    },
  },
  resolveOwner: async () => {
    resolveCalls += 1;
    return { goalId: goal.id, runtimeKey: "main-02", conversationId: "conversation-old" };
  },
  pollMs: 0,
});

await manager.start({ schedule: false });
assert.deepEqual(owners.at(-1), {
  goalId: goal.id,
  runtimeKey: "main-02",
  conversationId: "conversation-old",
});
assert.equal(resolveCalls, 1);
assert.equal(typeof manager.noteVerifiedRollover, "function", "Host Overlay must expose a verified-rollover owner transfer hook");

const wrongRuntime = await manager.noteVerifiedRollover({
  goalId: goal.id,
  runtimeKey: "main-03",
  oldConversationId: "conversation-old",
  newConversationId: "conversation-new",
});
assert.equal(wrongRuntime, false, "another Main must never steal the overlay owner");

const wrongOldConversation = await manager.noteVerifiedRollover({
  goalId: goal.id,
  runtimeKey: "main-02",
  oldConversationId: "conversation-not-owner",
  newConversationId: "conversation-new",
});
assert.equal(wrongOldConversation, false, "a stale/unverified rollover must not move the owner");

const transferred = await manager.noteVerifiedRollover({
  goalId: goal.id,
  runtimeKey: "main-02",
  oldConversationId: "conversation-old",
  newConversationId: "conversation-new",
});
assert.equal(transferred, true, "a verified same-runtime rollover must transfer ownership to the fresh conversation");
const replayedTransfer = await manager.noteVerifiedRollover({
  goalId: goal.id,
  runtimeKey: "main-02",
  oldConversationId: "conversation-old",
  newConversationId: "conversation-new",
});
assert.equal(replayedTransfer, true, "process-restart reconciliation must accept an already-moved exact owner idempotently");

await manager.syncOnce();
assert.deepEqual(owners.at(-1), {
  goalId: goal.id,
  runtimeKey: "main-02",
  conversationId: "conversation-new",
});
assert.equal(resolveCalls, 1, "verified rollover transfer must not rediscover/rebind ownership through ordinary polling");

await manager.close();

{
  const refreshes = [];
  const resolved = await overlayModule.resolveClassicHostOverlayOwner({
    goal,
    goalHostBridge: { async findMatchingCandidate() { return null; } },
    contextAdapter: {
      status() {
        return {
          runtimes: [
            { runtimeKey: "main-01", port: 9721 },
            { runtimeKey: "main-02", port: 9732 },
            { runtimeKey: "main-03", port: 9733 },
          ],
        };
      },
      async refreshSnapshot(runtimeKey) {
        refreshes.push(runtimeKey);
        if (runtimeKey !== "main-03") return { ok: false, runtimeKey, mode: "chat", conversationId: null };
        return {
          ok: true,
          runtimeKey,
          mode: "chat",
          conversationId: "conversation-hidden-fresh",
          generating: true,
          composerTextChars: 0,
          visibleMessageCount: 0,
        };
      },
    },
  });
  assert.deepEqual(resolved, {
    goalId: goal.id,
    runtimeKey: "main-03",
    conversationId: "conversation-hidden-fresh",
  }, "a unique hidden-style active Chat may bootstrap owner state after an upgrade/reload with no persisted pointer");
  assert.deepEqual(refreshes, ["main-01", "main-02", "main-03"]);

  const ambiguous = await overlayModule.resolveClassicHostOverlayOwner({
    goal,
    goalHostBridge: { async findMatchingCandidate() { return null; } },
    contextAdapter: {
      status() { return { runtimes: [{ runtimeKey: "main-02", port: 9732 }, { runtimeKey: "main-03", port: 9733 }] }; },
      async refreshSnapshot(runtimeKey) {
        return {
          ok: true,
          runtimeKey,
          mode: "chat",
          conversationId: `conversation-${runtimeKey}`,
          generating: true,
          composerTextChars: 0,
          visibleMessageCount: 0,
        };
      },
    },
  });
  assert.equal(ambiguous, null, "multiple hidden-style active Chats must fail closed instead of guessing an owner");

  let candidateOptions = null;
  const boundWrongConversation = await overlayModule.resolveClassicHostOverlayOwner({
    goal: { ...goal, conversationId: "conversation-authoritative" },
    goalHostBridge: {
      async findMatchingCandidate(_goalId, options) {
        candidateOptions = options;
        return {
          runtimePort: 9732,
          conversationId: "conversation-wrong",
        };
      },
    },
    contextAdapter: {
      status() { return { runtimes: [{ runtimeKey: "main-02", port: 9732 }] }; },
      async refreshSnapshot(runtimeKey) {
        return {
          ok: true,
          runtimeKey,
          mode: "chat",
          conversationId: "conversation-wrong",
          generating: true,
          composerTextChars: 0,
          visibleMessageCount: 0,
        };
      },
    },
  });
  assert.deepEqual(candidateOptions, { conversationId: "conversation-authoritative" });
  assert.equal(boundWrongConversation, null, "a bound Goal must never project its overlay into a different conversation even when a stale widget survives there");
}

console.log(JSON.stringify({
  ok: true,
  gate: "classic-host-overlay-owner",
  exactRuntimeConversationOwnership: true,
  verifiedRolloverOnlyTransfer: true,
}));
