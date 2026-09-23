import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { attachAutoCompactContract } from "./auto-compact-contract.js";
import { ContextGuardianRolloverCoordinator, buildMainCompactCapsule } from "./context-guardian-rollover.js";
import { ContextGuardianRolloverStateStore } from "./context-guardian-rollover-state.js";

const nowMs = Date.parse("2026-09-23T02:00:00.000Z");
const runtimeKey = "main-06";
const oldConversationId = "conversation-old";
const newConversationId = "conversation-new";
const goal = {
  id: "goal_durable",
  objective: "Prove Auto Compact survives a real Core restart",
  status: "active",
  round: 4,
  roundState: "working",
  revision: 10,
  successCriteria: [{ id: "criterion_durable", text: "Preserve exact Goal authority" }],
  recentReports: [],
};
const plan = {
  id: "plan_durable",
  title: "Durable rollover",
  status: "active",
  revision: 3,
  steps: [{ id: "step_durable", text: "Verify restart recovery", status: "in_progress" }],
};
const sourceDescriptor = {
  conversationId: oldConversationId,
  currentNode: "source-boundary-message",
  title: "Durable rollover",
  modelSlug: "gpt-5-6-thinking",
  payloadBytes: 2_000_000,
  branchMessageCount: 3_400,
  textChars: 800_000,
};

function durableCapsule() {
  const base = buildMainCompactCapsule({
    runtimeKey,
    goal,
    plan,
    context: {
      currentModelSlug: "gpt-5-6-thinking",
      contextWindowTokens: 262_144,
      pressure: { stage: "rollover", usageSource: "classic-native-actual-usage", usedTokens: 220_000 },
    },
    recentMessages: [{ role: "assistant", text: "Bounded visible checkpoint." }],
  });
  return attachAutoCompactContract(base, {
    source: sourceDescriptor,
    uiContinuityKey: `goal:${goal.id}`,
    runtimeKey,
    goalId: goal.id,
    planId: plan.id,
    mode: "user-turn",
    now: () => new Date(nowMs),
  });
}

function continuityHarness({ failMetaCount = 0 } = {}) {
  const records = new Map();
  const updates = [];
  let sequence = 0;
  let remainingMetaFailures = Math.max(0, Number(failMetaCount) || 0);
  return {
    runtime: {
      enabled: true,
      ready: Promise.resolve(),
      async checkpoint(input) {
        const id = `capsule_durable_${++sequence}`;
        const record = { id, capsuleId: id, capsule: structuredClone(input) };
        records.set(id, record);
        return structuredClone(record);
      },
      async loadCapsule(id) {
        const record = records.get(id);
        if (!record) throw new Error(`Unknown capsule ${id}`);
        return structuredClone(record);
      },
      async updateCapsuleMeta(id, patch) {
        if (remainingMetaFailures > 0) {
          remainingMetaFailures -= 1;
          throw new Error("injected capsule metadata failure");
        }
        updates.push({ id, patch: structuredClone(patch) });
      },
    },
    records,
    updates,
  };
}

