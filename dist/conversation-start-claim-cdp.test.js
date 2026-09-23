import assert from "node:assert/strict";
import './claim-display-regression.test.js';
import {
  ConversationStartClaimCdpResolver,
  conversationStartClaimCdpInternals,
} from "./conversation-start-claim-cdp.js";

const chosenContext = conversationStartClaimCdpInternals.chooseAppContext({
  contexts: [
    { id: 1, auxData: { isDefault: true, frameId: "iframe-target" } },
    { id: 2, auxData: { isDefault: true, frameId: "inner-app-frame" } },
  ],
}, "iframe-target");
assert.equal(chosenContext?.id, 2,
  "claim resolver must evaluate window.openai in the MCP App inner execution context, not the outer iframe world");

const claimId = "claim_12345678901234567890";
const pages = {
  9732: [
    { id: "page-02", type: "page", url: "https://chatgpt.com/c/conversation-main-02" },
    { id: "frame-02-a", parentId: "page-02", type: "iframe", webSocketDebuggerUrl: "ws://frame-02-a" },
  ],
  9733: [
    { id: "page-03", type: "page", url: "https://chatgpt.com/g/project/c/conversation-main-03" },
    { id: "frame-03-old", parentId: "page-03", type: "iframe", webSocketDebuggerUrl: "ws://frame-03-old" },
    { id: "frame-03-claim", parentId: "page-03", type: "iframe", webSocketDebuggerUrl: "ws://frame-03-claim" },
  ],
};

const resolver = new ConversationStartClaimCdpResolver({
  ports: [9732, 9733],
  listTargets: async (port) => pages[port] || [],
  evaluateTarget: async (target, expected) => target.id === "frame-03-claim" && expected === claimId,
  now: () => Date.parse("2026-09-17T03:20:00.000Z"),
});
const found = await resolver.find({ claimId });
assert.equal(found.conversationId, "conversation-main-03");
assert.equal(found.runtimeKey, "main-03");
assert.equal(found.claimId, claimId);
assert.equal(found.pageVerified, true);
assert.equal(found.source, "classic-exact-page-start-claim-cdp-page-verified");

const progressFound = await resolver.find({ claimId, claimType: "progress" });
assert.equal(progressFound.conversationId, "conversation-main-03");
assert.equal(progressFound.runtimeKey, "main-03");
assert.equal(progressFound.source, "classic-exact-page-progress-claim-cdp-page-verified");

const ambiguous = new ConversationStartClaimCdpResolver({
  ports: [9732, 9733],
  listTargets: async (port) => pages[port] || [],
  evaluateTarget: async (target) => ["frame-02-a", "frame-03-claim"].includes(target.id),
});
assert.equal(await ambiguous.find({ claimId }), null,
  "the same claim observed under two ChatGPT pages must fail closed");

const duplicateSamePage = new ConversationStartClaimCdpResolver({
  ports: [9733],
  listTargets: async () => [
    ...pages[9733],
    { id: "frame-03-duplicate", parentId: "page-03", type: "iframe", webSocketDebuggerUrl: "ws://frame-03-duplicate" },
  ],
  evaluateTarget: async (target) => ["frame-03-claim", "frame-03-duplicate"].includes(target.id),
});
assert.equal((await duplicateSamePage.find({ claimId }))?.conversationId, "conversation-main-03",
  "duplicate renderer mounts under the same exact page are one owner, not an ambiguity");

assert.equal(await resolver.find({ claimId: "short" }), null);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-start-claim-cdp",
  exactIframeParentPageProof: true,
  progressClaimProof: true,
  innerAppExecutionContext: true,
  duplicateSamePageAllowed: true,
  crossMainAmbiguityFailsClosed: true,
  runtimeOnlyInference: false,
  pageNavigation: false,
}));
