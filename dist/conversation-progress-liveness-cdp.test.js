import assert from "node:assert/strict";
import { ConversationProgressLivenessCdpAdapter, isClassicTurnErrorText, _test } from "./conversation-progress-liveness-cdp.js";
import { observedClassicMainPortEntries } from './classic-main-debug-ports.js';

assert.equal(isClassicTurnErrorText("思考失敗"), true);
assert.equal(isClassicTurnErrorText("思考失败"), true);
assert.equal(isClassicTurnErrorText("Thinking failed"), true);
assert.equal(isClassicTurnErrorText("Thought failed"), true);
assert.equal(isClassicTurnErrorText("已中斷思考"), true);
assert.equal(isClassicTurnErrorText("已中断思考"), true);
assert.equal(isClassicTurnErrorText("Thinking interrupted"), true);
assert.equal(isClassicTurnErrorText("正常完成"), false);
const previousAssistant = { id: "assistant-previous-turn" };
const currentAssistant = { id: "assistant-current-turn" };
assert.equal(_test.selectCurrentTurnMessage(currentAssistant, previousAssistant, true), currentAssistant);
assert.equal(_test.selectCurrentTurnMessage(null, previousAssistant, false), previousAssistant,
  "older ChatGPT UI without turn sections may still use the latest global role-bearing message");
assert.equal(_test.selectCurrentTurnMessage(null, previousAssistant, true), null,
  "a present role-less current turn must remain nonterminal until its own error/final surface appears");
const exactInspectionSource = _test.exactConversationExpression("conversation-error-scope");
assert.match(exactInspectionSource, /section\[data-testid\^=\\?"conversation-turn-/,
  "failure detection must inspect the latest ChatGPT turn section, not only the message article");
assert.match(exactInspectionSource, /const latestTurnSection = turnSections\.at\(-1\) \|\| null/,
  "a role-less failed assistant turn must remain visible as the last turn boundary");
assert.match(exactInspectionSource, /selectCurrentTurnMessage\(/,
  "current-turn role selection must use the tested fail-closed helper");
assert.match(exactInspectionSource, /querySelectorAll\('button,/,
  "the unlabelled Thinking failed button must be included in scoped error candidates");
assert.match(exactInspectionSource, /思考失敗/);
assert.match(exactInspectionSource, /已中斷思考/);
assert.match(exactInspectionSource, /latestTurnMessages\.length === 0/,
  "a role-less terminal turn section must be checked even when no error button exists");
assert.match(exactInspectionSource, /latestTurnRoleless/,
  "the page snapshot must retain diagnostics for a present role-less current turn boundary");
assert.match(exactInspectionSource, /latestUserMessageId/,
  "the exact page snapshot must expose the source user message id for Rescue episode identity");
const lightweightInspectionSource = _test.lightweightExactConversationExpression("conversation-error-scope");
assert.match(lightweightInspectionSource, /selectCurrentTurnMessage\(roleNodes\.at\(-1\),fallbackRoles\.at\(-1\),Boolean\(lastTurn\)\)/,
  "the bounded fallback must use the same tested current-turn role selection");
assert.match(lightweightInspectionSource, /roleNodes\.length===0&&errorPattern\.test\(lastTurnText\)/,
  "the bounded fallback may classify plain role-less Thinking-failed text without treating a user's quoted error text as failure");

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

const rescueTarget = {
  id: "page-rescue-boundary",
  type: "page",
  url: "https://chatgpt.com/c/conversation-rescue-boundary",
  webSocketDebuggerUrl: "ws://page-rescue-boundary",
};
const rescueEvaluations = [];
const rescueCalls = [];
let rescueEvaluateIndex = 0;
const rescueAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01"],
  listTargets: async () => [rescueTarget],
  sleep: async () => {},
  connect: async () => ({
    evaluate: async (expression) => {
      rescueEvaluations.push(expression);
      rescueEvaluateIndex += 1;
      if (rescueEvaluateIndex <= 2) return { ok: true };
      return { ok: true, state: "visible" };
    },
    call: async (method, params) => { rescueCalls.push({ method, params }); return {}; },
    close() {},
  }),
});
const rescueResolvedTarget = {
  exact: true,
  conversationId: "conversation-rescue-boundary",
  runtimeKey: "main-01",
  port: 9721,
  target: {
    runtimeKey: "main-01",
    port: 9721,
    targetId: rescueTarget.id,
    url: rescueTarget.url,
    webSocketDebuggerUrl: rescueTarget.webSocketDebuggerUrl,
  },
};
const rescueSend = await rescueAdapter.sendContinue({
  conversationId: "conversation-rescue-boundary",
  target: rescueResolvedTarget,
  sourceUserMessageId: "source-user-message-1234",
  attempt: 1,
});
assert.equal(rescueSend.ok, true);
assert.equal(rescueSend.visibilityVerified, true);
assert.equal(rescueCalls.length, 1);
assert.equal(rescueCalls[0].method, "Input.insertText");
assert.match(rescueEvaluations[0], /source-user-message-1234/);
assert.match(rescueEvaluations[0], /previousUserId === rescueBoundary\.sourceUserMessageId/,
  "text equality alone must not treat an older visible - 繼續 as this episode's Rescue");
assert.match(rescueEvaluations.at(-1), /previousUser\?\.getAttribute\('data-message-id'\) === rescueBoundary\.sourceUserMessageId/,
  "post-send visibility must prove the new Rescue user message follows the exact failed user turn");
assert.deepEqual(await rescueAdapter.sendContinue({
  conversationId: "conversation-rescue-boundary",
  target: rescueResolvedTarget,
}), { ok: false, definiteFailure: true, dispatchCommitted: false, state: "rescue-source-user-required" });

let fallbackConnections = 0;
const fallbackAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ['main-02'],
  listTargets: async port => port === 9732 ? [{
    id: 'fallback-page', type: 'page', url: 'https://chatgpt.com/c/conversation-fallback',
    webSocketDebuggerUrl: 'ws://fallback-page',
  }] : [],
  connect: async () => {
    fallbackConnections += 1;
    return {
      async evaluate() {
        if (fallbackConnections === 1) throw Object.assign(new Error('large DOM evaluation timed out'), { name: 'TimeoutError' });
        return {
          exact: true, conversationId: 'conversation-fallback', hydrated: true,
          generating: true, latestMessageRole: 'user', latestMessageTextLength: 12,
          latestUserMessageId: 'user-fallback-1234', previousUserMessageId: null,
          hasTurnError: true, normalCompletion: false, incompleteUserTurn: false,
          composerFound: true, composerEmpty: true, composerLength: 0,
          progressCardMounted: true, progressConversationId: 'conversation-fallback',
          url: 'https://chatgpt.com/c/conversation-fallback', inspectionFallback: 'latest-turn-bounded',
        };
      },
      close() {},
    };
  },
});
const fallback = await fallbackAdapter.findAtRuntime({ conversationId: 'conversation-fallback', runtimeKey: 'main-02' });
assert.equal(fallback.exact, true);
assert.equal(fallback.hasTurnError, true);
assert.equal(fallback.boundedInspectionFallback, true);
assert.equal(fallback.primaryInspectionErrorName, 'TimeoutError');
assert.equal(fallbackConnections, 2);

