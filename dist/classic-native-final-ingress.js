import { createHash } from 'node:crypto';
import { runtimeKeyForClassicPort } from './classic-main-debug-ports.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value) ? value : null;
const digest = text => createHash('sha256').update(text).digest('hex');

function nativeStreamEnvelope(block) {
  const raw = String(block || '').trim();
  const data = raw.startsWith('{') ? raw : raw.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  try { return JSON.parse(data); } catch { return null; }
}

// A first/new-chat request may not yet have a conversation ID. Learn only
// the native envelope identity from that exact response, not a page URL,
// quoted JSON, message content, or another request's cached conversation.
export function nativeConversationFromStreamBlock(block) {
  const payload = nativeStreamEnvelope(block);
  return payload?.message?.author?.role === 'assistant' && id(payload.message.id)
    ? id(payload.conversation_id) : null;
}

// Consume only an explicit native message envelope. Never search message text,
// tool arguments, quoted documents, DOM, or transport EOF for a final marker.
export function nativeFinalFromStreamBlock(block, { conversationId, sourceUserMessageId, requestId, observedAtMs } = {}) {
  if (!id(conversationId) || !id(sourceUserMessageId) || !requestId || !Number.isFinite(observedAtMs)) return null;
  const payload = nativeStreamEnvelope(block);
  const message = payload?.message;
  if (payload?.conversation_id !== conversationId || !id(message?.id)
    || message?.author?.role !== 'assistant'
    || (message.channel != null && message.channel !== 'final')
    || (message.metadata?.channel != null && message.metadata.channel !== 'final')
    || (message.recipient != null && message.recipient !== 'all')
    || message.status !== 'finished_successfully' || message.end_turn !== true
    || message.metadata?.is_visually_hidden_from_conversation === true
    || message.content?.content_type !== 'text' || !Array.isArray(message.content.parts)
    || message.content.parts.some(part => typeof part !== 'string')
    || typeof message.create_time !== 'number' || !Number.isFinite(message.create_time)
    || message.create_time <= 0) return null;
  const text = message.content.parts.join('\n').trim();
  const createdAtMs = message.create_time * 1000;
  if (!text || text.length > 100_000 || !Number.isFinite(createdAtMs)
    || createdAtMs > observedAtMs + 60_000 || createdAtMs > 8.64e15) return null;
  return {
    source: 'native-assistant-turn-final', ingress: 'native-response-stream',
    conversationId, sourceUserMessageId, requestId,
    assistantMessageId: message.id, assistantTextHash: digest(text),
    assistantCreatedAt: new Date(createdAtMs).toISOString(),
    status: 'finished_successfully', endTurn: true, publicFinal: true,
    observedAtMs, observedAt: new Date(observedAtMs).toISOString(),
  };
}

export function isNativeStreamFinalReceipt(event) {
  return event?.source === 'native-assistant-turn-final' && event.ingress === 'native-response-stream'
    && event.status === 'finished_successfully' && event.endTurn === true && event.publicFinal === true
    && id(event.conversationId) && id(event.sourceUserMessageId) && id(event.assistantMessageId)
    && typeof event.requestId === 'string' && Boolean(event.requestId)
    && /^[a-f0-9]{64}$/.test(String(event.assistantTextHash || ''))
    && Number.isFinite(Date.parse(event.assistantCreatedAt))
    && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(String(event.runtimeKey || ''))
    && typeof event.pageTargetId === 'string' && Boolean(event.pageTargetId)
    && runtimeKeyForClassicPort(event.port) === event.runtimeKey;
}

// Live native branch ownership. Deliberately not restored from disk: a prior
// final receipt is durable history, not proof that no newer turn has started.
export class ClassicNativeFinalBoundaryStore {
  constructor({ maxEntries = 128 } = {}) { this.maxEntries = maxEntries; this.turns = new Map(); }
  key(event) { return `${event.runtimeKey}:${event.pageTargetId}:${event.conversationId}`; }
  invalidatePage({ runtimeKey, pageTargetId } = {}) {
    if (!runtimeKey || !pageTargetId) return;
    const prefix = `${runtimeKey}:${pageTargetId}:`;
    for (const key of this.turns.keys()) if (key.startsWith(prefix)) this.turns.delete(key);
  }
  noteTurn(event) {
    if (!['started', 'resumed', 'failed', 'expired', 'evicted'].includes(event?.kind)
      || !id(event.conversationId) || !event.runtimeKey || !event.pageTargetId || !event.requestId) return;
    const key = this.key(event), previous = this.turns.get(key);
    if (['failed', 'expired', 'evicted'].includes(event.kind)) {
      if (previous?.requestId === event.requestId && !previous.final) this.turns.delete(key);
      return;
    }
    this.turns.delete(key);
    this.turns.set(key, { requestId: event.requestId, sourceUserMessageId: event.sourceUserMessageId, final: null });
    while (this.turns.size > this.maxEntries) this.turns.delete(this.turns.keys().next().value);
  }
  noteFinal(event) {
    if (!isNativeStreamFinalReceipt(event)) return false;
    const turn = this.turns.get(this.key(event));
    if (!turn || turn.requestId !== event.requestId || turn.sourceUserMessageId !== event.sourceUserMessageId) return false;
    turn.final = { ...event };
    return true;
  }
  inspect(goal, row) {
    const proof = row?.nativeCompletionProof || goal?.lastTurnCompletion;
    if (proof?.ingress !== 'native-response-stream' || proof.conversationId !== goal?.conversationId) return null;
    const turn = this.turns.get(this.key(proof));
    if (!turn) return { pages: null, inspectionReason: 'awaiting-native-final-ingress' };
    if (turn.sourceUserMessageId && turn.sourceUserMessageId !== proof.sourceUserMessageId) {
      return { pages: null, newUser: true, newUserMessageId: turn.sourceUserMessageId };
    }
    const event = turn.final;
    if (!event || event.assistantMessageId !== proof.assistantMessageId
      || event.assistantTextHash !== proof.assistantTextHash) return { pages: null, inspectionReason: 'native-final-boundary-changed' };
    return { pages: [{
      conversationId: event.conversationId, runtimeKey: event.runtimeKey, pageTargetId: event.pageTargetId,
      latestUserMessageId: event.sourceUserMessageId, latestAssistantMessageId: event.assistantMessageId,
      nativeFinalReceipt: { ...event },
      candidate: { runtimePort: event.port, pageTargetId: event.pageTargetId },
    }] };
  }
}
