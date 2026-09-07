import { createHash } from "node:crypto";

const DEFAULT_MAX_CARRY_CHARS = 30_000;
const DEFAULT_MAX_CARRY_TOKENS = 12_000;
const DEFAULT_MAX_CARRY_RATIO = 0.25;
const FORBIDDEN_STRUCTURAL_KEYS = new Set([
  "mapping",
  "messages",
  "rawmessages",
  "rawtranscript",
  "conversationpayload",
  "rawtooloutput",
  "rawtooloutputs",
  "chainofthought",
  "reasoningcontent",
]);
const PRESERVED_CATEGORIES = Object.freeze([
  "goal-objective",
  "user-intent",
  "hard-constraints",
  "accepted-decisions",
  "completed-work-summary",
  "goal-plan-frontier",
  "current-state",
  "tests-and-evidence",
  "blockers",
  "next-actions",
  "important-file-references",
  "durable-memory-references",
]);
const EXCLUDED_CATEGORIES = Object.freeze([
  "full-conversation-mapping",
  "verbatim-old-transcript",
  "raw-tool-output-history",
  "hidden-chain-of-thought",
  "duplicate-progress-chatter",
  "expired-transport-state",
  "credentials-and-secrets",
]);

function clean(value, max = 1_000) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  return text ? text.slice(0, max) : null;
}

function integer(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function estimateAutoCompactTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  let whitespace = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (/\s/u.test(char)) whitespace += 1;
    else if (cp <= 0x7f) ascii += 1;
    else if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk * 1.08 + ascii / 3.2 + other / 1.8 + whitespace / 7));
}

