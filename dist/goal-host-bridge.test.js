import assert from "node:assert/strict";

let moduleUnderTest = null;
try {
  moduleUnderTest = await import("./goal-host-bridge.js");
} catch {
  // RED until the production bridge exists.
}

assert.equal(typeof moduleUnderTest?.ClassicGoalHostBridge, "function", "ClassicGoalHostBridge must exist");
assert.equal(typeof moduleUnderTest?.defaultMainDebugPorts, "function", "defaultMainDebugPorts must exist");
assert.equal(typeof moduleUnderTest?.waitForVisibleReportBoundary, "function", "waitForVisibleReportBoundary must exist");
assert.equal(typeof moduleUnderTest?.probeClassicConversationPagePort, "function", "exact conversation page probe must exist");

{
  const snapshots = [
    { chatMode: true, generating: true, streamStatus: "IN_PROGRESS", latestAssistantText: "" },
    { chatMode: true, generating: false, streamStatus: "COMPLETE", latestMessageRole: "assistant", latestAssistantText: "MAIN1-GOAL-R2 — visible summary" },
  ];
  let index = 0;
  let now = Date.parse("2026-09-05T01:00:00.000Z");
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => snapshots[Math.min(index++, snapshots.length - 1)],
    reportedAt: "2026-09-05T01:00:00.000Z",
    minimumReportSettleMs: 400,
    timeoutMs: 1_000,
    pollMs: 1,
    now: () => now,
    sleep: async () => { now += 500; },
  });
  assert.equal(boundary.ok, true);
  assert.equal(boundary.committed, true);
  assert.match(boundary.latestAssistantText, /visible summary/);
}

{
  let now = Date.parse("2026-09-05T01:00:00.100Z");
  let inspections = 0;
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => {
      inspections += 1;
      return { chatMode: true, generating: false, streamStatus: "COMPLETE", latestMessageRole: "assistant", latestAssistantText: "current-looking summary" };
    },
    reportedAt: "2026-09-05T01:00:00.000Z",
    minimumReportSettleMs: 400,
    timeoutMs: 1_000,
    pollMs: 1,
    now: () => now,
    sleep: async () => { now += 350; },
  });
  assert.equal(boundary.ok, true);
  assert.ok(inspections >= 2, "already-COMPLETE state must not bypass the report settle window");
}

{
  let now = Date.parse("2026-09-05T01:00:01.000Z");
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => ({
      chatMode: true,
      generating: true,
      streamStatus: "COMPLETE",
      latestAssistantText: "",
      deliveryTimeoutVisible: true,
      retryVisible: true,
      safetyCheckVisible: false,
      conversationId: "conversation_delivery_timeout",
    }),
    reportedAt: "2026-09-05T01:00:00.000Z",
    minimumReportSettleMs: 400,
    timeoutMs: 1_000,
    pollMs: 1,
    now: () => now,
    sleep: async () => { now += 500; },
  });
  assert.equal(boundary.ok, true, "native terminal + explicit delivery-timeout surface must unblock pending continuation without clicking Retry");
  assert.equal(boundary.deliveryFailed, true);
  assert.equal(boundary.committed, false);
  assert.equal(boundary.conversationId, "conversation_delivery_timeout");
}

{
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => ({ chatMode: false, generating: false, streamStatus: "COMPLETE", latestAssistantText: "summary" }),
    reportedAt: "2026-09-05T01:00:00.000Z",
    timeoutMs: 10,
    pollMs: 1,
    sleep: async () => {},
  });
  assert.equal(boundary.ok, false);
  assert.equal(boundary.definiteFailure, true);
  assert.match(boundary.error, /Chat mode/i);
}

{
  let now = 0;
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => ({ chatMode: true, generating: false, streamStatus: "IN_PROGRESS", latestAssistantText: "summary" }),
    reportedAt: "1970-01-01T00:00:00.000Z",
    timeoutMs: 5,
    pollMs: 1,
    now: () => now,
    sleep: async () => { now += 2; },
  });
  assert.equal(boundary.ok, false);
  assert.equal(boundary.definiteFailure, false);
  assert.match(boundary.error, /not committed/i);
}

