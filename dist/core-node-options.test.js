import assert from "node:assert/strict";
import {
  CORE_HEAP_PROFILES,
  nodeArgsForCoreHeapProfile,
  normalizeCoreHeapProfile,
  validateCoreNodeArgs,
} from "./core-node-options.js";

assert.deepEqual(CORE_HEAP_PROFILES, ["system"]);
assert.equal(normalizeCoreHeapProfile(undefined), "system");
assert.equal(normalizeCoreHeapProfile("BOUNDED-512"), "system", "legacy capped profiles must migrate to system-managed sizing without applying a cap");
assert.deepEqual(nodeArgsForCoreHeapProfile("system"), ["--expose-gc"]);
assert.deepEqual(nodeArgsForCoreHeapProfile("bounded-512"), ["--expose-gc"]);
assert.notEqual(nodeArgsForCoreHeapProfile("system"), nodeArgsForCoreHeapProfile("system"));
assert.throws(() => normalizeCoreHeapProfile("1024"), /Production accepts only system-managed heap sizing/);
assert.throws(() => validateCoreNodeArgs(["--max-old-space-size=464"]), /memory caps are forbidden/);
assert.throws(() => validateCoreNodeArgs(["--max-semi-space-size=16"], { allowDiagnosticGc: true }), /memory caps are forbidden/);
assert.deepEqual(validateCoreNodeArgs(["--expose-gc"], { allowDiagnosticGc: true }), ["--expose-gc"]);
assert.throws(() => validateCoreNodeArgs(["--expose-gc"]), /Unsupported Stable Gateway Core Node argument/);
assert.throws(() => validateCoreNodeArgs(["--require=malicious.js"], { allowDiagnosticGc: true }), /Unsupported Stable Gateway Core Node argument/);
assert.throws(() => validateCoreNodeArgs("--max-old-space-size=464"), /must be an array/);

console.log(JSON.stringify({
  ok: true,
  gate: "core-node-options",
  verifiedProfile: "system",
  productionMemoryCapsRejected: true,
  arbitraryNodeFlagsRejected: true,
}));