function findForbiddenKey(value, path = "capsule", depth = 0) {
  if (depth > 20 || value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_STRUCTURAL_KEYS.has(normalized)) return `${path}.${key}`;
    const found = findForbiddenKey(child, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

function capsuleEssentials(capsule) {
  const constraints = Array.isArray(capsule?.constraints) ? capsule.constraints.filter(Boolean) : [];
  const nextSteps = Array.isArray(capsule?.nextSteps) ? capsule.nextSteps.filter(Boolean) : [];
  const blockers = Array.isArray(capsule?.blockers) ? capsule.blockers.filter(Boolean) : [];
  const toolState = Array.isArray(capsule?.toolState) ? capsule.toolState.filter(Boolean) : [];
  return {
    goal: Boolean(clean(capsule?.goal, 6_000)),
    currentState: Boolean(clean(capsule?.currentState, 8_000)),
    constraints: constraints.length > 0,
    frontier: nextSteps.length > 0 || blockers.length > 0,
    authorityReferences: toolState.some((item) => /(?:goalId|planId|continuityKey|runtime)=/i.test(String(item))),
  };
}

export function validateSelectiveCompactCapsule(capsule, {
  maxCarryChars = DEFAULT_MAX_CARRY_CHARS,
  maxCarryTokens = DEFAULT_MAX_CARRY_TOKENS,
} = {}) {
  if (!capsule || typeof capsule !== "object" || Array.isArray(capsule)) throw new Error("Auto Compact capsule must be an object.");
  const forbiddenPath = findForbiddenKey(capsule);
  if (forbiddenPath) throw new Error(`Auto Compact capsule must not embed full/raw conversation state (${forbiddenPath}).`);
  const serialized = JSON.stringify(capsule);
  const carryChars = serialized.length;
  const carryEstimatedTokens = estimateAutoCompactTokens(serialized);
  const essentials = capsuleEssentials(capsule);
  const missing = Object.entries(essentials).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) throw new Error(`Auto Compact capsule is missing essential continuity state: ${missing.join(", ")}.`);
  if (carryChars <= 32) throw new Error("Auto Compact capsule is effectively empty.");
  if (carryChars > Math.max(1_000, Number(maxCarryChars) || DEFAULT_MAX_CARRY_CHARS)) {
    throw new Error(`Auto Compact capsule exceeds the ${maxCarryChars}-character carry budget.`);
  }
  if (carryEstimatedTokens > Math.max(500, Number(maxCarryTokens) || DEFAULT_MAX_CARRY_TOKENS)) {
    throw new Error(`Auto Compact capsule exceeds the ${maxCarryTokens}-token carry budget.`);
  }
  return {
    ok: true,
    carryChars,
    carryBytes: Buffer.byteLength(serialized, "utf8"),
    carryEstimatedTokens,
    capsuleFingerprint: sha256(serialized),
    essentials,
    forbiddenStructuralState: false,
  };
}

function normalizeSource(source = {}) {
  const conversationId = clean(source.conversationId || source.sourceConversationId, 240);
  const boundaryMessageId = clean(source.currentNode || source.boundaryMessageId, 240);
  const payloadBytes = integer(source.payloadBytes || source.sourcePayloadBytes, null);
  const mappingCount = integer(source.mappingCount || source.sourceMappingCount, null);
  const branchMessageCount = integer(source.branchMessageCount || source.sourceBranchMessageCount, null);
  const textChars = integer(source.textChars || source.sourceTextChars, null);
  const exactUsedTokens = integer(source.exactUsedTokens, null);
  if (!conversationId) throw new Error("Auto Compact source conversation id is required.");
  if (!boundaryMessageId) throw new Error("Auto Compact source boundary message id is required.");
  if (payloadBytes == null && mappingCount == null && branchMessageCount == null && exactUsedTokens == null) {
    throw new Error("Auto Compact requires at least one measurable source-size signal.");
  }
  return {
    conversationId,
    boundaryMessageId,
    title: clean(source.title, 500),
    modelSlug: clean(source.modelSlug || source.defaultModelSlug, 200),
    payloadBytes,
    mappingCount,
    branchMessageCount,
    textChars,
    exactUsedTokens,
  };
}

export function createAutoCompactContract({
  capsule,
  source,
  uiContinuityKey,
  runtimeKey,
  goalId,
  planId,
  mode = "user-turn",
  maxCarryChars = DEFAULT_MAX_CARRY_CHARS,
  maxCarryTokens = DEFAULT_MAX_CARRY_TOKENS,
  maxCarryRatio = DEFAULT_MAX_CARRY_RATIO,
  now = () => new Date(),
} = {}) {
  const normalizedSource = normalizeSource(source);
  const capsuleValidation = validateSelectiveCompactCapsule(capsule, { maxCarryChars, maxCarryTokens });
  const carryMessageCount = mode === "hidden-goal-continuation" ? 1 : 2;
  const ratios = {
    exactTokenRatio: normalizedSource.exactUsedTokens && normalizedSource.exactUsedTokens > 0
      ? capsuleValidation.carryEstimatedTokens / normalizedSource.exactUsedTokens
      : null,
    payloadByteRatio: normalizedSource.payloadBytes && normalizedSource.payloadBytes > 0
      ? capsuleValidation.carryBytes / normalizedSource.payloadBytes
      : null,
    mappingRatio: normalizedSource.mappingCount && normalizedSource.mappingCount > 0
      ? carryMessageCount / normalizedSource.mappingCount
      : null,
    branchMessageRatio: normalizedSource.branchMessageCount && normalizedSource.branchMessageCount > 0
      ? carryMessageCount / normalizedSource.branchMessageCount
      : null,
  };
  const ratioLimit = Math.max(0.05, Math.min(0.50, Number(maxCarryRatio) || DEFAULT_MAX_CARRY_RATIO));
  const availableRatios = Object.entries(ratios).filter(([, value]) => Number.isFinite(value));
  if (!availableRatios.length) throw new Error("Auto Compact could not calculate a source-to-carry reduction ratio.");
  const failing = availableRatios.filter(([, value]) => value >= ratioLimit);
  if (failing.length) {
    throw new Error(`Auto Compact carry-forward is not sufficiently compressed; ratios=${failing.map(([name, value]) => `${name}:${value.toFixed(4)}`).join(",")}.`);
  }
  if (normalizedSource.branchMessageCount != null && normalizedSource.branchMessageCount <= carryMessageCount) {
    throw new Error("Auto Compact must reduce the source branch to fewer carried messages.");
  }
  const continuityKey = clean(uiContinuityKey, 300) || (goalId ? `goal:${goalId}` : `runtime:${runtimeKey || "unknown"}`);
  const createdAt = now() instanceof Date ? now().toISOString() : new Date(now()).toISOString();
  return {
    schemaVersion: 1,
    strategy: "selective-hidden-capsule-continuation",
    mode,
    createdAt,
    uiContinuityKey: continuityKey,
    source: normalizedSource,
    authority: {
      runtimeKey: clean(runtimeKey, 100),
      goalId: clean(goalId, 200),
      planId: clean(planId, 200),
    },
    preservedCategories: [...PRESERVED_CATEGORIES],
    excludedCategories: [...EXCLUDED_CATEGORIES],
    carry: {
      messageCount: carryMessageCount,
      chars: capsuleValidation.carryChars,
      bytes: capsuleValidation.carryBytes,
      estimatedTokens: capsuleValidation.carryEstimatedTokens,
      capsuleFingerprint: capsuleValidation.capsuleFingerprint,
    },
    ratios,
    maxCarryRatio: ratioLimit,
    accepted: true,
    fullHistoryInherited: false,
    zeroContextContinuation: false,
  };
}

export function attachAutoCompactContract(capsule, options = {}) {
  const contract = createAutoCompactContract({ capsule, ...options });
  return {
    ...capsule,
    continuity: {
      schemaVersion: contract.schemaVersion,
      strategy: contract.strategy,
      mode: contract.mode,
      createdAt: contract.createdAt,
      uiContinuityKey: contract.uiContinuityKey,
      sourceConversationId: contract.source.conversationId,
      sourceBoundaryMessageId: contract.source.boundaryMessageId,
      sourceTitle: contract.source.title,
      sourceModelSlug: contract.source.modelSlug,
      runtimeKey: contract.authority.runtimeKey,
      goalId: contract.authority.goalId,
      planId: contract.authority.planId,
      capsuleFingerprint: contract.carry.capsuleFingerprint,
    },
    compression: {
      strategy: contract.strategy,
      sourcePayloadBytes: contract.source.payloadBytes,
      sourceMappingCount: contract.source.mappingCount,
      sourceBranchMessageCount: contract.source.branchMessageCount,
      sourceTextChars: contract.source.textChars,
      sourceExactUsedTokens: contract.source.exactUsedTokens,
      carryMessageCount: contract.carry.messageCount,
      carryChars: contract.carry.chars,
      carryBytes: contract.carry.bytes,
      carryEstimatedTokens: contract.carry.estimatedTokens,
      ratios: contract.ratios,
      maxCarryRatio: contract.maxCarryRatio,
      preservedCategories: contract.preservedCategories,
      excludedCategories: contract.excludedCategories,
      fullHistoryInherited: false,
      zeroContextContinuation: false,
      accepted: true,
    },
  };
}

export function validateAutoCompactContinuation({
  contract,
  sourceConversationId,
  targetConversationId,
  targetMappingCount,
  targetBranchMessageCount,
  targetPayloadBytes,
  hiddenMessages,
  visibleUsers,
  visibleAssistants,
  uiContinuityVerified,
  nativeContinuationSourceId,
} = {}) {
  const sourceId = clean(sourceConversationId || contract?.source?.conversationId || contract?.continuity?.sourceConversationId, 240);
  const targetId = clean(targetConversationId, 240);
  if (!sourceId || !targetId || sourceId === targetId) throw new Error("Auto Compact continuation must create a distinct backend conversation id.");
  if (uiContinuityVerified !== true) throw new Error("Auto Compact continuation did not preserve the user-facing conversation continuity key.");
  if (integer(hiddenMessages, 0) < 1) throw new Error("Auto Compact target is missing the hidden continuity capsule.");
  if (integer(visibleAssistants, 0) < 1) throw new Error("Auto Compact target did not produce an assistant continuation.");
  if (integer(visibleUsers, 0) < 0) throw new Error("Invalid visible user count.");
  const ratioLimit = Math.max(0.05, Math.min(0.50, Number(contract?.maxCarryRatio ?? contract?.compression?.maxCarryRatio) || DEFAULT_MAX_CARRY_RATIO));
  const sourceMapping = integer(contract?.source?.mappingCount ?? contract?.compression?.sourceMappingCount, null);
  const targetMapping = integer(targetMappingCount, null);
  if (sourceMapping != null && targetMapping == null) {
    throw new Error("Auto Compact target mapping size is unavailable; full-history inheritance cannot be ruled out.");
  }
  if (sourceMapping != null && targetMapping >= sourceMapping * ratioLimit) {
    throw new Error("Auto Compact target inherited too much of the source mapping.");
  }
  const sourceMessages = integer(contract?.source?.branchMessageCount ?? contract?.compression?.sourceBranchMessageCount, null);
  const targetMessages = integer(targetBranchMessageCount, null);
  if (sourceMessages != null && targetMessages == null) {
    throw new Error("Auto Compact target branch size is unavailable; context reduction cannot be verified.");
  }
  if (sourceMessages != null && targetMessages >= sourceMessages * ratioLimit) {
    throw new Error("Auto Compact target inherited too much of the source message branch.");
  }
  const sourceBytes = integer(contract?.source?.payloadBytes ?? contract?.compression?.sourcePayloadBytes, null);
  const targetBytes = integer(targetPayloadBytes, null);
  if (sourceBytes != null && targetBytes == null) {
    throw new Error("Auto Compact target payload size is unavailable; material reduction cannot be verified.");
  }
  if (sourceBytes != null && targetBytes >= sourceBytes * ratioLimit) {
    throw new Error("Auto Compact target payload is not materially smaller than the source payload.");
  }
  const nativeSource = clean(nativeContinuationSourceId, 240);
  if (nativeSource && nativeSource !== sourceId) throw new Error("ChatGPT continuation metadata points to a different source conversation.");
  return {
    ok: true,
    sourceConversationId: sourceId,
    targetConversationId: targetId,
    backendIdChanged: true,
    uiContinuityVerified: true,
    sourceMappingCount: sourceMapping,
    targetMappingCount: targetMapping,
    sourceBranchMessageCount: sourceMessages,
    targetBranchMessageCount: targetMessages,
    sourcePayloadBytes: sourceBytes,
    targetPayloadBytes: targetBytes,
    hiddenMessages: integer(hiddenMessages, 0),
    visibleUsers: integer(visibleUsers, 0),
    visibleAssistants: integer(visibleAssistants, 0),
    fullHistoryInherited: false,
    zeroContextContinuation: false,
  };
}

export const AUTO_COMPACT_CONTRACT_DEFAULTS = Object.freeze({
  maxCarryChars: DEFAULT_MAX_CARRY_CHARS,
  maxCarryTokens: DEFAULT_MAX_CARRY_TOKENS,
  maxCarryRatio: DEFAULT_MAX_CARRY_RATIO,
  preservedCategories: [...PRESERVED_CATEGORIES],
  excludedCategories: [...EXCLUDED_CATEGORIES],
});
