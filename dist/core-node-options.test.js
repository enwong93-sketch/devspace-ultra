import assert from "node:assert/strict";
import {
  CORE_HEAP_PROFILES,
  nodeArgsForCoreHeapProfile,
  normalizeCoreHeapProfile,
  validateCoreNodeArgs,
} from "./core-node-options.js";

assert.deepEqual(CORE_HEAP_PROFILES, ["system", "bounded-512"]);
assert.equal(normalizeCoreHeapProfile(undefined), "system");
assert.equal(normalizeCoreHeapProfile("BOUNDED-512"), "bounded-512");
assert.deepEqual(nodeArgsForCoreHeapProfile("system"), []);
assert.deepEqual(nodeArgsForCoreHeapProfile("bounded-512"), [
  "--max-old-space-size=464",
  "--max-semi-space-size=16",
]);
assert.notEqual(nodeArgsForCoreHeapProfile("bounded-512"), nodeArgsForCoreHeapProfile("bounded-512"));
assert.throws(() => normalizeCoreHeapProfile("1024"), /Invalid Stable Gateway Core heap profile/);
assert.deepEqual(validateCoreNodeArgs(["--max-old-space-size=464", "--max-semi-space-size=16"]), [
  "--max-old-space-size=464",
  "--max-semi-space-size=16",
]);
assert.throws(() => validateCoreNodeArgs(["--require=malicious.js"]), /Unsupported Stable Gateway Core Node argument/);
assert.throws(() => validateCoreNodeArgs("--max-old-space-size=464"), /must be an array/);

console.log(JSON.stringify({
  ok: true,
  gate: "core-node-options",
  verifiedProfile: "bounded-512",
  arbitraryNodeFlagsRejected: true,
}));
