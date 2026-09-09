import assert from "node:assert/strict";
import { ContextGuardianRolloverCoordinator } from "./context-guardian-rollover.js";

function stableSnapshot(overrides = {}) {
  return {
    ok: true,
    runtimeKey: "main-02",
    mode: "chat",
    conversationId: "conversation-source",
    modelSlug: "gpt-5-6-thinking",
    generating: false,
    composerTextChars: 0,
    devspacePluginPaired: true,
    documentReadyState: "complete",
    composerReady: true,
    routeHydrated: true,
    routeStableForMs: 10_000,
    documentId: "document-source",
    routeEpoch: 1,
    ...overrides,
  };
}

function makeHarness({
  enabled = true,
  stage = "normal",
  snapshot = stableSnapshot(),
  descriptorError = null,
  armResult = { armed: true, mode: "user-turn" },
  onVerifiedRollover = async () => true,
} = {}) {
  const calls = {
    status: 0,
    observations: [],
    descriptors: [],
    checkpoints: [],
    arms: [],
    cancels: [],
    capsuleMeta: [],
    verified: [],
  };
  const pressure = () => ({
    stage,
    usageSource: "devspace-ledger",
    usedTokens: stage === "normal" ? 1_000 : 220_000,
    predictedInputTokens: stage === "normal" ? 1_000 : 220_000,
    rolloverLimitTokens: 214_959,
    shouldPrepareCheckpoint: stage !== "normal",
    shouldRolloverBeforeNextRequest: stage === "rollover",
  });
  const contextGuardian = {
    async observeRuntimeSnapshot(value) { calls.observations.push(value); },
    async status(runtimeKey) {
      calls.status += 1;
      return {
        runtimeKey,
        mode: "chat",
        conversationId: "conversation-source",
        currentModelSlug: "gpt-5-6-thinking",
        contextWindowTokens: 262_144,
        supportedChatMode: true,
        pressure: pressure(),
      };
    },
  };
  const sourceDescriptor = {
    conversationId: "conversation-source",
    currentNode: "source-boundary",
    title: "Source",
    modelSlug: "gpt-5-6-thinking",
    payloadBytes: 900_000,
    mappingCount: 240,
    branchMessageCount: 180,
    textChars: 260_000,
    estimatedTokens: 220_000,
    recentVisibleMessages: [
      { role: "user", text: "Continue safely." },
      { role: "assistant", text: "Preparing a bounded continuation." },
    ],
  };
  const contextAdapter = {
    status() { return { connected: 1, runtimes: [{ runtimeKey: "main-02", port: 9732 }] }; },
    async refreshSnapshot() { return structuredClone(snapshot); },
    async recentVisibleMessages() { return sourceDescriptor.recentVisibleMessages; },
    async nativeConversationDescriptor(runtimeKey, options = {}) {
      calls.descriptors.push({ runtimeKey, options });
      if (descriptorError) throw descriptorError;
      return structuredClone(sourceDescriptor);
    },
    async armUserTurnRollover(runtimeKey, input) {
      calls.arms.push({ runtimeKey, input });
      return { ...armResult, oldConversationId: input.oldConversationId };
    },
    async startHiddenRollover(runtimeKey, input) {
      calls.arms.push({ runtimeKey, input, hidden: true });
      return { ...armResult, mode: "hidden-goal-continuation", oldConversationId: input.oldConversationId };
    },
    async cancelUserTurnRollover(runtimeKey) {
      calls.cancels.push(runtimeKey);
      return { cancelled: true };
    },
  };
  const goal = {
    id: "goal-safety",
    conversationId: "conversation-source",
    objective: "Preserve the source chat while compacting safely.",
    status: "active",
    round: 2,
    roundState: "working",
    revision: 4,
    successCriteria: [{ id: "criterion-a", text: "Source remains usable" }],
    recentReports: [],
  };
  const plan = {
    id: "plan-safety",
    conversationId: "conversation-source",
    title: "Safe compact",
    status: "active",
    revision: 3,
    steps: [
      { id: "step-a", text: "Prepare", status: "completed" },
      { id: "step-b", text: "Commit safely", status: "in_progress" },
    ],
  };
  const continuityRuntime = {
    async checkpoint(input) {
      calls.checkpoints.push(input);
      return { ok: true, capsuleId: `capsule-${calls.checkpoints.length}`, capsule: input };
    },
    async updateCapsuleMeta(id, patch) { calls.capsuleMeta.push({ id, patch }); },
  };
  const goalRuntime = {
    async activeGoals() { return [goal]; },
    async status() { return goal; },
  };
  const planRuntime = {
    async activePlans() { return [plan]; },
  };
  const coordinator = new ContextGuardianRolloverCoordinator({
    enabled,
    contextGuardian,
    contextAdapter,
    continuityRuntime,
    goalRuntime,
    planRuntime,
    onVerifiedRollover: async (event) => {
      calls.verified.push(event);
      return await onVerifiedRollover(event);
    },
    pollMs: 0,
  });
  return { coordinator, calls, goal, plan, sourceDescriptor };
}

{
  const { coordinator, calls } = makeHarness({ enabled: false, stage: "rollover" });
  const result = await coordinator.pollOnce();
  assert.equal(result.disabled, true);
  assert.equal(calls.status, 0);
  assert.equal(calls.descriptors.length, 0);
  assert.equal(calls.arms.length, 0);
  await coordinator.close();
}

