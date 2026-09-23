import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";
import { enqueueRecoverablePersist } from "./recoverable-persist-queue.js";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_PREPARED = 32;
const MAX_FAILURES = 64;
const DEFAULT_PREPARED_TTL_MS = 10 * 60_000;
const DEFAULT_COMMITTING_TTL_MS = 24 * 60 * 60_000;

function cleanText(value, max = 240) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanRuntimeKey(value) {
  const text = cleanText(value, 80)?.toLowerCase();
  return text && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(text) ? text : null;
}

function cleanId(value, max = 300) {
  const text = cleanText(value, max);
  return text && /^[A-Za-z0-9_.:@/-]{1,300}$/.test(text) ? text : null;
}

function integer(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function timestamp(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cleanContinuity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    sourceConversationId: cleanId(value.sourceConversationId, 240),
    sourceBoundaryMessageId: cleanId(value.sourceBoundaryMessageId, 240),
    uiContinuityKey: cleanText(value.uiContinuityKey, 300),
    capsuleFingerprint: cleanText(value.capsuleFingerprint, 96),
  };
  for (const key of Object.keys(result)) if (result[key] == null) delete result[key];
  return Object.keys(result).length ? result : null;
}

function cleanTargetDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    conversationId: cleanId(value.conversationId, 240),
    mappingCount: integer(value.mappingCount),
    branchMessageCount: integer(value.branchMessageCount),
    payloadBytes: integer(value.payloadBytes),
    textChars: integer(value.textChars),
    devspaceContinuity: cleanContinuity(value.devspaceContinuity),
  };
  for (const key of Object.keys(result)) if (result[key] == null) delete result[key];
  return result.conversationId ? result : null;
}

export function sanitizeRolloverCommitEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtimeKey = cleanRuntimeKey(value.runtimeKey);
  const oldConversationId = cleanId(value.oldConversationId, 240);
  const capsuleId = cleanId(value.capsuleId, 300);
  if (!runtimeKey || !oldConversationId || !capsuleId || typeof value.ok !== "boolean") return null;
  const result = {
    ok: value.ok,
    mode: cleanText(value.mode, 80),
    runtimeKey,
    goalId: cleanId(value.goalId, 240),
    planId: cleanId(value.planId, 240),
    capsuleId,
    oldConversationId,
    newConversationId: cleanId(value.newConversationId || value.conversationId, 240),
    conversationId: cleanId(value.conversationId || value.newConversationId, 240),
    visibleUsers: integer(value.visibleUsers),
    visibleAssistants: integer(value.visibleAssistants),
    hiddenMessages: integer(value.hiddenMessages),
    uiContinuityKey: cleanText(value.uiContinuityKey, 300),
    nativeContinuationSourceId: cleanId(value.nativeContinuationSourceId, 240),
    observedAt: isoTimestamp(value.observedAt),
    // Never persist arbitrary host/tool error prose: it may contain user data,
    // URLs, credentials or a transcript excerpt. A bounded state code is
    // sufficient to resume the fail-closed abort path after restart.
    error: value.ok === false ? cleanText(value.state || "rollover-failed", 240) : null,
    targetDescriptor: cleanTargetDescriptor(value.targetDescriptor),
  };
  for (const key of Object.keys(result)) if (result[key] == null) delete result[key];
  return result;
}

function normalizePrepared(value, { nowMs, preparedTtlMs, committingTtlMs = DEFAULT_COMMITTING_TTL_MS }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtimeKey = cleanRuntimeKey(value.runtimeKey);
  const conversationId = cleanId(value.conversationId, 240);
  const capsuleId = cleanId(value.capsuleId, 300);
  const preparedAt = timestamp(value.preparedAt);
  const status = value.status === "committing" ? "committing" : "prepared";
  const defaultTtl = status === "committing" ? committingTtlMs : preparedTtlMs;
  const expiresAtMs = timestamp(value.expiresAtMs, preparedAt == null ? null : preparedAt + defaultTtl);
  if (!runtimeKey || !conversationId || !capsuleId || preparedAt == null || expiresAtMs == null || expiresAtMs <= nowMs) return null;
  const commitEvent = status === "committing" ? sanitizeRolloverCommitEvent(value.commitEvent) : null;
  if (status === "committing" && !commitEvent) return null;
  return {
    runtimeKey,
    conversationId,
    usedTokens: integer(value.usedTokens, 0),
    preparedAt,
    expiresAtMs,
    mode: value.mode === "hidden-goal-continuation" ? "hidden-goal-continuation" : "user-turn",
    capsuleId,
    uiContinuityKey: cleanText(value.uiContinuityKey, 300),
    status,
    preparationVersion: integer(value.preparationVersion, 0),
    ...(commitEvent ? { commitEvent } : {}),
  };
}

function normalizeDescriptorFailure(value, nowMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtimeKey = cleanRuntimeKey(value.runtimeKey);
  const conversationId = cleanId(value.conversationId, 240);
  const retryAfterMs = timestamp(value.retryAfterMs);
  if (!runtimeKey || !conversationId || retryAfterMs == null || retryAfterMs <= nowMs) return null;
  return { runtimeKey, conversationId, retryAfterMs };
}

function normalizeCompactFailure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtimeKey = cleanRuntimeKey(value.runtimeKey);
  const conversationId = cleanId(value.conversationId, 240);
  const reason = cleanText(value.reason, 240);
  if (!runtimeKey || !conversationId || !reason) return null;
  return {
    runtimeKey,
    conversationId,
    reason,
    failedAtMs: timestamp(value.failedAtMs, 0),
    capsuleId: cleanId(value.capsuleId, 300),
  };
}

