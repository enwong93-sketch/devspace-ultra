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
  ["conversation-a", { exact: true, conversationId: "conversation-a", locatedRuntimeKey: "main-01", hydrated: true, generating: true, composerEmpty: true }],
  ["conversation-b", { exact: true, conversationId: "conversation-b", locatedRuntimeKey: "main-02", hydrated: true, generating: false, composerEmpty: true }],
]);
const adapter = {
  async find({ conversationId }) {
    const page = pages.get(conversationId);
    return page ? { ...page } : { exact: false, state: "page-not-open" };
  },
  async projectReminder(input) {
    calls.push({ action: "projectReminder", ...input });
    return { ok: true };
  },
  async clearReminder(input) {
    calls.push({ action: "clearReminder", ...input });
    return { ok: true };
  },
  async sendReminder(input) {
    calls.push({ action: "sendReminder", ...input });
    return { ok: true };
  },
  async sendContinue(input) {
    calls.push({ action: "sendContinue", ...input });
    return { ok: true };
  },
};

await writeFile(planStatePath, JSON.stringify({
  plans: {
    planA: {
      id: "plan-a",
      status: "active",
      revision: 1,
      updatedAt: new Date(now).toISOString(),
      conversationId: "conversation-a",
    },
    planB: {
      id: "plan-b",
      status: "active",
      revision: 1,
      updatedAt: new Date(now).toISOString(),
      conversationId: "conversation-b",
    },
  },
}), "utf8");
await writeFile(progressStatePath, JSON.stringify({
  messages: [
    {
      text: "A report",
      at: new Date(now).toISOString(),
      conversationId: "conversation-a",
      source: "agent-progress-tool",
      kind: "progress",
    },
    {
      text: "B report",
      at: new Date(now).toISOString(),
      conversationId: "conversation-b",
      source: "agent-progress-tool",
      kind: "progress",
    },
  ],
}), "utf8");

const supervisor = new ConversationProgressLivenessSupervisor({
  statePath,
  planStatePath,
  progressStatePath,
  adapter,
  reminderMs: 10 * 60_000,
  continueMs: 20 * 60_000,
  pollMs: 1_000,
  now: () => now,
});
await supervisor.start({ schedule: false });
assert.equal(supervisor.status().records.length, 2);
assert.equal(calls.filter((row) => row.action === "sendContinue").length, 0);

now += 10 * 60_000;
await supervisor.tick();
const reminderCalls = calls.filter((row) => row.action === "projectReminder");
assert.deepEqual(
  reminderCalls.map((row) => row.conversationId).sort(),
  ["conversation-a", "conversation-b"],
  "each conversation must project only its own reminder",
);
assert.equal(reminderCalls.some((row) => Object.hasOwn(row, "runtimeKey")), false, "reminder ownership must never include a runtime key");
const sentReminders = calls.filter((row) => row.action === "sendReminder");
assert.deepEqual(
  sentReminders.map((row) => row.conversationId).sort(),
  ["conversation-a", "conversation-b"],
  "the ten-minute reminder must be dispatched independently to each exact conversation",
);
assert.equal(sentReminders.some((row) => Object.hasOwn(row, "runtimeKey")), false);

now += 10 * 60_000;
await supervisor.tick();
assert.equal(
  calls.filter((row) => row.action === "sendContinue").length,
  0,
  "a generating conversation and the first idle observation must not auto-send",
);

now += 30_000;
await supervisor.tick();
const continues = calls.filter((row) => row.action === "sendContinue");
assert.equal(continues.length, 1);
assert.equal(continues[0].conversationId, "conversation-b");
assert.equal(Object.hasOwn(continues[0], "runtimeKey"), false, "continuation dispatch must be conversation-bound only");
assert.equal(
  continues.some((row) => row.conversationId === "conversation-a"),
  false,
  "Main-01 may not receive a continuation while its own turn is still generating",
);

await supervisor.noteReport({
  conversationId: "conversation-a",
  observedAtMs: now,
});
const stateAfterA = supervisor.status().records.find((row) => row.conversationId === "conversation-a");
const stateAfterB = supervisor.status().records.find((row) => row.conversationId === "conversation-b");
assert.equal(stateAfterA.reminderPending, false);
assert.equal(stateAfterA.continueAttempts, 0);
assert.equal(stateAfterB.continueAttempts, 1, "reporting in A must not reset B");

pages.set("conversation-a", {
  ...pages.get("conversation-a"),
  locatedRuntimeKey: "main-03",
  generating: false,
});
now += 20 * 60_000;
await supervisor.tick();
now += 30_000;
await supervisor.tick();
const allContinues = calls.filter((row) => row.action === "sendContinue");
assert.equal(allContinues.filter((row) => row.conversationId === "conversation-a").length, 1);
assert.equal(allContinues.filter((row) => row.conversationId === "conversation-b").length, 2);
assert.equal(
  pages.get("conversation-a").locatedRuntimeKey,
  "main-03",
  "the same conversation may move to Runtime 03 without changing narration ownership",
);

