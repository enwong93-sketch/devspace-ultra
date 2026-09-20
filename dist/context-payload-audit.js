/** Structural diagnostics only. Never return transcript, reasoning or credentials.
 * Bytes/characters are NOT native token usage or ChatGPT's admission limit.
 */
export function summarizeContextPayload(payload = {}) {
  const bytes = value => new TextEncoder().encode(String(value)).length;
  const mapping = payload.mapping || {};
  const nodes = [];
  const visited = new Set();
  let id = payload.current_node;
  while (id && mapping[id] && !visited.has(id)) {
    visited.add(id); nodes.push(mapping[id]); id = mapping[id].parent;
  }
  const activeBranchResolved = nodes.length > 0;
  if (!activeBranchResolved) return { ok: false, reason: 'active-branch-unresolved', rawContentReturned: false };
  nodes.reverse();
  const groups = {};
  const seen = new Map();
  const largest = [];
  const byTool = {};
  let latestTool = null;
  let repeatedTextBytes = 0;
  let excludedReasoningMessages = 0;
  let firstUser = null;
  const markers = { ctcRequests: 0, goalContinuations: 0, compactCapsules: 0 };
  for (const [index, node] of nodes.entries()) {
    const m = node.message;
    if (!m) continue;
    const channel = m.channel || m.metadata?.channel;
    if (['analysis', 'justify', 'confidence'].includes(channel) || m.content?.content_type === 'thoughts') {
      excludedReasoningMessages += 1; continue;
    }
    const role = m.author?.role || m.role || 'unknown';
    const recipient = m.recipient || 'all';
    const group = role === 'tool' ? 'toolResults' : role === 'assistant' && recipient !== 'all' ? 'toolCalls' : role;
    const content = m.content || {};
    const text = typeof content.text === 'string' ? content.text
      : Array.isArray(content.parts) ? content.parts.filter(x => typeof x === 'string').join('\n') : '';
    const size = bytes(text);
    if (group === 'toolCalls') {
      latestTool = recipient;
      try {
        const call = JSON.parse(text);
        const path = call.path || call.name || call.toolName;
        if (typeof path === 'string') {
          const candidate = path.split('/').filter(Boolean).at(-1);
          if (/^[A-Za-z0-9_.:-]{1,180}$/.test(candidate || '')) latestTool = candidate;
        }
      } catch { /* raw programs are not evaluated or returned */ }
    }
    if (group === 'toolResults') {
      const tool = latestTool || 'unattributed';
      const entry = byTool[tool] ||= { messages: 0, textBytes: 0, maxBytes: 0 };
      entry.messages += 1; entry.textBytes += size; entry.maxBytes = Math.max(entry.maxBytes, size);
    }
    const row = groups[group] ||= { messages: 0, textBytes: 0, chars: 0 };
    row.messages += 1; row.textBytes += size; row.chars += text.length;
    if (size > 0) {
      const key = role + ':' + text;
      if (seen.has(key)) repeatedTextBytes += size;
      seen.set(key, true);
    }
    if (role === 'user' && !firstUser) firstUser = { textBytes: size, chars: text.length };
    if (text.includes('CTC_REQUEST:')) markers.ctcRequests += 1;
    if (text.includes('[DEVSPACE_GOAL_CONTINUATION]')) markers.goalContinuations += 1;
    if (text.includes('DEVSPACE_COMPACT_CAPSULE_BEGIN')) markers.compactCapsules += 1;
    const name = role === 'tool' ? latestTool || m.author?.name : latestTool || recipient;
    largest.push({ branchIndex: index, group, textBytes: size,
      tool: typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(name) ? name : null });
  }
  return { ok: true, measurement: 'stored-active-branch-non-reasoning-text', nativeTokens: null,
    mappingNodes: Object.keys(mapping).length, activeBranchNodes: nodes.length,
    offBranchNodes: Object.keys(mapping).length - nodes.length,
    groups, firstUser, repeatedTextBytes, markers, excludedReasoningMessages,
    byPrecedingTool: Object.entries(byTool).sort((a, b) => b[1].textBytes - a[1].textBytes)
      .slice(0, 12).map(([tool, value]) => ({ tool, ...value })),
    toolAttribution: 'preceding-call-in-active-branch-not-native-call-id',
    largestMessages: largest.sort((a, b) => b.textBytes - a.textBytes).slice(0, 8),
    rawContentReturned: false, credentialsReturned: false,
    fullMappingSentToModel: false, injectionProven: false };
}