const ports = moduleUnderTest.defaultMainDebugPorts();
{
  let now = 1000;
  const boundary = await moduleUnderTest.waitForVisibleReportBoundary({
    inspect: async () => ({chatMode:true, generating:false, streamStatus:'COMPLETE',
      latestMessageRole:'user', latestAssistantText:'An answer to the PREVIOUS user request'}),
    reportedAt:new Date(0).toISOString(), timeoutMs:10, pollMs:1,
    now:() => now, sleep:async () => { now += 2; },
  });
  assert.equal(boundary.ok, false, 'an old assistant answer cannot complete a newer user turn');
}
assert.equal(ports[0], 9721);
assert.equal(ports[1], 9732);
assert.equal(ports.at(-1), 9762);
assert.equal(ports.length, 32);
assert.equal(new Set(ports).size, ports.length);

const probeCalls = [];
const rawCalls = [];
const visibleBoundaryCalls = [];
let beforeDispatchCalls = 0;
const bridge = new moduleUnderTest.ClassicGoalHostBridge({
  async beforeDispatch() { beforeDispatchCalls += 1; },
  async waitForVisibleReport(candidate, payload) {
    visibleBoundaryCalls.push({ candidate, payload });
    return { ok: true, committed: true };
  },
  ports: [9732, 9733],
  async probeRelayPort(port, conversationId) {
    probeCalls.push(port);
    if (port === 9732) {
      return [
        { runtimePort: 9732, runtimeLabel: "Main-02", targetId: "work-target", pageTargetId: "page-work", conversationId, chatMode: false, webSocketDebuggerUrl: "ws://relay-work" },
      ];
    }
    return [
      { runtimePort: 9733, runtimeLabel: "Main-03", targetId: "chat-target", pageTargetId: "page-chat-target", conversationId, chatMode: true, webSocketDebuggerUrl: "ws://relay-chat", title: "DevSpace Goal Relay" },
    ];
  },
  async sendRaw(candidate, payload) {
    rawCalls.push({ candidate, payload });
    return { ok: true };
  },
});

const result = await bridge.dispatch({
  goalId: "goal_target",
  continuationId: "continuation_1",
  leaseId: "lease_1",
  round: 2,
  prompt: "hidden continuation prompt",
  reportedAt: "2026-09-05T01:00:00.000Z",
  conversationId: "conversation_target",
  runtimePort: 9733,
  expectedPageTargetId: "page-chat-target",
});
assert.equal(result.ok, true);
assert.equal(beforeDispatchCalls, 1);
assert.equal(visibleBoundaryCalls.length, 1, "hidden continuation must wait for the visible report boundary");
assert.equal(visibleBoundaryCalls[0].candidate.targetId, "chat-target");
assert.equal(visibleBoundaryCalls[0].payload.round, 2);
assert.equal(visibleBoundaryCalls[0].payload.reportedAt, "2026-09-05T01:00:00.000Z");
assert.equal(result.transport, "classic-raw-host-rpc");
assert.equal(result.runtimeLabel, "Main-03");
assert.equal(result.runtimePort, 9733);
assert.equal(result.targetId, "chat-target");
assert.deepEqual(probeCalls, [9733]);
assert.equal(rawCalls.length, 1);
assert.equal(rawCalls[0].payload.prompt, "hidden continuation prompt");
assert.ok(visibleBoundaryCalls[0].payload.prompt.includes("hidden continuation prompt"));
assert.equal(rawCalls[0].payload.scrollToBottom, false);

let normalHiddenInspections = 0;
const normalHiddenBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9733],
  async waitForVisibleReport() { return { ok: true, committed: true }; },
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9733, runtimeLabel: "Main-03", targetId: "normal-hidden-relay",
      pageTargetId: "normal-hidden-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://normal-hidden-relay", pageWebSocketDebuggerUrl: "ws://normal-hidden-page" }];
  },
  async inspectComposer() { return { ok: true, state: "empty", exactOwnedPayload: false }; },
  async sendRaw() { return { ok: true, dispatchCommitted: true, backgroundAccepted: true }; },
  async inspectVisibleReport() {
    normalHiddenInspections += 1;
    return { nativeContinuation: { resolved: true, sourceUserFound: true,
      baselineAssistantFound: true, latestUserMessageId: "normal-source-user",
      newUserAfterBaselineMessageId: null,
      newAssistantAfterBaselineMessageId: "normal-hidden-assistant" } };
  },
  hiddenConfirmTimeoutMs: 1000,
  hiddenConfirmPollMs: 50,
  sleep: async () => {},
});
const normalHidden = await normalHiddenBridge.dispatch({
  goalId: "goal_normal_hidden", continuationId: "continuation_normal_hidden",
  leaseId: "lease_normal_hidden", round: 4, prompt: "hidden continuation prompt",
  reportedAt: "2026-09-05T01:00:00.000Z", conversationId: "conversation_normal_hidden",
  runtimePort: 9733, expectedPageTargetId: "normal-hidden-page",
  sourceUserId: "normal-source-user", assistantMessageId: "normal-visible-final",
});
assert.equal(normalHidden.ok, true);
assert.equal(normalHidden.transport, "classic-hidden-continuation-native-confirmed");
assert.equal(normalHidden.nativeBranchReconciled, true);
assert.equal(normalHiddenInspections, 1);

const supersededHiddenBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9733],
  async waitForVisibleReport() { return { ok: true, committed: true }; },
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9733, runtimeLabel: "Main-03", targetId: "superseded-hidden-relay",
      pageTargetId: "superseded-hidden-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://superseded-hidden-relay", pageWebSocketDebuggerUrl: "ws://superseded-hidden-page" }];
  },
  async inspectComposer() { return { ok: true, state: "empty", exactOwnedPayload: false }; },
  async sendRaw() { return { ok: true, dispatchCommitted: true, backgroundAccepted: true }; },
  async inspectVisibleReport() {
    return { nativeContinuation: { resolved: true, sourceUserFound: true,
      baselineAssistantFound: true, latestUserMessageId: "new-human-user",
      newUserAfterBaselineMessageId: "new-human-user",
      newAssistantAfterBaselineMessageId: null } };
  },
  hiddenConfirmTimeoutMs: 1000,
  hiddenConfirmPollMs: 50,
  sleep: async () => {},
});
const supersededHidden = await supersededHiddenBridge.dispatch({
  goalId: "goal_superseded_hidden", continuationId: "continuation_superseded_hidden",
  leaseId: "lease_superseded_hidden", round: 4, prompt: "hidden continuation prompt",
  reportedAt: "2026-09-05T01:00:00.000Z", conversationId: "conversation_superseded_hidden",
  runtimePort: 9733, expectedPageTargetId: "superseded-hidden-page",
  sourceUserId: "old-source-user", assistantMessageId: "visible-final-before-new-human",
});
assert.equal(supersededHidden.ok, false);
assert.equal(supersededHidden.dispatchCommitted, true);
assert.equal(supersededHidden.state, "new-user-before-hidden-assistant");

const defaultBoundaryInspections = [];
const defaultBoundaryRawCalls = [];
const defaultBoundaryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort(_port, conversationId) {
    return [{
      runtimePort: 9732,
      runtimeLabel: "Main-02",
      targetId: "chat-target-default",
      pageTargetId: "page-default-boundary",
      conversationId,
      chatMode: true,
      webSocketDebuggerUrl: "ws://relay-default",
    }];
  },
  async inspectVisibleReport(candidate, payload) {
    defaultBoundaryInspections.push({ candidate, payload });
    return {
      chatMode: true,
      generating: false,
      streamStatus: "COMPLETE",
      latestAssistantText: "ROUND DEFAULT — visible report committed",
      latestMessageRole: "assistant",
      conversationId: "conversation_default",
    };
  },
  async sendRaw(candidate, payload) {
    defaultBoundaryRawCalls.push({ candidate, payload });
    return { ok: true };
  },
  visibleReportTimeoutMs: 100,
  visibleReportPollMs: 1,
  sleep: async () => {},
});
const defaultBoundary = await defaultBoundaryBridge.dispatch({
  goalId: "goal_default_boundary",
  continuationId: "continuation_default",
  leaseId: "lease_default",
  round: 1,
  prompt: "default boundary prompt",
  reportedAt: "2026-09-05T01:00:00.000Z",
  conversationId: "conversation_default",
  runtimePort: 9732,
  expectedPageTargetId: "page-default-boundary",
});
assert.equal(defaultBoundary.ok, true);
assert.equal(defaultBoundaryInspections.length, 1, "production default must inspect the visible report boundary");
assert.equal(defaultBoundaryRawCalls.length, 1);