await writeFile(planStatePath, JSON.stringify({
  plans: {
    duplicateA1: { id: "duplicate-a-1", status: "active", revision: 1, updatedAt: new Date(now).toISOString(), conversationId: "conversation-a" },
    duplicateA2: { id: "duplicate-a-2", status: "active", revision: 1, updatedAt: new Date(now).toISOString(), conversationId: "conversation-a" },
    planB: { id: "plan-b", status: "active", revision: 1, updatedAt: new Date(now).toISOString(), conversationId: "conversation-b" },
  },
}), "utf8");
await supervisor.tick();
const ambiguousA = supervisor.status().records.find((row) => row.conversationId === "conversation-a");
assert.equal(ambiguousA.armed, false);
assert.equal(ambiguousA.ambiguous, true);
assert.equal(ambiguousA.lastDispatchState, "multiple-active-plans");

await supervisor.noteTurn({
  kind: "started",
  runtimeKey: "main-03",
  conversationId: "conversation-b",
  observedAtMs: now,
});
const relocatedB = supervisor.status().records.find((row) => row.conversationId === "conversation-b");
assert.equal(relocatedB.armed, true);
assert.equal(relocatedB.ambiguous, false);
assert.equal(Object.hasOwn(relocatedB, "runtimeKey"), false, "runtime changes are not ownership conflicts");

const persisted = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(persisted.records["conversation-a"].conversationId, "conversation-a");
assert.equal(persisted.records["conversation-b"].conversationId, "conversation-b");
assert.equal(persisted.version, 2);
assert.equal(JSON.stringify(persisted).includes("runtimeKey"), false, "liveness state must not persist runtime ownership");
assert.equal(JSON.stringify(persisted).includes("A report"), false, "raw narration text must not be copied into liveness state");
assert.equal(supervisor.status().crossConversationSharing, false);
assert.equal(supervisor.status().authorityKey, "conversationId");
assert.equal(supervisor.status().runtimeBinding, false);
assert.equal(supervisor.status().goalRecoveryDependency, false);
assert.equal(supervisor.status().autoCompactDependency, false);

assert.equal(cdpTest.runtimePort("main-01"), 9721);
assert.equal(cdpTest.runtimePort("main-02"), 9732);
assert.equal(cdpTest.runtimePort("main-03"), 9733);
assert.equal(cdpTest.runtimePort("main-32"), 9762);
assert.equal(cdpTest.runtimePort("worker-01"), null);
assert.equal(cdpTest.conversationIdFromUrl("https://chatgpt.com/c/conversation-a"), "conversation-a");
assert.equal(cdpTest.conversationIdFromUrl("https://chatgpt.com/c/conversation-b"), "conversation-b");
assert.match(cdpTest.localMinute(Date.parse("2026-09-11T06:27:00Z")), /^2026-09-11 14:27$/);
assert.notEqual(cdpTest.markerFor("conversation-a", 1), cdpTest.markerFor("conversation-b", 1));
assert.equal(typeof _test.activePlans, "function");

const targetsByPort = new Map([
  [9721, []],
  [9732, [{
    id: "main-02-other",
    type: "page",
    url: "https://chatgpt.com/c/conversation-other",
    webSocketDebuggerUrl: "ws://main-02-other",
    snapshot: { exact: true, conversationId: "conversation-other", hydrated: true, generating: false, composerEmpty: true },
  }]],
  [9733, [{
    id: "main-03-a",
    type: "page",
    url: "https://chatgpt.com/c/conversation-a",
    webSocketDebuggerUrl: "ws://main-03-a",
    snapshot: { exact: true, conversationId: "conversation-a", hydrated: true, generating: false, composerEmpty: true },
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
assert.equal(locatedOnRuntime03.conversationId, "conversation-a");
assert.equal(locatedOnRuntime03.locatedRuntimeKey, "main-03");

targetsByPort.get(9732).push({
  id: "main-02-duplicate-a",
  type: "page",
  url: "https://chatgpt.com/c/conversation-a",
  webSocketDebuggerUrl: "ws://main-02-duplicate-a",
});
const duplicateConversationPage = await runtime03Adapter.find({ conversationId: "conversation-a" });
assert.equal(duplicateConversationPage.exact, false);
assert.equal(duplicateConversationPage.ambiguous, true);
assert.equal(duplicateConversationPage.matchCount, 2);

const hostFollowUps = [];
const conversationOnlyHostAdapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01", "main-02", "main-03"],
  hostBridge: {
    async dispatchConversationFollowUp(input) {
      hostFollowUps.push(input);
      return { ok: true, conversationId: input.conversationId, runtimePort: 9733 };
    },
  },
});
assert.equal((await conversationOnlyHostAdapter.sendReminder({ conversationId: "conversation-a" })).ok, true);
assert.equal(hostFollowUps.length, 1);
assert.equal(hostFollowUps[0].conversationId, "conversation-a");
assert.equal(Object.hasOwn(hostFollowUps[0], "runtimePort"), false, "liveness Host dispatch must search by conversation rather than bind to a Runtime");

await supervisor.close();
await rm(dir, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-progress-liveness",
  exactConversationIsolation: true,
  tenMinuteReminder: true,
  arbitraryToolResultCoupling: false,
  twentyMinuteContinue: true,
  generatingTurnProtected: true,
  unsentComposerProtectedByAdapter: true,
  duplicatePlanFailsClosed: true,
  conversationMovesAcrossRuntime03: true,
  runtimeIsNotOwnership: true,
  runtime03PageDiscovery: true,
  duplicateConversationPageFailsClosed: true,
  hostFollowUpConversationOnly: true,
  reportResetsOnlyOwner: true,
  rawNarrationCopiedToWatchdogState: false,
  goalRecoveryDependency: false,
  autoCompactDependency: false,
}));
