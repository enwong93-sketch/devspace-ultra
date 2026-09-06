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

{
  const snapshots = [
    { chatMode: true, generating: true, streamStatus: "IN_PROGRESS", latestAssistantText: "" },
    { chatMode: true, generating: false, streamStatus: "COMPLETE", latestAssistantText: "MAIN1-GOAL-R2 — visible summary" },
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
      return { chatMode: true, generating: false, streamStatus: "COMPLETE", latestAssistantText: "current-looking summary" };
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
  async probePort(port) {
    probeCalls.push(port);
    if (port === 9732) {
      return [
        { runtimePort: 9732, runtimeLabel: "Main-02", targetId: "work-target", goalId: "goal_target", chatMode: false, pageWebSocketDebuggerUrl: "ws://page-work" },
      ];
    }
    return [
      { runtimePort: 9733, runtimeLabel: "Main-03", targetId: "other-goal", goalId: "goal_other", chatMode: true, pageWebSocketDebuggerUrl: "ws://page-chat" },
      { runtimePort: 9733, runtimeLabel: "Main-03", targetId: "chat-target", goalId: "goal_target", chatMode: true, pageWebSocketDebuggerUrl: "ws://page-chat" },
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
assert.deepEqual(probeCalls, [9732, 9733]);
assert.equal(rawCalls.length, 1);
assert.equal(rawCalls[0].payload.prompt, "hidden continuation prompt");
assert.ok(visibleBoundaryCalls[0].payload.prompt.includes("hidden continuation prompt"));
assert.equal(rawCalls[0].payload.scrollToBottom, false);

const defaultBoundaryInspections = [];
const defaultBoundaryRawCalls = [];
const defaultBoundaryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probePort() {
    return [{
      runtimePort: 9732,
      runtimeLabel: "Main-02",
      targetId: "chat-target-default",
      goalId: "goal_default_boundary",
      chatMode: true,
      pageWebSocketDebuggerUrl: "ws://page-default",
    }];
  },
  async inspectVisibleReport(candidate, payload) {
    defaultBoundaryInspections.push({ candidate, payload });
    return {
      chatMode: true,
      generating: false,
      streamStatus: "COMPLETE",
      latestAssistantText: "ROUND DEFAULT — visible report committed",
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
});
assert.equal(defaultBoundary.ok, true);
assert.equal(defaultBoundaryInspections.length, 1, "production default must inspect the visible report boundary");
assert.equal(defaultBoundaryRawCalls.length, 1);

const recoveryRawCalls = [];
const recoveryBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probePort() {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "recovery-target", goalId: "goal_recovery", chatMode: true, pageWebSocketDebuggerUrl: "ws://page-recovery" }];
  },
  async inspectVisibleReport() {
    return { chatMode: true, generating: false, streamStatus: "COMPLETE", latestAssistantText: "premature final", conversationId: "conversation_recovery" };
  },
  async sendRaw(candidate, payload) {
    recoveryRawCalls.push({ candidate, payload });
    return { ok: true };
  },
});
const workingSnapshot = await recoveryBridge.inspectWorkingRound("goal_recovery");
assert.equal(workingSnapshot.chatMode, true);
assert.equal(workingSnapshot.generating, false);
assert.equal(workingSnapshot.streamStatus, "COMPLETE");
assert.equal(workingSnapshot.conversationId, "conversation_recovery");
const recoveryDispatch = await recoveryBridge.dispatchRoundRecovery({
  goalId: "goal_recovery",
  round: 2,
  recoveryId: "recovery_aaaaaaaaaaaaaaaa",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] continue same round",
});
assert.equal(recoveryDispatch.ok, true);
assert.equal(recoveryDispatch.transport, "classic-raw-host-rpc");
assert.equal(recoveryRawCalls.length, 1);
assert.match(recoveryRawCalls[0].payload.prompt, /GOAL_ROUND_RECOVERY/);
assert.equal(recoveryRawCalls[0].payload.round, 2);
assert.equal(recoveryRawCalls[0].payload.recoveryId, "recovery_aaaaaaaaaaaaaaaa");

const relayFallbackCalls = [];
const relayFallbackBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732, 9733],
  async probePort() { return []; },
  async probeRelayPort(port, conversationId) {
    if (port !== 9733 || conversationId !== "conversation_bound_recovery") return [];
    return [{
      runtimePort: 9733,
      runtimeLabel: "Main-03",
      targetId: "generic-devspace-relay",
      goalId: null,
      chatMode: true,
      conversationId,
      pageWebSocketDebuggerUrl: "ws://page-bound-recovery",
      webSocketDebuggerUrl: "ws://relay-bound-recovery",
      relayOnly: true,
    }];
  },
  async inspectVisibleReport(candidate) {
    return {
      chatMode: true,
      generating: false,
      streamStatus: "COMPLETE",
      latestAssistantText: "",
      conversationId: candidate.conversationId,
      deliveryTimeoutVisible: true,
      retryVisible: true,
      safetyCheckVisible: false,
    };
  },
  async sendRaw(candidate, payload) {
    relayFallbackCalls.push({ candidate, payload });
    return { ok: true };
  },
});
const relaySnapshot = await relayFallbackBridge.inspectWorkingRound({
  id: "goal_bound_recovery",
  conversationId: "conversation_bound_recovery",
});
assert.equal(relaySnapshot.chatMode, true, "conversation-bound recovery must inspect the page even when the Goal Dock iframe disappeared");
assert.equal(relaySnapshot.conversationId, "conversation_bound_recovery");
assert.equal(relaySnapshot.relayFallback, true);
const relayRecovery = await relayFallbackBridge.dispatchRoundRecovery({
  goalId: "goal_bound_recovery",
  conversationId: "conversation_bound_recovery",
  round: 5,
  recoveryId: "recovery_bound_recovery",
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY] continue durable run",
});
assert.equal(relayRecovery.ok, true);
assert.equal(relayRecovery.transport, "classic-raw-host-rpc");
assert.equal(relayRecovery.relayFallback, true);
assert.equal(relayFallbackCalls.length, 1);
assert.equal(relayFallbackCalls[0].candidate.targetId, "generic-devspace-relay");
assert.equal(relayFallbackCalls[0].payload.goalId, "goal_bound_recovery");

const rolloverHookCalls = [];
const rolloverBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9721],
  async probePort() {
    return [{ runtimePort: 9721, runtimeLabel: "Main-01", targetId: "goal-rollover", goalId: "goal_rollover", chatMode: true, pageWebSocketDebuggerUrl: "ws://page-rollover" }];
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
});
assert.equal(rolloverDispatch.ok, true);
assert.equal(rolloverDispatch.transport, "classic-hidden-rollover");
assert.equal(rolloverHookCalls.length, 1);
assert.equal(rolloverHookCalls[0].candidate.runtimePort, 9721);
assert.equal(rolloverHookCalls[0].payload.goalId, "goal_rollover");

const boundaryFailBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probePort() {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "chat-target", goalId: "goal_boundary", chatMode: true }];
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
});
assert.equal(boundaryFail.ok, false);
assert.equal(boundaryFail.definiteFailure, false);
assert.match(boundaryFail.error, /visible report/i);

const missingBridge = new moduleUnderTest.ClassicGoalHostBridge({
  ports: [9732],
  async probePort() {
    return [{ runtimePort: 9732, runtimeLabel: "Main-02", targetId: "wrong", goalId: "goal_wrong", chatMode: true }];
  },
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
});
assert.equal(missing.ok, false);
assert.equal(missing.definiteFailure, true);
assert.match(missing.error, /matching Chat-mode Goal widget/i);

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
}));
