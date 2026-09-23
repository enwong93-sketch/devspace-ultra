/**
 * Reduce one native current-branch message sequence to the minimum causal
 * Rescue evidence. This is deliberately independent of the virtualized DOM:
 * older visible nodes may disappear while the native branch remains intact.
 * Raw message text is used only for exact `- 繼續` classification and is never
 * returned by this helper.
 */
export function analyzeRescueSequence(branch, sourceUserMessageId, expectedText) {
  const rows = Array.isArray(branch) ? branch : [];
  const source = String(sourceUserMessageId || '').trim();
  const expected = String(expectedText || '').trim();
  const sourceIndex = rows.findIndex(message => (
    message?.id === source && message?.author?.role === 'user'
  ));
  if (sourceIndex < 0) {
    return { ok: false, state: 'source-user-not-on-current-branch', rawContentReturned: false };
  }
  const normalize = value => String(value || '')
    .replace(/^DevSpace Local Gateway\s*/, '')
    .trim();
  const afterSource = rows.slice(sourceIndex + 1).map((message, index) => {
    const text = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter(part => typeof part === 'string').join('\n')
      : message?.content?.text;
    return {
      index,
      id: typeof message?.id === 'string' ? message.id : null,
      role: message?.author?.role || null,
      status: message?.status || null,
      endTurn: message?.end_turn === true,
      isExpectedRescue: message?.author?.role === 'user' && normalize(text) === expected,
    };
  });
  const rescueRows = afterSource.filter(row => row.isExpectedRescue);
  const latestRescue = rescueRows.at(-1) || null;
  const assistantAfterRescue = latestRescue
    ? afterSource.find(row => row.index > latestRescue.index && row.role === 'assistant') || null
    : null;
  return {
    ok: true,
    sourceUserMessageId: source,
    rescueUserIds: rescueRows.map(row => row.id).filter(Boolean),
    latestRescueUserId: latestRescue?.id || null,
    assistantAfterRescueId: assistantAfterRescue?.id || null,
    assistantAfterRescueStatus: assistantAfterRescue?.status || null,
    assistantAfterRescueEndTurn: assistantAfterRescue?.endTurn === true,
    rawContentReturned: false,
  };
}
