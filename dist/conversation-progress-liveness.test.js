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
  ["conversation-a", { runtimeKey: "main-01", port: 9721, hydrated: true, generating: true, composerEmpty: true }],
  ["conversation-b", { runtimeKey: "main-02", port: 9732, hydrated: true, generating: false, composerEmpty: true }],
]);
const duplicateConversations = new Set();

function locatedPage(conversationId, page) {
  return {
    exact: true,
    conversationId,
    runtimeKey: page.runtimeKey,
    port: page.port,
    hydrated: page.hydrated,
    generating: page.generating,
    composerEmpty: page.composerEmpty,
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
  async projectReminder(input) {
    calls.push({
      action: "projectReminder",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
      locatedPort: input.target?.port || null,
    });
    return { ok: true };
  },
  async clearReminder(input) {
    calls.push({
      action: "clearReminder",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
    });
    return { ok: true };
  },
  async sendReminder(input) {
    calls.push({
      action: "sendReminder",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
      locatedPort: input.target?.port || null,
    });
    return { ok: true, runtimeBinding: false };
  },
  async sendContinue(input) {
    calls.push({
      action: "sendContinue",
      conversationId: input.conversationId,
      locatedRuntimeKey: input.target?.runtimeKey || null,
      locatedPort: input.target?.port || null,
      attempt: input.attempt,
    });
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
assert.equal(supervisor.status().stateKey, "conversationId");
assert.equal(supervisor.status().runtimeBinding, false);
assert.equal(supervisor.status().runtimeUsedOnlyAsEphemeralLocator, true);
assert.equal(supervisor.status().supportsRuntime03AndLater, true);
for (const record of supervisor.status().records) {
  assert.equal(Object.hasOwn(record, "runtimeKey"), false, "runtimeKey must never be a persisted liveness owner");
  assert.equal(Object.hasOwn(record, "lastObservedRuntimeKey"), false, "even diagnostic Runtime observations must not become durable identity");
}
assert.equal(calls.filter((row) => row.action === "sendContinue").length, 0);

now += 10 * 60_000;
await supervisor.tick();
const reminderCalls = calls.filter((row) => row.action === "projectReminder");
assert.deepEqual(
  reminderCalls.map((row) => `${row.conversationId}:${row.locatedRuntimeKey}`).sort(),
  ["conversation-a:main-01", "conversation-b:main-02"],
  "each reminder must locate the exact conversation independently",
);
const sentReminderCalls = calls.filter((row) => row.action === "sendReminder");
assert.deepEqual(
  sentReminderCalls.map((row) => `${row.conversationId}:${row.locatedRuntimeKey}`).sort(),
  ["conversation-a:main-01", "conversation-b:main-02"],
  "the ten-minute Agent reminder must be dispatched to each exact conversation independently",
);
assert.equal(
  sentReminderCalls.some((row) => Object.hasOwn(row, "runtimeBinding")),
  false,
  "test transport observations must not become persisted narration ownership",
);

now += 10 * 60_000;
await supervisor.tick();
assert.equal(
  calls.filter((row) => row.action === "sendContinue").length,
  0,
  "a generating conversation and each conversation's first idle observation must not auto-send",
);

now += 30_000;
await supervisor.tick();
let continues = calls.filter((row) => row.action === "sendContinue");
assert.equal(continues.length, 1);
assert.deepEqual(
  continues[0],
  {
    action: "sendContinue",
    conversationId: "conversation-b",
    locatedRuntimeKey: "main-02",
    locatedPort: 9732,
    attempt: 1,
  },
);
assert.equal(
  continues.some((row) => row.conversationId === "conversation-a"),
  false,
  "conversation-a may not receive a continuation while its own turn is still generating",
);

// The same conversation moves from Runtime 02 to Runtime 03. The durable
// record and silence window must follow the conversation, not the window.
pages.set("conversation-b", {
  ...pages.get("conversation-b"),
  runtimeKey: "main-03",
  port: 9733,
});
await supervisor.noteTurn({
  kind: "finished",
  conversationId: "conversation-b",
  runtimeKey: "main-03",
  observedAtMs: now,
});
let recordB = supervisor.status().records.find((row) => row.conversationId === "conversation-b");
assert.equal(Object.hasOwn(recordB, "runtimeKey"), false);
assert.equal(recordB.continueAttempts, 1, "moving windows must not reset the conversation's continuation history");

now += 20 * 60_000;
await supervisor.tick();
now += 30_000;
await supervisor.tick();
continues = calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-b");
assert.equal(continues.length, 2);
assert.equal(continues.at(-1).locatedRuntimeKey, "main-03");
assert.equal(continues.at(-1).locatedPort, 9733);

// A report from A may arrive after that same conversation appears on Runtime
// 03. The runtime observation is irrelevant and must not cause a conflict.
await supervisor.noteReport({
  conversationId: "conversation-a",
  runtimeKey: "main-03",
  observedAtMs: now,
});
const stateAfterA = supervisor.status().records.find((row) => row.conversationId === "conversation-a");
recordB = supervisor.status().records.find((row) => row.conversationId === "conversation-b");
assert.equal(stateAfterA.reminderPending, false);
assert.equal(stateAfterA.continueAttempts, 0);
assert.equal(recordB.continueAttempts, 2, "reporting in A must not reset B");
assert.notEqual(stateAfterA.lastDispatchState, "runtime-owner-conflict");

// Two visible pages for the same conversation are ambiguous. The supervisor
// fails closed for that conversation only; it does not touch another record.
duplicateConversations.add("conversation-a");
now += 20 * 60_000;
await supervisor.tick();
const ambiguousA = supervisor.status().records.find((row) => row.conversationId === "conversation-a");
recordB = supervisor.status().records.find((row) => row.conversationId === "conversation-b");
assert.equal(ambiguousA.duplicatePageObserved, true);
assert.equal(ambiguousA.lastDispatchState, "duplicate-conversation-pages");
assert.equal(recordB.duplicatePageObserved, false);
assert.equal(
  calls.filter((row) => row.action === "sendContinue" && row.conversationId === "conversation-a").length,
  0,
  "duplicate pages must never receive an guessed continuation",
);

const persisted = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(persisted.version, 2);
assert.equal(persisted.identityKey, "conversationId");
assert.equal(persisted.runtimeBinding, false);
assert.equal(Object.hasOwn(persisted.records["conversation-a"], "runtimeKey"), false);
assert.equal(Object.hasOwn(persisted.records["conversation-b"], "runtimeKey"), false);
assert.equal(JSON.stringify(persisted).includes("A report"), false, "raw narration text must not be copied into liveness state");
assert.equal(supervisor.status().crossConversationSharing, false);
assert.equal(supervisor.status().goalRecoveryDependency, false);
assert.equal(supervisor.status().autoCompactDependency, false);

assert.equal(cdpTest.runtimePort("main-01"), 9721);
assert.equal(cdpTest.runtimePort("main-02"), 9732);
assert.equal(cdpTest.runtimePort("main-03"), 9733);
assert.equal(cdpTest.runtimePort("main-32"), 9762);
assert.equal(cdpTest.runtimePort("worker-01"), null);
assert.equal(cdpTest.conversationIdFromUrl("https://chatgpt.com/c/conversation-a"), "conversation-a");
assert.match(cdpTest.localMinute(Date.parse("2026-09-11T06:27:00Z")), /^2026-09-11 14:27$/);
assert.notEqual(cdpTest.markerFor("conversation-a", 1), cdpTest.markerFor("conversation-b", 1));
assert.match(_test.reminderInstruction(10 * 60_000), /devspace_progress_report/);

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
      generating: true,
      composerEmpty: true,
      progressCardMounted: true,
      progressConversationId: "conversation-a",
    },
  }]],
]);
const hostReminderCalls = [];
const runtime03Adapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01", "main-02", "main-03"],
  listTargets: async (port) => targetsByPort.get(port) || [],
  connect: async (target) => ({
    evaluate: async () => ({ ...target.snapshot }),
    close() {},
  }),
  hostBridge: {
    async dispatchConversationFollowUp(input) {
      hostReminderCalls.push(input);
      return { ok: true, transport: "test-exact-conversation-relay" };
    },
  },
});
const locatedOnRuntime03 = await runtime03Adapter.find({ conversationId: "conversation-a" });
assert.equal(locatedOnRuntime03.exact, true);
assert.equal(locatedOnRuntime03.locatedRuntimeKey, "main-03");
assert.equal(locatedOnRuntime03.locatorOnly, true);
assert.equal(locatedOnRuntime03.runtimeBinding, false);
const reminderOnRuntime03 = await runtime03Adapter.sendReminder({
  conversationId: "conversation-a",
  target: locatedOnRuntime03,
  silenceMs: 10 * 60_000,
});
assert.equal(reminderOnRuntime03.ok, true);
assert.equal(reminderOnRuntime03.conversationId, "conversation-a");
assert.equal(reminderOnRuntime03.locatedRuntimeKey, "main-03");
assert.equal(reminderOnRuntime03.runtimeBinding, false);
assert.deepEqual(hostReminderCalls, [{
  conversationId: "conversation-a",
  prompt: hostReminderCalls[0].prompt,
  purpose: "progress-reminder",
}]);
assert.match(hostReminderCalls[0].prompt, /devspace_progress_report/);
assert.equal(Object.hasOwn(hostReminderCalls[0], "runtimePort"), false,
  "the ten-minute reminder transport must search by exact conversationId rather than bind to Runtime 03");