observedClassicMainPortEntries({ rows: [{
  port: 19735, mainNumber: 5,
  commandLine: 'chatgpt-classic-main05.exe --remote-debugging-port=19735',
}] });
const driftAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ['main-05'],
  listTargets: async port => port === 19735 ? [{
    id: 'main05-drift-page', type: 'page', url: 'https://chatgpt.com/c/conversation-main05-drift',
    webSocketDebuggerUrl: 'ws://main05-drift-page',
    snapshot: {
      exact: true, conversationId: 'conversation-main05-drift', hydrated: true,
      generating: false, latestMessageRole: 'assistant', hasTurnError: false,
      normalCompletion: true, incompleteUserTurn: false, composerFound: true,
      composerEmpty: true, progressCardMounted: true,
      progressConversationId: 'conversation-main05-drift',
      url: 'https://chatgpt.com/c/conversation-main05-drift',
    },
  }] : [],
  connect: async target => ({ async evaluate() { return structuredClone(target.snapshot); }, close() {} }),
});
const drift = await driftAdapter.findAtRuntime({ conversationId: 'conversation-main05-drift', runtimeKey: 'main-05' });
assert.equal(drift.exact, true);
assert.equal(drift.port, 19735);
assert.deepEqual(drift.attemptedPorts, undefined, 'successful runtime inspection returns only authoritative located port');
observedClassicMainPortEntries({ rows: [] });

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
  rolelessCurrentTurnDoesNotBorrowPreviousFinal: true,
  quotedFailureTextDoesNotTriggerFallback: true,
  duplicateConversationUniqueActiveResolved: true,
  multipleActiveDuplicatesFailClosed: true,
  rescueEpisodeBoundaryRequired: true,
  oldContinueTextCannotSatisfyNewRescue: true,
  boundedInspectionFallback: true,
  observedDebugPortAuthority: true,
}));
