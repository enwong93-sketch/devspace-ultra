import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator } from "./context-guardian-rollover.js";

const goal = {
  id: "goal_overlay_rollover_1234",
  objective: "Keep Host Overlay on the same conversation while true compact is unresolved.",
  status: "active",
  round: 3,
  roundState: "working",
  revision: 10,
  successCriteria: [{ id: "criterion_a", text: "Preserve overlay owner" }],
  recentReports: [],
};
const plan = {
  id: "plan_overlay_rollover_1234",
  title: "Overlay conversation authority",
  status: "active",
  revision: 4,
  steps: [{ id: "step_a", text: "True same-conversation compact", status: "in_progress" }],
};

const notices = [];
const checkpoints = [];
const forbiddenFreshChatCalls = [];
const contextGuardian = {
  async observeRuntimeSnapshot() {},
  async status(runtimeKey) {
    return {
      runtimeKey,
      mode: "chat",
      conversationId: "conversation-old",
      currentModelSlug: "gpt-5-6-thinking",
      contextWindowTokens: 262144,
      supportedChatMode: true,
      pressure: {
        stage: "rollover",
        usageSource: "classic-native-actual-usage",
        usedTokens: 220000,
        predictedInputTokens: 220000,
        rolloverLimitTokens: 214959,
      },
    };
  },
};
const contextAdapter = {
  status() { return { connected: 1, runtimes: [{ runtimeKey: "main-02", port: 9732 }] }; },
  async refreshSnapshot(runtimeKey) {
    return {
      ok: true,
      runtimeKey,
      mode: "chat",
      conversationId: "conversation-old",
      modelSlug: "gpt-5-6-thinking",
      generating: false,
      composerTextChars: 0,
    };
  },
  async recentVisibleMessages() { return []; },
  async startHiddenRollover() { forbiddenFreshChatCalls.push("startHiddenRollover"); throw new Error("forbidden"); },
  async armUserTurnRollover() { forbiddenFreshChatCalls.push("armUserTurnRollover"); throw new Error("forbidden"); },
};
const continuityRuntime = {
  async checkpoint(input) {
    checkpoints.push(input);
    return { ok: true, capsuleId: "capsule_overlay_owner", capsule: input };
  },
};
const goalRuntime = {
  async activeGoals() { return [goal]; },
  async status(goalId) { assert.equal(goalId, goal.id); return goal; },
};
const planRuntime = { async activePlans() { return [plan]; } };

const coordinator = new ContextGuardianRolloverCoordinator({
  contextGuardian,
  contextAdapter,
  continuityRuntime,
  goalRuntime,
  planRuntime,
  pollMs: 0,
  onVerifiedRollover: async (event) => { notices.push(event); },
});

const result = await coordinator.beforeGoalContinuation({
  runtimeKey: "main-02",
  goalId: goal.id,
  continuationPrompt: "[DEVSPACE_GOAL_CONTINUATION] continue the authorized Goal round",
});
assert.equal(result.handled, false);
assert.equal(result.reason, "true-same-conversation-compact-required");
assert.equal(checkpoints.length, 1, "pressure may checkpoint without moving the conversation");
assert.deepEqual(forbiddenFreshChatCalls, [], "Context Guardian must not invoke any fresh-conversation transport");
assert.equal(notices.length, 0, "Host Overlay owner must not migrate as a side effect of fake fresh-conversation compaction");

await coordinator.close();
console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-overlay",
  legacyRolloverOwnerTransferDisabled: true,
  conversationMustRemainStable: true,
}));
