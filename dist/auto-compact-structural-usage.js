const MAX_SAFE_TOKENS = 2_000_000_000;

function boundedNonNegative(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_SAFE_TOKENS, Math.floor(number));
}

/**
 * Produce a conservative context-pressure estimate from a sanitized native
 * conversation descriptor. This is a trigger signal only; it is never labelled
 * as exact native usage and never requires raw messages or transcript content.
 */
export function estimateStructuralContextTokens(descriptor = {}) {
  const payloadBytes = boundedNonNegative(descriptor?.payloadBytes);
  const textChars = boundedNonNegative(descriptor?.textChars);
  const branchMessageCount = boundedNonNegative(
    descriptor?.branchMessageCount ?? descriptor?.currentBranchMessageCount,
  );
  const explicitEstimate = boundedNonNegative(descriptor?.estimatedTokens);

  // UTF-8 payload bytes conservatively capture CJK and metadata/tool payloads;
  // text chars protect compact JSON representations; per-message overhead keeps
  // long tool-heavy branches from appearing artificially free.
  const payloadEstimate = Math.ceil(payloadBytes / 4);
  const textEstimate = Math.ceil(textChars / 2);
  const messageEstimate = branchMessageCount * 12;
  const estimatedTokens = Math.min(
    MAX_SAFE_TOKENS,
    Math.max(explicitEstimate, payloadEstimate, textEstimate, messageEstimate),
  );

  return {
    estimatedTokens,
    source: "classic-conversation-structural",
    exact: false,
    components: {
      payloadBytes,
      textChars,
      branchMessageCount,
      payloadEstimate,
      textEstimate,
      messageEstimate,
      explicitEstimate,
    },
    rawContentUsed: false,
  };
}
