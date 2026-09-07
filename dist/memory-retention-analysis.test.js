import assert from "node:assert/strict";
import { analyzeMemoryRetention, isRetentionIdleSample } from "./memory-retention-analysis.js";

const MIB = 1024 * 1024;
const base = Date.parse("2026-09-07T03:00:00.000Z");
function sample(index, overrides = {}) {
  return {
    observedAtMs: base + index * 60_000,
    observedAt: new Date(base + index * 60_000).toISOString(),
    heapUsed: (300 + index) * MIB,
    heapLimit: 512 * MIB,
    sessions: 32,
    activeRequests: 40,
    eventStreams: 40,
    nonSseActive: 0,
    maxEventStreams: 40,
    processSessions: 0,
    turnPending: 0,
    contextPending: 0,
    streamPending: 0,
    capabilityConnecting: 0,
    capabilityStartupTails: 0,
    ...overrides,
  };
}

assert.equal(isRetentionIdleSample(sample(0)), true);
assert.equal(isRetentionIdleSample(sample(0, { activeRequests: 41, eventStreams: 40, nonSseActive: 1 })), false);
assert.equal(isRetentionIdleSample(sample(0, { contextPending: 1 })), false);

const bounded = analyzeMemoryRetention([
  sample(0, { heapUsed: 310 * MIB }),
  sample(1, { heapUsed: 318 * MIB }),
  sample(2, { heapUsed: 312 * MIB }),
  sample(3, { heapUsed: 316 * MIB }),
  sample(4, { heapUsed: 313 * MIB }),
]);
assert.equal(bounded.ok, true);
assert.equal(bounded.conclusion, "bounded-during-idle");
assert.equal(bounded.idle.sustainedGrowth, false);

const busy = analyzeMemoryRetention([
  sample(0, { nonSseActive: 1, activeRequests: 41 }),
  sample(1, { nonSseActive: 2, activeRequests: 42 }),
]);
assert.equal(busy.ok, true);
assert.equal(busy.conclusion, "busy-observation-hard-bounds-only");

const growth = analyzeMemoryRetention([
  sample(0, { heapUsed: 200 * MIB }),
  sample(1, { heapUsed: 230 * MIB }),
  sample(2, { heapUsed: 260 * MIB }),
  sample(3, { heapUsed: 290 * MIB }),
], {
  maxIdleNetGrowthBytes: 64 * MIB,
  maxIdleSlopeBytesPerMinute: 4 * MIB,
});
assert.equal(growth.ok, false);
assert.equal(growth.conclusion, "suspected-idle-retention-growth");
assert.equal(growth.idle.sustainedGrowth, true);

const heapBreach = analyzeMemoryRetention([
  sample(0, { heapUsed: 500 * MIB }),
]);
assert.equal(heapBreach.ok, false);
assert.equal(heapBreach.conclusion, "hard-bound-breach");
assert.equal(heapBreach.capBreaches[0].type, "heap-utilization");

const sessionBreach = analyzeMemoryRetention([
  sample(0, { sessions: 41 }),
]);
assert.equal(sessionBreach.ok, false);
assert.equal(sessionBreach.capBreaches.some((row) => row.type === "mcp-sessions"), true);

console.log(JSON.stringify({
  ok: true,
  gate: "memory-retention-analysis",
  idleVsBusySeparated: true,
  hardBoundsEnforced: true,
  sustainedIdleGrowthDetected: true,
  normalGcNoiseAccepted: true,
}));
