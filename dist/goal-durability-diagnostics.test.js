import assert from "node:assert/strict";
import test from "node:test";
import { ClassicGoalRoundCompletionGuard } from "./goal-round-completion-guard.js";
import { goalDurabilityDiagnostics, safeGoalDurabilityDiagnostics } from "./goal-durability-diagnostics.js";

function makeGuard() {
  return new ClassicGoalRoundCompletionGuard({
    goalRuntime: { async recoverableWorkingRounds() { return []; } },
    inspect: async () => ({}),
    dispatch: async () => ({ ok: false }),
    pollMs: 0,
  });
}

test("real Goal guard exposes bounded diagnostics before, after poll and close", async () => {
  const guard = makeGuard();
  let status = guard.status();
  assert.equal(status.closed, false);
  assert.equal(status.running, false);
  assert.equal(status.lastPollAt, null);
  assert.equal(status.rawPromptReturned, false);
  await guard.start({ schedule: false });
  status = guard.status();
  assert.match(status.lastPollAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.lastRecovered, 0);
  assert.deepEqual(status.lastResults, []);
  await guard.close();
  assert.equal(guard.status().closed, true);
});

test("loopback diagnostics invoke the real guard contract and return no state payload", async () => {
  const guard = makeGuard();
  await guard.start({ schedule: false });
  const result = goalDurabilityDiagnostics({
    goalRoundCompletionGuard: guard,
    goalRuntime: { lastPersistError: null, persistFailureCount: 2, persistRecoveryCount: 2 },
    planRuntime: { lastPersistError: "bounded failure", persistFailureCount: 1, persistRecoveryCount: 0 },
    conversationCollisions: [{
      conversationId: "conversation-duplicate",
      goals: [{ id: "goal_a", status: "active", round: 3 }, { id: "goal_b", status: "paused", round: 1 }],
    }],
  });
  assert.equal(result.goalRoundRecovery.closed, false);
  assert.deepEqual(result.statePersistence.goal, {
    lastError: null,
    failureCount: 2,
    recoveryCount: 2,
  });
  assert.deepEqual(result.statePersistence.plan, {
    lastError: "bounded failure",
    failureCount: 1,
    recoveryCount: 0,
  });
  assert.equal(result.rawStateReturned, false);
  assert.equal(result.diagnosticsAvailable, true);
  assert.equal(result.diagnosticsError, null);
  assert.equal(result.goalConversationCollisions.count, 1);
  assert.deepEqual(result.goalConversationCollisions.groups[0].goalIds, ["goal_a", "goal_b"]);
  assert.equal(result.goalConversationCollisions.automaticDispatchBlocked, true);
  assert.equal(result.goalConversationCollisions.rawObjectivesReturned, false);
  assert.equal(JSON.stringify(result).includes("objective"), false);
  await guard.close();
});

test("missing status contract fails in tests instead of becoming an HTTP 500 after deployment", () => {
  assert.throws(() => goalDurabilityDiagnostics({
    goalRoundCompletionGuard: {},
    goalRuntime: {},
    planRuntime: {},
  }), /status-capable guard/);
  const safe = safeGoalDurabilityDiagnostics({
    goalRoundCompletionGuard: {},
    goalRuntime: { persistFailureCount: 1 },
    planRuntime: {},
    conversationCollisions: [],
  });
  assert.equal(safe.diagnosticsAvailable, false);
  assert.equal(safe.diagnosticsError, "goal-durability-contract-unavailable");
  assert.equal(safe.goalRoundRecovery.running, false);
  assert.equal(safe.statePersistence.goal.failureCount, 1);
  assert.equal(safe.goalConversationCollisions.count, 0);
  assert.equal(safe.rawStateReturned, false);
});