let hiddenRecoveryProbes = 0;
let hiddenRecoverySends = 0;
let hiddenRecoveryBeforeDispatchCalls = 0;
const recoveryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9721, 9732],
  async beforeDispatch() { hiddenRecoveryBeforeDispatchCalls += 1; },
  async probeRelayPort(port, conversationId) {
    hiddenRecoveryProbes += 1;
    if (port !== 9732 || conversationId !== "conversation_recovery") return [];
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "hidden-recovery-relay",
      pageTargetId: "recovery-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://hidden-recovery-relay", pageWebSocketDebuggerUrl: "ws://hidden-recovery-page" }];
  },
  async inspectComposer() { return { ok: true, state: "empty", exactOwnedPayload: false }; },
  async sendRaw(_candidate, payload) {
    hiddenRecoverySends += 1;
    assert.match(payload.prompt, /^\[DEVSPACE_GOAL_ROUND_RECOVERY\]/);
    return { ok: true, dispatchCommitted: true, backgroundAccepted: true };
  },
  async inspectVisibleReport() {
    return { nativeContinuation: { resolved: true, sourceUserFound: true,
      baselineAssistantFound: true, latestUserMessageId: "user-hidden-recovery",
      newUserAfterBaselineMessageId: null,
      newAssistantAfterBaselineMessageId: "assistant-hidden-recovery" } };
  },
  hiddenConfirmTimeoutMs: 1000,
  hiddenConfirmPollMs: 50,
  sleep: async () => {},
});
const hiddenRecovery = await recoveryBridge.dispatchRoundRecovery({
  goalId: "goal_recovery",
  conversationId: "conversation_recovery",
  round: 2,
  recoveryId: "recovery_aaaaaaaaaaaaaaaa",
  attempt: 1,
  expectedPageTargetId: "recovery-page",
  sourceUserMessageId: "user-hidden-recovery",
  baselineAssistantMessageId: "assistant-before-hidden-recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] continue same round",
});
assert.equal(hiddenRecovery.ok, true);
assert.equal(hiddenRecovery.transport, "classic-hidden-round-recovery");
assert.equal(hiddenRecovery.backgroundAccepted, true);
assert.equal(hiddenRecovery.visibleUserMessage, false);
assert.equal(hiddenRecovery.composerMutation, false);
assert.equal(hiddenRecoverySends, 1);
assert.ok(hiddenRecoveryProbes >= 1);
assert.equal(hiddenRecoveryBeforeDispatchCalls, 0,
  "same-round hidden recovery must never run Primary debug or foreground repair");

const invalidHiddenRecovery = await recoveryBridge.dispatchRoundRecovery({
  goalId: "goal_recovery",
  conversationId: "conversation_recovery",
  prompt: "arbitrary stale caller payload",
});
assert.deepEqual(invalidHiddenRecovery, {
  ok: false,
  definiteFailure: true,
  dispatchCommitted: false,
  state: "invalid-hidden-goal-recovery-boundary",
});

let blockedRecoverySends = 0;
const blockedRecoveryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "blocked-relay",
      pageTargetId: "blocked-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://blocked-relay", pageWebSocketDebuggerUrl: "ws://blocked-page" }];
  },
  async inspectComposer() { return { ok: true, state: "non-empty", exactOwnedPayload: false }; },
  async sendRaw() { blockedRecoverySends += 1; return { ok: true }; },
});
const blockedRecovery = await blockedRecoveryBridge.dispatchRoundRecovery({
  goalId: "goal_blocked_recovery", conversationId: "conversation_blocked_recovery",
  round: 2, recoveryId: "recovery_blocked_recovery", attempt: 1,
  expectedPageTargetId: "blocked-page",
  sourceUserMessageId: "user-blocked-recovery",
  baselineAssistantMessageId: "assistant-before-blocked-recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] must not overwrite a user draft",
});
assert.equal(blockedRecovery.ok, false);
assert.equal(blockedRecovery.state, "non-empty");
assert.equal(blockedRecoverySends, 0);

const exposedChecks = [{ ok: true, state: "empty", exactOwnedPayload: false },
  { ok: true, state: "non-empty", exactOwnedPayload: true }];
