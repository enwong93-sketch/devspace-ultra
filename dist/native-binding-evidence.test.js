import assert from "node:assert/strict";
import { validateNativeGoalBinding } from "./native-binding-evidence.js";

const goal = {
  id: "goal_123",
  status: "active",
  round: 6,
  revision: 40,
  conversationId: "6a8b1234-1234-83e8-9999-123456789abc",
};
const authority = {
  records: [{
    conversationId: goal.conversationId,
    sessionFingerprint: "a".repeat(64),
    runtimeKeys: ["main-01"],
  }],
};
const valid = validateNativeGoalBinding(goal, authority);
assert.equal(valid.ok, true);
assert.equal(valid.conversationId, goal.conversationId);
assert.equal(valid.runtimeKey, "main-01");
assert.equal(valid.sessionFingerprintPresent, true);

assert.throws(
  () => validateNativeGoalBinding({ ...goal, conversationId: null }, authority),
  /no valid native conversation binding/i,
);
assert.throws(
  () => validateNativeGoalBinding(goal, { records: [] }),
  /absent from the native authority registry/i,
);
assert.throws(
  () => validateNativeGoalBinding(goal, { records: [{ conversationId: goal.conversationId, sessionFingerprint: "raw-session" }] }),
  /no hashed session fingerprint/i,
);
assert.throws(
  () => validateNativeGoalBinding(goal, {
    records: [
      { conversationId: goal.conversationId, sessionFingerprint: "a".repeat(64), runtimeKey: "main-01" },
      { conversationId: goal.conversationId, sessionFingerprint: "b".repeat(64), runtimeKey: "main-02" },
    ],
  }),
  /ambiguous across runtimes/i,
);

console.log(JSON.stringify({
  ok: true,
  gate: "native-binding-evidence",
  hashedSessionRequired: true,
  runtimeAmbiguityFailsClosed: true,
}));
