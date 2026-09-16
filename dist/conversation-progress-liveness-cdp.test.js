import assert from "node:assert/strict";
import { ConversationProgressLivenessCdpAdapter } from "./conversation-progress-liveness-cdp.js";

const targets = new Map([
  [9721, [{
    id: "page-a",
    type: "page",
    url: "https://chatgpt.com/c/conversation-a",
    webSocketDebuggerUrl: "ws://page-a",
    snapshot: {
      exact: true,
      conversationId: "conversation-a",
      hydrated: true,
      generating: true,
      latestMessageRole: "user",
      hasTurnError: false,
      normalCompletion: false,
      incompleteUserTurn: false,
      composerFound: true,
      composerEmpty: true,
      progressCardMounted: true,
      progressConversationId: "conversation-a",
      url: "https://chatgpt.com/c/conversation-a",
    },
  }]],
  [9732, [{
    id: "page-b",
    type: "page",
    url: "https://chatgpt.com/c/conversation-b",
    webSocketDebuggerUrl: "ws://page-b",
    snapshot: {
      exact: true,
      conversationId: "conversation-b",
      hydrated: true,
      generating: false,
      latestMessageRole: "assistant",
      hasTurnError: false,
      normalCompletion: true,
      incompleteUserTurn: false,
      composerFound: true,
      composerEmpty: true,
      progressCardMounted: true,
      progressConversationId: "conversation-b",
      url: "https://chatgpt.com/c/conversation-b",
    },
  }]],
]);

const adapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01", "main-02"],
  async listTargets(port) {
    return structuredClone(targets.get(port) || []);
  },
  async connect(target) {
    return {
      async evaluate() { return structuredClone(target.snapshot); },
      close() {},
    };
  },
});

const unique = await adapter.findUniqueActiveConversation({
  requireGenerating: true,
  requireProgressCard: true,
});
assert.equal(unique.exact, true);
assert.equal(unique.pageVerified, true);
assert.equal(unique.uniqueActiveConversation, true);
assert.equal(unique.conversationId, "conversation-a");
assert.equal(unique.runtimeKey, "main-01");
assert.equal(unique.runtimeBinding, false);

const secondTarget = targets.get(9732)[0];
secondTarget.snapshot.generating = true;
secondTarget.snapshot.normalCompletion = false;
secondTarget.snapshot.latestMessageRole = "user";
const ambiguous = await adapter.findUniqueActiveConversation({
  requireGenerating: true,
  requireProgressCard: true,
});
assert.equal(ambiguous.exact, false);
assert.equal(ambiguous.ambiguous, true);
assert.equal(ambiguous.state, "multiple-active-conversation-pages");
assert.equal(ambiguous.matchCount, 2);

secondTarget.snapshot.generating = false;
secondTarget.snapshot.normalCompletion = true;
const firstTarget = targets.get(9721)[0];
firstTarget.snapshot.progressConversationId = "conversation-other";
const rejectedWrongCardOwner = await adapter.findUniqueActiveConversation({
  requireGenerating: true,
  requireProgressCard: true,
});
assert.equal(rejectedWrongCardOwner.exact, false);
assert.equal(rejectedWrongCardOwner.state, "no-active-conversation-page");

firstTarget.snapshot.progressConversationId = "conversation-a";
firstTarget.snapshot.generating = false;
firstTarget.snapshot.incompleteUserTurn = true;
const incompleteAllowed = await adapter.findUniqueActiveConversation({
  requireGenerating: true,
  allowIncompleteUserTurn: true,
  requireProgressCard: true,
});
assert.equal(incompleteAllowed.exact, true);
assert.equal(incompleteAllowed.conversationId, "conversation-a");
const incompleteRejected = await adapter.findUniqueActiveConversation({
  requireGenerating: true,
  allowIncompleteUserTurn: false,
  requireProgressCard: true,
});
assert.equal(incompleteRejected.exact, false);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-progress-liveness-cdp",
  uniqueActivePageFallback: true,
  duplicateActivePagesFailClosed: true,
  progressCardOwnerRequired: true,
  runtimeLocatorOnly: true,
  incompleteUserTurnOptInOnly: true,
}));
