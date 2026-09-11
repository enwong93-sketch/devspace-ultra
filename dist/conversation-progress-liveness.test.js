import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConversationProgressLivenessSupervisor,
  _test,
} from "./conversation-progress-liveness.js";
import {
  ConversationProgressLivenessCdpAdapter,
  _test as cdpTest,
} from "./conversation-progress-liveness-cdp.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-liveness-test-"));
const statePath = join(dir, "liveness.json");
const planStatePath = join(dir, "plans.json");
const progressStatePath = join(dir, "progress.json");
let now = Date.parse("2026-09-11T06:00:00.000Z");
const calls = [];

const pages = new Map([
  ["conversation-running", {
    runtimeKey: "main-01",
    port: 9721,
    hydrated: true,
    generating: true,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: false,
  }],
  ["conversation-complete", {
    runtimeKey: "main-02",
    port: 9732,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "assistant",
    hasTurnError: false,
    normalCompletion: true,
    incompleteUserTurn: false,
  }],
  ["conversation-finish-pending", {
    runtimeKey: "main-02",
    port: 9732,
    hydrated: true,
    generating: true,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: false,
  }],
  ["conversation-failed", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: true,
  }],
  ["conversation-uncertain", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "assistant",
    hasTurnError: false,
    normalCompletion: true,
    incompleteUserTurn: false,
  }],
  ["conversation-duplicate", {
    runtimeKey: "main-04",
    port: 9734,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: true,
    normalCompletion: false,
    incompleteUserTurn: true,
  }],
  ["conversation-rescue-race", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: true,
    normalCompletion: false,
    incompleteUserTurn: true,
  }],
  ["conversation-restart-interrupted", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: true,
    normalCompletion: false,
    incompleteUserTurn: true,
  }],
  ["conversation-restart-complete", {
    runtimeKey: "main-02",
    port: 9732,
    hydrated: true,
    generating: false,
    composerEmpty: true,
    latestMessageRole: "assistant",
    hasTurnError: false,
    normalCompletion: true,
    incompleteUserTurn: false,
  }],
]);
const duplicateConversations = new Set();
const rescueHooks = new Map();

function locatedPage(conversationId, page) {
  return {
    exact: true,
    conversationId,
    ...page,
    target: {
      runtimeKey: page.runtimeKey,
      port: page.port,
      targetId: `${conversationId}-${page.runtimeKey}`,
      url: `https://chatgpt.com/c/${conversationId}`,
      webSocketDebuggerUrl: `ws://${page.runtimeKey}/${conversationId}`,
    },
  };
}

const adapter = {
  async find({ conversationId }) {
    if (duplicateConversations.has(conversationId)) {
      return {
        exact: false,
        ambiguous: true,
        state: "duplicate-conversation-pages",
        conversationId,
        matchCount: 2,
      };
    }
    const page = pages.get(conversationId);
    return page
      ? locatedPage(conversationId, page)
      : { exact: false, state: "conversation-page-not-open", conversationId };
  },
  async clearReminder(input) {
    calls.push({
      action: "clearReminder",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
    });
    return { ok: true };
  },
  async sendContinue(input) {
    calls.push({
      action: "sendContinue",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
      locatedPort: input.target?.port || null,
      attempt: input.attempt,
      rescueEvidence: input.rescueEvidence,
    });
    const hook = rescueHooks.get(input.conversationId);
    if (hook) await hook(input);
    return { ok: true };
  },
};

// Old persisted episodes must never restart an automatic rescue loop after a
// Core reload. The fresh native turn observer is the only arming authority.
await writeFile(statePath, JSON.stringify({
  version: 2,
  records: {
    "conversation-old": {
      conversationId: "conversation-old",
      armed: true,
      lastReportAt: new Date(now - 60 * 60_000).toISOString(),
      lastReminderAt: new Date(now - 50 * 60_000).toISOString(),
      lastContinueAt: new Date(now - 40 * 60_000).toISOString(),
      continueAttempts: 3,
    },
  },
}), "utf8");

// Active Plan/progress rows are metadata only. They cannot arm rescue on an
// idle or already completed conversation.
await writeFile(planStatePath, JSON.stringify({
  plans: {
    planOnly: {
      id: "plan-only",
      status: "active",
      revision: 8,
      updatedAt: new Date(now).toISOString(),
      conversationId: "conversation-plan-only",
    },
  },
}), "utf8");
await writeFile(progressStatePath, JSON.stringify({
  messages: [{
    text: "historic progress",
    at: new Date(now).toISOString(),
    conversationId: "conversation-plan-only",
    source: "agent-progress-tool",
    kind: "progress",
  }],
}), "utf8");