targetsByPort.get(9732).push({
  id: "main-02-duplicate-conversation-a",
  type: "page",
  url: "https://chatgpt.com/c/conversation-a",
  webSocketDebuggerUrl: "ws://main-02-duplicate-conversation-a",
});
const duplicateConversation = await runtime03Adapter.find({ conversationId: "conversation-a" });
assert.equal(duplicateConversation.exact, false);
assert.equal(duplicateConversation.ambiguous, true);
assert.equal(duplicateConversation.state, "duplicate-conversation-pages");
const duplicateReminder = await runtime03Adapter.sendReminder({ conversationId: "conversation-a" });
assert.equal(duplicateReminder.ok, false);
assert.equal(duplicateReminder.ambiguous, true);
assert.equal(hostReminderCalls.length, 1,
  "an ambiguous duplicate page must fail before any reminder dispatch");

await supervisor.close();
await rm(dir, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  gate: "conversation-progress-liveness",
  identityKey: "conversationId",
  runtimeBinding: false,
  runtime03Relocation: true,
  exactConversationIsolation: true,
  duplicateConversationFailsClosed: true,
  tenMinuteReminder: true,
  tenMinuteAgentReminder: true,
  runtime03ReminderUsesConversationId: true,
  duplicateReminderFailsClosed: true,
  twentyMinuteContinue: true,
  generatingTurnProtected: true,
  unsentComposerProtectedByAdapter: true,
  reportResetsOnlyConversation: true,
  rawNarrationCopiedToWatchdogState: false,
  goalRecoveryDependency: false,
  autoCompactDependency: false,
}));
