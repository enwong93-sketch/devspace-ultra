import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStableGatewayRuntime } from "./devspace-stable-gateway.mjs";

const temp = await mkdtemp(join(tmpdir(), "devspace-gateway-degraded-"));
let attempts = 0;
let ready = false;
let closed = false;
const controller = {
  async start() {
    attempts += 1;
    if (attempts < 3) throw new ReferenceError("simulated Core startup regression");
    ready = true;
    return this.status();
  },
  async handover() {
    return { ok: false, state: "not-needed" };
  },
  handlePublicRequest(_req, res) {
    res.statusCode = ready ? 200 : 503;
    res.end(ready ? "ready" : "degraded");
  },
  status() {
    return {
      ok: ready && !closed,
      activeSlot: ready ? "a" : null,
      activePid: ready ? 12345 : null,
      fatal: false,
      fatalCoreRecoveryError: null,
      handoverInProgress: false,
      admission: { activeRequests: 0 },
      sessions: { sessions: [] },
    };
  },
  async close() {
    closed = true;
    ready = false;
  },
};

const runtime = await startStableGatewayRuntime({
  gatewayPort: 0,
  configDir: temp,
  stateDir: temp,
  controller,
  controlToken: "degraded-startup-control-token-local-only",
  // Keep the first retry outside the initial HTTP assertion window so the
  // gate validates the degraded listener deterministically on slower hosts.
  coreStartRetryMs: 500,
});

try {
  const base = `http://127.0.0.1:${runtime.gatewayPort}`;
  const first = await fetch(`${base}/__devspace/gateway/healthz`);
  const firstBody = await first.json();
  assert.equal(first.status, 503);
  assert.equal(firstBody.ok, false);
  assert.equal(firstBody.state, "degraded");
  assert.equal(firstBody.coreStartup.attempts, 1);
  assert.equal(firstBody.coreStartup.lastErrorName, "ReferenceError");
  const publicWhileDegraded = await fetch(`${base}/mcp`);
  assert.equal(publicWhileDegraded.status, 503);

  const deadline = Date.now() + 2_000;
  let finalResponse = null;
  let finalBody = null;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    finalResponse = await fetch(`${base}/__devspace/gateway/healthz`);
    finalBody = await finalResponse.json();
    if (finalResponse.status === 200 && finalBody.ok === true) break;
  }
  assert.equal(finalResponse?.status, 200);
  assert.equal(finalBody?.ok, true);
  assert.equal(finalBody?.state, "ready");
  assert.equal(runtime.gatewayPort > 0, true);
  assert.equal(attempts, 3);

  console.log(JSON.stringify({
    ok: true,
    gate: "stable-gateway-degraded-startup",
    listenerSurvivesCoreFailure: true,
    degradedHttpStatus: 503,
    automaticRetry: true,
    recoveredWithoutGatewayRestart: true,
    startupAttempts: attempts,
  }));
} finally {
  await runtime.close();
  await rm(temp, { recursive: true, force: true });
}