{
  const { coordinator, calls } = makeHarness({
    stage: "normal",
    snapshot: stableSnapshot({ routeHydrated: false, routeStableForMs: 0 }),
  });
  const result = await coordinator.pollOnce();
  assert.equal(result.results[0].action, "normal");
  assert.equal(calls.descriptors.length, 0, "re-entry hydration must not trigger a descriptor request");
  await coordinator.close();
}

{
  const notFound = new Error("conversation descriptor unavailable");
  notFound.code = "NATIVE_DESCRIPTOR_NOT_FOUND";
  notFound.status = 404;
  const { coordinator, calls } = makeHarness({ stage: "normal", descriptorError: notFound });
  const first = await coordinator.pollOnce();
  assert.equal(first.results[0].action, "error");
  assert.equal(calls.descriptors.length, 1);
  const second = await coordinator.pollOnce();
  assert.equal(second.results[0].action, "error");
  assert.equal(calls.descriptors.length, 1, "descriptor failure circuit must suppress repeated backend requests");
  assert.match(second.results[0].error, /circuit is open/i);
  await coordinator.close();
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const prepared = await coordinator.pollOnce();
  assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
  assert.equal(calls.descriptors.length, 1, "rollover checkpoint must reuse the fresh structural descriptor instead of fetching twice");
  assert.equal(calls.arms.length, 1);
  const arm = calls.arms[0].input;
  const failed = await coordinator.noteUserTurnRollover({
    ok: false,
    runtimeKey: "main-02",
    oldConversationId: "conversation-source",
    goalId: "goal-safety",
    planId: "plan-safety",
    capsuleId: "capsule-1",
    sourceConversationPreserved: true,
    error: "source page changed after prepare",
  });
  assert.equal(failed, false);
  assert.equal(calls.capsuleMeta.at(-1).patch.status, "source-preserved-abort");
  const blocked = await coordinator.pollOnce();
  assert.equal(blocked.results[0].action, "compact-circuit-open");
  assert.equal(calls.arms.length, 1, "a failed commit must not immediately re-arm the same source conversation");
  assert.equal(calls.cancels.length, 1);
  assert.equal(blocked.results[0].conversationId, arm.oldConversationId);
  await coordinator.close();
}

{
  const { coordinator, calls } = makeHarness({ stage: "rollover" });
  const prepared = await coordinator.pollOnce();
  assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
  const arm = calls.arms[0].input;
  const accepted = await coordinator.noteUserTurnRollover({
    ok: true,
    mode: "user-turn",
    runtimeKey: "main-02",
    goalId: "goal-safety",
    planId: "plan-safety",
    capsuleId: "capsule-1",
    oldConversationId: "conversation-source",
    newConversationId: "conversation-invalid-target",
    conversationId: "conversation-invalid-target",
    visibleUsers: 0,
    visibleAssistants: 0,
    hiddenMessages: 0,
    uiContinuityKey: arm.uiContinuityKey,
    compressionContract: arm.compressionContract,
    targetDescriptor: {
      conversationId: "conversation-invalid-target",
      mappingCount: 180,
      branchMessageCount: 180,
      payloadBytes: 900_000,
      devspaceContinuity: {},
    },
  });
  assert.equal(accepted, false);
  assert.equal(calls.verified.length, 0);
  assert.equal(calls.capsuleMeta.at(-1).patch.status, "verification-failed");
  assert.equal(calls.capsuleMeta.at(-1).patch.sourceConversationPreserved, true);
  const blocked = await coordinator.pollOnce();
  assert.equal(blocked.results[0].action, "compact-circuit-open");
  await coordinator.close();
}

{
  const { coordinator, calls } = makeHarness({
    stage: "rollover",
    onVerifiedRollover: async () => false,
  });
  await coordinator.pollOnce();
  const arm = calls.arms[0].input;
  const accepted = await coordinator.noteUserTurnRollover({
    ok: true,
    mode: "user-turn",
    runtimeKey: "main-02",
    goalId: "goal-safety",
    planId: "plan-safety",
    capsuleId: "capsule-1",
    oldConversationId: "conversation-source",
    newConversationId: "conversation-valid-target",
    conversationId: "conversation-valid-target",
    visibleUsers: 1,
    visibleAssistants: 1,
    hiddenMessages: 1,
    uiContinuityKey: arm.uiContinuityKey,
    nativeContinuationSourceId: "conversation-source",
    compressionContract: arm.compressionContract,
    targetDescriptor: {
      conversationId: "conversation-valid-target",
      mappingCount: 4,
      branchMessageCount: 3,
      payloadBytes: 20_000,
      devspaceContinuity: {
        sourceConversationId: "conversation-source",
        uiContinuityKey: arm.uiContinuityKey,
        capsuleFingerprint: arm.capsuleFingerprint,
      },
    },
  });
  assert.equal(accepted, false);
  assert.equal(calls.capsuleMeta.at(-1).patch.status, "authority-rebind-failed");
  const blocked = await coordinator.pollOnce();
  assert.equal(blocked.results[0].action, "compact-circuit-open");
  await coordinator.close();
}

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-safety",
  disabledMeansNoDescriptorTraffic: true,
  reentryHydrationNoDescriptorTraffic: true,
  descriptorFailureCircuit: true,
  sourcePreservingAbortCircuit: true,
  verificationFailureCircuit: true,
  authorityRebindFailureCircuit: true,
  singleDescriptorPerCommitPreparation: true,
}));
