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
  INTERRUPTED_TURN_RESCUE_TEXT,
  _test as cdpTest,
} from "./conversation-progress-liveness-cdp.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-liveness-test-"));
const statePath = join(dir, "liveness.json");
const planStatePath = join(dir, "plans.json");
const progressStatePath = join(dir, "progress.json");
let now = Date.parse("2026-09-11T06:00:00.000Z");
const calls = [];
const settled = [];

assert.equal(INTERRUPTED_TURN_RESCUE_TEXT, "- 繼續",
  "the visible interrupted-turn rescue must stay minimal and must not inject policy instructions");
assert.doesNotMatch(INTERRUPTED_TURN_RESCUE_TEXT, /devspace_progress_report|conversation|Runtime|工作中斷補救/i,
  "rescue policy belongs to the backend guard, not the synthetic user message");

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
  ["conversation-transport-only", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: true,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: false,
  }],
  ["conversation-stale-generating", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: true,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: false,
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
  ["conversation-restart-running-stale", {
    runtimeKey: "main-03",
    port: 9733,
    hydrated: true,
    generating: true,
    composerEmpty: true,
    latestMessageRole: "user",
    hasTurnError: false,
    normalCompletion: false,
    incompleteUserTurn: false,
  }],
]);
const duplicateConversations = new Set();
const rescueHooks = new Map();
const rescueResults = new Map();

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
  async resetInterruptedGeneration(input) {
    calls.push({
      action: "resetInterruptedGeneration",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
      rescueEvidence: input.rescueEvidence,
    });
    const page = pages.get(input.conversationId);
    if (page) {
      pages.set(input.conversationId, {
        ...page,
        generating: false,
        hasTurnError: true,
        incompleteUserTurn: true,
      });
    }
    return { ok: true, state: "stale-generating-stop-clicked", resetCommitted: true };
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
    return rescueResults.get(input.conversationId) || { ok: true };
  },
};

