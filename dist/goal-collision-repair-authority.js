function text(value, max = 240) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

/**
 * Require both backend projection ownership and one exact open ChatGPT page.
 * This policy never selects a Goal from recency/activity and returns no content.
 */
export function assertGoalCollisionRepairAuthority({
  conversationId,
  keepGoalId,
  projection,
  pageResolution,
} = {}) {
  const conversation = text(conversationId);
  const goalId = text(keepGoalId, 200);
  if (!conversation || !goalId) throw new Error('Goal collision repair requires exact identifiers.');
  if (projection?.goal?.id !== goalId || projection?.goal?.status !== 'active') {
    throw new Error('Current backend overlay projection does not select the requested active Goal.');
  }
  const page = pageResolution?.candidate;
  if (!page || pageResolution?.ambiguous === true || Number(pageResolution?.matchCount || 0) !== 1
    || text(page.conversationId) !== conversation) {
    throw new Error('Exactly one current ChatGPT page must prove the collision-repair conversation.');
  }
  return {
    conversationId: conversation,
    keepGoalId: goalId,
    pageTargetId: text(page.pageTargetId, 200),
    runtimePort: Number.isInteger(page.runtimePort) ? page.runtimePort : null,
    backendProjectionVerified: true,
    exactPageVerified: true,
    rawGoalContentReturned: false,
  };
}
