import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator, buildMainCompactCapsule } from "./context-guardian-rollover.js";

const goal = {
  id: "goal_1111111111111111",
  objective: "Ship true same-conversation Context Guardian",
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
  lastExplanation: "Fresh-chat rollover is forbidden; true compact is next.",
  steps: [
    { id: "step_1111111111111111", text: "Dynamic model windows", status: "completed" },
    { id: "step_2222222222222222", text: "True same-conversation compact", status: "in_progress" },
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
  { role: "assistant", text: "Continue in the same conversation." },
];

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
  assert.ok(capsule.nextSteps.some((item) => /True same-conversation compact/.test(item)));
}

function makeHarness({ stage = "rollover", workingGoal = goal, snapshot = {}, runtimes = null } = {}) {
  const calls = { checkpoints: [], forbiddenFreshChatCalls: [], statuses: [], snapshots: [] };
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
    async captureNativeSnapshot() { calls.forbiddenFreshChatCalls.push("captureNativeSnapshot"); throw new Error("forbidden"); },
    async armUserTurnRollover() { calls.forbiddenFreshChatCalls.push("armUserTurnRollover"); throw new Error("forbidden"); },
    async startHiddenRollover() { calls.forbiddenFreshChatCalls.push("startHiddenRollover"); throw new Error("forbidden"); },
    async cancelUserTurnRollover() { return { cancelled: false }; },
  };
  const continuityRuntime = {
    async checkpoint(input) {
      calls.checkpoints.push(input);
      return { ok: true, capsuleId: `capsule_${calls.checkpoints.length}`, continuityKey: input.continuityKey, capsule: input };
    },
  };
  const goalRuntime = {
    async status(id) { assert.equal(id, goal.id); return workingGoal; },
    async activeGoals() { return workingGoal ? [workingGoal] : []; },
  };
  const planRuntime = { async activePlans() { return [plan]; } };
  const coordinator = new ContextGuardianRolloverCoordinator({
    contextGuardian,
    contextAdapter,
    continuityRuntime,
    goalRuntime,
    planRuntime,
    pollMs: 0,
  });
  return { coordinator, calls };
}

{
  const { coordinator, calls } = makeHarness({ stage: "normal" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "normal");
  assert.deepEqual(calls.forbiddenFreshChatCalls, [], "normal observation must never call legacy native snapshot reload/fresh-chat helpers");
}

{
  const { coordinator, calls } = makeHarness({ stage: "prepare" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "prepared");
  assert.equal(calls.checkpoints.length, 1);
  assert.deepEqual(calls.forbiddenFreshChatCalls, []);
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "true-compact-required");
  assert.equal(result.results[0].reason, "legacy-fresh-conversation-rollover-disabled");
  assert.equal(calls.checkpoints.length, 1, "pressure may checkpoint state without mutating the ChatGPT page or conversation");
  assert.deepEqual(calls.forbiddenFreshChatCalls, [], "rollover pressure must not call fresh-conversation paths");
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover", snapshot: { generating: true } });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "skipped-generating");
  assert.equal(calls.checkpoints.length, 0);
  assert.deepEqual(calls.forbiddenFreshChatCalls, []);
}

{
  const reportedGoal = { ...goal, roundState: "reported" };
  const { coordinator, calls } = makeHarness({ stage: "rollover", workingGoal: reportedGoal });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "prepared-reported-goal");
  assert.equal(calls.checkpoints.length, 1);
  assert.deepEqual(calls.forbiddenFreshChatCalls, []);
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const result = await coordinator.beforeGoalContinuation({
    runtimeKey: "main-01",
    goalId: goal.id,
    continuationPrompt: "[DEVSPACE_GOAL_CONTINUATION] begin next Goal round",
  });
  assert.equal(result.handled, false, "Goal continuation must never be rerouted to a fresh Chat as fake compaction");
  assert.equal(result.reason, "true-same-conversation-compact-required");
  assert.equal(calls.checkpoints.length, 1);
  assert.deepEqual(calls.forbiddenFreshChatCalls, []);
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
  assert.deepEqual(calls.forbiddenFreshChatCalls, []);
}

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover",
  checkpointOnlyAtPressure: true,
  freshConversationCompaction: false,
  pageMutationCapability: false,
  goalContinuationFreshChatReroute: false,
}));
