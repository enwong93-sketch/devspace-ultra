import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRunProgressSupervisor } from "./goal-run-progress-supervisor.js";

const root = await mkdtemp(join(tmpdir(), "devspace-goal-run-progress-"));
let now = Date.parse("2026-09-06T10:00:00.000Z");
let supervisor;
try {
  const goal = { id: "goal_test", conversationId: "conv-test", objective: "Fix delivery timeout permanently", status: "active", round: 5, revision: 10, updatedAt: new Date(now).toISOString() };
  const runtime = { async activeGoals() { return [goal]; } };
  const path = join(root, "goal-run-live.json");
  supervisor = new GoalRunProgressSupervisor({ statePath: path, goalRuntime: runtime, now: () => now, heartbeatMs: 60_000 });
  await supervisor.start();
  const identity = { conversationId: "conv-test" };
  let snap = await supervisor.noteToolStart({ ...identity, operationId: "command", toolName: "bash" });
  assert.equal(snap.active.stepCount, 0);
  assert.equal(snap.active.inFlightToolName, "bash");
  assert.equal(snap.active.evidenceState, "awaiting-result");
  now += 25_000;
  snap = await supervisor.refreshHeartbeat();
  assert.match(snap.active.currentText, /25 秒/);
  snap = await supervisor.noteToolBoundary({ ...identity, operationId: "command", success: true, durationMs: 25_000 });
  assert.equal(snap.active.stepCount, 1);
  assert.equal(snap.active.inFlightToolName, null);
  assert.equal(snap.active.lastDurationMs, 25_000);
  assert.equal(snap.active.recentBoundaries.length, 1);
  assert.deepEqual(snap.active.recentBoundaries[0], {
    at: new Date(now).toISOString(),
    stepCount: 1,
    toolName: "bash",
    toolCategory: "verification",
    success: true,
    durationMs: 25_000,
  });
  await supervisor.noteToolStart({ ...identity, operationId: "inspection", toolName: "read" });
  snap = await supervisor.noteToolBoundary({ ...identity, operationId: "inspection", success: true, durationMs: 12 });
  assert.equal(snap.active.stepCount, 2);
  now += 25_000;
  snap = await supervisor.refreshHeartbeat();
  assert.doesNotMatch(snap.active.currentText, /自動繼續|仍然持續處理/);
  await supervisor.noteToolStart({ ...identity, operationId: "change", toolName: "edit" });
  snap = await supervisor.noteToolBoundary({ ...identity, operationId: "change", success: false });
  assert.equal(snap.active.stepCount, 3);
  assert.equal(snap.active.failedSteps, 1);
  assert.equal(snap.active.lastDurationMs, null);
  assert.equal(snap.active.recentBoundaries.length, 3);
  assert.equal(snap.active.recentBoundaries[1].toolName, "read");
  assert.equal(snap.active.recentBoundaries[2].toolName, "edit");
  assert.equal(snap.active.recentBoundaries[2].success, false);
  assert.match(snap.active.currentText, /未通過/);
  assert.doesNotMatch(await readFile(path, "utf8"), /Bearer|password|secret/i);

  const planPath = join(root, "plan-run-live.json");
  const plan = {
    id: "plan_work_agent",
    conversationId: "conv-work",
    title: "完成 NPR 圖片參考驗收",
    status: "active",
    revision: 3,
    steps: [{ id: "step-image", text: "檢視參考圖片並核對造型", status: "in_progress" }],
  };
  const planOnly = new GoalRunProgressSupervisor({
    statePath: planPath,
    goalRuntime: { async activeGoals() { return []; } },
    planRuntime: { async activePlans() { return [plan]; } },
    now: () => now,
    heartbeatMs: 60_000,
  });
  try {
    await planOnly.start();
    let planSnap = await planOnly.noteToolStart({ conversationId: "conv-work", operationId: "image-read", toolName: "view_image" });
    assert.equal(planSnap.active.goalId, "plan:plan_work_agent");
    assert.equal(planSnap.active.planId, "plan_work_agent");
    assert.equal(planSnap.active.progressKind, "plan");
    assert.equal(planSnap.active.objective, "檢視參考圖片並核對造型");
    planSnap = await planOnly.noteToolBoundary({ conversationId: "conv-work", operationId: "image-read", success: true, durationMs: 2_000 });
    assert.equal(planSnap.active.stepCount, 1);
    planSnap = await planOnly.refreshHeartbeat();
    assert.equal(planSnap.active.goalId, "plan:plan_work_agent", "heartbeat must retain a plan-only Work agent run");
  } finally {
    await planOnly.close();
  }

  const conversationPath = join(root, "conversation-run-live.json");
  const conversationOnly = new GoalRunProgressSupervisor({
    statePath: conversationPath,
    goalRuntime: { async activeGoals() { return []; } },
    planRuntime: { async activePlans() { return []; } },
    now: () => now,
    heartbeatMs: 60_000,
  });
  try {
    await conversationOnly.start();
    let conversationSnap = await conversationOnly.noteConversationTurn({
      conversationId: "conv-main-01",
      runtimeKey: "main-01",
      observedAt: new Date(now).toISOString(),
    });
    assert.equal(conversationSnap.active.goalId, "conversation:conv-main-01");
    assert.equal(conversationSnap.active.progressKind, "conversation");
    assert.equal(conversationSnap.active.runtimeKey, "main-01");
    assert.equal(conversationSnap.active.stepCount, 0);
    assert.match(conversationSnap.active.objective, /等候第一個已驗證工具結果/);
    conversationSnap = await conversationOnly.noteToolStart({
      conversationId: "conv-main-01",
      runtimeKey: "main-01",
      operationId: "blender-inspect",
      toolName: "capability_call",
    });
    assert.equal(conversationSnap.active.goalId, "conversation:conv-main-01");
    assert.equal(conversationSnap.active.progressKind, "conversation");
    assert.equal(conversationSnap.active.runtimeKey, "main-01");
    conversationSnap = await conversationOnly.noteToolBoundary({
      conversationId: "conv-main-01",
      operationId: "blender-inspect",
      success: true,
      durationMs: 3_000,
    });
    assert.equal(conversationSnap.active.stepCount, 1);
    conversationSnap = await conversationOnly.refreshHeartbeat();
    assert.equal(conversationSnap.active.goalId, "conversation:conv-main-01");

    const workerIgnored = await conversationOnly.noteToolStart({
      conversationId: "conv-worker",
      runtimeKey: "worker-01",
      operationId: "worker-call",
      toolName: "capability_call",
    });
    assert.notEqual(workerIgnored.active?.conversationId, "conv-worker", "non-Main worker calls must remain backend-only");
  } finally {
    await conversationOnly.close();
  }

  console.log(JSON.stringify({ ok: true, gate: "goal-run-progress-supervisor", nativeTurnCreatesWaitingCard: true, automaticToolStart: true, automaticToolBoundary: true, boundedBoundaryQueue: true, autonomousHeartbeat: true, durable: true, planOnlyWorkAgent: true, ordinaryMainConversation: true, workerBackendOnly: true, evidenceNotInvented: true }));
} finally {
  await supervisor?.close();
  await rm(root, { recursive: true, force: true });
}
