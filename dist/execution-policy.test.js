import assert from "node:assert/strict";
import { DEVSPACE_EXECUTION_POLICY, executionPolicySnapshot } from "./execution-policy.js";
assert.equal(DEVSPACE_EXECUTION_POLICY.mode, "danger-full-access");
assert.equal(DEVSPACE_EXECUTION_POLICY.approvalPolicy, "never");
assert.equal(DEVSPACE_EXECUTION_POLICY.sandboxEnabled, false);
assert.deepEqual(DEVSPACE_EXECUTION_POLICY.alternativeModes, []);
assert.deepEqual(executionPolicySnapshot(), {
  mode: "danger-full-access",
  approvalPolicy: "never",
  sandboxEnabled: false,
  alternativeModes: [],
  ownerSelected: true,
  scope: "single-user-local-workspace",
});
console.log(JSON.stringify({ ok: true, gate: "execution-policy", fullAccessOnly: true, sandboxModes: 0 }));
