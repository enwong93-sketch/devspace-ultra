import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_CLAIMS = 128;
const KINDS = new Set(["progress", "milestone", "verification", "blocker", "direction-change"]);

function cleanText(value, max = 1_600) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = cleanText(value, 80)?.toLowerCase();
  return text && /^main-\d{2}$/.test(text) ? text : null;
}

function cleanFingerprint(value) {
  const text = cleanText(value, 64)?.toLowerCase();
  return text && /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function cleanObservedAt(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function publicClaim(record) {
  return {
    claimId: record.claimId,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    state: record.state,
  };
}

function verifiedAuthority(value) {
  const conversationId = cleanConversationId(value?.conversationId);
  const runtimeKey = cleanRuntimeKey(value?.runtimeKey);
  const callFingerprint = cleanFingerprint(value?.callFingerprint);
  const invocationFingerprint = cleanFingerprint(value?.invocationFingerprint);
  const source = cleanText(value?.source, 240);
  const observedAt = cleanObservedAt(value?.observedAt);
  if (
    !conversationId
    || !runtimeKey
    || !callFingerprint
    || !source
    || !observedAt
    || value?.pageVerified !== true
    || !source.endsWith("-page-verified")
  ) return null;
  return {
    conversationId,
    runtimeKey,
    callFingerprint,
    ...(invocationFingerprint ? { invocationFingerprint } : {}),
    source,
    observedAt,
  };
}

/**
 * Holds one unresolved progress message until the hidden MCP App relay proves
 * which exact ChatGPT Classic page received the original tool result.
 *
 * The raw message lives only in this bounded in-memory registry. The relay is
 * a one-time capability: a second conversation cannot claim it, duplicate
 * mounts reuse the first completion, and expiry removes it without writing any
 * progress or liveness state.
 */
export class ProgressClaimRegistry {
  constructor({
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxClaims = DEFAULT_MAX_CLAIMS,
    createId = () => randomUUID(),
  } = {}) {
    this.now = now;
    this.ttlMs = Math.max(5_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.maxClaims = Math.max(4, Number(maxClaims) || DEFAULT_MAX_CLAIMS);
    this.createId = createId;
    this.records = new Map();
    this.created = 0;
    this.completed = 0;
    this.expired = 0;
    this.rejected = 0;
  }

  create({ message, kind = "progress" } = {}) {
    this.prune();
    const text = cleanText(message, 1_600);
    const normalizedKind = cleanText(kind, 80);
    if (!text) throw new Error("Progress claim message is required.");
    if (!KINDS.has(normalizedKind)) throw new Error("Progress claim kind is invalid.");
    const createdAtMs = Number(this.now());
    const claimId = cleanText(this.createId(), 200);
    if (!claimId || !/^[A-Za-z0-9_-]{16,200}$/.test(claimId)) {
      throw new Error("Progress claim id generator returned an invalid id.");
    }
    const record = {
      claimId,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      state: "pending",
      message: text,
      kind: normalizedKind,
      owner: null,
      completionPromise: null,
      result: null,
    };
    this.records.set(claimId, record);
    this.created += 1;
    this.#enforceCap();
    return publicClaim(record);
  }

  async claim({ claimId, authority, complete } = {}) {
    this.prune();
    const id = cleanText(claimId, 200);
    const record = id ? this.records.get(id) : null;
    if (!record) throw new Error("Progress claim is unavailable or expired.");
    const owner = verifiedAuthority(authority);
    if (!owner) {
      this.rejected += 1;
      throw new Error("Progress claim requires exact page-verified conversation authority.");
    }
    if (typeof complete !== "function") throw new Error("Progress claim completion callback is required.");
    if (record.owner && (
      record.owner.conversationId !== owner.conversationId
      || record.owner.runtimeKey !== owner.runtimeKey
    )) {
      this.rejected += 1;
      throw new Error("Progress claim is already owned by another conversation page.");
    }
    if (record.state === "completed") {
      return structuredClone(record.result);
    }
    if (record.completionPromise) return await record.completionPromise;

    record.owner = owner;
    record.state = "claiming";
    record.completionPromise = Promise.resolve()
      .then(() => complete({
        claimId: record.claimId,
        message: record.message,
        kind: record.kind,
        authority: structuredClone(owner),
      }))
      .then((result) => {
        const publicResult = {
          ok: true,
          claimId: record.claimId,
          conversationId: owner.conversationId,
          runtimeKey: owner.runtimeKey,
          completedAt: new Date(Number(this.now())).toISOString(),
          ...(result && typeof result === "object" ? structuredClone(result) : {}),
        };
        record.state = "completed";
        record.result = publicResult;
        record.completionPromise = null;
        // The message is no longer needed after the authoritative write.
        record.message = null;
        this.completed += 1;
        return structuredClone(publicResult);
      })
      .catch((error) => {
        record.state = "pending";
        record.completionPromise = null;
        // Keep the exact owner so another page cannot race a retry.
        throw error;
      });
    return await record.completionPromise;
  }

  prune() {
    const now = Number(this.now());
    for (const [claimId, record] of this.records) {
      if (Number(record.expiresAtMs) > now) continue;
      this.records.delete(claimId);
      this.expired += 1;
    }
    this.#enforceCap();
  }

  diagnostics() {
    this.prune();
    const rows = [...this.records.values()];
    return {
      pending: rows.filter((row) => row.state === "pending").length,
      claiming: rows.filter((row) => row.state === "claiming").length,
      retainedCompleted: rows.filter((row) => row.state === "completed").length,
      created: this.created,
      completed: this.completed,
      expired: this.expired,
      rejected: this.rejected,
      ttlMs: this.ttlMs,
      maxClaims: this.maxClaims,
      rawMessagesExposed: false,
      durableConversationOwners: 0,
    };
  }

  #enforceCap() {
    if (this.records.size <= this.maxClaims) return;
    const oldest = [...this.records.values()]
      .sort((left, right) => Number(left.createdAtMs) - Number(right.createdAtMs));
    for (const row of oldest) {
      if (this.records.size <= this.maxClaims) break;
      this.records.delete(row.claimId);
      this.expired += 1;
    }
  }
}

export const progressClaimRegistryInternals = {
  KINDS,
  cleanConversationId,
  cleanFingerprint,
  cleanObservedAt,
  cleanRuntimeKey,
  cleanText,
  publicClaim,
  verifiedAuthority,
};
