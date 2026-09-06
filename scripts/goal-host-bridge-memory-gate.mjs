#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicGoalHostBridge } from "../dist/goal-host-bridge.js";

const port = Math.max(1024, Number(process.env.DEVSPACE_GOAL_MEMORY_PORT || 9732));
const goalId = String(process.env.DEVSPACE_GOAL_MEMORY_GOAL_ID || "goal_1b2f3eb499d8f460");
const iterations = Math.max(20, Math.min(500, Number(process.env.DEVSPACE_GOAL_MEMORY_ITERATIONS || 120)));
const batchSize = Math.max(5, Math.min(50, Number(process.env.DEVSPACE_GOAL_MEMORY_BATCH || 20)));
const maxGrowthMb = Math.max(8, Number(process.env.DEVSPACE_GOAL_MEMORY_MAX_GROWTH_MB || 48));

const bridge = new ClassicGoalHostBridge({ ports: [port], probeTimeoutMs: 1_500, contextSettleMs: 20 });
const samples = [];
let matched = 0;
let inspected = 0;

function memorySample(iteration) {
  global.gc?.();
  const memory = process.memoryUsage();
  return {
    iteration,
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

samples.push(memorySample(0));
for (let index = 1; index <= iterations; index += 1) {
  const result = await bridge.inspectWorkingRound(goalId);
  inspected += 1;
  if (result?.chatMode === true) matched += 1;
  if (index % batchSize === 0 || index === iterations) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    samples.push(memorySample(index));
  }
}

const baseline = samples[0];
const final = samples.at(-1);
const peakHeap = Math.max(...samples.map((sample) => sample.heapUsed));
const peakRss = Math.max(...samples.map((sample) => sample.rss));
const growth = final.heapUsed - baseline.heapUsed;
const growthMb = growth / 1024 / 1024;
assert.equal(growthMb <= maxGrowthMb, true, `Goal Host Bridge inspect heap grew ${growthMb.toFixed(1)} MB after forced GC; limit ${maxGrowthMb} MB.`);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-host-bridge-memory",
  port,
  goalId,
  inspected,
  matched,
  iterations,
  maxGrowthMb,
  growthMb: Number(growthMb.toFixed(2)),
  baselineHeapMb: Number((baseline.heapUsed / 1024 / 1024).toFixed(2)),
  finalHeapMb: Number((final.heapUsed / 1024 / 1024).toFixed(2)),
  peakHeapMb: Number((peakHeap / 1024 / 1024).toFixed(2)),
  peakRssMb: Number((peakRss / 1024 / 1024).toFixed(2)),
  samples: samples.map((sample) => ({
    iteration: sample.iteration,
    heapMb: Number((sample.heapUsed / 1024 / 1024).toFixed(2)),
    rssMb: Number((sample.rss / 1024 / 1024).toFixed(2)),
    externalMb: Number((sample.external / 1024 / 1024).toFixed(2)),
  })),
}));
