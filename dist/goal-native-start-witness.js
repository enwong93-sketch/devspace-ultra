// A display is not a turn. Only a server-created start receipt in an exact
// native tool result may connect a background request to a durable Goal.
// This function is also serialized into the existing read-only host inspector;
// keep it self-contained. Never read reasoning or user text. A structured
// tool-invocation envelope may identify an api_tool wrapper, but is not returned.
export function nativeGoalStartWitness(payload, receipt, conversationId) {
  const failed = reason => ({ verified: false, reason });
  if (!receipt || receipt.source !== 'server-created-goal-start'
    || receipt.conversationId !== conversationId
    || !/^goal_[a-f0-9]{16}$/.test(String(receipt.goalId || ''))
    || !/^[a-f0-9]{48}$/.test(String(receipt.receiptId || ''))
    || !Number.isFinite(Date.parse(String(receipt.issuedAt || '')))) return failed('start-receipt-unavailable');
  const payloadIds = [payload?.id, payload?.conversation_id].filter(value => value != null);
  if (!payloadIds.length || payloadIds.some(value => String(value) !== conversationId)) return failed('native-conversation-mismatch');
  const mapping = payload?.mapping;
  let id = payload?.current_node;
  const seen = new Set(), reverse = [];
  while (id) {
    if (!mapping?.[id] || seen.has(id) || seen.size >= 4096) return failed('native-branch-incomplete');
    seen.add(id);
    const node = mapping[id], message = node?.message;
    if (message) reverse.push({ message, parent: node?.parent });
    // Earlier history cannot change the latest user or the result's ancestry.
    // Do not scan unrelated old branches just to authenticate this request.
    if (message?.author?.role === 'user') break;
    id = node?.parent;
  }
  const branch = reverse.reverse(), matches = [];
  const marker = `[DEVSPACE_NATIVE_GOAL_START:${receipt.goalId}:${receipt.receiptId}]`;
  let sourceUser = null;
  for (const { message, parent } of branch) {
    if (message.author?.role === 'user') sourceUser = message;
    if (message.author?.role !== 'tool' || message.status !== 'finished_successfully') continue;
    // The marker in an assistant/user echo or another tool is not authority.
    // Do not accept a tool's arbitrary result metadata as its invocation name.
    const call = parent ? mapping[parent]?.message : null;
    const startName = value => /^(?:[A-Za-z0-9_-]+(?:\.|__))*devspace_goal_start$/.test(String(value || ''));
    let startTool = startName(message.author?.name)
      || (call?.author?.role === 'assistant' && startName(call.recipient));
    let structuredWrapper = false;
    if (!startTool && ['api_tool', 'api_tool.call_tool'].includes(message.author?.name)) {
      if (call?.author?.role === 'assistant' && call.recipient === 'api_tool.call_tool'
        && ['text', 'code'].includes(call.content?.content_type)) {
        const invocationText = call.content.content_type === 'code' ? call.content.text
          : call.content.parts?.length === 1 ? call.content.parts[0] : null;
        try {
          const envelope = typeof invocationText === 'string' && invocationText.length <= 65_536
            ? JSON.parse(invocationText) : null;
          startTool = typeof envelope?.path === 'string'
            && /^\/[A-Za-z0-9_./ -]{1,239}$/.test(envelope.path)
            && envelope.path.split('/').every(part => part !== '.' && part !== '..')
            && /(?:^|\/)devspace_goal_start$/.test(envelope.path);
          structuredWrapper = startTool;
        } catch { /* Free-form text is not a structured invocation. */ }
      }
    }
    if (!startTool) continue;
    let found = message.content?.content_type === 'text' && Array.isArray(message.content.parts)
      && message.content.parts.slice(0, 32).some(part => typeof part === 'string'
        && part.length <= 1_000_000 && part.includes(marker));
    let witnessFormat = found ? 'nonce-in-start-result-text' : null;
    // Observed native serialization keeps structuredContent, not result text.
    // Authenticate its exact canonical invocation and newly created Goal tuple.
    // The private nonce is NOT claimed to have appeared in this representation.
    if (!found && structuredWrapper && message.content?.content_type === 'code'
      && typeof message.content.text === 'string' && message.content.text.length <= 1_000_000) {
      try {
        const resultGoal = JSON.parse(message.content.text)?.goal;
        found = resultGoal?.id === receipt.goalId && resultGoal?.conversationId === conversationId
          && resultGoal?.createdAt === receipt.issuedAt && resultGoal?.status === 'active'
          && resultGoal?.round === 1 && resultGoal?.roundState === 'working';
        if (found) witnessFormat = 'canonical-start-result-goal-stamp';
      } catch { /* Free-form replies cannot provide structured start authority. */ }
    }
    if (!found || !sourceUser?.id || !message.id) continue;
    const userAt = typeof sourceUser.create_time === 'number' ? sourceUser.create_time * 1000 : NaN;
    const toolAt = typeof message.create_time === 'number' ? message.create_time * 1000 : NaN;
    if (!Number.isFinite(userAt) || !Number.isFinite(toolAt)
      || userAt > Date.parse(receipt.issuedAt) || toolAt < userAt) continue;
    matches.push({ witnessFormat, sourceUserMessageId: sourceUser.id, sourceUserCreatedAt: new Date(userAt).toISOString(),
      toolMessageId: message.id, toolCreatedAt: new Date(toolAt).toISOString() });
  }
  if (!matches.length) return failed('native-start-tool-result-unavailable');
  if (new Set(matches.map(row => row.sourceUserMessageId)).size !== 1) return failed('native-start-source-ambiguous');
  return { verified: true, source: 'native-goal-start-tool-result', goalId: receipt.goalId,
    receiptId: receipt.receiptId, conversationId, issuedAt: receipt.issuedAt, ...matches[0] };
}

