import assert from "node:assert/strict";
import {
  ClassicGoalRoundCompletionGuard,
  shouldRecoverWorkingRound,
} from "./goal-round-completion-guard.js";

let now = Date.parse("2026-09-08T01:00:30.000Z");
const guard = new ClassicGoalRoundCompletionGuard({
  goalRuntime: { async recoverableWorkingRounds() { return []; } },
  inspect: async () => null,
  recover: async () => null,
  dispatch: async () => null,
  pollMs: 0,
  minimumRoundSettleMs: 2_000,
  routeSettleMs: 3_000,
  requestPreRoundSlopMs: 30_000,
  now: () => now,
});

const goal = {
  id: "goal-recovery-lifecycle",
  status: "active",
  round: 4,
  roundState: "working",
  conversationId: "conversation-a",
  lastConsumedContinuationId: "continuation-4",
  roundBeganAt: "2026-09-08T01:00:00.000Z",
};

function snapshot(overrides = {}) {
  return {
    runtimePort: 9732,
    runtimeKey: "main-02",
    pageTargetId: "page-a",
    documentId: "document-a",
    routeEpoch: 1,
    conversationId: "conversation-a",
    chatMode: true,
    generating: false,
    streamStatus: "COMPLETE",
    documentReadyState: "complete",
    composerReady: true,
    routeHydrated: true,
    routeStableForMs: 10_000,
    routeEnteredAt: "2026-09-08T01:00:20.000Z",
    turnRequestObservedAt: "2026-09-08T01:00:05.000Z",
    nativeCompleteStableMs: 6_000,
    ...overrides,
  };
}

{
  const reentry = guard.observeRecoverySession(goal, snapshot());
  assert.equal(reentry.reset, true);
  assert.equal(reentry.stableOpenRoute, true);
  assert.equal(reentry.sawActiveTurn, false);
  assert.equal(reentry.sawCurrentRouteRequest, false);
  assert.equal(reentry.eligible, false, "opening an already-complete conversation must not inject a recovery prompt");
  assert.equal(reentry.reason, "reentry-or-unobserved-turn");
}

{
  const nativeFinal = guard.observeRecoverySession({
    ...goal,
    id: "goal-native-final-after-restart",
  }, snapshot({
    pageTargetId: "page-native-final",
    documentId: "document-native-final",
    routeEpoch: 4,
    routeEnteredAt: "2026-09-08T01:00:20.000Z",
    latestMessageRole: "assistant",
    latestUserMessageId: "user-native-current-round",
    latestAssistantMessageId: "assistant-native-current-round",
    latestAssistantText: "The current round completed before the replacement Core observed it.",
    nativeContinuation: {
      resolved: true,
      currentNodeId: "assistant-native-current-round",
      currentMessageId: "assistant-native-current-round",
      currentRole: "assistant",
      currentStatus: "finished_successfully",
      currentEndTurn: true,
      currentCreatedAt: "2026-09-08T01:00:15.000Z",
      latestUserMessageId: "user-native-current-round",
      latestUserCreatedAt: "2026-09-08T01:00:01.000Z",
      latestAssistantMessageId: "assistant-native-current-round",
      latestAssistantCreatedAt: "2026-09-08T01:00:15.000Z",
    },
  }));
  assert.equal(nativeFinal.reset, true);
  assert.equal(nativeFinal.sawActiveTurn, false);
  assert.equal(nativeFinal.sawCurrentRouteRequest, false);
  assert.equal(nativeFinal.sawNativeCurrentRoundFinal, true);
  assert.equal(nativeFinal.sawCurrentRoundAssistant, true);
  assert.equal(nativeFinal.eligible, true,
    "exact native branch evidence may recover a current-round final first observed after Core restart");
  assert.equal(nativeFinal.reason, "restart-safe-native-current-round-final");
}

{
  const staleNativeFinal = guard.observeRecoverySession({
    ...goal,
    id: "goal-stale-native-final",
  }, snapshot({
    pageTargetId: "page-stale-native-final",
    documentId: "document-stale-native-final",
    routeEpoch: 6,
    latestMessageRole: "assistant",
    latestUserMessageId: "user-before-round",
    latestAssistantMessageId: "assistant-before-round",
    latestAssistantText: "This final predates the current Goal round.",
    nativeContinuation: {
      resolved: true,
      currentNodeId: "assistant-before-round",
      currentMessageId: "assistant-before-round",
      currentRole: "assistant",
      currentStatus: "finished_successfully",
      currentEndTurn: true,
      currentCreatedAt: "2026-09-08T00:59:20.000Z",
      latestUserMessageId: "user-before-round",
      latestUserCreatedAt: "2026-09-08T00:59:00.000Z",
      latestAssistantMessageId: "assistant-before-round",
      latestAssistantCreatedAt: "2026-09-08T00:59:20.000Z",
    },
  }));
  assert.equal(staleNativeFinal.sawNativeCurrentRoundFinal, false);
  assert.equal(staleNativeFinal.eligible, false,
    "native branch evidence from before roundBeganAt must remain fail-closed");
}

