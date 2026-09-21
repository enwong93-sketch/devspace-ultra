import assert from "node:assert/strict";
import { StableGatewayAdmissionGate } from "./stable-gateway-admission.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gate = new StableGatewayAdmissionGate();
await gate.enter();
assert.equal(gate.snapshot().activeRequests, 1);
gate.closeAdmission();

let queuedEntered = false;
const queued = gate.enter({ timeoutMs: 250 }).then(() => { queuedEntered = true; });
let streamGateOpened = false;
assert.equal(typeof gate.waitForOpen, "function", "replayable MCP streams need a barrier-only wait that never counts against HTTP drain");
const streamGate = gate.waitForOpen({ timeoutMs: 250 }).then(() => { streamGateOpened = true; });
await sleep(15);
assert.equal(queuedEntered, false);
assert.equal(streamGateOpened, false);
assert.equal(gate.snapshot().activeRequests, 1, "barrier-only stream wait must not increment active request accounting");
assert.equal(gate.snapshot().queuedRequests, 2);

let drained = false;
const drain = gate.waitForDrain(250).then(() => { drained = true; });
await sleep(15);
assert.equal(drained, false);
gate.leave();
await drain;
assert.equal(drained, true);

assert.equal(gate.openAdmission(), true);
await Promise.all([queued, streamGate]);
assert.equal(queuedEntered, true);
assert.equal(streamGateOpened, true);
assert.equal(gate.snapshot().activeRequests, 1, "only the normal queued request enters drain accounting after admission opens");
gate.leave();
assert.deepEqual(gate.snapshot(), { closed: false, activeRequests: 0, queuedRequests: 0 });

{
  const cancelled = new StableGatewayAdmissionGate();
  cancelled.closeAdmission();
  const normalAbort = new AbortController();
  const streamAbort = new AbortController();
  const normal = cancelled.enter({ signal: normalAbort.signal });
  const stream = cancelled.waitForOpen({ signal: streamAbort.signal });
  await sleep(5);
  assert.equal(cancelled.snapshot().queuedRequests, 2);
  normalAbort.abort();
  streamAbort.abort();
  assert.equal(await normal, false);
  assert.equal(await stream, false);
  assert.deepEqual(cancelled.snapshot(), { closed: true, activeRequests: 0, queuedRequests: 0 },
    "clients that disconnect behind a handover barrier must not leak admission waiters or active counts");
}

{
  const preAborted = new StableGatewayAdmissionGate();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await preAborted.enter({ signal: controller.signal }), false);
  assert.equal(preAborted.snapshot().activeRequests, 0,
    "a request closed before the async enter continuation must never increment active admission accounting");
}

console.log(JSON.stringify({
  ok: true,
  gate: "stable-gateway-admission",
  abortedWaitersReleased: true,
  preAdmissionDisconnectDoesNotLeak: true,
}));