// Old persisted episodes must never restart an automatic rescue loop after a
// Core reload. The fresh native turn observer is the only arming authority.
await writeFile(statePath, JSON.stringify({
  version: 3,
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
  onConversationSettled: (event) => settled.push(event),
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
assert.equal(supervisor.status().restartRestoresActiveEpisodeAsInterrupted, true);
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
await supervisor.noteTurn({
  kind: "started",
  conversationId: "conversation-transport-only",
  runtimeKey: "main-03",
  observedAtMs: now,
});
await supervisor.noteTurn({
  kind: "finished",
  transportOnly: true,
  conversationId: "conversation-transport-only",
  runtimeKey: "main-03",
  observedAtMs: now + 2_500,
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
const transportOnlyRecord = supervisor.status().records.find((row) => row.conversationId === "conversation-transport-only");
assert.equal(completeRecord.armed, false, "normal native completion must immediately disarm rescue");
assert.equal(completeRecord.turnState, "completed");
assert.equal(finishPendingRecord.armed, true,
  "a transport boundary may not claim normal completion while the exact page is still generating");
assert.equal(finishPendingRecord.turnState, "completion-pending");
assert.equal(transportOnlyRecord.armed, true,
  "HTTP loadingFinished is only a transport boundary and must keep a tool-using assistant turn armed");
assert.equal(transportOnlyRecord.turnState, "running");
assert.equal(transportOnlyRecord.interruptedAt, null,
  "transport-only completion must not start the interruption/rescue clock");
assert.equal(transportOnlyRecord.lastDispatchState, "conversation-turn-transport-finished-nonterminal");
assert.equal(cancelledRecord.armed, false, "an explicit user cancellation must not be auto-rescued");
assert.equal(cancelledRecord.turnState, "cancelled");
assert.equal(settled.some((event) => event.conversationId === "conversation-complete" && event.turnState === "completed"), true);
assert.equal(settled.some((event) => event.conversationId === "conversation-cancelled" && event.turnState === "cancelled"), true);

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

// A click accepted by the exact page is a committed dispatch even if the
// bounded DOM visibility check cannot confirm the user turn. The same episode
// must close rather than sending a duplicate rescue message.
pages.set("conversation-rescue-unverified", {
  runtimeKey: "main-03",
  port: 9733,
  hydrated: true,
  generating: false,
  composerEmpty: true,
  latestMessageRole: "user",
  hasTurnError: true,
  normalCompletion: false,
  incompleteUserTurn: true,
});
rescueResults.set("conversation-rescue-unverified", {
  ok: false,
  state: "missing",
  dispatchCommitted: true,
  visibilityVerified: false,
});
await supervisor.noteTurn({
  kind: "started",
  conversationId: "conversation-rescue-unverified",
  runtimeKey: "main-03",
  observedAtMs: now,
});
await supervisor.noteTurn({
  kind: "failed",
  conversationId: "conversation-rescue-unverified",
  runtimeKey: "main-03",
  canceled: false,
  observedAtMs: now + 1_000,
});
now += 21 * 60_000;
await supervisor.tick();
now += 30_000;
await supervisor.tick();
const unverifiedRescue = supervisor.status().records.find((row) => row.conversationId === "conversation-rescue-unverified");
assert.equal(unverifiedRescue.armed, false);
assert.equal(unverifiedRescue.turnState, "rescue-submitted-unverified");
assert.equal(unverifiedRescue.continueAttempts, 1);
assert.equal(unverifiedRescue.lastDispatchState, "single-conversation-rescue-committed-no-retry");
now += 30 * 60_000;
await supervisor.tick();
assert.equal(
  calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-rescue-unverified").length,
  1,
  "a committed-but-unverified rescue may never be sent twice",
);

// Version-4 interrupted episodes may survive a Core restart, but only behind
// a fresh exact-page verification. Normal completion and already-rescued
// episodes remain disarmed. Version 3 is deliberately retired above because
// its report ownership could have been polluted by a shared direct session.
const restartDir = await mkdtemp(join(tmpdir(), "devspace-liveness-restart-test-"));
const restartStatePath = join(restartDir, "liveness.json");
const restartPlanStatePath = join(restartDir, "plans.json");
const restartProgressStatePath = join(restartDir, "progress.json");
await writeFile(restartStatePath, JSON.stringify({
  version: 4,
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
    "conversation-restart-running-stale": {
      conversationId: "conversation-restart-running-stale",
      armed: true,
      turnState: "running",
      episodeRevision: 3,
      startedAt: new Date(now - 5 * 60_000).toISOString(),
      lastActivityAt: new Date(now - 2 * 60_000).toISOString(),
      lastReportAt: new Date(now - 2 * 60_000).toISOString(),
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
let restartRunningStale = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-running-stale");
const restartRescued = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-rescued");
const restartFuture = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-future");
assert.equal(restartInterrupted.armed, true);
assert.equal(restartInterrupted.lastDispatchState, "interrupted-turn-idle-confirmation-armed");
assert.equal(restartComplete.armed, false);
assert.equal(restartComplete.turnState, "completed");
assert.equal(restartRunningStale.armed, true);
assert.equal(restartRunningStale.turnState, "restart-interrupted");
assert.equal(restartRunningStale.rescueEvidence, "core-restart");
assert.ok(restartRunningStale.restartObservedAt);
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
now += 21 * 60_000;
await restartSupervisor.tick();
restartRunningStale = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-running-stale");
assert.equal(restartRunningStale.lastDispatchState, "stale-generating-interruption-confirmation-armed");
now += 30_000;
await restartSupervisor.tick();
assert.equal(
  calls.filter((row) => row.action === "resetInterruptedGeneration" && row.conversationId === "conversation-restart-running-stale").length,
  1,
);
now += 30_000;
await restartSupervisor.tick();
now += 30_000;
await restartSupervisor.tick();
restartRunningStale = restartSupervisor.status().records.find((row) => row.conversationId === "conversation-restart-running-stale");
assert.equal(
  calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-restart-running-stale").length,
  1,
);
assert.equal(restartRunningStale.armed, false);
assert.equal(restartRunningStale.turnState, "rescue-dispatched");
await restartSupervisor.close();
await rm(restartDir, { recursive: true, force: true });

// A real transport failure can leave the ChatGPT page with a stale Stop
// affordance even though the prior turn is already dead. Rescue must not be
// blocked forever by that stale `generating` signal: after the full twenty
// minute boundary and a second idle confirmation, reset it exactly once, then
// use the ordinary exact-page one-shot `- 繼續` path on a later tick.
const staleDir = await mkdtemp(join(tmpdir(), "devspace-liveness-stale-generating-test-"));
const staleStatePath = join(staleDir, "liveness.json");
const stalePlanPath = join(staleDir, "plans.json");
const staleProgressPath = join(staleDir, "progress.json");
await writeFile(stalePlanPath, JSON.stringify({ plans: {} }), "utf8");
await writeFile(staleProgressPath, JSON.stringify({ messages: [] }), "utf8");
let staleNow = now;
const staleCalls = [];
const stalePages = new Map([["conversation-stale-generating", {
  runtimeKey: "main-03",
  port: 9733,
  hydrated: true,
  generating: true,
  composerEmpty: true,
  latestMessageRole: "user",
  hasTurnError: false,
  normalCompletion: false,
  incompleteUserTurn: false,
}]]);
let staleSupervisor;
const staleAdapter = {
  async find({ conversationId }) {
    const page = stalePages.get(conversationId);
    return page ? locatedPage(conversationId, page) : { exact: false, state: "conversation-page-not-open", conversationId };
  },
  async clearReminder() { return { ok: true }; },
  async resetInterruptedGeneration(input) {
    staleCalls.push({ action: "resetInterruptedGeneration", conversationId: input.conversationId, rescueEvidence: input.rescueEvidence });
    await staleSupervisor.noteTurn({
      kind: "failed",
      conversationId: input.conversationId,
      runtimeKey: "main-03",
      canceled: true,
      observedAtMs: staleNow,
    });
    const page = stalePages.get(input.conversationId);
    stalePages.set(input.conversationId, {
      ...page,
      generating: false,
      hasTurnError: true,
      incompleteUserTurn: true,
    });
    return { ok: true, state: "stale-generating-stop-clicked", resetCommitted: true };
  },
  async sendContinue(input) {
    staleCalls.push({ action: "sendContinue", conversationId: input.conversationId, rescueEvidence: input.rescueEvidence });
    return { ok: true };
  },
};
staleSupervisor = new ConversationProgressLivenessSupervisor({
  statePath: staleStatePath,
  planStatePath: stalePlanPath,
  progressStatePath: staleProgressPath,
  adapter: staleAdapter,
  reportIntervalMs: 10 * 60_000,
  continueMs: 20 * 60_000,
  pollMs: 1_000,
  now: () => staleNow,
});
await staleSupervisor.start({ schedule: false });
await staleSupervisor.noteTurn({
  kind: "started",
  conversationId: "conversation-stale-generating",
  runtimeKey: "main-03",
  observedAtMs: staleNow,
});
await staleSupervisor.noteTurn({
  kind: "failed",
  conversationId: "conversation-stale-generating",
  runtimeKey: "main-03",
  canceled: false,
  observedAtMs: staleNow + 1_000,
});
staleNow += 21 * 60_000;
await staleSupervisor.tick();
let staleRecord = staleSupervisor.status().records.find((row) => row.conversationId === "conversation-stale-generating");
assert.equal(staleRecord.lastDispatchState, "stale-generating-interruption-confirmation-armed");
assert.equal(staleCalls.length, 0, "stale generating state needs a second exact-page confirmation before any mutation");
staleNow += 30_000;
await staleSupervisor.tick();
staleRecord = staleSupervisor.status().records.find((row) => row.conversationId === "conversation-stale-generating");
assert.deepEqual(staleCalls, [{
  action: "resetInterruptedGeneration",
  conversationId: "conversation-stale-generating",
  rescueEvidence: "transport-failure",
}]);
assert.ok(staleRecord.generationResetAt, "the stale generating reset must be recorded so the same episode cannot click Stop twice");
assert.equal(staleRecord.continueAttempts, 0);
staleNow += 30_000;
await staleSupervisor.tick();
assert.equal(staleCalls.filter((row) => row.action === "resetInterruptedGeneration").length, 1);
assert.equal(staleCalls.filter((row) => row.action === "sendContinue").length, 0,
  "after resetting stale generation, rescue still requires the ordinary idle confirmation");
staleNow += 30_000;
await staleSupervisor.tick();
staleRecord = staleSupervisor.status().records.find((row) => row.conversationId === "conversation-stale-generating");
assert.equal(staleCalls.filter((row) => row.action === "resetInterruptedGeneration").length, 1);
assert.equal(staleCalls.filter((row) => row.action === "sendContinue").length, 1);
assert.equal(staleRecord.armed, false);
assert.equal(staleRecord.turnState, "rescue-dispatched");
assert.equal(staleRecord.continueAttempts, 1);
await staleSupervisor.close();
await rm(staleDir, { recursive: true, force: true });

const persisted = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(persisted.version, 4);
assert.equal(persisted.identityKey, "conversationId");
assert.equal(persisted.runtimeBinding, false);
assert.equal(persisted.tenMinuteAutomaticReminder, false);
assert.equal(persisted.tenMinuteAgentReportSloOnly, true);
assert.equal(persisted.twentyMinuteInterruptedTurnRescueOnly, true);
assert.equal(persisted.normalCompletionDisarms, true);
assert.equal(persisted.restartRestoresActiveEpisodeAsInterrupted, true);
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
const exactRuntime03 = await runtime03Adapter.findAtRuntime({
  conversationId: "conversation-a",
  runtimeKey: "main-03",
});
assert.equal(exactRuntime03.exact, true);
assert.equal(exactRuntime03.locatedRuntimeKey, "main-03");
assert.equal(exactRuntime03.runtimeBinding, false);
const wrongRuntime = await runtime03Adapter.findAtRuntime({
  conversationId: "conversation-a",
  runtimeKey: "main-02",
});
assert.equal(wrongRuntime.exact, false);
assert.equal(wrongRuntime.state, "conversation-not-in-runtime");
assert.equal(typeof runtime03Adapter.sendReminder, "undefined", "the ten-minute reminder API must not exist");
assert.equal(typeof runtime03Adapter.projectReminder, "undefined", "the ten-minute reminder banner API must not exist");

let resetExpression = "";
const staleResetTarget = {
  id: "main-03-stale-reset",
  type: "page",
  url: "https://chatgpt.com/c/conversation-stale-reset",
  webSocketDebuggerUrl: "ws://main-03-stale-reset",
};
const staleResetAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-03"],
  listTargets: async () => [staleResetTarget],
  connect: async () => ({
    evaluate: async (expression) => {
      resetExpression = expression;
      return { ok: true, state: "stale-generating-stop-clicked", resetCommitted: true };
    },
    close() {},
  }),
});
const staleResetResult = await staleResetAdapter.resetInterruptedGeneration({
  conversationId: "conversation-stale-reset",
  target: {
    exact: true,
    conversationId: "conversation-stale-reset",
    runtimeKey: "main-03",
    port: 9733,
    target: {
      runtimeKey: "main-03",
      port: 9733,
      targetId: staleResetTarget.id,
      url: staleResetTarget.url,
      webSocketDebuggerUrl: staleResetTarget.webSocketDebuggerUrl,
    },
  },
});
assert.equal(staleResetResult.ok, true);
assert.equal(staleResetResult.resetCommitted, true);
assert.equal(staleResetResult.locatedRuntimeKey, "main-03");
assert.equal(staleResetResult.runtimeBinding, false);
assert.equal(staleResetResult.foregroundActivation, false);
assert.equal(staleResetResult.pageNavigation, false);
assert.match(resetExpression, /data-testid=\\"stop-button\\"|data-testid="stop-button"/);
assert.match(resetExpression, /stop\.click\(\)/);
assert.doesNotMatch(resetExpression, /location\.(?:href|assign|replace)|window\.focus|activate/i,
  "stale generating reset must stay on the exact current page without navigation or foreground activation");

const exactRecoveryTarget = {
  id: "main-03-goal-recovery",
  type: "page",
  url: "https://chatgpt.com/c/conversation-goal-recovery",
  webSocketDebuggerUrl: "ws://main-03-goal-recovery",
};
const recoveryEvaluations = [];
const recoveryCalls = [];
let recoveryEvaluationIndex = 0;
const exactPageRecoveryAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-03"],
  listTargets: async () => [exactRecoveryTarget],
  sleep: async () => {},
  connect: async () => ({
    evaluate: async (expression) => {
      recoveryEvaluations.push(expression);
      recoveryEvaluationIndex += 1;
      if (recoveryEvaluationIndex === 1) return { ok: true };
      if (recoveryEvaluationIndex === 2) return { ok: true };
      return { ok: true, state: "visible" };
    },
    call: async (method, params) => {
      recoveryCalls.push({ method, params });
      return {};
    },
    close() {},
  }),
});
const goalRecoverySend = await exactPageRecoveryAdapter.sendGoalRecovery({
  conversationId: "conversation-goal-recovery",
  target: {
    exact: true,
    conversationId: "conversation-goal-recovery",
    runtimeKey: "main-03",
    port: 9733,
    target: {
      runtimeKey: "main-03",
      port: 9733,
      targetId: exactRecoveryTarget.id,
      url: exactRecoveryTarget.url,
      webSocketDebuggerUrl: exactRecoveryTarget.webSocketDebuggerUrl,
    },
  },
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY]\nContinue the same verified Goal round.",
  attempt: 1,
});
assert.equal(goalRecoverySend.ok, true);
assert.equal(goalRecoverySend.purpose, "goal-round-recovery");
assert.equal(goalRecoverySend.dispatchCommitted, true);
assert.equal(goalRecoverySend.visibilityVerified, true);
assert.equal(goalRecoverySend.foregroundActivation, false);
assert.equal(goalRecoverySend.pageNavigation, false);
assert.equal(recoveryCalls.length, 1);
assert.equal(recoveryCalls[0].method, "Input.insertText");
assert.match(recoveryEvaluations[0], /const allowNormalCompletion = true;/,
  "Goal Recovery must allow the completed assistant message that proves the prior round ended");
assert.match(recoveryEvaluations[0], /const requireInterruptionEvidence = false;/,
  "the Goal guard, not generic rescue DOM heuristics, owns recovery eligibility");
const invalidGoalRecovery = await exactPageRecoveryAdapter.sendGoalRecovery({
  conversationId: "conversation-goal-recovery",
  prompt: "untrusted arbitrary follow-up",
});
assert.deepEqual(invalidGoalRecovery, { ok: false, state: "invalid-goal-recovery-prompt" });

let alreadyVisibleCalls = 0;
const alreadyVisibleRecoveryAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-03"],
  listTargets: async () => [exactRecoveryTarget],
  sleep: async () => {},
  connect: async () => ({
    evaluate: async () => ({ ok: true, state: "already-visible", alreadyVisible: true }),
    call: async () => { alreadyVisibleCalls += 1; return {}; },
    close() {},
  }),
});
const alreadyVisibleRecovery = await alreadyVisibleRecoveryAdapter.sendGoalRecovery({
  conversationId: "conversation-goal-recovery",
  target: {
    exact: true,
    conversationId: "conversation-goal-recovery",
    runtimeKey: "main-03",
    port: 9733,
    target: {
      runtimeKey: "main-03",
      port: 9733,
      targetId: exactRecoveryTarget.id,
      url: exactRecoveryTarget.url,
      webSocketDebuggerUrl: exactRecoveryTarget.webSocketDebuggerUrl,
    },
  },
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY]\nContinue the same verified Goal round.",
  attempt: 1,
});
assert.equal(alreadyVisibleRecovery.ok, true);
assert.equal(alreadyVisibleRecovery.alreadyVisible, true);
assert.equal(alreadyVisibleRecovery.dispatchCommitted, true);
assert.equal(alreadyVisibleCalls, 0, "an already visible exact recovery turn must not be submitted twice");

let uncertainEvaluationIndex = 0;
const uncertainRecoveryAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-03"],
  listTargets: async () => [exactRecoveryTarget],
  sleep: async () => {},
  connect: async () => ({
    evaluate: async () => {
      uncertainEvaluationIndex += 1;
      if (uncertainEvaluationIndex <= 2) return { ok: true };
      return { ok: false, state: "missing" };
    },
    call: async () => ({}),
    close() {},
  }),
});
const uncertainRecovery = await uncertainRecoveryAdapter.sendGoalRecovery({
  conversationId: "conversation-goal-recovery",
  target: {
    exact: true,
    conversationId: "conversation-goal-recovery",
    runtimeKey: "main-03",
    port: 9733,
    target: {
      runtimeKey: "main-03",
      port: 9733,
      targetId: exactRecoveryTarget.id,
      url: exactRecoveryTarget.url,
      webSocketDebuggerUrl: exactRecoveryTarget.webSocketDebuggerUrl,
    },
  },
  prompt: "[DEVSPACE_GOAL_ROUND_RECOVERY]\nContinue one uncertain submission.",
  attempt: 2,
});
assert.equal(uncertainRecovery.ok, false);
assert.equal(uncertainRecovery.dispatchCommitted, true);
assert.equal(uncertainRecovery.visibilityVerified, false);
assert.equal(uncertainRecovery.definiteFailure, false);
assert.equal(uncertainEvaluationIndex, 22,
  "visibility verification must be bounded after one committed click");

