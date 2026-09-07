import assert from "node:assert/strict";
import {
  attachAutoCompactContract,
  createAutoCompactContract,
  estimateAutoCompactTokens,
  validateAutoCompactContinuation,
  validateSelectiveCompactCapsule,
} from "./auto-compact-contract.js";

const capsule = {
  goal: "Finish DevSpace Ultra v0.5 without repeating completed work.",
  userIntent: "Continue the same user-facing conversation after context compression.",
  constraints: [
    "Preserve the Goal objective and success criteria.",
    "Preserve the active Plan frontier.",
    "Do not carry raw transcript or raw tool output history.",
  ],
  decisions: ["Backend conversation id may change while the UI continuity key remains stable."],
  completed: ["Gateway fallback and progress narration were fixed."],
  currentState: "Goal goal_abc is active; Plan plan_abc has step_auto_compact in progress.",
  files: [{ path: "dist/context-guardian-rollover.js", status: "modified" }],
  tests: ["progress narration live controls passed"],
  blockers: [],
  nextSteps: ["Create a selective continuation and verify the target is materially smaller."],
  toolState: ["goalId=goal_abc", "planId=plan_abc", "runtime=main-02"],
  memoryRefs: ["PowerMem:devspace-v0.5"],
  notes: "Recent context is summarized, not copied verbatim.",
};
const source = {
  conversationId: "source-conversation",
  currentNode: "source-boundary-message",
  title: "DevSpace Ultra v0.5",
  modelSlug: "gpt-5-6-pro",
  payloadBytes: 2_000_000,
  mappingCount: 3_413,
  branchMessageCount: 3_400,
  textChars: 800_000,
  exactUsedTokens: 320_000,
};

assert.ok(estimateAutoCompactTokens("你好 world") >= 3);
const validated = validateSelectiveCompactCapsule(capsule);
assert.equal(validated.ok, true);
assert.equal(validated.forbiddenStructuralState, false);
assert.ok(validated.carryEstimatedTokens > 0);

const contract = createAutoCompactContract({
  capsule,
  source,
  uiContinuityKey: "goal:goal_abc",
  runtimeKey: "main-02",
  goalId: "goal_abc",
  planId: "plan_abc",
  now: () => new Date("2026-09-07T10:00:00.000Z"),
});
assert.equal(contract.accepted, true);
assert.equal(contract.fullHistoryInherited, false);
assert.equal(contract.zeroContextContinuation, false);
assert.equal(contract.source.conversationId, "source-conversation");
assert.ok(contract.ratios.payloadByteRatio < 0.25);
assert.ok(contract.ratios.mappingRatio < 0.25);
assert.ok(contract.ratios.branchMessageRatio < 0.25);
assert.ok(contract.preservedCategories.includes("goal-plan-frontier"));
assert.ok(contract.excludedCategories.includes("full-conversation-mapping"));

const attached = attachAutoCompactContract(capsule, {
  source,
  uiContinuityKey: "goal:goal_abc",
  runtimeKey: "main-02",
  goalId: "goal_abc",
  planId: "plan_abc",
});
assert.equal(attached.continuity.sourceConversationId, "source-conversation");
assert.equal(attached.continuity.sourceBoundaryMessageId, "source-boundary-message");
assert.equal(attached.compression.accepted, true);
assert.equal(attached.compression.fullHistoryInherited, false);
assert.equal(attached.compression.zeroContextContinuation, false);

const continuation = validateAutoCompactContinuation({
  contract,
  sourceConversationId: "source-conversation",
  targetConversationId: "target-conversation",
  targetMappingCount: 4,
  targetBranchMessageCount: 3,
  targetPayloadBytes: 18_000,
  hiddenMessages: 1,
  visibleUsers: 1,
  visibleAssistants: 1,
  uiContinuityVerified: true,
  nativeContinuationSourceId: "source-conversation",
});
assert.equal(continuation.ok, true);
assert.equal(continuation.backendIdChanged, true);
assert.equal(continuation.fullHistoryInherited, false);
assert.equal(continuation.zeroContextContinuation, false);

assert.throws(() => validateSelectiveCompactCapsule({ ...capsule, mapping: { a: {} } }), /must not embed full\/raw conversation state/);
assert.throws(() => validateSelectiveCompactCapsule({ goal: "x" }), /missing essential continuity state/);
assert.throws(() => createAutoCompactContract({
  capsule,
  source: { ...source, payloadBytes: 1_000, mappingCount: 2, branchMessageCount: 2, exactUsedTokens: 500 },
  uiContinuityKey: "goal:goal_abc",
}), /not sufficiently compressed|reduce the source branch/);
assert.throws(() => validateAutoCompactContinuation({
  contract,
  sourceConversationId: "same",
  targetConversationId: "same",
  hiddenMessages: 1,
  visibleAssistants: 1,
  uiContinuityVerified: true,
}), /distinct backend conversation id/);
assert.throws(() => validateAutoCompactContinuation({
  contract,
  sourceConversationId: "source-conversation",
  targetConversationId: "target-conversation",
  hiddenMessages: 0,
  visibleAssistants: 1,
  uiContinuityVerified: true,
}), /missing the hidden continuity capsule/);
assert.throws(() => validateAutoCompactContinuation({
  contract,
  sourceConversationId: "source-conversation",
  targetConversationId: "target-conversation",
  targetMappingCount: 2_100,
  targetBranchMessageCount: 2_000,
  targetPayloadBytes: 1_500_000,
  hiddenMessages: 1,
  visibleAssistants: 1,
  uiContinuityVerified: true,
}), /inherited too much|not materially smaller/);
assert.throws(() => createAutoCompactContract({
  capsule,
  source: { ...source, payloadBytes: validated.carryBytes * 2, mappingCount: 10_000, branchMessageCount: 10_000, exactUsedTokens: 1_000_000 },
  uiContinuityKey: "goal:goal_abc",
}), /payloadByteRatio/,
  "a small branch ratio must not hide an oversized carry payload");
assert.throws(() => validateAutoCompactContinuation({
  contract,
  sourceConversationId: "source-conversation",
  targetConversationId: "target-conversation",
  targetBranchMessageCount: 3,
  targetPayloadBytes: 18_000,
  hiddenMessages: 1,
  visibleAssistants: 1,
  uiContinuityVerified: true,
}), /target mapping size is unavailable/);

console.log(JSON.stringify({
  ok: true,
  gate: "auto-compact-contract",
  backendIdMayChange: true,
  uiContinuityRequired: true,
  fullHistoryInheritanceRejected: true,
  zeroContextRejected: true,
  sourceToCarryRatioMeasured: true,
  goalPlanFrontierRequired: true,
  rawTranscriptForbidden: true,
}));
