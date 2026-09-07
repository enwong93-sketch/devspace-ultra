import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator, buildMainCompactCapsule } from "./context-guardian-rollover.js";

const goal = {
  id: "goal_1111111111111111",
  objective: "Ship selective UI-continuous Auto Compact",
  status: "active",
  round: 3,
  roundState: "working",
  revision: 8,
  successCriteria: [
    { id: "criterion_1111111111111111", text: "Preserve Goal state" },
    { id: "criterion_2222222222222222", text: "Preserve Plan frontier" },
  ],
  recentReports: [{ round: 2, summary: "Dynamic model windows are complete.", meaningfulProgress: true }],
};
const plan = {
  id: "plan_1111111111111111",
  title: "Context Guardian v2",
  status: "active",
  revision: 4,
  lastExplanation: "Backend ID may change, but full history and zero-context continuation are both forbidden.",
  steps: [
    { id: "step_1111111111111111", text: "Dynamic model windows", status: "completed" },
    { id: "step_2222222222222222", text: "Selective Auto Compact continuation", status: "in_progress" },
  ],
};
const pressure = {
  stage: "rollover",
  usageSource: "classic-native-actual-usage",
  usedTokens: 220000,
  predictedInputTokens: 222000,
  contextWindowTokens: 262144,
  rolloverLimitTokens: 214959,
  shouldPrepareCheckpoint: true,
  shouldRolloverBeforeNextRequest: true,
};
const recentMessages = [
  { role: "user", text: "Keep the Goal and Plan state intact." },
  { role: "assistant", text: "Continue in the same user-facing conversation." },
];
const sourceDescriptor = {
  conversationId: "conversation-old",
  currentNode: "source-boundary-message",
  title: "Context Guardian v2",
  modelSlug: "gpt-5-6-thinking",
  payloadBytes: 2_000_000,
  branchMessageCount: 3_400,
  textChars: 800_000,
};

{
  const capsule = buildMainCompactCapsule({
    runtimeKey: "main-01",
    goal,
    plan,
    context: { currentModelSlug: "gpt-5-6-thinking", contextWindowTokens: 262144, pressure },
    recentMessages,
  });
  assert.equal(capsule.goal, goal.objective);
  assert.ok(capsule.constraints.some((item) => /Preserve Goal state/.test(item)));
  assert.ok(capsule.completed.some((item) => /Dynamic model windows/.test(item)));
  assert.match(capsule.currentState, /goal_1111111111111111/);
  assert.match(capsule.currentState, /plan_1111111111111111/);
  assert.ok(capsule.nextSteps.some((item) => /Selective Auto Compact continuation/.test(item)));
}

function makeHarness({ stage = "rollover", workingGoal = goal, snapshot = {}, runtimes = null, armResult = null } = {}) {
  const calls = {
    checkpoints: [],
    userArms: [],
    hiddenArms: [],
    verified: [],
    statuses: [],
    snapshots: [],
    capsuleMeta: [],
  };
  const contextGuardian = {
    async observeRuntimeSnapshot() {},
    async status(runtimeKey, options = {}) {
      calls.statuses.push({ runtimeKey, options });
      return {
        runtimeKey,
        mode: "chat",
        conversationId: "conversation-old",
        currentModelSlug: "gpt-5-6-thinking",
        contextWindowTokens: 262144,
        supportedChatMode: true,
        pressure: {
          ...pressure,
          stage,
          shouldPrepareCheckpoint: stage === "prepare" || stage === "rollover",
          shouldRolloverBeforeNextRequest: stage === "rollover",
        },
      };
    },
  };
  const runtimeRows = runtimes || [{ runtimeKey: "main-01", port: 9721 }];
  const contextAdapter = {
    status() { return { connected: runtimeRows.length, runtimes: runtimeRows }; },
    async refreshSnapshot(runtimeKey) {
      const value = {
        runtimeKey,
        ok: true,
        mode: "chat",
        conversationId: "conversation-old",
        modelSlug: "gpt-5-6-thinking",
        generating: false,
        composerTextChars: 0,
        ...snapshot,
      };
      calls.snapshots.push(value);
      return value;
    },
    async recentVisibleMessages() { return recentMessages; },
    async nativeConversationDescriptor() { return { ...sourceDescriptor }; },
    async captureNativeSnapshot() { throw new Error("forbidden legacy reload"); },
    async armUserTurnRollover(_runtimeKey, input) {
      calls.userArms.push(input);
      return armResult || { armed: true, mode: "user-turn" };
    },
    async startHiddenRollover(_runtimeKey, input) {
      calls.hiddenArms.push(input);
      return armResult || { armed: true, mode: "hidden-goal-continuation" };
    },
    async cancelUserTurnRollover() { return { cancelled: false }; },
  };
  const continuityRuntime = {
    async checkpoint(input) {
      calls.checkpoints.push(input);
      return {
        ok: true,
        capsuleId: `capsule_${calls.checkpoints.length}`,
        continuityKey: input.continuityKey,
        capsule: input,
      };
    },
    async updateCapsuleMeta(id, patch) { calls.capsuleMeta.push({ id, patch }); },
  };
  const goalRuntime = {
    async status(id) { assert.equal(id, goal.id); return workingGoal; },
    async activeGoals(options = {}) {
      assert.equal(options.conversationId === undefined || options.conversationId === "conversation-old", true);
      return workingGoal ? [workingGoal] : [];
    },
  };
  const planRuntime = {
    async activePlans(options = {}) {
      assert.equal(options.conversationId === undefined || options.conversationId === "conversation-old", true);
      return [plan];
    },
  };
  const coordinator = new ContextGuardianRolloverCoordinator({
    contextGuardian,
    contextAdapter,
    continuityRuntime,
    goalRuntime,
    planRuntime,
    onVerifiedRollover: async (event) => { calls.verified.push(event); },
    pollMs: 0,
  });
  return { coordinator, calls };
}

