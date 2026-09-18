import assert from "node:assert/strict";
import { ProgressClaimCdpResolver, progressClaimCdpInternals } from "./conversation-start-claim-cdp.js";

const chosen = progressClaimCdpInternals.chooseAppContext({
  contexts: [
    { id: 1, auxData: { isDefault: true, frameId: "iframe-target" } },
    { id: 2, auxData: { isDefault: true, frameId: "inner-app-frame" } },
  ],
}, "iframe-target");
assert.equal(chosen?.id, 2);

const claimId = "claim_12345678901234567890";
const pages = {
  9732: [
    { id: "page-02", type: "page", url: "https://chatgpt.com/c/conversation-main-02" },
    { id: "frame-02", parentId: "page-02", type: "iframe", webSocketDebuggerUrl: "ws://frame-02" },
  ],
  9733: [
    { id: "page-03", type: "page", url: "https://chatgpt.com/g/project/c/conversation-main-03" },
    { id: "frame-03", parentId: "page-03", type: "iframe", webSocketDebuggerUrl: "ws://frame-03" },
  ],
};

const resolver = new ProgressClaimCdpResolver({
  ports: [9732, 9733],
  listTargets: async (port) => pages[port] || [],
  evaluateTarget: async (target, expected) => target.id === "frame-03" && expected === claimId,
  now: () => Date.parse("2026-09-18T15:00:00.000Z"),
});
const found = await resolver.find({ claimId });
assert.equal(found.conversationId, "conversation-main-03");
assert.equal(found.runtimeKey, "main-03");
assert.equal(found.claimId, claimId);
assert.equal(found.pageVerified, true);
assert.equal(found.source, "classic-exact-page-progress-claim-cdp-page-verified");

const ambiguous = new ProgressClaimCdpResolver({
  ports: [9732, 9733],
  listTargets: async (port) => pages[port] || [],
  evaluateTarget: async () => true,
});
assert.equal(await ambiguous.find({ claimId }), null);
assert.equal(await resolver.find({ claimId: "short" }), null);

console.log(JSON.stringify({ ok: true, gate: "progress-claim-cdp", exactIframeParentPageProof: true, innerAppExecutionContext: true, crossMainAmbiguityFailsClosed: true }));
