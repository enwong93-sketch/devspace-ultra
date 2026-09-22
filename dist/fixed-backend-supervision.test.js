import assert from "node:assert/strict";
import { classifySupervisedGatewayExit } from "./fixed-backend-supervision.js";

assert.deepEqual(classifySupervisedGatewayExit({ code: 0, peerState: "ready" }), {
  exitCode: 0, state: "peer-gateway-ready", unexpected: false,
});
assert.equal(classifySupervisedGatewayExit({ code: 0, peerState: "down" }).exitCode, 1,
  "a clean child exit is still a failure while the supervised Gateway is down");
assert.equal(classifySupervisedGatewayExit({ code: null, signal: "SIGTERM", peerState: "down" }).exitCode, 1);
assert.equal(classifySupervisedGatewayExit({ code: 137, peerState: "down" }).exitCode, 137);

console.log(JSON.stringify({
  ok: true,
  gate: "fixed-backend-supervision",
  unexpectedCleanExitFailsTask: true,
  peerStartupRaceAccepted: true,
}));
