export const DEFAULT_PROGRESS_AUTHORITY_MAX_AGE_MS = 30 * 60_000;

function cleanConversationId(value) {
  const text = String(value ?? "").trim();
  return text && /^[A-Za-z0-9_-]{8,200}$/.test(text) ? text : null;
}

function cleanFingerprint(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function timeMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Verify a fallback progress authority after a Core restart or observer race.
 *
 * The MCP session mapping supplies a candidate conversation only. It never
 * supplies a Runtime owner. The candidate is accepted only when:
 *   1. the request's exact hashed MCP session maps unambiguously to it;
 *   2. that mapping is fresh enough for the current working turn;
 *   3. exactly one currently open ChatGPT page has that conversation id;
 *   4. the floating card on that page exposes the same conversation id; and
 *   5. the conversation is actively generating or has an unfinished native
 *      turn request in the independent delivery-evidence store.
 *
 * Failure returns null and affects only devspace_progress_report. Capability,
 * Blender and workspace authority are deliberately outside this function.
 */
export async function verifyProgressConversationAuthority({
  candidate,
  sessionFingerprint,
  adapter,
  deliveryEvidence,
  now = () => Date.now(),
  maxAgeMs = DEFAULT_PROGRESS_AUTHORITY_MAX_AGE_MS,
} = {}) {
  const conversationId = cleanConversationId(candidate?.conversationId);
  const requestSession = cleanFingerprint(sessionFingerprint);
  const candidateSession = cleanFingerprint(candidate?.sessionFingerprint);
  if (!conversationId || !requestSession || candidateSession !== requestSession) return null;

  const currentMs = Number(now());
  const observedAtMs = timeMs(candidate?.observedAt);
  const ageLimit = Math.max(60_000, Number(maxAgeMs) || DEFAULT_PROGRESS_AUTHORITY_MAX_AGE_MS);
  if (!Number.isFinite(currentMs) || !Number.isFinite(observedAtMs)) return null;
  if (observedAtMs > currentMs + 5_000) return null;
  const staleSessionMapping = currentMs - observedAtMs > ageLimit;

  const page = await adapter?.find?.({ conversationId }).catch(() => null);
  if (!page?.exact || page?.ambiguous || page.conversationId !== conversationId) return null;
  if (page.progressCardMounted !== true) return null;
  if (page.progressConversationId !== conversationId) return null;

  const since = new Date(currentMs - ageLimit).toISOString();
  const request = deliveryEvidence?.latest?.({ conversationId, kind: "request", since }) || null;
  const finished = deliveryEvidence?.latest?.({ conversationId, kind: "finished", since }) || null;
  const requestAtMs = timeMs(request?.observedAt);
  const finishedAtMs = timeMs(finished?.observedAt);
  const activeTransport = Number.isFinite(requestAtMs)
    && (!Number.isFinite(finishedAtMs) || requestAtMs > finishedAtMs);
  if (page.generating !== true && !activeTransport) return null;
  // A Core can restart in the middle of a long model turn. In that case the
  // new observer cannot replay the turn-start request, so the durable exact
  // MCP-session mapping may be older than the normal freshness window. It is
  // accepted only while the one matching conversation page is visibly still
  // generating; an idle page can never revive stale authority.
  if (staleSessionMapping && page.generating !== true) return null;

  return {
    conversationId,
    sessionFingerprint: requestSession,
    observedAt: candidate.observedAt,
    source: staleSessionMapping
      ? "classic-progress-session-page-restart-verified"
      : "classic-progress-session-page-verified",
    ephemeral: true,
    authorityDomain: "progress",
  };
}

export const _test = {
  cleanConversationId,
  cleanFingerprint,
  timeMs,
};