{
  const working = guard.observeRecoverySession(goal, snapshot({
    documentId: "document-live",
    routeEpoch: 2,
    routeEnteredAt: "2026-09-08T00:59:58.000Z",
    turnRequestObservedAt: "2026-09-08T01:00:01.000Z",
    generating: true,
    streamStatus: "STREAMING",
    routeStableForMs: 4_000,
  }));
  assert.equal(working.reset, true);
  assert.equal(working.sawActiveTurn, true);
  assert.equal(working.sawCurrentRouteRequest, true);
  assert.equal(working.eligible, true);

  now += 8_000;
  const completed = guard.observeRecoverySession(goal, snapshot({
    documentId: "document-live",
    routeEpoch: 2,
    routeEnteredAt: "2026-09-08T00:59:58.000Z",
    turnRequestObservedAt: "2026-09-08T01:00:01.000Z",
    generating: false,
    streamStatus: "COMPLETE",
    routeStableForMs: 12_000,
  }));
  assert.equal(completed.reset, false);
  assert.equal(completed.eligible, true, "the same open route may recover after its observed active turn completes without a report");
  assert.equal(shouldRecoverWorkingRound(goal, {
    ...snapshot({
      documentId: "document-live",
      routeEpoch: 2,
      routeEnteredAt: "2026-09-08T00:59:58.000Z",
      turnRequestObservedAt: "2026-09-08T01:00:01.000Z",
    }),
    recoverySessionEligible: completed.eligible,
  }, { nowMs: now, minimumRoundSettleMs: 2_000 }), true);
}

{
  const reloaded = guard.observeRecoverySession(goal, snapshot({
    pageTargetId: "page-after-reload",
    documentId: "document-after-reload",
    routeEpoch: 1,
    routeEnteredAt: new Date(now - 4_000).toISOString(),
    turnRequestObservedAt: "2026-09-08T01:00:01.000Z",
    streamStatus: "COMPLETE",
  }));
  assert.equal(reloaded.reset, true);
  assert.equal(reloaded.eligible, false, "active-turn evidence from the prior document must not survive a full reload");
}

{
  const sameRouteAfterCoreRestart = guard.observeRecoverySession({
    ...goal,
    id: "goal-recovery-restart",
  }, snapshot({
    pageTargetId: "page-restart",
    documentId: "document-restart",
    routeEpoch: 5,
    routeEnteredAt: "2026-09-08T00:59:59.000Z",
    turnRequestObservedAt: "2026-09-08T01:00:03.000Z",
    streamStatus: "COMPLETE",
    generating: false,
  }));
  assert.equal(sameRouteAfterCoreRestart.sawActiveTurn, false);
  assert.equal(sameRouteAfterCoreRestart.sawCurrentRouteRequest, true);
  assert.equal(sameRouteAfterCoreRestart.eligible, true, "persisted transport evidence may restore recovery only when it belongs to the current route session");
}

{
  const wrongConversation = guard.observeRecoverySession({
    ...goal,
    id: "goal-recovery-mismatch",
  }, snapshot({
    pageTargetId: "page-mismatch",
    documentId: "document-mismatch",
    routeEpoch: 1,
    conversationId: "conversation-b",
    routeEnteredAt: "2026-09-08T00:59:59.000Z",
    turnRequestObservedAt: "2026-09-08T01:00:03.000Z",
  }));
  assert.equal(wrongConversation.stableOpenRoute, false);
  assert.equal(wrongConversation.eligible, false);
  assert.equal(shouldRecoverWorkingRound(goal, {
    ...snapshot({ conversationId: "conversation-b" }),
    recoverySessionEligible: true,
  }, { nowMs: now, minimumRoundSettleMs: 2_000 }), false);
}

await guard.close();
console.log(JSON.stringify({
  ok: true,
  gate: "goal-round-recovery-lifecycle",
  reentryBlocked: true,
  fullReloadBlocked: true,
  observedOpenTurnRecoverable: true,
  currentRouteTransportEvidenceRecoverable: true,
  restartNativeFinalRecoverable: true,
  staleNativeFinalBlocked: true,
  crossConversationBlocked: true,
}));
