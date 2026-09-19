import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_CLAIMS = 64;
const ALLOWED_TOOLS = new Set(["devspace_goal_start", "devspace_plan_start"]);

function cleanText(value, max = 500) {
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

function verifiedAuthority(value, expectedClaimId) {
  const conversationId = cleanConversationId(value?.conversationId);
  const runtimeKey = cleanRuntimeKey(value?.runtimeKey);
  const source = cleanText(value?.source, 240);
  const observedAt = cleanObservedAt(value?.observedAt);
  if (!conversationId || !runtimeKey || !source || !observedAt || value?.pageVerified !== true) return null;

  const claimId = cleanText(value?.claimId, 200);
  if (
    source === "classic-exact-page-start-claim-cdp-page-verified"
    && claimId
    && claimId === expectedClaimId
  ) {
    return { conversationId, runtimeKey, claimId, source, observedAt };
  }

  const callFingerprint = cleanFingerprint(value?.callFingerprint);
  const invocationFingerprint = cleanFingerprint(value?.invocationFingerprint);
  if (!callFingerprint || !source.endsWith("-page-verified")) return null;
  return {
    conversationId,
    runtimeKey,
    callFingerprint,
    ...(invocationFingerprint ? { invocationFingerprint } : {}),
    source,
    observedAt,
  };
}

function publicClaim(record) {
  return {
    claimId: record.claimId,
    toolName: record.toolName,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    state: record.state,
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * Holds an unresolved Goal/Plan start request until the exact ChatGPT page that
 * received the tool result proves ownership through the hidden MCP App relay.
 *
 * Start arguments remain bounded in-memory only. The public claim exposes no
 * objective, criteria, title, steps, session identifiers, or page details.
 */
export class ConversationStartClaimRegistry {
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

  create({ toolName, input } = {}) {
    this.prune();
    const tool = cleanText(toolName, 220);
    if (!ALLOWED_TOOLS.has(tool)) throw new Error("Conversation start claim tool is not allowed.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Conversation start claim input is required.");
    }
    const claimId = cleanText(this.createId(), 200);
    if (!claimId || !/^[A-Za-z0-9_-]{16,200}$/.test(claimId)) {
      throw new Error("Conversation start claim id generator returned an invalid id.");
    }
    const createdAtMs = Number(this.now());
    const record = {
      claimId,
      toolName: tool,
      input: clone(input),
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      state: "pending",
      owner: null,
      completionPromise: null,
      result: null,
    };
    this.records.set(claimId, record);
    this.created += 1;
    this.#enforceCap();
    return publicClaim(record);
  }

  inspect({ claimId, toolName } = {}) {
    this.prune();
    const id = cleanText(claimId, 200);
    const tool = cleanText(toolName, 220);
    const record = id ? this.records.get(id) : null;
    if (!record || record.toolName !== tool) return null;
    return {
      ...publicClaim(record),
      completed: record.state === "completed",
      result: record.state === "completed" ? clone(record.result) : null,
    };
  }

  async claim({ claimId, toolName, authority, complete } = {}) {
    this.prune();
    const id = cleanText(claimId, 200);
    const tool = cleanText(toolName, 220);
    const record = id ? this.records.get(id) : null;
    if (!record || record.toolName !== tool) throw new Error("Conversation start claim is unavailable or expired.");
    const owner = verifiedAuthority(authority, record.claimId);
    if (!owner) {
      this.rejected += 1;
      throw new Error("Conversation start claim requires exact page-verified conversation authority.");
    }
    if (typeof complete !== "function") throw new Error("Conversation start claim completion callback is required.");
    if (record.owner && (
      record.owner.conversationId !== owner.conversationId
      || record.owner.runtimeKey !== owner.runtimeKey
    )) {
      this.rejected += 1;
      throw new Error("Conversation start claim is already owned by another conversation page.");
    }
    if (record.state === "completed") return clone(record.result);
    if (record.completionPromise) return await record.completionPromise;

    record.owner = owner;
    record.state = "claiming";
    const originalInput = clone(record.input);
    record.completionPromise = Promise.resolve()
      .then(() => complete({
        claimId: record.claimId,
        toolName: record.toolName,
        input: originalInput,
        authority: clone(owner),
      }))
      .then((result) => {
        record.state = "completed";
        record.result = clone(result);
        record.input = null;
        record.completionPromise = null;
        this.completed += 1;
        return clone(record.result);
      })
      .catch((error) => {
        record.state = "pending";
        record.completionPromise = null;
        // Keep the exact owner so another page can never race the retry.
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

  pendingClaims({ limit = 8 } = {}) {
    this.prune();
    const capped = Math.max(1, Math.min(32, Number(limit) || 8));
    return [...this.records.values()]
      .filter((row) => row.state === "pending")
      .sort((left, right) => Number(left.createdAtMs) - Number(right.createdAtMs))
      .slice(0, capped)
      .map((row) => publicClaim(row));
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
      rawInputsExposed: false,
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

export const conversationStartClaimRegistryInternals = {
  ALLOWED_TOOLS,
  cleanText,
  publicClaim,
  verifiedAuthority,
};
