import assert from "node:assert/strict";
import { ConversationStartClaimRegistry } from "./conversation-start-claim-registry.js";

let now = Date.parse("2026-09-17T03:00:00.000Z");
let nextId = 0;
const registry = new ConversationStartClaimRegistry({
  now: () => now,
  ttlMs: 10_000,
  maxClaims: 8,
  createId: () => `claim_${String(++nextId).padStart(20, "0")}`,
});

const authority = {
  conversationId: "conversation-main-03",
  runtimeKey: "main-03",
  callFingerprint: "a".repeat(64),
  invocationFingerprint: "b".repeat(64),
  source: "classic-native-call-mcp-correlation-page-verified",
  observedAt: new Date(now).toISOString(),
  pageVerified: true,
};

const created = registry.create({
  toolName: "devspace_goal_start",
  input: {
    objective: "Keep the real objective private inside the bounded claim registry",
    successCriteria: ["Bind to the exact page"],
  },
});
assert.equal(created.toolName, "devspace_goal_start");
assert.equal(created.state, "pending");
assert.equal(registry.pendingClaims()[0]?.claimId, created.claimId);
assert.equal(JSON.stringify(created).includes("real objective"), false);
assert.equal(registry.inspect({ claimId: created.claimId, toolName: "devspace_plan_start" }), null,
  "a claim must never be redeemable through a different start tool");

const completed = await registry.claim({
  claimId: created.claimId,
  toolName: "devspace_goal_start",
  authority,
  complete: async ({ input, authority: owner }) => ({
    goal: { id: "goal-a", conversationId: owner.conversationId, objective: input.objective },
  }),
});
assert.equal(completed.goal.conversationId, "conversation-main-03");
assert.equal(registry.pendingClaims().some((item) => item.claimId === created.claimId), false);
assert.equal(registry.inspect({ claimId: created.claimId, toolName: "devspace_goal_start" }).completed, true);
assert.deepEqual(await registry.claim({
  claimId: created.claimId,
  toolName: "devspace_goal_start",
  authority,
  complete: async () => { throw new Error("must not run twice"); },
}), completed, "duplicate exact-page relay delivery must be idempotent");

const planClaim = registry.create({
  toolName: "devspace_plan_start",
  input: {
    title: "Private plan title",
    steps: [
      { text: "one", status: "in_progress" },
      { text: "two", status: "pending" },
    ],
  },
});
await assert.rejects(() => registry.claim({
  claimId: planClaim.claimId,
  toolName: "devspace_plan_start",
  authority: { ...authority, pageVerified: false },
  complete: async () => ({}),
}), /exact page-verified/i);

await registry.claim({
  claimId: planClaim.claimId,
  toolName: "devspace_plan_start",
  authority,
  complete: async ({ authority: owner }) => ({ plan: { id: "plan-a", conversationId: owner.conversationId } }),
});
await assert.rejects(() => registry.claim({
  claimId: planClaim.claimId,
  toolName: "devspace_plan_start",
  authority: { ...authority, conversationId: "conversation-other", runtimeKey: "main-02" },
  complete: async () => ({}),
}), /another conversation page/i);

const expiring = registry.create({
  toolName: "devspace_goal_start",
  input: { objective: "expire", successCriteria: ["expire"] },
});
now += 20_000;
registry.prune();
assert.equal(registry.inspect({ claimId: expiring.claimId, toolName: "devspace_goal_start" }), null);

const diagnostics = registry.diagnostics();
assert.equal(diagnostics.rawInputsExposed, false);
assert.equal(diagnostics.durableConversationOwners, 0);
assert.equal(JSON.stringify(diagnostics).includes("Private plan title"), false);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-start-claim-registry",
  exactPageAuthorityRequired: true,
  goalAndPlanOnly: true,
  crossConversationClaimRejected: true,
  duplicateRelayIdempotent: true,
  boundedInMemoryOnly: true,
  rawInputsExposed: false,
}));
