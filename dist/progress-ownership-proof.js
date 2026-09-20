export const EXACT_CONVERSATION_REQUEST_PROOF = "exact-conversation-request-v1";
export const EXACT_PAGE_BRIDGE_PROOF = "exact-page-compatibility-bridge-v1";
export const EXACT_PAGE_CLAIM_PROOF = "exact-page-progress-claim-v1";
export const PROVIDER_CONVERSATION_PROOF = 'openai-conversation-page-v1';

const PROOFS = new Set([
  EXACT_CONVERSATION_REQUEST_PROOF,
  EXACT_PAGE_BRIDGE_PROOF,
  EXACT_PAGE_CLAIM_PROOF,
  PROVIDER_CONVERSATION_PROOF,
]);

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

function cleanTimestamp(value) {
  const text = cleanText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : null;
}

export function normalizeProgressOwnershipProof(value) {
  const proof = cleanText(value?.ownershipProof, 80);
  if (!proof || !PROOFS.has(proof)) return null;
  const conversationId = cleanConversationId(value?.conversationId);
  const ownershipRuntimeKey = cleanRuntimeKey(value?.ownershipRuntimeKey ?? value?.runtimeKey);
  const ownershipObservedAt = cleanTimestamp(value?.ownershipObservedAt ?? value?.at);
  const ownershipSource = cleanText(value?.ownershipSource, 240);
  if (!conversationId || !ownershipRuntimeKey || !ownershipObservedAt || !ownershipSource) return null;

  const ownershipCallFingerprint = cleanFingerprint(value?.ownershipCallFingerprint);
  const ownershipInvocationFingerprint = cleanFingerprint(value?.ownershipInvocationFingerprint);
  if (proof === EXACT_CONVERSATION_REQUEST_PROOF) {
    if (!ownershipCallFingerprint) return null;
    if (!/-page-verified$/.test(ownershipSource)) return null;
  }
  if (proof === EXACT_PAGE_BRIDGE_PROOF && ownershipSource !== "devspace-conversation-bridge") return null;
  if (proof === EXACT_PAGE_CLAIM_PROOF && ownershipSource !== "classic-exact-page-progress-claim-cdp-page-verified") return null;
  if (proof === PROVIDER_CONVERSATION_PROOF && ownershipSource !== 'openai-conversation-binding-page-verified') return null;

  return {
    ownershipProof: proof,
    ownershipSource,
    ownershipObservedAt,
    ownershipRuntimeKey,
    ...(ownershipCallFingerprint ? { ownershipCallFingerprint } : {}),
    ...(ownershipInvocationFingerprint ? { ownershipInvocationFingerprint } : {}),
  };
}

export function hasVerifiedProgressOwnership(value) {
  return Boolean(normalizeProgressOwnershipProof(value));
}

export function isProjectableProgressMessage(value) {
  const source = cleanText(value?.source, 80);
  if (source === "goal-round-report") return Boolean(cleanConversationId(value?.conversationId));
  return source === "agent-progress-tool" && hasVerifiedProgressOwnership(value);
}

export const progressOwnershipProofInternals = {
  PROOFS,
  cleanConversationId,
  cleanFingerprint,
  cleanRuntimeKey,
  cleanTimestamp,
  cleanText,
};