function coordinatorHarness({
  statePath,
  stateStore,
  continuity,
  onVerifiedRollover,
  runtimes = [{ runtimeKey, port: 9736 }],
  now = () => nowMs,
} = {}) {
  const calls = { arms: 0, snapshots: 0, verified: 0, cancels: 0 };
  const contextGuardian = {
    async observeRuntimeSnapshot() {},
    async status() {
      return {
        runtimeKey,
        mode: "chat",
        conversationId: oldConversationId,
        currentModelSlug: "gpt-5-6-thinking",
        contextWindowTokens: 262_144,
        supportedChatMode: true,
        pressure: {
          stage: "rollover",
          usageSource: "classic-native-actual-usage",
          usedTokens: 220_000,
          shouldPrepareCheckpoint: true,
          shouldRolloverBeforeNextRequest: true,
        },
      };
    },
  };
  const contextAdapter = {
    status: () => ({ runtimes }),
    async refreshSnapshot() {
      calls.snapshots += 1;
      return {
        ok: true,
        mode: "chat",
        conversationId: oldConversationId,
        modelSlug: "gpt-5-6-thinking",
        generating: false,
        composerTextChars: 0,
        documentReadyState: "complete",
        composerReady: true,
        routeHydrated: true,
        routeStableForMs: 5_000,
      };
    },
    async recentVisibleMessages() { return [{ role: "assistant", text: "Bounded visible checkpoint." }]; },
    async nativeConversationDescriptor() { return { ...sourceDescriptor }; },
    async armUserTurnRollover() { calls.arms += 1; return { armed: true, mode: "user-turn" }; },
    async startHiddenRollover() { throw new Error("not used"); },
    async cancelUserTurnRollover() { calls.cancels += 1; return { cancelled: true }; },
  };
  const coordinator = new ContextGuardianRolloverCoordinator({
    contextGuardian,
    contextAdapter,
    continuityRuntime: continuity.runtime,
    goalRuntime: {
      async activeGoals() { return [goal]; },
      async status() { return goal; },
    },
    planRuntime: { async activePlans() { return [plan]; } },
    statePath,
    stateStore,
    now,
    onVerifiedRollover: async (event) => {
      calls.verified += 1;
      return await onVerifiedRollover?.(event) ?? { ok: true };
    },
    pollMs: 0,
  });
  return { coordinator, calls };
}

function controlledStateStore({ failReplace } = {}) {
  return {
    ready: Promise.resolve(),
    state: { prepared: [], descriptorFailures: [], compactFailures: [] },
    writes: 0,
    snapshot() {
      return {
        ok: true,
        blocked: false,
        loadError: null,
        prepared: this.state.prepared.length,
        committing: this.state.prepared.filter((row) => row.status === "committing").length,
      };
    },
    async replace(value) {
      this.writes += 1;
      const next = structuredClone(value);
      if (await failReplace?.(next, this.writes)) throw new Error("injected final journal clear failure");
      this.state = next;
      return this.snapshot();
    },
    async close() {},
  };
}

function completionEvent(capsuleId, capsule) {
  return {
    ok: true,
    mode: "user-turn",
    runtimeKey,
    goalId: goal.id,
    planId: plan.id,
    capsuleId,
    oldConversationId,
    newConversationId,
    conversationId: newConversationId,
    visibleUsers: 1,
    visibleAssistants: 1,
    hiddenMessages: 1,
    uiContinuityKey: capsule.continuity.uiContinuityKey,
    nativeContinuationSourceId: oldConversationId,
    observedAt: new Date(nowMs + 1_000).toISOString(),
    targetDescriptor: {
      conversationId: newConversationId,
      payloadBytes: 18_000,
      branchMessageCount: 3,
      mappingCount: 4,
      devspaceContinuity: {
        sourceConversationId: oldConversationId,
        sourceBoundaryMessageId: sourceDescriptor.currentNode,
        uiContinuityKey: capsule.continuity.uiContinuityKey,
        capsuleFingerprint: capsule.continuity.capsuleFingerprint,
      },
    },
  };
}

