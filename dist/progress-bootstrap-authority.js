const ALLOWED_START_TOOLS = new Set(["devspace_goal_start", "devspace_plan_start", "devspace_goal_turn_report"]);
// One exact progress claim is the opening proof for the current physical
// ChatGPT conversation. Keep the lease alive while exact verified work
// continues, including host transport / provider alias rotation, while exact
// request traces and fresh page re-checks prevent reuse by another chat/server.
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SESSIONS = 128;
export const PROGRESS_CAPABILITY_PAGE_SOURCE = 'classic-progress-capability-conversation-page-verified';

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

function matchingOwnersForTraces(record, traces) {
  if (!record?.owners || !traces.length) return [];
  return [...record.owners.values()].filter((owner) => traces.some((trace) =>
    owner.traceCorrelationFingerprints?.includes(trace)));
}

function ownersHaveTraceAmbiguity(owners) {
  const seen = new Set();
  for (const owner of owners?.values?.() || []) {
    for (const trace of owner.traceCorrelationFingerprints || []) {
      if (seen.has(trace)) return true;
      seen.add(trace);
    }
  }
  return false;
}

/**
 * Short-lived fresh-chat bootstrap authority derived only from a successful
 * exact-page progress narration proof. This lets already-open ChatGPT
 * conversations with a cached Goal/Plan schema start their conversation-bound
 * controls and continue ordinary work while the host rotates transport aliases,
 * without reviving durable MCP-session ownership.
 *
 * A reused host session may retain several exact conversations only while its
 * request traces select one owner unambiguously; trace collisions fail closed.
 * Each start tool can consume the lease at most once; a new exact progress
 * report or admitted exact invocation refreshes the active capability lease
 * without replenishing those grants.
 */
