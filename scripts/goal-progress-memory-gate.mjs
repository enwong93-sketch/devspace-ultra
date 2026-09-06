#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { GoalRunProgressSupervisor } from "../dist/goal-run-progress-supervisor.js";

// Isolated component soak: no Core server, production state, CDP or network access.
assert.equal(typeof global.gc, "function", "run with --expose-gc");
const actualHeapLimitMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
assert.ok(actualHeapLimitMb <= 512, "use --max-old-space-size=464 --max-semi-space-size=16 and verify the actual total V8 heap limit");
const root = await mkdtemp(join(tmpdir(), "devspace-progress-memory-"));
const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;
let supervisor;
try {
  const runtime = new GoalRuntime({ stateDir: root });
  await runtime.ready;
  const conversationId = "isolated-progress-soak";
  const goal = await runtime.start({ conversationId, objective: "Isolated progress memory verification", successCriteria: ["Correlated operations complete without unbounded state"] });
  const statePath = join(root, "progress.json");
  supervisor = new GoalRunProgressSupervisor({ statePath, goalRuntime: runtime });
  await supervisor.start();
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  const waves = [];
  const batchSize = 64;
  const operationsPerWave = 2048;
  let expectedFailures = 0;
  for (let wave = 0; wave < 2; wave++) {
    for (let base = 0; base < operationsPerWave; base += batchSize) {
      const ids = Array.from({ length: batchSize }, (_, i) => `${wave}-${base + i}`);
      await Promise.all(ids.map((operationId) => supervisor.noteToolStart({ conversationId, toolName: "read", operationId })));
      assert.equal(supervisor.snapshot().active.inFlightCount, batchSize);
      await Promise.all(ids.map((operationId, i) => {
        const success = (base + i) % 17 !== 0;
        if (!success) expectedFailures++;
        return supervisor.noteToolBoundary({ operationId, success, durationMs: 1 });
      }));
      assert.equal(supervisor.snapshot().active.inFlightCount, 0);
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    global.gc();
    waves.push({ wave: wave + 1, completed: supervisor.snapshot().active.stepCount, retainedHeapMb: mb(process.memoryUsage().heapUsed) });
  }
  const snap = supervisor.snapshot();
  assert.equal(snap.active.goalId, goal.id);
  assert.equal(snap.active.stepCount, 4096);
  assert.equal(snap.active.failedSteps, expectedFailures);
  assert.equal(snap.active.successfulSteps, 4096 - expectedFailures);
  assert.equal(supervisor.inFlight.size, 0);
  assert.equal(supervisor.runs.size, 1);
  const disk = await readFile(statePath, "utf8");
  assert.equal(JSON.parse(disk).active.stepCount, 4096);
  assert.ok(Buffer.byteLength(disk) < 128 * 1024);
  assert.ok(waves[1].retainedHeapMb - waves[0].retainedHeapMb < 32, "retained heap must remain bounded between waves");
  console.log(JSON.stringify({ ok: true, gate: "goal-progress-memory", heapLimitMb: actualHeapLimitMb, realGoalRuntime: true, realDiskPersistence: true, operations: 4096, concurrency: batchSize, baselineHeapMb: mb(baseline), peakHeapMb: mb(peak), waves, stateBytes: Buffer.byteLength(disk), productionStateTouched: false, networkAccess: false, scope: "progress-component-only-not-full-Core" }));
} finally {
  await supervisor?.close();
  await rm(root, { recursive: true, force: true });
}
