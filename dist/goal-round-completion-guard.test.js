import assert from "node:assert/strict";

let moduleUnderTest = null;
try {
  moduleUnderTest = await import("./goal-round-completion-guard.js");
} catch {
  // RED until production guard exists.
}

assert.equal(typeof moduleUnderTest?.ClassicGoalRoundCompletionGuard, "function", "ClassicGoalRoundCompletionGuard must exist");
assert.equal(typeof moduleUnderTest?.shouldRecoverWorkingRound, "function", "shouldRecoverWorkingRound must exist");

const baseGoal = {
  id: "goal_aaaaaaaaaaaaaaaa",
  status: "active",
  round: 2,
  roundState: "working",
  roundBeganAt: "2026-09-05T03:00:00.000Z",
  lastConsumedContinuationId: "continuation_aaaaaaaaaaaaaaaa",
};

assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "COMPLETE",
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), true);
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: true,
  streamStatus: "COMPLETE",
  safetyCheckVisible: false,
  nativeCompleteStableMs: 1_000,
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false, "a newly COMPLETE native state must get a grace window when GUI generating is stale");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: true,
  streamStatus: "COMPLETE",
  safetyCheckVisible: false,
  nativeCompleteStableMs: 5_000,
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), true, "stable native COMPLETE must override a stale GUI generating flag after grace");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: true,
  streamStatus: "COMPLETE",
  safetyCheckVisible: true,
  nativeCompleteStableMs: 20_000,
}, { nowMs: Date.parse("2026-09-05T03:00:25.000Z") }), false, "an active additional-safety-check notice must still fail closed even when native COMPLETE is stable");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: false,
  generating: false,
  streamStatus: "COMPLETE",
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false);
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "IN_PROGRESS",
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false);
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "IS_STREAMING",
  deliveryTransportFailed: true,
  deliveryTimeoutVisible: true,
  retryVisible: true,
  safetyCheckVisible: false,
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), true, "native turn transport failure plus explicit host delivery-timeout surface must recover even when stream_status is stale");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "IS_STREAMING",
  deliveryTransportFailed: false,
  deliveryTimeoutVisible: true,
  retryVisible: true,
  safetyCheckVisible: false,
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false, "GUI timeout alone must never become recovery authority");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "IS_STREAMING",
  deliveryTransportFailed: true,
  deliveryTimeoutVisible: true,
  retryVisible: true,
  safetyCheckVisible: true,
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false, "an active safety-check notice must fail closed");
assert.equal(moduleUnderTest.shouldRecoverWorkingRound({ ...baseGoal, roundState: "reported" }, {
  chatMode: true,
  generating: false,
  streamStatus: "COMPLETE",
}, { nowMs: Date.parse("2026-09-05T03:00:05.000Z") }), false);
assert.equal(moduleUnderTest.shouldRecoverWorkingRound(baseGoal, {
  chatMode: true,
  generating: false,
  streamStatus: "COMPLETE",
}, { nowMs: Date.parse("2026-09-05T03:00:00.500Z") }), false, "newly begun round must get a settle window");

const calls = { inspect: [], dispatch: [], claims: [], acks: [], releases: [] };
const runtime = {
  async recoverableWorkingRounds() { return [baseGoal]; },
  async claimRoundRecovery({ goalId }) {
    calls.claims.push(goalId);
    return {
      claimed: true,
      claim: {
        goalId,
        round: 2,
        recoveryId: "recovery_aaaaaaaaaaaaaaaa",
        prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] same round",
      },
    };
  },
  async roundRecovery(input) {
    if (input.action === "ack") calls.acks.push(input);
    if (input.action === "release") calls.releases.push(input);
    return { goal: baseGoal };
  },
};
const guard = new moduleUnderTest.ClassicGoalRoundCompletionGuard({
  goalRuntime: runtime,
  now: () => Date.parse("2026-09-05T03:00:05.000Z"),
  inspect: async (goal) => {
    calls.inspect.push(goal.id);
    return { chatMode: true, generating: false, streamStatus: "COMPLETE", conversationId: "conversation_1" };
  },
  dispatch: async (claim) => {
    calls.dispatch.push(claim);
    return { ok: true, transport: "classic-raw-host-rpc" };
  },
  pollMs: 0,
});
const result = await guard.pollOnce();
assert.equal(result.recovered, 1);
assert.deepEqual(calls.inspect, [baseGoal.id]);
assert.deepEqual(calls.claims, [baseGoal.id]);
assert.equal(calls.dispatch.length, 1);
assert.equal(calls.dispatch[0].round, 2);
assert.match(calls.dispatch[0].prompt, /GOAL_ROUND_RECOVERY/);
assert.equal(calls.acks.length, 1);
assert.equal(calls.releases.length, 0);

const failedRuntimeCalls = { release: 0 };
const failedGuard = new moduleUnderTest.ClassicGoalRoundCompletionGuard({
  goalRuntime: {
    async recoverableWorkingRounds() { return [baseGoal]; },
    async claimRoundRecovery() {
      return { claimed: true, claim: { goalId: baseGoal.id, round: 2, recoveryId: "recovery_bbbbbbbbbbbbbbbb", prompt: "recover" } };
    },
    async roundRecovery({ action }) { if (action === "release") failedRuntimeCalls.release += 1; },
  },
  now: () => Date.parse("2026-09-05T03:00:05.000Z"),
  inspect: async () => ({ chatMode: true, generating: false, streamStatus: "COMPLETE" }),
  dispatch: async () => ({ ok: false, error: "transport failed" }),
  pollMs: 0,
});
const failed = await failedGuard.pollOnce();
assert.equal(failed.recovered, 0);
assert.equal(failedRuntimeCalls.release, 1, "failed hidden dispatch must release the recovery claim");

await guard.close();
await failedGuard.close();

console.log(JSON.stringify({
  ok: true,
  gate: "goal-round-completion-guard",
  chatModeOnly: true,
  serverCompleteOrNativeDeliveryFailureRequired: true,
  sameRoundRecovery: true,
  failedDispatchReleased: true,
}));