export function matchesNativeGoalStartWitness(goal, native) {
  const receipt = goal?.nativeStartReceipt, witness = native?.goalStartWitness;
  return receipt?.source === 'server-created-goal-start'
    && receipt.goalId === goal.id && receipt.conversationId === goal.conversationId
    && witness?.verified === true && witness.source === 'native-goal-start-tool-result'
    && witness.goalId === goal.id && witness.conversationId === goal.conversationId
    && witness.receiptId === receipt.receiptId && witness.issuedAt === receipt.issuedAt
    && witness.sourceUserMessageId === native.latestUserMessageId
    && witness.sourceUserCreatedAt === native.latestUserCreatedAt
    && Boolean(witness.toolMessageId)
    && Date.parse(witness.sourceUserCreatedAt) <= Date.parse(receipt.issuedAt)
    && Date.parse(witness.toolCreatedAt) >= Date.parse(witness.sourceUserCreatedAt)
    && (native.currentEndTurn !== true || native.currentRole !== 'assistant'
      || Date.parse(witness.toolCreatedAt) <= Date.parse(native.latestAssistantCreatedAt));
}

export function projectNativeGoalSource(snapshot, goal) {
  const native = snapshot?.nativeContinuation;
  if (!matchesNativeGoalStartWitness(goal, native)
    || snapshot?.chatMode !== true || snapshot.conversationId !== goal.conversationId
    || !snapshot.pageTargetId || snapshot.safetyCheckVisible || snapshot.deliveryTimeoutVisible
    || snapshot.retryVisible) return snapshot;
  const final = native.currentRole === 'assistant' && native.currentEndTurn === true
    && native.latestAssistantEndTurn === true && native.currentStatus === 'finished_successfully'
    && native.latestAssistantStatus === 'finished_successfully'
    && native.currentNodeId === native.currentMessageId
    && native.currentMessageId === native.latestAssistantMessageId
    && typeof native.latestPublicAssistantText === 'string' && native.latestPublicAssistantText.trim();
  if (final && /^(?:This request requires additional safety checks|Additional safety checks|此請求需要額外安全檢查|此请求需要额外安全检查|需要進行額外安全檢查|需要进行额外安全检查)/i.test(native.latestPublicAssistantText.trim())) {
    return { ...snapshot, nativeSafetyBlocked: true };
  }
  // Keep stream_status as an independent gate; never turn a failed transport
  // or a safety surface into a completed turn. No DOM or composer is mutated.
  return { ...snapshot, boundarySource: 'native-goal-start-tool-result',
    displaySourceUserMessageId: snapshot.latestUserMessageId,
    displayAssistantMessageId: snapshot.latestAssistantMessageId,
    latestUserMessageId: native.latestUserMessageId,
    latestUserText: null,
    previousUserMessageId: native.previousUserMessageId,
    assistantBeforeLatestUserMessageId: native.assistantBeforeLatestUserMessageId,
    latestMessageRole: final ? 'assistant' : native.currentRole,
    latestMessageId: native.currentMessageId,
    latestAssistantMessageId: final ? native.latestAssistantMessageId : null,
    latestAssistantText: final ? native.latestPublicAssistantText.trim() : '',
    generating: !final,
  };
}
