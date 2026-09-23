import assert from "node:assert/strict";
import {
  InteractiveProgressEnforcementGate,
  goalRoundClosureState,
  isPlanCompletionCall,
  isProgressSetupTool,
} from "./interactive-progress-enforcement.js";

let now = Date.parse("2026-09-16T11:00:00.000Z");
const durable = new Map();
const gate = new InteractiveProgressEnforcementGate({
  now: () => now,
  maxSilentMs: 10 * 60_000,
  latestProgressAt: async (conversationId) => durable.get(conversationId) || null,
});

const main = { conversationId: "conversation-main-01", runtimeKey: "main-01" };
gate.noteTurn({ ...main, kind: "started", observedAtMs: now, turnTraceFingerprint: "a".repeat(64) });
const firstAtomic = await gate.beforeTool({ ...main, toolName: "read" });
assert.equal(firstAtomic.ok, true, "one substantive tool remains a valid atomic exception");
assert.equal(firstAtomic.activityAccepted, true, "an admitted substantive tool is positive rescue-clock activity");
let result = await gate.beforeTool({ ...main, toolName: "grep" });
assert.equal(result.ok, false);
assert.equal(result.reason, "second-substantive-tool-requires-progress");
assert.equal(result.activityAccepted, false,
  "a progress-preflight-blocked tool attempt must never postpone interrupted-turn rescue");

gate.noteReport({ conversationId: main.conversationId, observedAtMs: now + 1_000 });
assert.equal((await gate.beforeTool({ ...main, toolName: "grep" })).ok, true);

now += 11 * 60_000;
result = await gate.beforeTool({ ...main, toolName: "exec_command" });
assert.equal(result.ok, false);
assert.equal(result.reason, "progress-stale");

const planned = { conversationId: "conversation-main-02", runtimeKey: "main-02" };
gate.noteTurn({ ...planned, kind: "started", observedAtMs: now, turnTraceFingerprint: "b".repeat(64) });
const activePlan = { id: "plan-a", createdAt: new Date(now).toISOString() };
result = await gate.beforeTool({ ...planned, toolName: "read", activePlan });
assert.equal(result.ok, false);
assert.equal(result.reason, "progress-preflight-required", "starting a Plan proves the task is multi-step, so the first substantive tool must wait for narration");
assert.equal(result.activityAccepted, false,
  "an active-Plan preflight rejection must not count as substantive liveness");
const planStatus = await gate.beforeTool({ ...planned, toolName: "devspace_plan_status", activePlan });
assert.equal(planStatus.ok, true);
assert.equal(planStatus.activityAccepted, false, "progress/setup tools do not reset interrupted-turn rescue");
const prematureRoundReport = await gate.beforeTool({ ...planned, toolName: "devspace_goal_turn_report", activePlan });
assert.equal(prematureRoundReport.ok, false);
assert.equal(prematureRoundReport.reason, "goal-round-plan-incomplete");
assert.equal(prematureRoundReport.errorType, "devspace_goal_round_plan_incomplete");
assert.match(prematureRoundReport.message, /update every Plan step to completed/i);

durable.set(planned.conversationId, new Date(now + 500).toISOString());
const admittedPlannedRead = await gate.beforeTool({ ...planned, toolName: "read", activePlan });
assert.equal(admittedPlannedRead.ok, true, "the exact compatibility bridge must satisfy the gate through durable progress state");
assert.equal(admittedPlannedRead.activityAccepted, true,
  "only the substantive call admitted after the verified progress preflight may reset the rescue clock");

result = await gate.beforeTool({
  ...planned,
  toolName: "devspace_update_plan",
  args: { steps: [{ id: "one", status: "completed" }, { id: "two", status: "completed" }] },
  activePlan,
});
assert.equal(result.ok, true, "Plan completion is allowed while the latest report is current");

now += 11 * 60_000;
result = await gate.beforeTool({
  ...planned,
  toolName: "devspace_update_plan",
  args: { steps: [{ id: "one", status: "completed" }, { id: "two", status: "completed" }] },
  activePlan,
});
assert.equal(result.ok, false);
assert.equal(result.reason, "final-progress-stale", "final Plan completion must not bypass the reporting ceiling");

