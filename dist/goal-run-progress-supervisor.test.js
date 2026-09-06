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
  assert.match(snap.active.currentText, /未通過/);
  assert.doesNotMatch(await readFile(path, "utf8"), /Bearer|password|secret/i);
  console.log(JSON.stringify({ ok: true, gate: "goal-run-progress-supervisor", automaticToolStart: true, automaticToolBoundary: true, autonomousHeartbeat: true, durable: true, evidenceNotInvented: true }));
} finally {
  await supervisor?.close();
  await rm(root, { recursive: true, force: true });
}
