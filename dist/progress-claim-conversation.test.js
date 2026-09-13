import assert from "node:assert/strict";
import { ClassicMcpCallCorrelator, fingerprintMcpToolCall } from "./classic-mcp-call-correlation.js";
import { ProgressClaimRegistry } from "./progress-claim-registry.js";

let now = 20_000;
const claims = new ProgressClaimRegistry({
  now: () => now,
  ttlMs: 10_000,
  createId: (() => {
    let next = 0;
    return () => `claim-exact-page-${String(++next).padStart(4, "0")}`;
  })(),
});
const correlator = new ClassicMcpCallCorrelator({
  now: () => now,
  ttlMs: 5_000,
  maxSkewMs: 1_000,
  waitTimeoutMs: 50,
});

const pendingA = claims.create({ message: "Progress for conversation A", kind: "milestone" });
const callA = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { claimId: pendingA.claimId },
});
correlator.noteNative({
  callFingerprint: callA,
  conversationId: "conversation-progress-a",
  runtimeKey: "main-02",
  toolName: "devspace_progress_report",
  source: "classic-native-call-mcp",
  observedAtMs: now,
});
const exactA = correlator.noteGateway({
  callFingerprint: callA,
  sessionFingerprint: "a".repeat(64),
  gatewayRequestId: "gateway-progress-a",
  toolName: "devspace_progress_report",
  observedAtMs: now + 10,
});
assert.equal(exactA?.conversationId, "conversation-progress-a");
assert.equal(exactA?.runtimeKey, "main-02");
assert.equal(exactA?.gatewayRequestId, "gateway-progress-a");

const writes = [];
await claims.claim({
  claimId: pendingA.claimId,
  authority: {
    ...exactA,
    pageVerified: true,
    source: `${exactA.source}-page-verified`,
  },
  complete: async ({ message, authority }) => {
    writes.push({ message, conversationId: authority.conversationId });
    return { messageCount: 1 };
  },
});
assert.deepEqual(writes, [{
  message: "Progress for conversation A",
  conversationId: "conversation-progress-a",
}]);

// Identical human-readable messages in another chat get distinct claim ids and
// therefore distinct canonical tool fingerprints.
now += 100;
const pendingB = claims.create({ message: "Progress for conversation A", kind: "milestone" });
const callB = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { claimId: pendingB.claimId },
});
assert.notEqual(callA, callB);
correlator.noteNative({
  callFingerprint: callB,
  conversationId: "conversation-progress-b",
  runtimeKey: "main-03",
  toolName: "devspace_progress_report",
  source: "classic-native-call-mcp",
  observedAtMs: now,
});
const exactB = correlator.noteGateway({
  callFingerprint: callB,
  sessionFingerprint: "a".repeat(64),
  gatewayRequestId: "gateway-progress-b",
  toolName: "devspace_progress_report",
  observedAtMs: now + 5,
});
assert.equal(exactB?.conversationId, "conversation-progress-b",
  "a reused server-side session cannot move a one-time page claim to another conversation");

// Two exact pages presenting the same claim fingerprint at equal skew are
// ambiguous and must write nothing.
now += 100;
const ambiguousClaim = claims.create({ message: "Never project ambiguously", kind: "progress" });
const ambiguousCall = fingerprintMcpToolCall("tools/call", {
  name: "devspace_progress_report",
  arguments: { claimId: ambiguousClaim.claimId },
});
correlator.noteNative({
  callFingerprint: ambiguousCall,
  conversationId: "conversation-duplicate-a",
  runtimeKey: "main-04",
  toolName: "devspace_progress_report",
  source: "classic-native-call-mcp",
  observedAtMs: now,
});
correlator.noteNative({
  callFingerprint: ambiguousCall,
  conversationId: "conversation-duplicate-b",
  runtimeKey: "main-05",
  toolName: "devspace_progress_report",
  source: "classic-native-call-mcp",
  observedAtMs: now,
});
assert.equal(correlator.noteGateway({
  callFingerprint: ambiguousCall,
  sessionFingerprint: "b".repeat(64),
  gatewayRequestId: "gateway-ambiguous",
  toolName: "devspace_progress_report",
  observedAtMs: now,
}), null);
assert.equal(correlator.diagnostics().ambiguousMatches > 0, true);
assert.equal(claims.diagnostics().pending > 0, true,
  "an ambiguous browser claim must remain unwritten until it expires");

console.log(JSON.stringify({
  ok: true,
  gate: "progress-claim-conversation",
  oneTimeClaimFingerprint: true,
  reusedSessionCannotSelectOwner: true,
  duplicatePagesFailClosed: true,
  exactConversationWritesOnly: true,
}));
