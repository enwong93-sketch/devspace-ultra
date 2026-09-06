#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicContextMetadataCdpAdapter } from "../dist/context-guardian-cdp.js";
import { ClassicHostOverlayContextAdapter, ClassicHostOverlayProjection } from "../dist/classic-host-overlay.js";

const iterations = Math.max(100, Math.min(5000, Number(process.argv[2] || 1200)));
const port = Number(process.env.DEVSPACE_OVERLAY_STRESS_PORT || 9733);
const conversationId = "devspace-overlay-memory-stress-dummy";
const goal = {
  id: "goal_aaaaaaaaaaaaaaaa",
  conversationId,
  objective: "Host Overlay memory stress projection",
  status: "active",
  round: 1,
  roundState: "working",
  revision: 1,
  updatedAt: new Date().toISOString(),
};
const plan = {
  id: "plan_bbbbbbbbbbbbbbbb",
  conversationId,
  title: "Host Overlay memory stress",
  status: "active",
  revision: 1,
  updatedAt: new Date().toISOString(),
  steps: [
    { id: "step_1111111111111111", text: "Stress projection", status: "in_progress" },
    { id: "step_2222222222222222", text: "Verify memory", status: "pending" },
  ],
};

const contextAdapter = new ClassicContextMetadataCdpAdapter({ ports: [port], connectionPollMs: 0 });
const adapter = new ClassicHostOverlayContextAdapter({ contextAdapter });
const manager = new ClassicHostOverlayProjection({
  goalRuntime: { async projectableGoals() { return [goal]; } },
  planRuntime: { async activePlans() { return [plan]; } },
  adapter,
  pollMs: 0,
});

function mb(bytes) { return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10; }
function snapshot() {
  const memory = process.memoryUsage();
  const status = contextAdapter.status();
  return {
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    connected: status.connected,
    pending: (status.runtimes || []).reduce((sum, runtime) => sum + Number(runtime.pendingCdpCalls || 0), 0),
  };
}

try {
  await contextAdapter.start({ schedule: false });
  assert.equal(contextAdapter.status().connected, 1, `Expected one ChatGPT Main on debug port ${port}`);
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const before = snapshot();
  let maxPending = before.pending;
  let maxHeap = before.heapUsed;
  for (let index = 0; index < iterations; index += 1) {
    await manager.syncOnce();
    if ((index + 1) % 100 === 0) {
      const current = snapshot();
      maxPending = Math.max(maxPending, current.pending);
      maxHeap = Math.max(maxHeap, current.heapUsed);
    }
  }
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.gc?.();
  const after = snapshot();
  console.log(JSON.stringify({
    ok: true,
    gate: "host-overlay-memory-stress",
    port,
    iterations,
    before: { heapUsedMb: mb(before.heapUsed), rssMb: mb(before.rss), pending: before.pending },
    after: { heapUsedMb: mb(after.heapUsed), rssMb: mb(after.rss), pending: after.pending },
    maxHeapMb: mb(maxHeap),
    heapGrowthMbAfterGc: mb(after.heapUsed - before.heapUsed),
    maxPending,
  }));
} finally {
  await manager.close().catch(() => {});
  await contextAdapter.close().catch(() => {});
}
