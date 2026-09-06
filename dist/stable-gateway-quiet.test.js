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
    timeoutMs: 2_000,
    pollMs: 1,
    consecutiveQuietSamples: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.quietSamples, 2);
  assert.equal(calls, 5, "a busy sample must reset the consecutive quiet counter");
}

{
  const result = await moduleUnderTest.waitForStableGatewayQuiet({
    statusProbe: async () => ({ admission: { activeRequests: 0 }, sessions: { totalActiveRequests: 1 } }),
    timeoutMs: 20,
    pollMs: 2,
    consecutiveQuietSamples: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "quiet-timeout");
  assert.equal(result.lastAdmissionActive, 0);
  assert.equal(result.lastSessionActive, 1);
}

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-quiet", consecutiveQuietSamples: 2 }));
