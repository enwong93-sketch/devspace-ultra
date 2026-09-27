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
    { id: "frame-03-claim", parentId: "page-03", type: "iframe", title: "https://asdk_app_local123.web-sandbox.oaiusercontent.com/?app=chatgpt", webSocketDebuggerUrl: "ws://frame-03-claim" },
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
assert.equal(found.appSandboxOrigin, "https://asdk_app_local123.web-sandbox.oaiusercontent.com");

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
    { id: "frame-03-duplicate", parentId: "page-03", type: "iframe", url: "https://asdk_app_local123.web-sandbox.oaiusercontent.com/?app=chatgpt", webSocketDebuggerUrl: "ws://frame-03-duplicate" },
  ],
  evaluateTarget: async (target) => ["frame-03-claim", "frame-03-duplicate"].includes(target.id),
});
assert.equal((await duplicateSamePage.find({ claimId }))?.conversationId, "conversation-main-03",
  "duplicate renderer mounts under the same exact page are one owner, not an ambiguity");

const crossConnectorSamePage = new ConversationStartClaimCdpResolver({
  ports: [9733],
  listTargets: async () => [
    ...pages[9733],
    { id: "frame-03-remote", parentId: "page-03", type: "iframe", title: "https://asdk_app_remote8740.web-sandbox.oaiusercontent.com/?app=chatgpt", webSocketDebuggerUrl: "ws://frame-03-remote" },
  ],
  evaluateTarget: async (target) => ["frame-03-claim", "frame-03-remote"].includes(target.id),
});
assert.equal(await crossConnectorSamePage.find({ claimId }), null,
  "the same claim appearing under two connector App origins must fail closed even on one page");

assert.equal(await resolver.find({ claimId: "short" }), null);

const crowdedFrames = Array.from({ length: 700 }, (_, index) => ({
  id: `crowded-${index}`,
  parentId: "page-crowded",
  type: "iframe",
  webSocketDebuggerUrl: `ws://crowded-${index}`,
}));
const crowded = new ConversationStartClaimCdpResolver({
  ports: [9734],
  maxIframes: 128,
  listTargets: async () => [
    { id: "page-crowded", type: "page", url: "https://chatgpt.com/c/conversation-crowded" },
    ...crowdedFrames,
  ],
  evaluateTarget: async (target) => target.id === "crowded-699",
});
const crowdedFound = await crowded.find({ claimId, claimType: "progress" });
assert.equal(crowdedFound?.conversationId, "conversation-crowded",
  "a newly mounted relay at either target-list edge must remain recoverable after historical iframe growth");
assert.ok(crowdedFound.inspectedIframes <= 128);
assert.equal(crowdedFound.inventoryIframes, 700);
assert.ok(crowdedFound.truncatedIframes >= 572);

const hiddenMiddle = new ConversationStartClaimCdpResolver({
  ports: [9734],
  maxIframes: 128,
  listTargets: crowded.listTargets,
  evaluateTarget: async (target) => target.id === "crowded-350",
});
assert.equal(await hiddenMiddle.find({ claimId, claimType: "progress" }), null,
  "an uninspected historical middle target must fail closed rather than be guessed");

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-start-claim-cdp",
  exactIframeParentPageProof: true,
  progressClaimProof: true,
  innerAppExecutionContext: true,
  duplicateSamePageAllowed: true,
  crossMainAmbiguityFailsClosed: true,
  crossConnectorAmbiguityFailsClosed: true,
  crowdedIframeRecoveryBounded: true,
  runtimeOnlyInference: false,
  pageNavigation: false,
}));