const supervisor = new ConversationProgressLivenessSupervisor({
  statePath,
  planStatePath,
  progressStatePath,
  adapter,
  reportIntervalMs: 10 * 60_000,
  continueMs: 20 * 60_000,
  pollMs: 1_000,
  now: () => now,
});
await supervisor.start({ schedule: false });

const boundedPolicy = new ConversationProgressLivenessSupervisor({
  enabled: false,
  reportIntervalMs: 6 * 60 * 60_000,
  continueMs: 60_000,
});
assert.equal(boundedPolicy.status().reportIntervalMs, 10 * 60_000,
  "configuration may request more frequent reporting but may not relax the ten-minute ceiling");
assert.equal(boundedPolicy.status().continueMs, 20 * 60_000,
  "rescue may never run earlier than twenty minutes");
await boundedPolicy.close();

let oldRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-old");
assert.equal(oldRecord.armed, false);
assert.equal(oldRecord.turnState, "startup-disarmed");
assert.equal(supervisor.status().records.some((row) => row.conversationId === "conversation-plan-only"), false,
  "Plan or progress history alone must not create a rescue episode");
assert.equal(supervisor.status().tenMinuteAutomaticReminder, false);
assert.equal(supervisor.status().tenMinuteSyntheticUserTurn, false);
assert.equal(supervisor.status().tenMinuteAgentReportSloOnly, true);
assert.equal(supervisor.status().twentyMinuteInterruptedTurnRescueOnly, true);
assert.equal(supervisor.status().normalCompletionDisarms, true);
assert.equal(supervisor.status().maxContinueAttempts, 1);

await supervisor.noteTurn({ kind: "started", conversationId: "conversation-running", runtimeKey: "main-01", observedAtMs: now });
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-complete", runtimeKey: "main-02", observedAtMs: now });
await supervisor.noteTurn({ kind: "finished", conversationId: "conversation-complete", runtimeKey: "main-02", observedAtMs: now + 1_000 });
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-finish-pending", runtimeKey: "main-02", observedAtMs: now });
await supervisor.noteTurn({ kind: "finished", conversationId: "conversation-finish-pending", runtimeKey: "main-02", observedAtMs: now + 1_500 });
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-failed", runtimeKey: "main-03", observedAtMs: now });
await supervisor.noteTurn({
  kind: "failed",
  conversationId: "conversation-failed",
  runtimeKey: "main-03",
  canceled: false,
  errorText: "net::ERR_CONNECTION_RESET",
  observedAtMs: now + 2_000,
});
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-cancelled", runtimeKey: "main-04", observedAtMs: now });
await supervisor.noteTurn({
  kind: "failed",
  conversationId: "conversation-cancelled",
  runtimeKey: "main-04",
  canceled: true,
  observedAtMs: now + 3_000,
});

let completeRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-complete");
let finishPendingRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-finish-pending");
let cancelledRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-cancelled");
assert.equal(completeRecord.armed, false, "normal native completion must immediately disarm rescue");
assert.equal(completeRecord.turnState, "completed");
assert.equal(finishPendingRecord.armed, true,
  "a transport boundary may not claim normal completion while the exact page is still generating");
assert.equal(finishPendingRecord.turnState, "completion-pending");
assert.equal(cancelledRecord.armed, false, "an explicit user cancellation must not be auto-rescued");
assert.equal(cancelledRecord.turnState, "cancelled");

now += 10 * 60_000 + 3_000;
await supervisor.tick();
let runningRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-running");
let failedRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-failed");
assert.equal(runningRecord.reportOverdue, true);
assert.equal(failedRecord.reportOverdue, true);
assert.equal(Object.hasOwn(runningRecord, "reminderPending"), false);
assert.equal(Object.hasOwn(failedRecord, "reminderPending"), false);
assert.equal(calls.some((row) => row.action === "sendReminder" || row.action === "projectReminder"), false,
  "ten minutes must never send or project a reminder");
assert.equal(calls.filter((row) => row.action === "sendContinue").length, 0,
  "ten minutes is never a rescue boundary");