let exposedCleanup = 0;
const exposedRecoveryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "exposed-relay",
      pageTargetId: "exposed-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://exposed-relay", pageWebSocketDebuggerUrl: "ws://exposed-page" }];
  },
  async inspectComposer() { return exposedChecks.shift(); },
  async clearOwnedComposer() { exposedCleanup += 1; return { ok: true }; },
  async sendRaw() { return { ok: false, dispatchCommitted: true, definiteFailure: false }; },
});
const exposedRecovery = await exposedRecoveryBridge.dispatchRoundRecovery({
  goalId: "goal_exposed_recovery", conversationId: "conversation_exposed_recovery",
  round: 2, recoveryId: "recovery_exposed_recovery", attempt: 1,
  expectedPageTargetId: "exposed-page",
  sourceUserMessageId: "user-exposed-recovery",
  baselineAssistantMessageId: "assistant-before-exposed-recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] exact owned payload",
});
assert.equal(exposedRecovery.state, "hidden-goal-recovery-composer-exposure-cleared");
assert.equal(exposedRecovery.dispatchCommitted, true);
assert.equal(exposedRecovery.composerCleanupVerified, true);
assert.equal(exposedCleanup, 1);

const uncertainRecoveryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "uncertain-recovery-relay",
      pageTargetId: "uncertain-recovery-page", conversationId, chatMode: true,
      webSocketDebuggerUrl: "ws://uncertain-recovery-relay", pageWebSocketDebuggerUrl: "ws://uncertain-recovery-page" }];
  },
  async inspectComposer() { return { ok: true, state: "empty", exactOwnedPayload: false }; },
  async sendRaw() {
    return { ok: false, definiteFailure: false, dispatchCommitted: true,
      state: "raw-host-acknowledgement-lost" };
  },
  async inspectVisibleReport() {
    return { nativeContinuation: { resolved: true, sourceUserFound: true,
      baselineAssistantFound: true, latestUserMessageId: "user-recovery-boundary",
      newUserAfterBaselineMessageId: null,
      newAssistantAfterBaselineMessageId: "assistant-hidden-recovery" } };
  },
  hiddenConfirmTimeoutMs: 1000,
  hiddenConfirmPollMs: 50,
  sleep: async () => {},
});
const uncertainRecoveryResult = await uncertainRecoveryBridge.dispatchRoundRecovery({
  goalId: "goal_uncertain_recovery", conversationId: "conversation_uncertain_recovery",
  round: 2, recoveryId: "recovery_uncertain_recovery", attempt: 1,
  expectedPageTargetId: "uncertain-recovery-page",
  sourceUserMessageId: "user-recovery-boundary",
  baselineAssistantMessageId: "assistant-visible-before-recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] reconcile hidden acknowledgement loss",
});
assert.equal(uncertainRecoveryResult.ok, true);
assert.equal(uncertainRecoveryResult.nativeBranchReconciled, true);
assert.equal(uncertainRecoveryResult.transport, "classic-hidden-round-recovery-native-reconciled");

const livenessFollowUps = [];
const livenessBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9721, 9732],
  async probeRelayPort(port, conversationId) {
    if (port !== 9732 || conversationId !== "conversation_liveness") return [];
    return [{
      runtimePort: 9732,
      runtimeLabel: "Main-02",
      targetId: "liveness-relay",
      pageTargetId: "liveness-page",
      chatMode: true,
      conversationId,
      webSocketDebuggerUrl: "ws://relay-liveness",
      relayOnly: true,
    }];
  },
  async sendRaw(candidate, payload) {
    livenessFollowUps.push({ candidate, payload });
    return { ok: true };
  },
});
const livenessDispatch = await livenessBridge.dispatchConversationFollowUp({
  conversationId: "conversation_liveness",
  runtimePort: 9732,
  prompt: "progress reminder",
  purpose: "progress-reminder",
});
assert.equal(livenessDispatch.ok, true);
assert.equal(livenessDispatch.conversationId, "conversation_liveness");
assert.equal(livenessDispatch.runtimePort, 9732);
assert.equal(livenessFollowUps.length, 1);
assert.equal(livenessFollowUps[0].candidate.targetId, "liveness-relay");

let ambiguousLivenessSends = 0;
const ambiguousLivenessBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9721, 9732],
  async probeRelayPort(port, conversationId) {
    return [{
      runtimePort: port,
      runtimeLabel: port === 9721 ? "Main-01" : "Main-02",
      targetId: `duplicate-${port}`,
      pageTargetId: `duplicate-page-${port}`,
      chatMode: true,
      conversationId,
      webSocketDebuggerUrl: `ws://duplicate-${port}`,
      relayOnly: true,
    }];
  },
  async sendRaw() {
    ambiguousLivenessSends += 1;
    return { ok: true };
  },
});
const ambiguousLiveness = await ambiguousLivenessBridge.dispatchConversationFollowUp({
  conversationId: "conversation_duplicate",
  prompt: "must fail closed",
});
assert.equal(ambiguousLiveness.ok, false);
assert.equal(ambiguousLiveness.ambiguous, true);
assert.equal(ambiguousLiveness.matchCount, 2);
assert.equal(ambiguousLivenessSends, 0, "a duplicated conversation route must never receive a follow-up on either Main");

