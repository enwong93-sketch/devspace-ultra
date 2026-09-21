import assert from "node:assert/strict";
import { ConversationProgressLivenessCdpAdapter, isClassicTurnErrorText, _test } from "./conversation-progress-liveness-cdp.js";

assert.equal(isClassicTurnErrorText("思考失敗"), true);
assert.equal(isClassicTurnErrorText("思考失败"), true);
assert.equal(isClassicTurnErrorText("Thinking failed"), true);
assert.equal(isClassicTurnErrorText("Thought failed"), true);
assert.equal(isClassicTurnErrorText("正常完成"), false);
const exactInspectionSource = _test.exactConversationExpression("conversation-error-scope");
assert.match(exactInspectionSource, /section\[data-testid\^=\\?"conversation-turn-/,
  "failure detection must inspect the latest ChatGPT turn section, not only the message article");
assert.match(exactInspectionSource, /const latestTurnContainer = turnSections\.at\(-1\)/,
  "a role-less failed assistant turn must remain visible as the last turn boundary");
assert.match(exactInspectionSource, /latestTurnMessages\.at\(-1\) \|\| messageNodes\.at\(-1\)/,
  "older role-bearing message metadata may be used only after selecting the current turn section");
assert.match(exactInspectionSource, /querySelectorAll\('button,/,
  "the unlabelled Thinking failed button must be included in scoped error candidates");
assert.match(exactInspectionSource, /思考失敗/);

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

firstTarget.url = "https://chatgpt.com/c/conversation-duplicate";
firstTarget.snapshot = {
  ...firstTarget.snapshot,
  conversationId: "conversation-duplicate",
  url: firstTarget.url,
  hydrated: true,
  composerFound: true,
  composerEmpty: true,
  generating: true,
  latestMessageRole: "user",
  hasTurnError: true,
  normalCompletion: false,
  incompleteUserTurn: false,
};
secondTarget.url = "https://chatgpt.com/c/conversation-duplicate";
secondTarget.snapshot = {
  ...secondTarget.snapshot,
  conversationId: "conversation-duplicate",
  url: secondTarget.url,
  hydrated: true,
  composerFound: true,
  composerEmpty: true,
  generating: false,
  latestMessageRole: "assistant",
  hasTurnError: false,
  normalCompletion: true,
  incompleteUserTurn: false,
};
const uniqueActiveDuplicate = await adapter.find({ conversationId: "conversation-duplicate" });
assert.equal(uniqueActiveDuplicate.exact, true);
assert.equal(uniqueActiveDuplicate.runtimeKey, "main-01");
assert.equal(uniqueActiveDuplicate.duplicatePageObserved, true);
assert.equal(uniqueActiveDuplicate.duplicateResolvedByUniqueActivePage, true);
assert.equal(uniqueActiveDuplicate.duplicateMatchCount, 2);

secondTarget.snapshot.generating = true;
secondTarget.snapshot.latestMessageRole = "user";
secondTarget.snapshot.normalCompletion = false;
const twoActiveDuplicates = await adapter.find({ conversationId: "conversation-duplicate" });
assert.equal(twoActiveDuplicates.exact, false);
assert.equal(twoActiveDuplicates.ambiguous, true);
assert.equal(twoActiveDuplicates.state, "duplicate-conversation-pages");
assert.equal(twoActiveDuplicates.activeMatchCount, 2);

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-progress-liveness-cdp",
  uniqueActivePageFallback: true,
  duplicateActivePagesFailClosed: true,
  progressCardOwnerRequired: true,
  runtimeLocatorOnly: true,
  incompleteUserTurnOptInOnly: true,
  thinkingFailedLocalized: true,
  latestTurnSectionScoped: true,
  duplicateConversationUniqueActiveResolved: true,
  multipleActiveDuplicatesFailClosed: true,
}));