test("prepared capsule reference survives coordinator replacement and commits once", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-prepared-restart-"));
  const statePath = join(root, "rollover.json");
  const continuity = continuityHarness();
  try {
    const first = coordinatorHarness({ statePath, continuity });
    const prepared = await first.coordinator.pollOnce();
    assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
    assert.equal(first.calls.arms, 1);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.prepared.length, 1);
    assert.equal(JSON.stringify(persisted).includes("Bounded visible checkpoint"), false,
      "durability journal stores only the capsule reference, never capsule text");

    const second = coordinatorHarness({ statePath, continuity });
    await second.coordinator.ready;
    const capsuleId = persisted.prepared[0].capsuleId;
    const capsule = continuity.records.get(capsuleId).capsule;
    assert.equal(await second.coordinator.noteUserTurnRollover(completionEvent(capsuleId, capsule)), true);
    assert.equal(second.calls.verified, 1);
    assert.equal(second.coordinator.status().prepared, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).prepared.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committing journal is reconciled once after process restart and then cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-commit-restart-"));
  const statePath = join(root, "rollover.json");
  const continuity = continuityHarness();
  const capsule = durableCapsule();
  const record = { id: "capsule_committing_123456", capsuleId: "capsule_committing_123456", capsule };
  continuity.records.set(record.id, record);
  try {
    const store = new ContextGuardianRolloverStateStore({ statePath, now: () => nowMs });
    await store.replace({ prepared: [{
      runtimeKey,
      conversationId: oldConversationId,
      usedTokens: 220_000,
      preparedAt: nowMs,
      expiresAtMs: nowMs + 60 * 60_000,
      mode: "user-turn",
      capsuleId: record.id,
      uiContinuityKey: capsule.continuity.uiContinuityKey,
      status: "committing",
      preparationVersion: 7,
      commitEvent: completionEvent(record.id, capsule),
    }] });
    await store.close();

    const recovered = coordinatorHarness({ statePath, continuity, runtimes: [] });
    await recovered.coordinator.start({ schedule: false });
    assert.equal(recovered.calls.verified, 1);
    assert.equal(recovered.coordinator.status().recoveredCommitCount, 1);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).prepared.length, 0);

    const restartedAgain = coordinatorHarness({ statePath, continuity, runtimes: [] });
    await restartedAgain.coordinator.start({ schedule: false });
    assert.equal(restartedAgain.calls.verified, 0, "a completed recovered commit cannot replay on another restart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-authority journal-clear failure retains committing state for same-Core reconciliation", async () => {
  let failClearOnce = true;
  const stateStore = controlledStateStore({
    failReplace(value) {
      if (failClearOnce && value.prepared.length === 0) {
        failClearOnce = false;
        return true;
      }
      return false;
    },
  });
  const continuity = continuityHarness();
  const runtimes = [{ runtimeKey, port: 9736 }];
  const harness = coordinatorHarness({ stateStore, continuity, runtimes });
  const prepared = await harness.coordinator.pollOnce();
  assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
  const persisted = stateStore.state.prepared[0];
  const capsule = continuity.records.get(persisted.capsuleId).capsule;
  await assert.rejects(
    () => harness.coordinator.noteUserTurnRollover(completionEvent(persisted.capsuleId, capsule)),
    /injected final journal clear failure/,
  );
  assert.equal(harness.calls.verified, 1, "authority migration happened before the final journal clear failed");
  assert.equal(harness.coordinator.status().prepared, 1,
    "the in-memory committing row must remain available for same-Core reconciliation");
  assert.equal(stateStore.snapshot().committing, 1,
    "the last durable truth must remain the committing journal");
  runtimes.length = 0;
  await harness.coordinator.pollOnce();
  assert.equal(harness.calls.verified, 2, "same-Core reconciliation may replay only the idempotent authority transaction");
  assert.equal(harness.coordinator.status().recoveredCommitCount, 1);
  assert.equal(harness.coordinator.status().prepared, 0);
  assert.equal(stateStore.state.prepared.length, 0);
  await harness.coordinator.close();
});

test("post-authority capsule metadata failure blocks re-arming and recovers in the same Core", async () => {
  let clock = nowMs;
  const stateStore = controlledStateStore();
  const continuity = continuityHarness({ failMetaCount: 2 });
  const runtimes = [{ runtimeKey, port: 9736 }];
  const harness = coordinatorHarness({ stateStore, continuity, runtimes, now: () => clock });
  const prepared = await harness.coordinator.pollOnce();
  assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
  const persisted = stateStore.state.prepared[0];
  const capsule = continuity.records.get(persisted.capsuleId).capsule;
  await assert.rejects(
    () => harness.coordinator.noteUserTurnRollover(completionEvent(persisted.capsuleId, capsule)),
    /injected capsule metadata failure/,
  );
  assert.equal(harness.calls.verified, 1);
  assert.equal(harness.coordinator.status().pendingCommitRecoveries, 1);
  const retrying = await harness.coordinator.pollOnce();
  assert.equal(harness.calls.verified, 2, "the first same-Core recovery retries the idempotent authority transaction");
  assert.equal(retrying.results[0].action, "compact-finalization-pending");
  assert.equal(harness.calls.arms, 1, "pending finalization must block a fresh source arm");
  const beforeRetry = await harness.coordinator.pollOnce();
  assert.equal(harness.calls.verified, 2, "the bounded retry floor must suppress an immediate third transaction replay");
  assert.equal(beforeRetry.results[0].action, "compact-finalization-pending");
  clock += 5_001;
  runtimes.length = 0;
  await harness.coordinator.pollOnce();
  assert.equal(harness.calls.verified, 3);
  assert.equal(harness.coordinator.status().recoveredCommitCount, 1);
  assert.equal(harness.coordinator.status().pendingCommitRecoveries, 0);
  assert.equal(stateStore.state.prepared.length, 0);
  assert.equal(continuity.updates.length, 1);
  await harness.coordinator.close();
});