{
  const { coordinator, calls } = makeHarness({ stage: "normal" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "normal");
  assert.equal(calls.userArms.length, 0);
  assert.equal(calls.hiddenArms.length, 0);
}

{
  const { coordinator, calls } = makeHarness({ stage: "prepare" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "prepared-selective-capsule");
  assert.equal(calls.checkpoints.length, 1);
  const checkpoint = calls.checkpoints[0];
  assert.equal(checkpoint.compression.accepted, true);
  assert.equal(checkpoint.compression.fullHistoryInherited, false);
  assert.equal(checkpoint.compression.zeroContextContinuation, false);
  assert.equal(checkpoint.continuity.sourceConversationId, "conversation-old");
  assert.equal(checkpoint.continuity.sourceBoundaryMessageId, "source-boundary-message");
  assert.equal(checkpoint.continuity.uiContinuityKey, `goal:${goal.id}`);
  assert.equal(calls.userArms.length, 0);
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "armed-user-turn-auto-compact");
  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.userArms.length, 1);
  const arm = calls.userArms[0];
  assert.equal(arm.mode, "user-turn");
  assert.equal(arm.oldConversationId, "conversation-old");
  assert.equal(arm.sourceMessageId, "source-boundary-message");
  assert.equal(arm.uiContinuityKey, `goal:${goal.id}`);
  assert.match(arm.capsulePrompt, /selective capsule/i);
  assert.equal(arm.compressionContract.compression.fullHistoryInherited, false);

  const accepted = await coordinator.noteUserTurnRollover({
    ok: true,
    mode: "user-turn",
    runtimeKey: "main-01",
    goalId: goal.id,
    planId: plan.id,
    capsuleId: "capsule_1",
    oldConversationId: "conversation-old",
    newConversationId: "conversation-new",
    conversationId: "conversation-new",
    visibleUsers: 1,
    visibleAssistants: 1,
    hiddenMessages: 1,
    uiContinuityKey: arm.uiContinuityKey,
    compressionContract: arm.compressionContract,
    targetDescriptor: {
      conversationId: "conversation-new",
      payloadBytes: 18_000,
      branchMessageCount: 3,
      devspaceContinuity: {
        sourceConversationId: "conversation-old",
        sourceBoundaryMessageId: "source-boundary-message",
        uiContinuityKey: arm.uiContinuityKey,
        capsuleFingerprint: arm.capsuleFingerprint,
      },
    },
  });
  assert.equal(accepted, true);
  assert.equal(calls.verified.length, 1);
  assert.equal(calls.verified[0].oldConversationId, "conversation-old");
  assert.equal(calls.verified[0].newConversationId, "conversation-new");
  assert.equal(calls.capsuleMeta.at(-1).patch.status, "verified-continuation");
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover", snapshot: { generating: true } });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "skipped-generating");
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(calls.userArms.length, 0);
}

{
  const reportedGoal = { ...goal, roundState: "reported" };
  const { coordinator, calls } = makeHarness({ stage: "rollover", workingGoal: reportedGoal });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "prepared-reported-goal");
  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.userArms.length, 0);
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const result = await coordinator.beforeGoalContinuation({
    runtimeKey: "main-01",
    goalId: goal.id,
    continuationPrompt: "[DEVSPACE_GOAL_CONTINUATION] begin next Goal round",
  });
  assert.equal(result.handled, false, "Raw dispatch must proceed after the Fetch transform is armed.");
  assert.equal(result.armed, true);
  assert.equal(result.reason, "hidden-goal-auto-compact-armed");
  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.hiddenArms.length, 1);
  assert.equal(calls.hiddenArms[0].oldConversationId, "conversation-old");
  assert.equal(calls.hiddenArms[0].sourceMessageId, "source-boundary-message");
  assert.match(calls.hiddenArms[0].prompt, /DEVSPACE_AUTO_COMPACT_CONTINUATION/);
  assert.match(calls.hiddenArms[0].prompt, /DEVSPACE_GOAL_CONTINUATION/);
}

{
  const { coordinator } = makeHarness({ stage: "rollover", armResult: { armed: false, reason: "devspace-plugin-not-paired" } });
  const result = await coordinator.beforeGoalContinuation({
    runtimeKey: "main-01",
    goalId: goal.id,
    continuationPrompt: "next round",
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /auto-compact-arm-failed/);
}

{
  const { coordinator, calls } = makeHarness({ stage: "normal" });
  const result = await coordinator.beforeGoalContinuation({
    runtimeKey: "main-01",
    goalId: goal.id,
    continuationPrompt: "next round",
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "headroom-available");
  assert.equal(calls.hiddenArms.length, 0);
}

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover",
  checkpointOnlyAtPressure: true,
  selectiveContinuationCompaction: true,
  backendConversationIdMayChange: true,
  uiContinuityKeyRequired: true,
  fullHistoryInheritanceRejected: true,
  zeroContextRejected: true,
  userTurnArmedAtRollover: true,
  hiddenGoalContinuationArmedAtRollover: true,
  authorityRebindAfterVerificationOnly: true,
}));
