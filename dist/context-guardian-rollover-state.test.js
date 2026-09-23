import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ContextGuardianRolloverStateStore,
  normalizeRolloverDurabilityState,
  sanitizeRolloverCommitEvent,
} from "./context-guardian-rollover-state.js";

const now = Date.parse("2026-09-23T00:00:00.000Z");
const event = {
  ok: true,
  mode: "user-turn",
  runtimeKey: "main-06",
  goalId: "goal_safe",
  planId: "plan_safe",
  capsuleId: "capsule_safe_123456",
  oldConversationId: "conversation-old",
  newConversationId: "conversation-new",
  visibleUsers: 1,
  visibleAssistants: 1,
  hiddenMessages: 1,
  uiContinuityKey: "goal:goal_safe",
  nativeContinuationSourceId: "conversation-old",
  observedAt: new Date(now).toISOString(),
  error: "Bearer super-secret-token must never persist",
  targetDescriptor: {
    conversationId: "conversation-new",
    mappingCount: 4,
    branchMessageCount: 3,
    payloadBytes: 12_000,
    devspaceContinuity: {
      sourceConversationId: "conversation-old",
      sourceBoundaryMessageId: "message-old",
      uiContinuityKey: "goal:goal_safe",
      capsuleFingerprint: "a".repeat(64),
    },
    rawTranscript: "must never persist",
  },
  rawTranscript: "must never persist",
  credentials: "must never persist",
};

test("durability state persists only bounded references and safe verification metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-state-"));
  const statePath = join(root, "rollover.json");
  try {
    const store = new ContextGuardianRolloverStateStore({ statePath, now: () => now });
    await store.replace({
      prepared: [{
        runtimeKey: "main-06",
        conversationId: "conversation-old",
        usedTokens: 250_000,
        preparedAt: now,
        expiresAtMs: now + 300_000,
        mode: "user-turn",
        capsuleId: "capsule_safe_123456",
        uiContinuityKey: "goal:goal_safe",
        status: "committing",
        preparationVersion: 4,
        commitEvent: event,
        capsule: { notes: "raw capsule must never persist" },
      }],
      descriptorFailures: [{ runtimeKey: "main-06", conversationId: "conversation-old", retryAfterMs: now + 60_000 }],
      compactFailures: [{ runtimeKey: "main-05", conversationId: "conversation-failed", reason: "verification-failed", failedAtMs: now }],
    });
    const serialized = await readFile(statePath, "utf8");
    assert.equal(serialized.includes("must never persist"), false);
    assert.equal(serialized.includes("rawTranscript"), false);
    assert.equal(serialized.includes("credentials"), false);
    const restored = new ContextGuardianRolloverStateStore({ statePath, now: () => now + 1 });
    await restored.ready;
    assert.equal(restored.snapshot().committing, 1);
    assert.equal(restored.state.prepared[0].commitEvent.targetDescriptor.conversationId, "conversation-new");
    assert.equal(restored.state.prepared[0].commitEvent.targetDescriptor.rawTranscript, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired preparation and descriptor cooldown are discarded without reviving work", () => {
  const state = normalizeRolloverDurabilityState({
    version: 1,
    prepared: [{ runtimeKey: "main-01", conversationId: "conversation-old", capsuleId: "capsule-old-123456", preparedAt: now - 700_000, expiresAtMs: now - 1 }],
    descriptorFailures: [{ runtimeKey: "main-01", conversationId: "conversation-old", retryAfterMs: now - 1 }],
    compactFailures: [{ runtimeKey: "main-01", conversationId: "conversation-old", reason: "source-preserved-abort" }],
  }, { nowMs: now });
  assert.equal(state.prepared.length, 0);
  assert.equal(state.descriptorFailures.length, 0);
  assert.equal(state.compactFailures.length, 1, "verified failure circuits survive restart until explicitly cleared");
});

test("corrupt or oversized state fails closed instead of silently resetting", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-corrupt-"));
  try {
    const corruptPath = join(root, "corrupt.json");
    await writeFile(corruptPath, "{not-json", "utf8");
    const corrupt = new ContextGuardianRolloverStateStore({ statePath: corruptPath, now: () => now });
    await corrupt.ready;
    assert.equal(corrupt.snapshot().blocked, true);
    await assert.rejects(() => corrupt.replace({}), /durability state is blocked/i);

    const hugePath = join(root, "huge.json");
    await writeFile(hugePath, "x".repeat(20_000), "utf8");
    const huge = new ContextGuardianRolloverStateStore({ statePath: hugePath, maxStateBytes: 16_384, now: () => now });
    await huge.ready;
    assert.equal(huge.snapshot().blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit event sanitizer rejects missing exact identity and strips raw fields", () => {
  assert.equal(sanitizeRolloverCommitEvent({ ok: true }), null);
  const safe = sanitizeRolloverCommitEvent(event);
  assert.equal(safe.runtimeKey, "main-06");
  assert.equal(safe.targetDescriptor.rawTranscript, undefined);
  assert.equal(safe.error, undefined, "successful commit cannot persist arbitrary host error prose");
  assert.equal(JSON.stringify(safe).includes("must never persist"), false);
  const failed = sanitizeRolloverCommitEvent({ ...event, ok: false, state: "target-verification-failed" });
  assert.equal(failed.error, "target-verification-failed");
  assert.equal(JSON.stringify(failed).includes("super-secret-token"), false);
});

test("failed write does not promote an undurable in-memory snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-rollover-state-write-failure-"));
  const statePath = join(root, "rollover.json");
  let failNext = false;
  try {
    const store = new ContextGuardianRolloverStateStore({
      statePath,
      now: () => now,
      writeJsonImpl: async (path, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected state write failure");
        }
        await writeFile(path, JSON.stringify(value), "utf8");
      },
    });
    await store.replace({ prepared: [] });
    failNext = true;
    await assert.rejects(() => store.replace({
      prepared: [{
        runtimeKey: "main-06",
        conversationId: "conversation-old",
        usedTokens: 250_000,
        preparedAt: now,
        expiresAtMs: now + 300_000,
        mode: "user-turn",
        capsuleId: "capsule_safe_123456",
        uiContinuityKey: "goal:goal_safe",
        status: "committing",
        preparationVersion: 4,
        commitEvent: event,
      }],
    }), /injected state write failure/);
    assert.equal(store.snapshot().committing, 0,
      "memory state must continue to describe the last successfully persisted snapshot");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).prepared.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  ok: true,
  gate: "context-guardian-rollover-state",
  preparedReferenceDurable: true,
  commitPhaseDurable: true,
  failureCircuitsDurable: true,
  corruptStateFailsClosed: true,
  rawCapsulePersisted: false,
  rawTranscriptPersisted: false,
  credentialsPersisted: false,
  failedWriteDoesNotPromoteState: true,
}));
