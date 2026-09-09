import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator } from "./context-guardian-rollover.js";

const goal = {
  id: "goal_overlay_rollover_1234",
  objective: "Continue the same user-facing Goal through selective Auto Compact.",
  status: "active",
  round: 3,
  roundState: "reported",
  revision: 10,
  successCriteria: [{ id: "criterion_a", text: "Preserve overlay owner and Goal state" }],
  recentReports: [{ round: 3, summary: "The current round is reported and the next continuation is authorized.", meaningfulProgress: true }],
};
const plan = {
  id: "plan_overlay_rollover_1234",
  title: "Overlay conversation authority",
  status: "active",
  revision: 4,
  steps: [
    { id: "step_done", text: "Build selective capsule", status: "completed" },
    { id: "step_a", text: "Verify backend-id-changing UI continuity", status: "in_progress" },
  ],
};

const notices = [];
const checkpoints = [];
const arms = [];
const capsuleUpdates = [];
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
      documentReadyState: "complete",
      composerReady: true,
      routeHydrated: true,
      routeStableForMs: 5_000,
    };
  },
  async recentVisibleMessages() {
    return [
      { role: "user", text: "Keep the Goal and Plan frontier while reducing old context." },
      { role: "assistant", text: "The continuation will carry a bounded hidden capsule only." },
    ];
  },
  async nativeConversationDescriptor() {
    return {
      conversationId: "conversation-old",
      currentNode: "source-boundary-message",
      title: "DevSpace Ultra selective Auto Compact",
      defaultModelSlug: "gpt-5-6-thinking",
      mappingCount: 240,
      branchMessageCount: 180,
      payloadBytes: 800000,
      textChars: 260000,
      authenticatedBackendFetch: true,
      rawContentReturned: false,
      credentialsReturned: false,
    };
  },
  async startHiddenRollover(runtimeKey, input) {
    arms.push({ runtimeKey, input });
    return { armed: true, mode: "hidden-goal-continuation", oldConversationId: input.oldConversationId };
  },
  async armUserTurnRollover() {
    throw new Error("ordinary user-turn arm is not expected in this reported-Goal test");
  },
};
const continuityRuntime = {
  enabled: true,
  async checkpoint(input) {
    checkpoints.push(input);
    return { ok: true, capsuleId: "capsule_overlay_owner", capsule: input };
  },
  async updateCapsuleMeta(id, patch) {
    capsuleUpdates.push({ id, patch });
  },
};
const goalRuntime = {
  async activeGoals({ conversationId } = {}) {
    return !conversationId || conversationId === "conversation-old" ? [goal] : [];
  },
  async status(goalId) { assert.equal(goalId, goal.id); return goal; },
};
const planRuntime = {
  async activePlans({ conversationId } = {}) {
    return !conversationId || conversationId === "conversation-old" ? [plan] : [];
  },
};

const coordinator = new ContextGuardianRolloverCoordinator({
  contextGuardian,
  contextAdapter,
  continuityRuntime,
  goalRuntime,
  planRuntime,
  pollMs: 0,
  onVerifiedRollover: async (event) => { notices.push(event); return true; },
});

const result = await coordinator.beforeGoalContinuation({
  runtimeKey: "main-02",
  goalId: goal.id,
  continuationPrompt: "[DEVSPACE_GOAL_CONTINUATION] continue the authorized Goal round",
});
assert.equal(result.handled, false, "the already-authorized raw Goal dispatch must still proceed through the armed rewrite");
assert.equal(result.armed, true);
assert.equal(result.reason, "hidden-goal-auto-compact-armed");
assert.equal(checkpoints.length, 1);
assert.equal(arms.length, 1);
assert.equal(notices.length, 0, "Host Overlay owner must not migrate before target verification");

const arm = arms[0].input;
assert.equal(arm.oldConversationId, "conversation-old");
assert.equal(arm.sourceMessageId, "source-boundary-message");
assert.equal(arm.compressionContract.compression.fullHistoryInherited, false);
assert.equal(arm.compressionContract.compression.zeroContextContinuation, false);
assert.ok(arm.compressionContract.compression.carryMessageCount < arm.compressionContract.compression.sourceBranchMessageCount);
assert.ok(arm.compressionContract.compression.ratios.payloadByteRatio < 0.25);
assert.match(arm.prompt, /DEVSPACE_COMPACT_CAPSULE_BEGIN/);
assert.match(arm.prompt, /DEVSPACE_GOAL_CONTINUATION/);

const accepted = await coordinator.noteUserTurnRollover({
  ok: true,
  mode: "hidden-goal-continuation",
  runtimeKey: "main-02",
  goalId: goal.id,
  planId: plan.id,
  capsuleId: "capsule_overlay_owner",
  oldConversationId: "conversation-old",
  newConversationId: "conversation-new",
  conversationId: "conversation-new",
  uiContinuityKey: arm.uiContinuityKey,
  compressionContract: arm.compressionContract,
  nativeContinuationSourceId: "conversation-old",
  hiddenMessages: 1,
  visibleUsers: 0,
  visibleAssistants: 1,
  targetDescriptor: {
    conversationId: "conversation-new",
    mappingCount: 4,
    branchMessageCount: 3,
    payloadBytes: 24000,
    devspaceContinuity: {
      uiContinuityKey: arm.uiContinuityKey,
      sourceConversationId: "conversation-old",
      capsuleFingerprint: arm.capsuleFingerprint,
    },
  },
});
assert.equal(accepted, true);
assert.equal(notices.length, 1, "verified continuation must transfer Host Overlay/Goal authority exactly once");
assert.equal(notices[0].oldConversationId, "conversation-old");
assert.equal(notices[0].newConversationId, "conversation-new");
assert.equal(notices[0].rollover.fullHistoryInherited, false);
assert.equal(notices[0].rollover.zeroContextContinuation, false);
assert.equal(capsuleUpdates.at(-1)?.patch?.status, "verified-continuation");

await coordinator.close();
console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-overlay",
  backendConversationIdChanged: true,
  selectiveCapsuleRequired: true,
  fullHistoryInherited: false,
  zeroContextContinuation: false,
  ownerTransferAfterVerificationOnly: true,
  userFacingContinuityPreserved: true,
}));