const roundBeganAt = new Date(now + 1_000).toISOString();
const completedAt = new Date(now + 5_000).toISOString();
const activeGoal = {
  id: "goal_round_closure",
  conversationId: planned.conversationId,
  status: "active",
  round: 8,
  roundState: "working",
  roundBeganAt,
};
const completedTurnPlan = {
  id: "plan_round_closure",
  conversationId: planned.conversationId,
  status: "completed",
  createdAt: new Date(now + 2_000).toISOString(),
  completedAt,
};
const roundClosure = goalRoundClosureState({ activeGoal, latestPlan: completedTurnPlan });
assert.deepEqual(roundClosure, {
  goalId: activeGoal.id,
  round: activeGoal.round,
  planId: completedTurnPlan.id,
  planCompletedAt: completedAt,
});
result = await gate.beforeTool({ ...planned, toolName: "exec_command", roundClosure });
assert.equal(result.ok, false);
assert.equal(result.reason, "goal-round-report-required");
assert.equal(result.errorType, "devspace_goal_round_report_required");
assert.equal(result.activityAccepted, false,
  "a blocked post-Plan tool cannot postpone same-round recovery or rescue");
assert.match(result.message, /devspace_goal_turn_report.*final tool/i);

for (const allowedTool of [
  "devspace_goal_turn_report",
  "devspace_progress_report",
  "devspace_goal_status",
  "devspace_plan_status",
  "devspace_goal_complete",
  "devspace_goal_blocked",
  "devspace_goal_control",
  "devspace_goal_mount",
  "devspace_plan_mount",
  "devspace_plan_start",
  "request_user_input",
]) {
  const allowed = await gate.beforeTool({ ...planned, toolName: allowedTool, roundClosure });
  assert.equal(allowed.ok, true, `${allowedTool} must remain available at the round-closure boundary`);
  assert.equal(allowed.activityAccepted, false);
}

assert.equal(goalRoundClosureState({
  activeGoal,
  activePlan: { id: "plan-new-active" },
  latestPlan: completedTurnPlan,
}), null, "a fresh active Plan proves that meaningful work remains in this round");
assert.equal(goalRoundClosureState({
  activeGoal,
  latestPlan: {
    ...completedTurnPlan,
    createdAt: new Date(Date.parse(roundBeganAt) - 10_000).toISOString(),
    completedAt: new Date(Date.parse(roundBeganAt) - 5_000).toISOString(),
  },
}), null, "a previous round's completed Plan cannot force the current round to report");
assert.equal(goalRoundClosureState({
  activeGoal: { ...activeGoal, roundState: "reported" },
  latestPlan: completedTurnPlan,
}), null);

const worker = { conversationId: "conversation-worker", runtimeKey: "worker-01" };
assert.equal((await gate.beforeTool({ ...worker, toolName: "exec_command" })).enforced, false, "backend-only workers never write the user-facing card");

for (let mainNumber = 1; mainNumber <= 5; mainNumber += 1) {
  const runtimeKey = `main-${String(mainNumber).padStart(2, "0")}`;
  const conversationId = `conversation-main-${String(mainNumber).padStart(2, "0")}-coverage`;
  const coverageGate = new InteractiveProgressEnforcementGate({ now: () => now });
  coverageGate.noteTurn({ conversationId, runtimeKey, kind: "started", observedAtMs: now });
  assert.equal((await coverageGate.beforeTool({ conversationId, runtimeKey, toolName: "read" })).ok, true);
  const blocked = await coverageGate.beforeTool({ conversationId, runtimeKey, toolName: "grep" });
  assert.equal(blocked.reason, "second-substantive-tool-requires-progress", `${runtimeKey} must share the same mandatory progress policy`);
}

assert.equal(isProgressSetupTool("open_workspace"), true);
assert.equal(isProgressSetupTool("devspace_update_plan", { steps: [{ status: "in_progress" }] }), true);
assert.equal(isPlanCompletionCall("devspace_update_plan", { steps: [{ status: "completed" }] }), true);

console.log(JSON.stringify({
  ok: true,
  gate: "interactive-progress-enforcement",
  atomicFirstToolException: true,
  secondSubstantiveToolBlockedUntilNarration: true,
  activePlanRequiresOpeningNarration: true,
  incompletePlanBlocksGoalRoundReport: true,
  durableBridgeNarrationAccepted: true,
  tenMinuteCeilingEnforced: true,
  planCompletionRequiresFreshNarration: true,
  completedPlanRequiresGoalRoundReport: true,
  freshPlanCanReopenRoundWork: true,
  priorRoundPlanIgnored: true,
  onlyAdmittedSubstantiveToolsCountAsActivity: true,
  main01Through05Covered: true,
  backendWorkersExcluded: true,
  syntheticNarration: false,
}));