pages.set("conversation-finish-pending", {
  ...pages.get("conversation-finish-pending"),
  generating: false,
  latestMessageRole: "assistant",
  normalCompletion: true,
});
await supervisor.tick();
finishPendingRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-finish-pending");
assert.equal(finishPendingRecord.armed, false);
assert.equal(finishPendingRecord.turnState, "completed");
assert.equal(finishPendingRecord.lastDispatchState, "normal-completion-observed-on-page");

await supervisor.noteReport({ conversationId: "conversation-running", runtimeKey: "main-03", observedAtMs: now });
runningRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-running");
assert.equal(runningRecord.armed, true);
assert.equal(runningRecord.reportOverdue, false);
assert.equal(Object.hasOwn(runningRecord, "runtimeKey"), false,
  "moving a page to Main-03 cannot turn Runtime into narration ownership");

now += 10 * 60_000;
await supervisor.tick();
assert.equal(calls.filter((row) => row.action === "sendContinue").length, 0,
  "the first interrupted-turn idle observation must not send immediately");
failedRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-failed");
assert.equal(failedRecord.rescuePending, true);
assert.equal(failedRecord.rescueEvidence, "transport-failure");
assert.equal(failedRecord.lastDispatchState, "interrupted-turn-idle-confirmation-armed");

now += 30_000;
await supervisor.tick();
let rescueCalls = calls.filter((row) => row.action === "sendContinue");
assert.deepEqual(rescueCalls, [{
  action: "sendContinue",
  conversationId: "conversation-failed",
  locatedRuntimeKey: "main-03",
  locatedPort: 9733,
  attempt: 1,
  rescueEvidence: "transport-failure",
}]);
failedRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-failed");
assert.equal(failedRecord.armed, false, "successful rescue must close the old episode");
assert.equal(failedRecord.turnState, "rescue-dispatched");
assert.equal(failedRecord.continueAttempts, 1);

now += 60 * 60_000;
await supervisor.tick();
rescueCalls = calls.filter((row) => row.action === "sendContinue");
assert.equal(rescueCalls.length, 1, "one interruption episode may never emit repeated rescue turns");
completeRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-complete");
cancelledRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-cancelled");
assert.equal(completeRecord.armed, false);
assert.equal(cancelledRecord.armed, false);