const exactConversationDispatches = [];
const exactConversationInspections = [];
const conversationSafeBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732, 9733],
  async probePort(port) {
    if (port !== 9732) return [];
    return [{
      runtimePort: 9732,
      runtimeLabel: "Main-02",
      targetId: "stale-goal-widget",
      goalId: "goal_conversation_safe",
      chatMode: true,
      conversationId: "conversation_wrong",
      pageWebSocketDebuggerUrl: "ws://page-wrong",
      webSocketDebuggerUrl: "ws://widget-wrong",
    }];
  },
  async probeConversationPage(port, conversationId) {
    if (port !== 9733 || conversationId !== "conversation_authoritative") return [];
    return [{
      runtimePort: 9733,
      runtimeLabel: "Main-03",
      pageTargetId: "authoritative-conversation-page",
      chatMode: true,
      conversationId,
      pageWebSocketDebuggerUrl: "ws://page-authoritative",
      pageUrl: "https://chatgpt.com/c/conversation_authoritative",
      directPage: true,
    }];
  },
  async probeRelayPort(port, conversationId) {
    if (port !== 9733 || conversationId !== "conversation_authoritative") return [];
    return [{
      runtimePort: 9733,
      runtimeLabel: "Main-03",
      targetId: "authoritative-hidden-relay",
      pageTargetId: "authoritative-conversation-page",
      chatMode: true,
      conversationId,
      webSocketDebuggerUrl: "ws://authoritative-hidden-relay",
      title: "DevSpace Goal Relay",
    }];
  },
  async inspectVisibleReport(candidate, payload = {}) {
    exactConversationInspections.push({ candidate, payload });
    return {
      chatMode: true,
      generating: false,
      streamStatus: "COMPLETE",
      latestAssistantText: "",
      conversationId: candidate.conversationId,
      ...(payload.includeNativeBranch === true ? { nativeContinuation: {
        resolved: true,
        sourceUserFound: true,
        baselineAssistantFound: true,
        latestUserMessageId: "user-authoritative-recovery",
        newUserAfterBaselineMessageId: null,
        newAssistantAfterBaselineMessageId: "assistant-authoritative-hidden-recovery",
      } } : {}),
    };
  },
  async inspectComposer() { return { ok: true, state: "empty", exactOwnedPayload: false }; },
  async sendRaw(candidate, payload) {
    exactConversationDispatches.push({ candidate, payload });
    return { ok: true, dispatchCommitted: true, backgroundAccepted: true };
  },
});
const conversationSafeSnapshot = await conversationSafeBridge.inspectWorkingRound({
  id: "goal_conversation_safe",
  conversationId: "conversation_authoritative",
});
assert.equal(conversationSafeSnapshot.conversationId, "conversation_authoritative");
assert.equal(conversationSafeSnapshot.runtimePort, 9733);
assert.equal(conversationSafeSnapshot.relayFallback, false, "a stale same-goal widget in another conversation must be ignored");
assert.equal(conversationSafeSnapshot.directPage, true);
assert.equal(exactConversationInspections.at(-1).payload.includeNativeBranch, false);
const nativeConversationSafeSnapshot = await conversationSafeBridge.inspectWorkingRound({
  id: "goal_conversation_safe",
  conversationId: "conversation_authoritative",
}, { includeNativeBranch: true });
assert.equal(nativeConversationSafeSnapshot.nativeContinuation?.resolved, true,
  "working-round inspection must support one exact native-branch proof on demand");