await supervisor.close();
await runtime03Adapter.close();
await exactPageRecoveryAdapter.close();
await alreadyVisibleRecoveryAdapter.close();
await uncertainRecoveryAdapter.close();
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
  restartRestoresActiveEpisodeAsInterrupted: true,
  completionRevokesActiveTurnAuthority: true,
  exactPageGoalRecovery: true,
  goalRecoveryForegroundActivation: false,
  goalRecoveryPageNavigation: false,
  transportFinishRequiresPageCompletion: true,
  transportOnlyFinishNonTerminal: true,
  cancelledTurnDisarms: true,
  staleGeneratingInterruptedTurnResetOnce: true,
  resetGeneratedCancellationPreservesRescue: true,
  oneRescuePerInterruptionEpisode: true,
  committedRescueNeverRetried: true,
  rescueStartRaceProtected: true,
  persistedOldEpisodeDisarmed: true,
  interruptedEpisodeRestartRecoveredByPageEvidence: true,
  runningEpisodeRestartRecoveredByCoreRestartEvidence: true,
  completedEpisodeRestartDisarmed: true,
  rescuedEpisodeRestartDisarmed: true,
  futureTimestampRestartDisarmed: true,
  planAndReportHistoryCannotArm: true,
  duplicateConversationFailsClosed: true,
  progressFailureCannotGateOtherTools: true,
  goalRecoveryDependency: false,
  autoCompactDependency: false,
}));