export function normalizeRolloverDurabilityState(value, {
  nowMs = Date.now(),
  preparedTtlMs = DEFAULT_PREPARED_TTL_MS,
  committingTtlMs = DEFAULT_COMMITTING_TTL_MS,
  maxPrepared = MAX_PREPARED,
  maxFailures = MAX_FAILURES,
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const prepared = (Array.isArray(source.prepared) ? source.prepared : [])
    .map((row) => normalizePrepared(row, { nowMs, preparedTtlMs, committingTtlMs }))
    .filter(Boolean)
    .sort((left, right) => right.preparedAt - left.preparedAt)
    .slice(0, Math.max(1, Math.min(MAX_PREPARED, Number(maxPrepared) || MAX_PREPARED)));
  const descriptorFailures = (Array.isArray(source.descriptorFailures) ? source.descriptorFailures : [])
    .map((row) => normalizeDescriptorFailure(row, nowMs))
    .filter(Boolean)
    .sort((left, right) => right.retryAfterMs - left.retryAfterMs)
    .slice(0, Math.max(1, Math.min(MAX_FAILURES, Number(maxFailures) || MAX_FAILURES)));
  const compactFailures = (Array.isArray(source.compactFailures) ? source.compactFailures : [])
    .map(normalizeCompactFailure)
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(MAX_FAILURES, Number(maxFailures) || MAX_FAILURES)));
  return {
    version: STATE_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    prepared,
    descriptorFailures,
    compactFailures,
  };
}

export class ContextGuardianRolloverStateStore {
  constructor({
    statePath,
    now = Date.now,
    maxStateBytes = MAX_STATE_BYTES,
    preparedTtlMs = DEFAULT_PREPARED_TTL_MS,
    committingTtlMs = DEFAULT_COMMITTING_TTL_MS,
    readFileImpl = readFile,
    statImpl = stat,
    writeJsonImpl = atomicWriteJson,
  } = {}) {
    this.statePath = statePath ? resolve(String(statePath)) : null;
    this.now = now;
    this.maxStateBytes = Math.max(16_384, Math.min(4 * 1024 * 1024, Number(maxStateBytes) || MAX_STATE_BYTES));
    this.preparedTtlMs = Math.max(30_000, Math.min(60 * 60_000, Number(preparedTtlMs) || DEFAULT_PREPARED_TTL_MS));
    this.committingTtlMs = Math.max(this.preparedTtlMs, Math.min(7 * 24 * 60 * 60_000, Number(committingTtlMs) || DEFAULT_COMMITTING_TTL_MS));
    this.readFileImpl = readFileImpl;
    this.statImpl = statImpl;
    this.writeJsonImpl = writeJsonImpl;
    this.state = normalizeRolloverDurabilityState({}, { nowMs: Number(this.now()), preparedTtlMs: this.preparedTtlMs });
    this.blocked = false;
    this.loadError = null;
    this.persistQueue = Promise.resolve();
    this.persistFailureCount = 0;
    this.persistRecoveryCount = 0;
    this.lastPersistError = null;
    this.ready = this.#load();
  }

  async #load() {
    if (!this.statePath) return this.snapshot();
    try {
      const info = await this.statImpl(this.statePath);
      if (!info?.isFile?.() || Number(info.size || 0) > this.maxStateBytes) {
        throw new Error("Auto Compact rollover durability state is not a bounded regular file.");
      }
      const text = await this.readFileImpl(this.statePath, "utf8");
      const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
      if (parsed?.version !== STATE_VERSION) throw new Error(`Unsupported Auto Compact rollover durability state version ${parsed?.version}.`);
      this.state = normalizeRolloverDurabilityState(parsed, {
        nowMs: Number(this.now()),
        preparedTtlMs: this.preparedTtlMs,
        committingTtlMs: this.committingTtlMs,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return this.snapshot();
      this.blocked = true;
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      ok: !this.blocked,
      blocked: this.blocked,
      loadError: this.loadError,
      statePath: this.statePath,
      prepared: this.state.prepared.length,
      committing: this.state.prepared.filter((row) => row.status === "committing").length,
      descriptorFailures: this.state.descriptorFailures.length,
      compactFailures: this.state.compactFailures.length,
      persistFailureCount: this.persistFailureCount,
      persistRecoveryCount: this.persistRecoveryCount,
      lastPersistError: this.lastPersistError,
      rawCapsulePersisted: false,
      rawTranscriptPersisted: false,
      credentialsPersisted: false,
    };
  }

  async replace(value) {
    await this.ready;
    if (this.blocked) {
      const error = new Error(`Auto Compact durability state is blocked: ${this.loadError || "unavailable"}`);
      error.code = "AUTO_COMPACT_DURABILITY_BLOCKED";
      throw error;
    }
    const next = normalizeRolloverDurabilityState(value, {
      nowMs: Number(this.now()),
      preparedTtlMs: this.preparedTtlMs,
      committingTtlMs: this.committingTtlMs,
    });
    if (!this.statePath) {
      this.state = next;
      return this.snapshot();
    }
    await enqueueRecoverablePersist(this, async () => {
      await this.writeJsonImpl(this.statePath, next);
      this.state = next;
    });
    return this.snapshot();
  }

  async close() {
    await this.ready;
    await Promise.resolve(this.persistQueue);
  }
}

export const contextGuardianRolloverStateInternals = {
  STATE_VERSION,
  MAX_STATE_BYTES,
  DEFAULT_PREPARED_TTL_MS,
  DEFAULT_COMMITTING_TTL_MS,
  cleanRuntimeKey,
  cleanId,
  cleanTargetDescriptor,
  normalizePrepared,
  normalizeDescriptorFailure,
  normalizeCompactFailure,
};
