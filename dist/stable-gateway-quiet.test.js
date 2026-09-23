import assert from "node:assert/strict";
import { assessVerifiedHandoverReadiness } from "./verified-handover-policy.js";

let moduleUnderTest = null;
try {
  moduleUnderTest = await import("./stable-gateway-quiet.js");
} catch {
  // RED until the production helper exists.
}

assert.equal(typeof moduleUnderTest?.waitForStableGatewayQuiet, "function", "waitForStableGatewayQuiet must exist");

{
  const samples = [
    { admission: { activeRequests: 1 }, sessions: { totalActiveRequests: 0 } },
    { admission: { activeRequests: 0 }, sessions: { totalActiveRequests: 0 } },
    { admission: { activeRequests: 2 }, sessions: { totalActiveRequests: 0 } },
    { admission: { activeRequests: 0 }, sessions: { totalActiveRequests: 0 } },
    { admission: { activeRequests: 0 }, sessions: { totalActiveRequests: 0 } },
  ];
  let calls = 0;
  const result = await moduleUnderTest.waitForStableGatewayQuiet({
    statusProbe: async () => samples[Math.min(calls++, samples.length - 1)],
    timeoutMs: 1,
    pollMs: 1,
    consecutiveQuietSamples: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.quietSamples, 2);
  assert.equal(calls, 5, "a busy sample must reset the consecutive quiet counter");
}

{
  const busyHealthy = assessVerifiedHandoverReadiness({
    quiet: { ok: false, state: "cancelled" },
    status: {
      ok: true,
      fatal: false,
      handoverInProgress: false,
      coreRecoveryInProgress: false,
      admission: { closed: false, activeRequests: 4 },
      sessions: { totalNonStreamActiveRequests: 4, sessions: [{ publicSessionId: "live" }] },
    },
  });
  assert.equal(busyHealthy.ok, true);
  assert.equal(busyHealthy.mode, "controller-admission-drain",
    "continuous Multi-Main traffic must fall through to the controller's close-admission drain instead of starving forever");
  const unhealthy = assessVerifiedHandoverReadiness({
    quiet: { ok: false, state: "cancelled" },
    status: { ok: false, fatal: true, admission: { closed: false }, sessions: { sessions: [] } },
  });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.mode, "refused");
  const alreadyQuiet = assessVerifiedHandoverReadiness({
    quiet: { ok: true, state: "quiet" },
    status: { admission: { activeRequests: 0 }, sessions: { totalNonStreamActiveRequests: 0 } },
  });
  assert.equal(alreadyQuiet.mode, "pre-quiet");
}

{
  const result = await moduleUnderTest.waitForStableGatewayQuiet({
    statusProbe: async () => ({
      admission: { activeRequests: 0 },
      sessions: {
        totalActiveRequests: 4,
        sessions: [{ activeRequests: 4, eventStreams: 4 }],
      },
    }),
    pollMs: 1,
    consecutiveQuietSamples: 2,
  });
  assert.equal(result.ok, true, "persistent replayable event streams must not block Core handover forever");
  assert.equal(result.lastSessionActive, 0);
}

{
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 20);
  const result = await moduleUnderTest.waitForStableGatewayQuiet({
    statusProbe: async () => ({
      admission: { activeRequests: 0 },
      sessions: {
        totalActiveRequests: 4,
        sessions: [{ activeRequests: 4, eventStreams: 3 }],
      },
    }),
    timeoutMs: 1,
    pollMs: 2,
    consecutiveQuietSamples: 2,
    signal: controller.signal,
  });
  clearTimeout(cancellation);
  assert.equal(result.ok, false);
  assert.equal(result.state, "cancelled", "only explicit cancellation may stop quiet-boundary waiting");
  assert.equal(result.lastAdmissionActive, 0);
  assert.equal(result.lastSessionActive, 1, "one non-stream request must continue to block handover");
}

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-quiet",
  consecutiveQuietSamples: 2,
  wallClockTimeoutRemoved: true,
  replayableEventStreamsDoNotBlock: true,
  nonStreamRequestsStillBlock: true,
  busyMultiMainFallsThroughToControllerDrain: true,
}));
