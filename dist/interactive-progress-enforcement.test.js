import assert from "node:assert/strict";
import { InteractiveProgressEnforcementGate, isPlanCompletionCall, isProgressSetupTool } from "./interactive-progress-enforcement.js";

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
  durableBridgeNarrationAccepted: true,
  tenMinuteCeilingEnforced: true,
  planCompletionRequiresFreshNarration: true,
  onlyAdmittedSubstantiveToolsCountAsActivity: true,
  main01Through05Covered: true,
  backendWorkersExcluded: true,
  syntheticNarration: false,
}));
