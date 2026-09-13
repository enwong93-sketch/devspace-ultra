import assert from "node:assert/strict";
import { ProgressClaimRegistry } from "./progress-claim-registry.js";

let now = Date.parse("2026-09-13T08:00:00.000Z");
let ids = 0;
const registry = new ProgressClaimRegistry({
  now: () => now,
  ttlMs: 5_000,
  maxClaims: 4,
  createId: () => `progress-claim-${String(++ids).padStart(4, "0")}`,
});

const claim = registry.create({ message: "Exact progress message", kind: "verification" });
assert.equal(claim.state, "pending");
assert.equal(registry.diagnostics().pending, 1);
assert.equal(JSON.stringify(registry.diagnostics()).includes("Exact progress message"), false);

const authorityA = {
  conversationId: "conversation-progress-a",
  runtimeKey: "main-02",
  callFingerprint: "a".repeat(64),
  invocationFingerprint: "b".repeat(64),
  observedAt: new Date(now).toISOString(),
  source: "classic-native-call-mcp-correlation-page-verified",
  pageVerified: true,
};
let writes = 0;
const completed = await registry.claim({
  claimId: claim.claimId,
  authority: authorityA,
  complete: async ({ message, kind, authority }) => {
    writes += 1;
    assert.equal(message, "Exact progress message");
    assert.equal(kind, "verification");
    assert.equal(authority.conversationId, "conversation-progress-a");
    return { messageCount: 1, updatedAt: new Date(now).toISOString() };
  },
});
assert.equal(completed.conversationId, "conversation-progress-a");
assert.equal(writes, 1);

const duplicate = await registry.claim({
  claimId: claim.claimId,
  authority: authorityA,
  complete: async () => { writes += 1; },
});
assert.deepEqual(duplicate, completed);
assert.equal(writes, 1, "duplicate relay mounts must not write progress twice");

await assert.rejects(
  registry.claim({
    claimId: claim.claimId,
    authority: { ...authorityA, conversationId: "conversation-progress-b", runtimeKey: "main-03" },
    complete: async () => ({}),
  }),
  /another conversation page/,
);

const invalid = registry.create({ message: "Unverified", kind: "progress" });
await assert.rejects(
  registry.claim({
    claimId: invalid.claimId,
    authority: { ...authorityA, pageVerified: false },
    complete: async () => ({}),
  }),
  /exact page-verified/,
);

const expired = registry.create({ message: "Expire without write", kind: "progress" });
now += 5_001;
registry.prune();
await assert.rejects(
  registry.claim({ claimId: expired.claimId, authority: authorityA, complete: async () => ({}) }),
  /unavailable or expired/,
);
assert.equal(registry.diagnostics().durableConversationOwners, 0);

console.log(JSON.stringify({
  ok: true,
  gate: "progress-claim-registry",
  exactPageAuthorityRequired: true,
  crossConversationClaimRejected: true,
  duplicateClaimIdempotent: true,
  expiredClaimWritesNothing: true,
  rawMessagesExposed: false,
  durableConversationOwners: 0,
}));
