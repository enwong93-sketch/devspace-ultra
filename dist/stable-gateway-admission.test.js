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

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-admission" }));
