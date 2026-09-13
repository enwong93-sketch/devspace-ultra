import assert from "node:assert/strict";
import {
  EXACT_CONVERSATION_REQUEST_PROOF,
  EXACT_PAGE_BRIDGE_PROOF,
  hasVerifiedProgressOwnership,
  isProjectableProgressMessage,
  normalizeProgressOwnershipProof,
} from "./progress-ownership-proof.js";

const direct = {
  conversationId: "conversation-proof-a",
  source: "agent-progress-tool",
  ownershipProof: EXACT_CONVERSATION_REQUEST_PROOF,
  ownershipSource: "classic-websocket-tool-invocation-correlation-page-verified",
  ownershipObservedAt: "2026-09-13T04:00:00.000Z",
  ownershipRuntimeKey: "main-02",
  ownershipCallFingerprint: "a".repeat(64),
  ownershipInvocationFingerprint: "b".repeat(64),
};
assert.equal(hasVerifiedProgressOwnership(direct), true);
assert.equal(isProjectableProgressMessage(direct), true);
assert.deepEqual(normalizeProgressOwnershipProof(direct), {
  ownershipProof: EXACT_CONVERSATION_REQUEST_PROOF,
  ownershipSource: direct.ownershipSource,
  ownershipObservedAt: direct.ownershipObservedAt,
  ownershipRuntimeKey: "main-02",
  ownershipCallFingerprint: "a".repeat(64),
  ownershipInvocationFingerprint: "b".repeat(64),
});

assert.equal(hasVerifiedProgressOwnership({ ...direct, ownershipCallFingerprint: null }), false);
assert.equal(hasVerifiedProgressOwnership({ ...direct, ownershipSource: "classic-native-turn" }), false);
assert.equal(isProjectableProgressMessage({
  conversationId: "conversation-proof-a",
  source: "agent-progress-tool",
}), false, "legacy unproved narration must stay diagnostic-only");

const bridge = {
  conversationId: "conversation-proof-b",
  source: "agent-progress-tool",
  ownershipProof: EXACT_PAGE_BRIDGE_PROOF,
  ownershipSource: "devspace-conversation-bridge",
  ownershipObservedAt: "2026-09-13T04:01:00.000Z",
  ownershipRuntimeKey: "main-03",
};
assert.equal(hasVerifiedProgressOwnership(bridge), true);
assert.equal(isProjectableProgressMessage(bridge), true);
assert.equal(hasVerifiedProgressOwnership({ ...bridge, ownershipSource: "another-bridge" }), false);
assert.equal(isProjectableProgressMessage({
  conversationId: "conversation-proof-goal",
  source: "goal-round-report",
}), true);

console.log(JSON.stringify({
  ok: true,
  gate: "progress-ownership-proof",
  directRequestProof: true,
  exactPageBridgeProof: true,
  legacyUnprovedRowsHidden: true,
  goalRoundReportsPreserved: true,
}));