assert.equal(exactConversationInspections.at(-1).payload.includeNativeBranch, true);
const conversationSafeDispatch = await conversationSafeBridge.dispatchRoundRecovery({
  goalId: "goal_conversation_safe",
  conversationId: "conversation_authoritative",
  round: 3,
  recoveryId: "recovery_conversation_safe",
  expectedPageTargetId: "authoritative-conversation-page",
  sourceUserMessageId: "user-authoritative-recovery",
  baselineAssistantMessageId: "assistant-before-authoritative-recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] stay on authoritative conversation",
});
assert.equal(conversationSafeDispatch.ok, true);
assert.equal(conversationSafeDispatch.transport, "classic-hidden-round-recovery");
assert.equal(conversationSafeDispatch.visibleUserMessage, false);
assert.equal(conversationSafeDispatch.composerMutation, false);
assert.equal(exactConversationDispatches.length, 1,
  "the exact authoritative page may receive one hidden same-round recovery without composer automation");
assert.equal(exactConversationDispatches[0].candidate.pageTargetId, "authoritative-conversation-page");

const rolloverHookCalls = [];
const rolloverBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9721],
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9721, runtimeLabel: "Main-01", targetId: "goal-rollover", pageTargetId: "page-rollover", conversationId, chatMode: true, webSocketDebuggerUrl: "ws://relay-rollover" }];
  },
  async waitForVisibleReport() { return { ok: true, committed: true }; },
  async beforeRawDispatch(candidate, payload) {
    rolloverHookCalls.push({ candidate, payload });
    return { handled: true, transport: "classic-hidden-rollover", rollover: { conversationId: "fresh-conversation" } };
  },
  async sendRaw() { throw new Error("normal raw continuation must be skipped when Context Guardian handled rollover"); },
});
const rolloverDispatch = await rolloverBridge.dispatch({
  goalId: "goal_rollover",
  continuationId: "continuation_rollover",
  leaseId: "lease_rollover",
  round: 2,
  prompt: "goal continuation carried into fresh chat",
  reportedAt: "2026-09-05T01:00:00.000Z",
  conversationId: "conversation_rollover",
  runtimePort: 9721,
  expectedPageTargetId: "page-rollover",
});
assert.equal(rolloverDispatch.ok, true);
assert.equal(rolloverDispatch.transport, "classic-hidden-rollover");
assert.equal(rolloverHookCalls.length, 1);
assert.equal(rolloverHookCalls[0].candidate.runtimePort, 9721);
assert.equal(rolloverHookCalls[0].payload.goalId, "goal_rollover");

const boundaryFailBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort(_port, conversationId) {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "chat-target", pageTargetId: "page-boundary", conversationId, chatMode: true, webSocketDebuggerUrl: "ws://relay-boundary" }];
  },
  async waitForVisibleReport() {
    return { ok: false, definiteFailure: false, error: "visible report not committed" };
  },
  async sendRaw() {
    throw new Error("must not send before visible report commit");
  },
});
const boundaryFail = await boundaryFailBridge.dispatch({
  goalId: "goal_boundary",
  continuationId: "continuation_boundary",
  leaseId: "lease_boundary",
  round: 2,
  prompt: "prompt",
  conversationId: "conversation_boundary",
  runtimePort: 9732,
  expectedPageTargetId: "page-boundary",
});
assert.equal(boundaryFail.ok, false);
assert.equal(boundaryFail.definiteFailure, false);
assert.match(boundaryFail.error, /visible report/i);

const missingBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probeRelayPort() { return []; },
  async sendRaw() {
    throw new Error("must not send");
  },
});

const missing = await missingBridge.dispatch({
  goalId: "goal_missing",
  continuationId: "continuation_missing",
  leaseId: "lease_missing",
  round: 1,
  prompt: "prompt",
  conversationId: "conversation_missing",
  runtimePort: 9732,
});
assert.equal(missing.ok, false);
assert.equal(missing.definiteFailure, true);
assert.match(missing.error, /matching Chat-mode DevSpace relay|No exact Chat-mode relay/i);

await assert.rejects(
  () => bridge.dispatch({ goalId: "", prompt: "prompt" }),
  /goalId/i,
);
await assert.rejects(
  () => bridge.dispatch({ goalId: "goal_target", prompt: "" }),
  /prompt/i,
);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-host-bridge",
  ports: ports.length,
  main01: ports[0],
  main32: ports.at(-1),
  chatModeOnly: true,
  singleRawDispatch: true,
  hiddenHostRecovery: true,
  visibleSameRoundRecoveryRetired: true,
  visibleComposerRecovery: false,
  composerExposureDetectedAndCleared: true,
  recoveryForegroundActivation: false,
  recoveryPageNavigation: false,
}));