export class ProgressBootstrapAuthorityRegistry {
  constructor({
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
  } = {}) {
    this.now = now;
    this.ttlMs = Math.max(5_000, Math.min(15 * 60_000, Number(ttlMs) || DEFAULT_TTL_MS));
    this.maxSessions = Math.max(8, Math.min(512, Number(maxSessions) || DEFAULT_MAX_SESSIONS));
    this.sessions = new Map();
    this.registered = 0;
    this.consumed = 0;
    this.capabilityConsumed = 0;
    this.capabilityRefreshed = 0;
    this.capabilityClaimRelayVerified = 0;
    this.capabilityConversationPageVerified = 0;
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
      return { ok: true, ambiguous: ownersHaveTraceAmbiguity(owners), ownerCount: owners.size,
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
      ambiguous: ownersHaveTraceAmbiguity(owners),
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
    const matchingOwners = matchingOwnersForTraces(record, traces);
    if (matchingOwners.length !== 1) {
      this.ambiguous += 1;
      return null;
    }
    const owner = matchingOwners[0];
    if (owner.usedTools.has(tool)) return null;
    // Session affinity is never authority. Re-read the exact opaque claim from
    // its current parent page, then commit once after all asynchronous checks.
    let live;
    try { live = await verifyPage(owner.claimId); } catch { return null; }
    this.prune();
    if (this.sessions.get(session) !== record
      || matchingOwnersForTraces(record, traces).length !== 1
      || matchingOwnersForTraces(record, traces)[0] !== owner
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

  /**
   * Reuse the exact progress proof for ordinary tools in the same ChatGPT
   * turn. Unlike Goal/Plan bootstrap, this is intentionally repeatable: real
   * agent work commonly calls read/write/exec more than once. Authority stays
   * bounded by the exact request trace, the original opaque claim, its TTL and
   * a fresh globally-unique local page verification on every call.
   */
  async consumeCapability({
    sessionFingerprint,
    toolName,
    traceCorrelationFingerprints,
    callFingerprint,
    verifyPage,
    verifyConversationPage,
  } = {}) {
    this.prune();
    const session = cleanFingerprint(sessionFingerprint);
    const tool = cleanText(toolName, 220);
    const traces = cleanTraceFingerprints(traceCorrelationFingerprints);
    const call = cleanFingerprint(callFingerprint);
    if (!session || !tool || !traces.length
      || (typeof verifyPage !== 'function' && typeof verifyConversationPage !== 'function')) return null;
    const record = this.sessions.get(session);
    if (!record) return null;
    const matchingOwners = matchingOwnersForTraces(record, traces);
    if (matchingOwners.length !== 1) {
      this.ambiguous += 1;
      return null;
    }
    const owner = matchingOwners[0];
    let live = null;
    let claimRelayVerified = false;
    if (typeof verifyPage === 'function') {
      try { live = await verifyPage(owner.claimId); } catch { live = null; }
      claimRelayVerified = Boolean(
        live?.pageVerified === true
        && live?.claimId === owner.claimId
        && live?.source === 'classic-exact-page-progress-claim-cdp-page-verified'
        && live?.conversationId === owner.conversationId
        && cleanRuntimeKey(live?.runtimeKey) === owner.runtimeKey
      );
      if (!claimRelayVerified) live = null;
    }
    if (!live && typeof verifyConversationPage === 'function') {
      try {
        live = await verifyConversationPage({
          conversationId: owner.conversationId,
          runtimeKey: owner.runtimeKey,
        });
      } catch { live = null; }
      const directPageVerified = Boolean(
        live?.pageVerified === true
        && live?.exact === true
        && live?.ambiguous !== true
        && live?.duplicatePageObserved !== true
        && live?.hydrated === true
        && live?.composerFound === true
        && live?.source === PROGRESS_CAPABILITY_PAGE_SOURCE
        && live?.conversationId === owner.conversationId
        && cleanRuntimeKey(live?.runtimeKey) === owner.runtimeKey
      );
      if (!directPageVerified) live = null;
    }
    this.prune();
    const committedOwners = matchingOwnersForTraces(record, traces);
    if (!live || this.sessions.get(session) !== record || committedOwners.length !== 1
      || committedOwners[0] !== owner || record.owners.get(owner.conversationId) !== owner) return null;
    const nowMs = Number(this.now());
    const expiresAtMs = nowMs + this.ttlMs;
    owner.observedAt = cleanObservedAt(live.observedAt) || new Date(nowMs).toISOString();
    // Active verified work renews the whole exact claim family. The hidden
    // relay may be removed after its bounded UI-retention window; the globally
    // unique hydrated conversation page is the ongoing proof after bootstrap.
    for (const candidate of this.sessions.values()) {
      if (candidate.owners.get(owner.conversationId) !== owner) continue;
      candidate.updatedAtMs = nowMs;
      candidate.expiresAtMs = expiresAtMs;
    }
    this.capabilityConsumed += 1;
    if (claimRelayVerified) this.capabilityClaimRelayVerified += 1;
    else this.capabilityConversationPageVerified += 1;
    return {
      conversationId: owner.conversationId,
      runtimeKey: live.runtimeKey,
      runtimeKeys: [live.runtimeKey],
      sessionFingerprint: session,
      source: 'exact-progress-turn-capability-page-verified',
      observedAt: live.observedAt,
      ...(call ? { callFingerprint: call } : {}),
      pageVerified: true,
      currentInvocationVerified: true,
      bootstrapLease: true,
      capabilityLease: true,
      claimRelayVerified,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Keep an already-proved fresh-chat capability lease alive when ChatGPT
   * rotates its transport / `openai/session` alias during the same physical
   * conversation. This method is never an independent source of authority: it
   * requires a current exact page-verified invocation first, then copies only
   * the existing opaque progress claim grant for that same conversation and
   * Runtime onto the newly observed host-session fingerprint.
   *
   * A reusable session may retain several conversations only when their exact
   * request traces remain disjoint. A trace collision fails closed. Goal/Plan
   * one-shot consumption state is shared rather than replenished, while
   * ordinary capability calls remain repeatable.
   */
  refreshCapabilityLease({
    sessionFingerprint,
    conversationId,
    runtimeKey,
    traceCorrelationFingerprints,
    pageVerified,
    exactInvocationVerified,
    source,
  } = {}) {
    this.prune();
    const session = cleanFingerprint(sessionFingerprint);
    const conversation = cleanConversationId(conversationId);
    const runtime = cleanRuntimeKey(runtimeKey);
    const traces = cleanTraceFingerprints(traceCorrelationFingerprints);
    const sourceText = cleanText(source, 240);
    if (!session || !conversation || !runtime || !traces.length
      || pageVerified !== true || exactInvocationVerified !== true
      || !sourceText || !sourceText.includes("page-verified")) return null;

    const nowMs = Number(this.now());
    const candidates = [];
    for (const [candidateSession, record] of this.sessions) {
      if (Number(record.expiresAtMs) <= nowMs) continue;
      const owner = record.owners.get(conversation);
      if (!owner) continue;
      if (owner.conversationId !== conversation || owner.runtimeKey !== runtime) continue;
      candidates.push({ candidateSession, record, owner });
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => Number(right.record.updatedAtMs) - Number(left.record.updatedAtMs));
    const sourceGrant = candidates[0];
    const owner = sourceGrant.owner;

    const existing = this.sessions.get(session);
    let owners = new Map();
    if (existing && Number(existing.expiresAtMs) > nowMs) owners = new Map(existing.owners);
    const traceCollision = [...this.sessions.values()].some((record) =>
      record.owners.get(conversation) === owner
      && [...record.owners.values()].some((item) => item.conversationId !== conversation
        && traces.some((trace) => item.traceCorrelationFingerprints?.includes(trace))))
      || [...owners.values()].some((item) => item.conversationId !== conversation
        && traces.some((trace) => item.traceCorrelationFingerprints?.includes(trace)));
    if (traceCollision) {
      this.ambiguous += 1;
      return null;
    }
    owner.traceCorrelationFingerprints = cleanTraceFingerprints([
      ...owner.traceCorrelationFingerprints,
      ...traces,
    ]);
    owner.observedAt = new Date(nowMs).toISOString();
    const priorOwner = owners.get(conversation);
    if (priorOwner && priorOwner !== owner) {
      for (const usedTool of priorOwner.usedTools || []) owner.usedTools.add(usedTool);
      owner.traceCorrelationFingerprints = cleanTraceFingerprints([
        ...owner.traceCorrelationFingerprints,
        ...(priorOwner.traceCorrelationFingerprints || []),
      ]);
    }
    owners.set(conversation, owner);
    const expiresAtMs = nowMs + this.ttlMs;
    this.sessions.set(session, {
      sessionFingerprint: session,
      owners,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      expiresAtMs,
    });
    // Keep all aliases of this exact claim family alive while useful work is
    // still being admitted. No new conversation owner is created here.
    for (const record of this.sessions.values()) {
      const matching = record.owners.get(conversation);
      if (matching !== owner) continue;
      record.updatedAtMs = nowMs;
      record.expiresAtMs = expiresAtMs;
    }
    this.capabilityRefreshed += 1;
    this.#enforceCap();
    return {
      ok: true,
      conversationId: conversation,
      runtimeKey: runtime,
      aliasSessionAdded: sourceGrant.candidateSession !== session,
      sharedHostSession: owners.size > 1,
      expiresAt: new Date(expiresAtMs).toISOString(),
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
    const nowMs = Number(this.now());
    let ambiguousSessions = 0;
    let ownerCount = 0;
    let sharedSessionCount = 0;
    let oldestUpdatedAgeMs = 0;
    let nearestExpiryMs = null;
    let farthestExpiryMs = null;
    for (const record of this.sessions.values()) {
      if (ownersHaveTraceAmbiguity(record.owners)) ambiguousSessions += 1;
      ownerCount += record.owners.size;
      if (record.owners.size > 1) sharedSessionCount += 1;
      oldestUpdatedAgeMs = Math.max(oldestUpdatedAgeMs, Math.max(0, nowMs - Number(record.updatedAtMs || nowMs)));
      const expiresInMs = Math.max(0, Number(record.expiresAtMs || nowMs) - nowMs);
      nearestExpiryMs = nearestExpiryMs == null ? expiresInMs : Math.min(nearestExpiryMs, expiresInMs);
      farthestExpiryMs = farthestExpiryMs == null ? expiresInMs : Math.max(farthestExpiryMs, expiresInMs);
    }
    return {
      activeSessions: this.sessions.size,
      ownerCount,
      sharedSessionCount,
      ambiguousSessions,
      registered: this.registered,
      consumed: this.consumed,
      capabilityConsumed: this.capabilityConsumed,
      capabilityRefreshed: this.capabilityRefreshed,
      capabilityClaimRelayVerified: this.capabilityClaimRelayVerified,
      capabilityConversationPageVerified: this.capabilityConversationPageVerified,
      ambiguousRejects: this.ambiguous,
      expired: this.expired,
      ttlMs: this.ttlMs,
      oldestUpdatedAgeMs,
      nearestExpiryMs,
      farthestExpiryMs,
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

/**
 * Resolve the hard instance-isolation gate without racing the request-scoped
 * native correlation promise. A current capability authority wins, then an
 * exact progress lease, then the bounded late exact-page correlation. The
 * caller still performs the final source/runtime verification.
 */
export async function resolveRequestCapabilityAuthority({
  requestConversation = null,
  requestedToolName,
  sessionFingerprint,
  traceCorrelationFingerprints,
  callFingerprint,
  progressBootstrapAuthority = null,
  verifyPage = null,
  verifyConversationPage = null,
  allowLateCorrelation = true,
  lateCorrelationTimeoutMs = 8_000,
} = {}) {
  let authority = requestConversation?.capabilityAuthority || null;
  if (!authority?.conversationId && progressBootstrapAuthority?.consumeCapability) {
    authority = await progressBootstrapAuthority.consumeCapability({
      sessionFingerprint,
      toolName: requestedToolName,
      traceCorrelationFingerprints,
      callFingerprint,
      verifyPage,
      verifyConversationPage,
    }).catch(() => null);
  }
  if (!authority?.conversationId && allowLateCorrelation !== false && requestConversation?.authorityPromise) {
    const timeoutMs = Math.max(100, Math.min(15_000, Number(lateCorrelationTimeoutMs) || 8_000));
    let timer = null;
    try {
      authority = await Promise.race([
        Promise.resolve(requestConversation.authorityPromise).catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          // This timer is the only settlement path when native correlation
          // never arrives. Keep it referenced until the request finishes;
          // Node 22 can otherwise exit with the Promise still pending.
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return authority?.conversationId ? authority : null;
}

export const progressBootstrapAuthorityInternals = {
  ALLOWED_START_TOOLS,
  cleanConversationId,
  cleanFingerprint,
  cleanObservedAt,
  cleanTraceFingerprints,
  matchingOwnersForTraces,
  ownersHaveTraceAmbiguity,
  cleanRuntimeKey,
  cleanText,
};