// If the transport observer expires a long turn, page evidence still protects a
// normally completed assistant response from rescue.
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-uncertain", runtimeKey: "main-03", observedAtMs: now });
await supervisor.noteTurn({ kind: "expired", conversationId: "conversation-uncertain", runtimeKey: "main-03", observedAtMs: now + 10 * 60_000 });
now += 21 * 60_000;
await supervisor.tick();
const uncertainRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-uncertain");
assert.equal(uncertainRecord.armed, false);
assert.equal(uncertainRecord.turnState, "completed");
assert.equal(uncertainRecord.lastDispatchState, "normal-completion-observed-on-page");
assert.equal(calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-uncertain").length, 0);

// Duplicate pages fail closed for only that conversation.
await supervisor.noteTurn({ kind: "started", conversationId: "conversation-duplicate", runtimeKey: "main-04", observedAtMs: now });
await supervisor.noteTurn({ kind: "failed", conversationId: "conversation-duplicate", runtimeKey: "main-04", observedAtMs: now + 1_000 });
duplicateConversations.add("conversation-duplicate");
now += 21 * 60_000;
await supervisor.tick();
const duplicateRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-duplicate");
assert.equal(duplicateRecord.duplicatePageObserved, true);
assert.equal(duplicateRecord.lastDispatchState, "duplicate-conversation-pages");
assert.equal(calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-duplicate").length, 0);

// A successful rescue creates a new ChatGPT turn. If the native started event
// arrives before sendContinue returns, the old episode must not disarm the new
// one. This is the exact race that otherwise makes recovery self-cancel.
await supervisor.noteTurn({
  kind: "started",
  conversationId: "conversation-rescue-race",
  runtimeKey: "main-03",
  observedAtMs: now,
});
await supervisor.noteTurn({
  kind: "failed",
  conversationId: "conversation-rescue-race",
  runtimeKey: "main-03",
  canceled: false,
  observedAtMs: now + 1_000,
});
rescueHooks.set("conversation-rescue-race", async () => {
  pages.set("conversation-rescue-race", {
    ...pages.get("conversation-rescue-race"),
    generating: true,
    hasTurnError: false,
    incompleteUserTurn: false,
  });
  await supervisor.noteTurn({
    kind: "started",
    conversationId: "conversation-rescue-race",
    runtimeKey: "main-03",
    observedAtMs: now,
  });
});
now += 21 * 60_000;
await supervisor.tick();
now += 30_000;
await supervisor.tick();
const raceRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-rescue-race");
assert.equal(raceRecord.armed, true, "the rescue-created native turn must remain armed as a new episode");
assert.equal(raceRecord.turnState, "running");
assert.equal(raceRecord.episodeRevision, 2);
assert.equal(
  calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-rescue-race").length,
  1,
);

// Version-3 interrupted episodes may survive a Core restart, but only behind
// a fresh exact-page verification. Normal completion and already-rescued
// episodes remain disarmed, preventing the old repeated-message loop.
const restartDir = await mkdtemp(join(tmpdir(), "devspace-liveness-restart-test-"));
const restartStatePath = join(restartDir, "liveness.json");
const restartPlanStatePath = join(restartDir, "plans.json");
const restartProgressStatePath = join(restartDir, "progress.json");
await writeFile(restartStatePath, JSON.stringify({
  version: 3,
  records: {
    "conversation-restart-interrupted": {
      conversationId: "conversation-restart-interrupted",
      armed: true,
      turnState: "interrupted",
      episodeRevision: 4,
      startedAt: new Date(now - 40 * 60_000).toISOString(),
      interruptedAt: new Date(now - 21 * 60_000).toISOString(),
      lastActivityAt: new Date(now - 21 * 60_000).toISOString(),
      lastReportAt: new Date(now - 30 * 60_000).toISOString(),
      continueAttempts: 0,
      rescueEvidence: "transport-failure",
    },
    "conversation-restart-complete": {
      conversationId: "conversation-restart-complete",
      armed: true,
      turnState: "running",
      episodeRevision: 2,
      startedAt: new Date(now - 21 * 60_000).toISOString(),
      lastActivityAt: new Date(now - 21 * 60_000).toISOString(),
      continueAttempts: 0,
    },
    "conversation-restart-rescued": {
      conversationId: "conversation-restart-rescued",
      armed: true,
      turnState: "interrupted",
      episodeRevision: 5,
      startedAt: new Date(now - 40 * 60_000).toISOString(),
      interruptedAt: new Date(now - 21 * 60_000).toISOString(),
      continueAttempts: 1,
    },
    "conversation-restart-future": {
      conversationId: "conversation-restart-future",
      armed: true,
      turnState: "interrupted",
      episodeRevision: 1,
      startedAt: new Date(now + 60 * 60_000).toISOString(),
      interruptedAt: new Date(now + 60 * 60_000).toISOString(),
      continueAttempts: 0,
    },
  },
}), "utf8");
await writeFile(restartPlanStatePath, JSON.stringify({ plans: {} }), "utf8");
await writeFile(restartProgressStatePath, JSON.stringify({ messages: [] }), "utf8");
const restartSupervisor = new ConversationProgressLivenessSupervisor({
  statePath: restartStatePath,
  planStatePath: restartPlanStatePath,
  progressStatePath: restartProgressStatePath,
  adapter,
  reportIntervalMs: 10 * 60_000,
  continueMs: 20 * 60_000,
  pollMs: 1_000,
  now: () => now,
});
await restartSupervisor.start({ schedule: false });
let restartInterrupted = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-interrupted");
const restartComplete = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-complete");
const restartRescued = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-rescued");
const restartFuture = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-future");
assert.equal(restartInterrupted.armed, true);
assert.equal(restartInterrupted.lastDispatchState, "interrupted-turn-idle-confirmation-armed");
assert.equal(restartComplete.armed, false);
assert.equal(restartComplete.turnState, "completed");
assert.equal(restartRescued.armed, false);
assert.equal(restartRescued.turnState, "startup-disarmed");
assert.equal(restartFuture.armed, false, "future-dated state must never arm rescue after restart");
now += 30_000;
await restartSupervisor.tick();
restartInterrupted = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-interrupted");
assert.equal(restartInterrupted.armed, false);
assert.equal(restartInterrupted.turnState, "rescue-dispatched");
assert.equal(
  calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-restart-interrupted").length,
  1,
);
await restartSupervisor.close();
await rm(restartDir, { recursive: true, force: true });

const persisted = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(persisted.version, 3);
assert.equal(persisted.identityKey, "conversationId");
assert.equal(persisted.runtimeBinding, false);
assert.equal(persisted.tenMinuteAutomaticReminder, false);
assert.equal(persisted.tenMinuteAgentReportSloOnly, true);
assert.equal(persisted.twentyMinuteInterruptedTurnRescueOnly, true);
assert.equal(persisted.normalCompletionDisarms, true);
assert.equal(JSON.stringify(persisted).includes("lastReminderAt"), false);
assert.equal(JSON.stringify(persisted).includes("lastReminderProjectedAt"), false);
assert.equal(JSON.stringify(persisted).includes("reminderPending"), false);
assert.equal(JSON.stringify(persisted).includes("runtimeKey"), false);
assert.equal(JSON.stringify(persisted).includes("historic progress"), false);

assert.equal(cdpTest.runtimePort("main-01"), 9721);
assert.equal(cdpTest.runtimePort("main-02"), 9732);
assert.equal(cdpTest.runtimePort("main-03"), 9733);
assert.equal(cdpTest.runtimePort("main-32"), 9762);
assert.equal(cdpTest.runtimePort("worker-01"), null);
assert.equal(cdpTest.conversationIdFromUrl("https://chatgpt.com/c/conversation-a"), "conversation-a");
assert.notEqual(cdpTest.markerFor("conversation-a", 1), cdpTest.markerFor("conversation-b", 1));
assert.match(_test.progressReportingPolicy(), /No timer may send a reminder message/);

// Live adapter discovery may find an incomplete conversation on Main-03, but
// Runtime 03 remains a locator only.
const targetsByPort = new Map([
  [9721, []],
  [9732, []],
  [9733, [{
    id: "main-03-conversation-a",
    type: "page",
    url: "https://chatgpt.com/c/conversation-a",
    webSocketDebuggerUrl: "ws://main-03-conversation-a",
    snapshot: {
      exact: true,
      conversationId: "conversation-a",
      hydrated: true,
      generating: false,
      composerEmpty: true,
      latestMessageRole: "user",
      hasTurnError: true,
      normalCompletion: false,
      incompleteUserTurn: true,
      progressCardMounted: true,
      progressConversationId: "conversation-a",
    },
  }]],
]);
const runtime03Adapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01", "main-02", "main-03"],
  listTargets: async (port) => targetsByPort.get(port) || [],
  connect: async (target) => ({
    evaluate: async () => ({ ...target.snapshot }),
    close() {},
  }),
});
const locatedOnRuntime03 = await runtime03Adapter.find({ conversationId: "conversation-a" });
assert.equal(locatedOnRuntime03.exact, true);
assert.equal(locatedOnRuntime03.locatedRuntimeKey, "main-03");
assert.equal(locatedOnRuntime03.locatorOnly, true);
assert.equal(locatedOnRuntime03.runtimeBinding, false);
assert.equal(locatedOnRuntime03.normalCompletion, false);
assert.equal(locatedOnRuntime03.incompleteUserTurn, true);
assert.equal(typeof runtime03Adapter.sendReminder, "undefined", "the ten-minute reminder API must not exist");
assert.equal(typeof runtime03Adapter.projectReminder, "undefined", "the ten-minute reminder banner API must not exist");

await supervisor.close();
await runtime03Adapter.close();
await rm(dir, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-progress-liveness",
  identityKey: "conversationId",
  runtimeBinding: false,
  runtime03LocatorOnly: true,
  tenMinuteAgentReportSloOnly: true,
  tenMinuteAutomaticReminder: false,
  tenMinuteSyntheticUserTurn: false,
  twentyMinuteInterruptedTurnRescueOnly: true,
  normalCompletionDisarms: true,
  transportFinishRequiresPageCompletion: true,
  cancelledTurnDisarms: true,
  oneRescuePerInterruptionEpisode: true,
  rescueStartRaceProtected: true,
  persistedOldEpisodeDisarmed: true,
  interruptedEpisodeRestartRecoveredByPageEvidence: true,
  completedEpisodeRestartDisarmed: true,
  rescuedEpisodeRestartDisarmed: true,
  futureTimestampRestartDisarmed: true,
  planAndReportHistoryCannotArm: true,
  duplicateConversationFailsClosed: true,
  progressFailureCannotGateOtherTools: true,
  goalRecoveryDependency: false,
  autoCompactDependency: false,
}));
