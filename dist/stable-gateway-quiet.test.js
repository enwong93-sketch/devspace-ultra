import assert from "node:assert/strict";

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
}));
