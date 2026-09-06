import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRunProgressSupervisor } from "./goal-run-progress-supervisor.js";

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "devspace-progress-integrity-"));
  let time = Date.parse("2026-09-07T00:00:00Z");
  const goals = [
    { id: "goal_a", conversationId: "conv-a", objective: "Repair A", status: "active", round: 1, revision: 1, updatedAt: new Date(time).toISOString() },
    { id: "goal_b", conversationId: "conv-b", objective: "Repair B", status: "active", round: 1, revision: 1, updatedAt: new Date(time + 1).toISOString() },
  ];
  const statePath = join(root, "progress.json");
  const goalRuntime = { async activeGoals() { return goals; } };
  const options = { statePath, goalRuntime, now: () => time, heartbeatMs: 60_000, ...extra };
  const supervisor = new GoalRunProgressSupervisor(options);
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  return { supervisor, goals, options, advance(ms) { time += ms; } };
}

test("an idle service heartbeat is not evidence of work or automatic continuation", async (t) => {
  const { supervisor: s, goals, advance } = await fixture(t);
  goals.splice(1);
  await s.start();
  advance(90_000);
  const a = (await s.refreshHeartbeat()).active;
  assert.equal(a.stepCount, 0);
  assert.equal(a.lastBoundaryAt, null);
  assert.equal(a.evidenceState, "waiting-for-work");
  assert.doesNotMatch(a.currentText, /仍然持續處理|已開始處理|自動繼續/);
});

test("native conversation A cannot accrue work to newer Goal B", async (t) => {
  const { supervisor: s } = await fixture(t);
  const a = (await s.noteToolStart({ toolName: "read", conversationId: "conv-a", operationId: "op-a" })).active;
  assert.equal(a.goalId, "goal_a");
  assert.equal(a.conversationId, "conv-a");
  assert.equal(a.stepCount, 0);
});

test("unidentified calls do not mutate a bound Goal or claim a completed step", async (t) => {
  const { supervisor: s } = await fixture(t);
  await s.noteToolStart({ toolName: "read", conversationId: "conv-a", operationId: "op-a" });
  const before = s.snapshot();
  await s.noteToolBoundary({ toolName: "read", operationId: "unidentified", success: true });
  assert.deepEqual(s.snapshot(), before);
});

test("overlapping tools retain the other pending operation after either finishes", async (t) => {
  const { supervisor: s } = await fixture(t);
  const identity = { conversationId: "conv-a" };
  await s.noteToolStart({ ...identity, toolName: "bash", operationId: "one" });
  await s.noteToolStart({ ...identity, toolName: "read", operationId: "two" });
  let a = (await s.noteToolBoundary({ ...identity, toolName: "read", operationId: "two", success: true })).active;
  assert.equal(a.inFlightCount, 1);
  assert.equal(a.inFlightToolName, "bash");
  assert.equal(a.stepCount, 1);
  a = (await s.noteToolBoundary({ ...identity, toolName: "bash", operationId: "one", success: false })).active;
  assert.equal(a.inFlightCount, 0);
  assert.equal(a.stepCount, 2);
  assert.equal(a.failedSteps, 1);
  assert.equal(a.successfulSteps, 1);
  const before = s.snapshot();
  await s.noteToolBoundary({ ...identity, toolName: "bash", operationId: "one", success: true });
  assert.deepEqual(s.snapshot(), before, "duplicate completion must not increment progress");
});

test("a long pending result remains pending, not proof of continuing useful work", async (t) => {
  const { supervisor: s, advance } = await fixture(t);
  await s.noteToolStart({ toolName: "bash", conversationId: "conv-a", operationId: "one" });
  advance(120_000);
  const a = (await s.refreshHeartbeat()).active;
  assert.equal(a.evidenceState, "awaiting-result-stale");
  assert.equal(a.stepCount, 0);
  assert.match(a.currentText, /未收到.*結果/);
  assert.doesNotMatch(a.currentText, /自動繼續|仍然正在執行/);
});

test("legacy HTTP-derived counters are preserved but not promoted into verified work", async (t) => {
  const { supervisor: s, options } = await fixture(t);
  await writeFile(options.statePath, JSON.stringify({ version: 1, active: { goalId: "goal_a", conversationId: "conv-a", round: 1, stepCount: 9999, lastSuccess: true, lastBoundaryAt: "2026-09-07T00:00:00Z" } }));
  const a = (await s.start()).active;
  assert.equal(a.stepCount, 0);
  assert.equal(a.lastBoundaryAt, null);
  assert.equal(a.legacyStepCount, 9999);
  assert.equal(a.legacyProgressUnverified, true);
});

test("restart never resurrects a saved in-flight operation", async (t) => {
  const { supervisor: s, options } = await fixture(t);
  await s.noteToolStart({ toolName: "bash", conversationId: "conv-a", operationId: "old-process-call" });
  await s.close();
  const restored = new GoalRunProgressSupervisor(options);
  t.after(() => restored.close());
  const a = (await restored.start()).active;
  assert.equal(a.inFlightToolName, null);
  assert.equal(a.inFlightCount, 0);
  assert.equal(a.evidenceState, "interrupted");
  assert.match(a.currentText, /重啟|中斷/);
});

test("slow persistence retains only one in-flight and one latest pending snapshot", async (t) => {
  let release;
  let started;
  const began = new Promise((r) => { started = r; });
  const blocked = new Promise((r) => { release = r; });
  const saved = [];
  const { supervisor: s } = await fixture(t, { writeState: async (_path, value) => {
    saved.push(structuredClone(value));
    if (saved.length === 1) { started(); await blocked; }
  } });
  s.state.updatedAt = "initial";
  const first = s.persist();
  await began;
  const waits = [];
  for (let index = 0; index < 5000; index++) {
    s.state.updatedAt = `latest-${index}`;
    waits.push(s.persist());
  }
  try {
    assert.equal(saved.length, 1);
    assert.ok(waits.every((p) => p === first), "writes must share a bounded drain, not retain a promise chain per snapshot");
  } finally { release(); }
  await Promise.all(waits);
  assert.equal(saved.length, 2);
  assert.equal(saved.at(-1).updatedAt, "latest-4999");
});
