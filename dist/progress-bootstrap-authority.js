const ALLOWED_START_TOOLS = new Set(["devspace_goal_start", "devspace_plan_start", "devspace_goal_turn_report"]);
const DEFAULT_TTL_MS = 45_000;
const DEFAULT_MAX_SESSIONS = 128;

function cleanText(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanFingerprint(value) {
  const text = cleanText(value, 64)?.toLowerCase();
  return text && /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function cleanConversationId(value) {
  const text = cleanText(value, 200);
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanRuntimeKey(value) {
  const text = cleanText(value, 80)?.toLowerCase();
  return text && /^main-\d{2}$/.test(text) ? text : null;
}

function cleanObservedAt(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cleanTraceFingerprints(value) {
  return [...new Set((Array.isArray(value) ? value : []).slice(0, 8)
    .map(cleanFingerprint).filter(Boolean))];
}

/**
 * Short-lived one-turn bootstrap authority derived only from a successful
 * exact-page progress narration proof. This exists solely so already-open
 * ChatGPT conversations with a cached Goal/Plan schema can start their
 * conversation-bound Goal/Plan immediately after the mandatory progress
 * preflight, without reviving durable MCP-session ownership.
 *
 * A reused host session that maps to two exact conversations inside the lease
 * window becomes ambiguous and fails closed. Each start tool can consume the
 * lease at most once; a new exact progress report refreshes the lease.
 */
export class ProgressBootstrapAuthorityRegistry {
  constructor({
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
  } = {}) {
    this.now = now;
    this.ttlMs = Math.max(5_000, Math.min(120_000, Number(ttlMs) || DEFAULT_TTL_MS));
    this.maxSessions = Math.max(8, Math.min(512, Number(maxSessions) || DEFAULT_MAX_SESSIONS));
    this.sessions = new Map();
    this.registered = 0;
    this.consumed = 0;
    this.ambiguous = 0;
    this.expired = 0;
  }

  register({ sessionFingerprint, conversationId, runtimeKey, observedAt,
    traceCorrelationFingerprints, claimId, source, pageVerified } = {}) {
    this.prune();
    const session = cleanFingerprint(sessionFingerprint);
    const conversation = cleanConversationId(conversationId);
    const runtime = cleanRuntimeKey(runtimeKey);
    const observed = cleanObservedAt(observedAt);
    const traces = cleanTraceFingerprints(traceCorrelationFingerprints);
    const claim = cleanText(claimId, 200);
    if (!session || !conversation || !runtime || !observed || !traces.length
      || !claim || !/^[A-Za-z0-9_-]{16,200}$/.test(claim)
      || pageVerified !== true
      || source !== 'classic-exact-page-progress-claim-cdp-page-verified') return null;

    const nowMs = Number(this.now());
    const observedMs = Date.parse(observed);
    if (observedMs > nowMs + 1_000 || nowMs - observedMs >= this.ttlMs) return null;
    const ownerKey = conversation;
    const existing = this.sessions.get(session);
    let owners = new Map();
    if (existing && Number(existing.expiresAtMs) > nowMs) {
      owners = new Map(existing.owners);
    }
    const previous = owners.get(ownerKey);
    if (previous?.claimId === claim) {
      // A duplicate relay acknowledgement must not replenish consumed grants.
      return { ok: true, ambiguous: owners.size > 1, ownerCount: owners.size,
        expiresAt: new Date(existing.expiresAtMs).toISOString() };
    }
    owners.set(ownerKey, {
      conversationId: conversation,
      runtimeKey: runtime,
      observedAt: observed,
      claimId: claim,
      traceCorrelationFingerprints: traces,
      usedTools: new Set(),
      ...(previous?.firstObservedAt ? { firstObservedAt: previous.firstObservedAt } : { firstObservedAt: observed }),
    });
    const record = {
      sessionFingerprint: session,
      owners,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: observedMs + this.ttlMs,
    };
    this.sessions.set(session, record);
    this.registered += 1;
    this.#enforceCap();
    return {
      ok: true,
      ambiguous: owners.size > 1,
      ownerCount: owners.size,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  async consume({ sessionFingerprint, toolName, traceCorrelationFingerprints, verifyPage } = {}) {
    this.prune();
    const session = cleanFingerprint(sessionFingerprint);
    const tool = cleanText(toolName, 220);
    const traces = cleanTraceFingerprints(traceCorrelationFingerprints);
    if (!session || !ALLOWED_START_TOOLS.has(tool) || !traces.length
      || typeof verifyPage !== 'function') return null;
    const record = this.sessions.get(session);
    if (!record) return null;
    if (record.owners.size !== 1) {
      this.ambiguous += 1;
      return null;
    }
    const owner = [...record.owners.values()][0];
    if (owner.usedTools.has(tool)) return null;
    if (!traces.some((trace) => owner.traceCorrelationFingerprints.includes(trace))) return null;
    // Session affinity is never authority. Re-read the exact opaque claim from
    // its current parent page, then commit once after all asynchronous checks.
    let live;
    try { live = await verifyPage(owner.claimId); } catch { return null; }
    this.prune();
    if (this.sessions.get(session) !== record || record.owners.size !== 1
      || record.owners.get(owner.conversationId) !== owner || owner.usedTools.has(tool)
      || live?.pageVerified !== true || live?.claimId !== owner.claimId
      || live?.source !== 'classic-exact-page-progress-claim-cdp-page-verified'
      || live?.conversationId !== owner.conversationId || !cleanRuntimeKey(live?.runtimeKey)) return null;
    owner.usedTools.add(tool);
    this.consumed += 1;
    return {
      conversationId: owner.conversationId,
      runtimeKey: live.runtimeKey,
      sessionFingerprint: session,
      source: "exact-progress-bootstrap-lease-page-verified",
      observedAt: live.observedAt,
      pageVerified: true,
      bootstrapLease: true,
    };
  }

  prune() {
    const nowMs = Number(this.now());
    for (const [session, record] of this.sessions) {
      if (Number(record.expiresAtMs) > nowMs) continue;
      this.sessions.delete(session);
      this.expired += 1;
    }
    this.#enforceCap();
  }

  diagnostics() {
    this.prune();
    let ambiguousSessions = 0;
    for (const record of this.sessions.values()) {
      if (record.owners.size > 1) ambiguousSessions += 1;
    }
    return {
      activeSessions: this.sessions.size,
      ambiguousSessions,
      registered: this.registered,
      consumed: this.consumed,
      ambiguousRejects: this.ambiguous,
      expired: this.expired,
      ttlMs: this.ttlMs,
      maxSessions: this.maxSessions,
      rawSessionPersisted: false,
      durableConversationOwners: 0,
      exactRequestTraceRequired: true,
      currentClaimPageRevalidated: true,
    };
  }

  #enforceCap() {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = [...this.sessions.entries()]
      .sort((left, right) => Number(left[1].updatedAtMs) - Number(right[1].updatedAtMs));
    for (const [session] of oldest) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(session);
      this.expired += 1;
    }
  }
}

export const progressBootstrapAuthorityInternals = {
  ALLOWED_START_TOOLS,
  cleanConversationId,
  cleanFingerprint,
  cleanObservedAt,
  cleanTraceFingerprints,
  cleanRuntimeKey,
  cleanText,
};