test("abort finalization persistence failure restores the committing row and failure map", async () => {
  let failAbortClearOnce = true;
  const stateStore = controlledStateStore({
    failReplace(value) {
      if (failAbortClearOnce && value.prepared.length === 0 && value.compactFailures.length === 1) {
        failAbortClearOnce = false;
        return true;
      }
      return false;
    },
  });
  const continuity = continuityHarness();
  const runtimes = [{ runtimeKey, port: 9736 }];
  const harness = coordinatorHarness({ stateStore, continuity, runtimes });
  const prepared = await harness.coordinator.pollOnce();
  assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
  const persisted = stateStore.state.prepared[0];
  const capsule = continuity.records.get(persisted.capsuleId).capsule;
  const failedEvent = {
    ...completionEvent(persisted.capsuleId, capsule),
    ok: false,
    state: "target-verification-failed",
  };
  await assert.rejects(
    () => harness.coordinator.noteUserTurnRollover(failedEvent),
    /injected final journal clear failure/,
  );
  assert.equal(harness.calls.verified, 0);
  assert.equal(harness.coordinator.status().prepared, 1);
  assert.equal(harness.coordinator.status().compactFailures, 0,
    "an undurable failure circuit must not remain promoted in memory");
  assert.equal(stateStore.snapshot().committing, 1);
  runtimes.length = 0;
  await harness.coordinator.pollOnce();
  assert.equal(harness.coordinator.status().prepared, 0);
  assert.equal(harness.coordinator.status().compactFailures, 1);
  assert.equal(stateStore.state.prepared.length, 0);
  assert.equal(stateStore.state.compactFailures.length, 1);
  assert.equal(continuity.updates.at(-1)?.patch?.status, "source-preserved-abort");
  await harness.coordinator.close();
});

test("corrupt durability state blocks all arming before page or capsule work", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-blocked-restart-"));
  const statePath = join(root, "rollover.json");
  const continuity = continuityHarness();
  try {
    await writeFile(statePath, "{corrupt", "utf8");
    const harness = coordinatorHarness({ statePath, continuity });
    const result = await harness.coordinator.pollOnce();
    assert.equal(result.action, "auto-compact-durability-blocked");
    assert.equal(harness.calls.snapshots, 0);
    assert.equal(harness.calls.arms, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired prepared state rejects late completion and cancels the stale browser arm", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-expired-"));
  const statePath = join(root, "rollover.json");
  const continuity = continuityHarness();
  let clock = nowMs;
  try {
    const harness = coordinatorHarness({ statePath, continuity, now: () => clock });
    const prepared = await harness.coordinator.pollOnce();
    assert.equal(prepared.results[0].action, "armed-user-turn-auto-compact");
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    const capsuleId = persisted.prepared[0].capsuleId;
    const capsule = continuity.records.get(capsuleId).capsule;
    clock += 10 * 60_000 + 1;
    assert.equal(await harness.coordinator.noteUserTurnRollover(completionEvent(capsuleId, capsule)), false);
    assert.equal(harness.calls.cancels, 1);
    assert.equal(harness.calls.verified, 0);
    assert.equal(harness.coordinator.status().prepared, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).prepared.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-persistence",
  preparedReferenceSurvivesRestart: true,
  committingStateReconciledOnce: true,
  postAuthorityClearFailureReconciledSameCore: true,
  postAuthorityMetadataFailureReconciledSameCore: true,
  pendingFinalizationBlocksRearm: true,
  abortClearFailureRestoresCommittingTruth: true,
  duplicateRestartReplay: false,
  corruptedStateFailsClosed: true,
  expiredPreparedCompletionRejected: true,
  rawCapsuleDuplicated: false,
}));
