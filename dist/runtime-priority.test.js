import assert from "node:assert/strict";
import { applyDevspaceRuntimePriority, devspaceRuntimePriorityTargets } from "./runtime-priority.js";

assert.equal(devspaceRuntimePriorityTargets.launcher, 0);
assert.equal(devspaceRuntimePriorityTargets.core, 0);
assert.equal(devspaceRuntimePriorityTargets.gateway, -7);
assert.equal(Object.values(devspaceRuntimePriorityTargets).some(value => value < -7), false,
  "DevSpace must never use High or Realtime process priority");

let current = 10;
const calls = [];
const gateway = applyDevspaceRuntimePriority("gateway", {
  pid: 42,
  platform: "win32",
  getPriorityImpl: () => current,
  setPriorityImpl: (pid, value) => { calls.push({ pid, value }); current = value; },
});
assert.equal(gateway.ok, true);
assert.deepEqual(calls, [{ pid: 42, value: -7 }]);
assert.equal(gateway.before, 10);
assert.equal(gateway.after, -7);

current = -7;
const core = applyDevspaceRuntimePriority("core", {
  pid: 99,
  platform: "win32",
  getPriorityImpl: () => current,
  setPriorityImpl: (_pid, value) => { current = value; },
});
assert.equal(core.ok, true);
assert.equal(core.after, 0, "Core work must be lowered back to Normal after inheriting Gateway priority");

const denied = applyDevspaceRuntimePriority("launcher", {
  platform: "win32",
  getPriorityImpl: () => { throw Object.assign(new Error("denied"), { name: "SystemError" }); },
});
assert.equal(denied.ok, false);
assert.equal(denied.errorName, "SystemError");
assert.equal(applyDevspaceRuntimePriority("gateway", { platform: "linux" }).reason, "non-windows");
assert.throws(() => applyDevspaceRuntimePriority("realtime"), /Unknown DevSpace runtime priority role/);

console.log(JSON.stringify({
  ok: true,
  gate: "runtime-priority",
  gatewayAboveNormal: true,
  coreNormal: true,
  highOrRealtimeExcluded: true,
  failureNonFatal: true,
}));
