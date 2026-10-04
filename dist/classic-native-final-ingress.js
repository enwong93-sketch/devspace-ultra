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

export const hasNativeFinalIngress = proof => ['native-response-stream', 'native-conversation-api'].includes(proof?.ingress);

export function nativeApiFinalFromPages(goal, pages, { readStartedAtMs, observedAtMs = Date.now() } = {}) {
  if (!goal?.conversationId || !Array.isArray(pages) || pages.length !== 1
    || !Number.isFinite(readStartedAtMs) || readStartedAtMs > observedAtMs) return null;
  const page = pages[0], native = page?.nativeContinuation;
  const createdAt = Date.parse(native?.latestAssistantCreatedAt || '');
  if (page?.conversationId !== goal.conversationId || page.chatMode !== true || page.nativeSafetyBlocked === true
    || native?.resolved !== true || native.conversationIdVerified !== true
    || native.currentRole !== 'assistant' || native.currentStatus !== 'finished_successfully'
    || native.latestAssistantStatus !== 'finished_successfully' || native.currentEndTurn !== true
    || native.latestAssistantEndTurn !== true || !id(native.latestUserMessageId) || !id(native.latestAssistantMessageId)
    || native.currentNodeId !== native.latestAssistantMessageId || native.currentMessageId !== native.latestAssistantMessageId
    || Date.parse(native.currentCreatedAt || '') !== createdAt || !Number.isFinite(createdAt)
    || createdAt > observedAtMs + 60_000 || typeof native.latestPublicAssistantText !== 'string'
    || !native.latestPublicAssistantText.trim() || native.latestPublicAssistantText.length > 100_000) return null;
  const event = { source:'native-assistant-turn-final', ingress:'native-conversation-api',
    conversationId:goal.conversationId, sourceUserMessageId:native.latestUserMessageId,
    assistantMessageId:native.latestAssistantMessageId, assistantTextHash:digest(native.latestPublicAssistantText.trim()),
    assistantCreatedAt:native.latestAssistantCreatedAt, status:'finished_successfully', endTurn:true, publicFinal:true,
    runtimeKey:page.runtimeKey, pageTargetId:page.pageTargetId, port:page.candidate?.runtimePort || page.runtimePort,
    readStartedAtMs, observedAtMs, observedAt:new Date(observedAtMs).toISOString(), nativeConversationVerified:true,
    sourceUserTextHash:native.latestUserTextHash || null, parentMessageId:native.latestUserParentMessageId || null };
  return isNativeCompletedFinalReceipt(event) ? event : null;
}

export function isNativeCompletedFinalReceipt(event) {
  if (event?.ingress === 'native-response-stream') return isNativeStreamFinalReceipt(event);
  return event?.source === 'native-assistant-turn-final' && event.ingress === 'native-conversation-api'
    && event.nativeConversationVerified === true && event.status === 'finished_successfully'
    && event.endTurn === true && event.publicFinal === true
    && id(event.conversationId) && id(event.sourceUserMessageId) && id(event.assistantMessageId)
    && /^[a-f0-9]{64}$/.test(String(event.assistantTextHash || ''))
    && Number.isFinite(Date.parse(event.assistantCreatedAt))
    && Number.isFinite(event.readStartedAtMs) && Number.isFinite(event.observedAtMs)
    && event.readStartedAtMs <= event.observedAtMs
    && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(String(event.runtimeKey || ''))
    && typeof event.pageTargetId === 'string' && Boolean(event.pageTargetId)
    && runtimeKeyForClassicPort(event.port) === event.runtimeKey;
}

// This admits an ALREADY issued public continuation into its working round.
// It is not a final receipt and can never authorize another continuation.
export function nativeApiStartedFromPages(goal,pages,{readStartedAtMs,observedAtMs=Date.now()}={}) {
  if(!goal?.conversationId || pages?.length!==1 || !Number.isFinite(readStartedAtMs) || readStartedAtMs>observedAtMs)return null;
  const page=pages[0],n=page.nativeContinuation;
  const created=Date.parse(n?.latestAssistantCreatedAt||''),userCreated=Date.parse(n?.latestUserCreatedAt||'');
  if(page.conversationId!==goal.conversationId || page.chatMode!==true || page.nativeSafetyBlocked===true
    || n?.resolved!==true || n.conversationIdVerified!==true || !['assistant','tool'].includes(n.currentRole)
    || n.currentEndTurn!==false || n.latestAssistantEndTurn!==false
    || !['in_progress','finished_successfully'].includes(n.latestAssistantStatus)
    || n.currentNodeId!==n.currentMessageId || !id(n.currentMessageId)
    || n.currentRole==='assistant'&&n.currentMessageId!==n.latestAssistantMessageId
    || !Number.isFinite(created)||!Number.isFinite(userCreated)||created<userCreated||created>observedAtMs+60_000)return null;
  const event={source:'native-public-assistant-started',ingress:'native-conversation-api',nativeConversationVerified:true,
    conversationId:goal.conversationId,sourceUserMessageId:n.latestUserMessageId,assistantMessageId:n.latestAssistantMessageId,
    assistantCreatedAt:n.latestAssistantCreatedAt,sourceUserTextHash:n.latestUserTextHash,
    parentMessageId:n.latestUserParentMessageId,runtimeKey:page.runtimeKey,pageTargetId:page.pageTargetId,
    port:page.candidate?.runtimePort||page.runtimePort,readStartedAtMs,observedAtMs};
  return isNativeApiStartedReceipt(event)?event:null;
}
export function isNativeApiStartedReceipt(event) {
  return event?.source==='native-public-assistant-started' && event.ingress==='native-conversation-api'
    && event.nativeConversationVerified===true && id(event.conversationId)&&id(event.sourceUserMessageId)
    && id(event.assistantMessageId)&&id(event.parentMessageId)&&/^[a-f0-9]{64}$/.test(String(event.sourceUserTextHash||''))
    && Number.isFinite(Date.parse(event.assistantCreatedAt))&&Number.isFinite(event.readStartedAtMs)
    && Number.isFinite(event.observedAtMs)&&event.readStartedAtMs<=event.observedAtMs
    && /^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(String(event.runtimeKey||''))
    && typeof event.pageTargetId==='string'&&!!event.pageTargetId&&runtimeKeyForClassicPort(event.port)===event.runtimeKey;
}

// Live native branch ownership. Deliberately not restored from disk: a prior
// final receipt is durable history, not proof that no newer turn has started.
export class ClassicNativeFinalBoundaryStore {
  constructor({ maxEntries = 128 } = {}) { this.maxEntries = maxEntries; this.turns = new Map(); this.pageRevisions = new Map(); this.provisionalTurns = new Map(); this.pageTurns = new Map(); }
  key(event) { return `${event.runtimeKey}:${event.pageTargetId}:${event.conversationId}`; }
  pageKey(event) { return `${event.runtimeKey}:${event.pageTargetId}`; }
  captureRevisions() { return new Map(this.pageRevisions); }
  matchesReadRevision(event,revisions) {
    if(!(revisions instanceof Map)||(revisions.get(this.pageKey(event))||0)!==(this.pageRevisions.get(this.pageKey(event))||0))return false;
    const current=this.pageTurns.get(this.pageKey(event));
    if(!current||current.completed)return true;
    return !(current.conversationId&&current.conversationId!==event.conversationId
      ||current.sourceUserMessageId&&current.sourceUserMessageId!==event.sourceUserMessageId
      ||!current.conversationId&&!current.sourceUserMessageId
      ||current.startedAtMs&&Date.parse(event.assistantCreatedAt)<current.startedAtMs);
  }
  bumpPage(event) {
    const key=this.pageKey(event);this.pageRevisions.set(key,(this.pageRevisions.get(key)||0)+1);
  }
  invalidatePage({ runtimeKey, pageTargetId } = {}) {
    if (!runtimeKey || !pageTargetId) return;
    this.bumpPage({runtimeKey,pageTargetId});
    this.provisionalTurns.delete(this.pageKey({runtimeKey,pageTargetId}));
    this.pageTurns.delete(this.pageKey({runtimeKey,pageTargetId}));
    const prefix = `${runtimeKey}:${pageTargetId}:`;
    for (const key of this.turns.keys()) if (key.startsWith(prefix)) this.turns.delete(key);
  }
  noteTurn(event) {
    if (['started','resumed'].includes(event?.kind) && event.runtimeKey && event.pageTargetId) {
      if(!id(event.conversationId)) {
        this.invalidatePage(event);
        this.provisionalTurns.set(this.pageKey(event),{sourceUserMessageId:event.sourceUserMessageId||null,
          startedAtMs:Number(event.observedAtMs)||Date.parse(event.observedAt||'')||0});
      } else {this.bumpPage(event);this.provisionalTurns.delete(this.pageKey(event));}
      this.pageTurns.set(this.pageKey(event),{conversationId:id(event.conversationId),sourceUserMessageId:event.sourceUserMessageId||null,
        requestId:event.requestId,startedAtMs:Number(event.observedAtMs)||Date.parse(event.observedAt||'')||0,completed:false});
    }
    if (!['started', 'resumed', 'failed', 'expired', 'evicted'].includes(event?.kind)
      || !id(event.conversationId) || !event.runtimeKey || !event.pageTargetId || !event.requestId) return;
    const key = this.key(event), previous = this.turns.get(key);
    if (['failed', 'expired', 'evicted'].includes(event.kind)) {
      if (previous?.requestId === event.requestId && !previous.final) this.turns.delete(key);
      return;
    }
    this.turns.delete(key);
    this.turns.set(key, { requestId: event.requestId, sourceUserMessageId: event.sourceUserMessageId,
      startedAtMs: Number(event.observedAtMs)||Date.parse(event.observedAt||'')||0, final: null });
    while (this.turns.size > this.maxEntries) this.turns.delete(this.turns.keys().next().value);
  }
  noteFinal(event) {
    if (!isNativeStreamFinalReceipt(event)) return false;
    const turn = this.turns.get(this.key(event));
    if (!turn || turn.requestId !== event.requestId || turn.sourceUserMessageId !== event.sourceUserMessageId) return false;
    turn.final = { ...event };
    const pageTurn=this.pageTurns.get(this.pageKey(event));
    if(pageTurn?.requestId===event.requestId)pageTurn.completed=true;
    return true;
  }
  noteApiFinal(event, revisions) {
    if (event?.ingress !== 'native-conversation-api' || !isNativeCompletedFinalReceipt(event)
      || !this.matchesReadRevision(event,revisions)) return false;
    const key=this.key(event),previous=this.turns.get(key);
    const provisional=this.provisionalTurns.get(this.pageKey(event));
    if(provisional && (!provisional.sourceUserMessageId || provisional.sourceUserMessageId!==event.sourceUserMessageId
      || !provisional.startedAtMs || Date.parse(event.assistantCreatedAt)<provisional.startedAtMs))return false;
    if (previous && !previous.final && (previous.sourceUserMessageId && previous.sourceUserMessageId!==event.sourceUserMessageId
      || previous.startedAtMs && Date.parse(event.assistantCreatedAt)<previous.startedAtMs)) return false;
    // A same-final API read must not strip the original stream request receipt.
    if (previous?.final?.assistantMessageId===event.assistantMessageId
      && previous.final.assistantTextHash===event.assistantTextHash) return true;
    this.turns.delete(key);
    this.provisionalTurns.delete(this.pageKey(event));
    const pageTurn=this.pageTurns.get(this.pageKey(event));
    if(pageTurn)pageTurn.completed=true;
    this.turns.set(key,{requestId:null,sourceUserMessageId:event.sourceUserMessageId,final:{...event}});
    while(this.turns.size>this.maxEntries)this.turns.delete(this.turns.keys().next().value);
    return true;
  }
  inspect(goal, row) {
    const proof = row?.nativeCompletionProof || goal?.lastTurnCompletion;
    if (!hasNativeFinalIngress(proof) || proof.conversationId !== goal?.conversationId) return null;
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

// Read the exact native conversation branch, not rendered text, socket EOF or
// an idle composer. Every dispatch read samples again; cache history is not a
// current-turn claim. Page revisions fence late reads across request/navigation.
export class ClassicNativeFinalApiIngress {
  constructor({boundaries,inspectPages,now=()=>Date.now()}={}) {
    if(!boundaries || typeof inspectPages!=='function')throw new Error('Native API ingress requires scoped branch inspection and live boundary storage.');
    this.boundaries=boundaries;this.inspectPages=inspectPages;this.now=now;
  }
  async inspect(goal,row=null) {
    const revisions=this.boundaries.captureRevisions(),readStartedAtMs=this.now();
    const proof=row?.nativeCompletionProof||null;
    const scope=proof||row?.apiScope;
    const pages=await this.inspectPages(goal,{runtimeKey:scope?.runtimeKey||null,pageTargetId:scope?.pageTargetId||null,
      includeNativeBranch:true,nativeFinalApiOnly:true});
    const event=nativeApiFinalFromPages(goal,pages,{readStartedAtMs,observedAtMs:this.now()});
    if(!event && !proof) {
      const started=nativeApiStartedFromPages(goal,pages,{readStartedAtMs,observedAtMs:this.now()});
      if(started && this.boundaries.matchesReadRevision(started,revisions))return{pages:null,started};
    }
    if(!event || !this.boundaries.noteApiFinal(event,revisions))return{pages:null,inspectionReason:'native-api-final-unavailable-or-changed',
      diagnostic:{pageCount:pages?.length??null,pages:Array.isArray(pages)?pages.map(p=>({runtimeKey:p.runtimeKey,
        runtimePort:p.candidate?.runtimePort,chatMode:p.chatMode,nativeSafetyBlocked:p.nativeSafetyBlocked,
        resolved:p.nativeContinuation?.resolved,state:p.nativeContinuation?.state,
        conversationIdVerified:p.nativeContinuation?.conversationIdVerified,currentRole:p.nativeContinuation?.currentRole,
        currentStatus:p.nativeContinuation?.currentStatus,currentEndTurn:p.nativeContinuation?.currentEndTurn,
        nodeMatchesAssistant:p.nativeContinuation?.currentNodeId===p.nativeContinuation?.latestAssistantMessageId,
        messageMatchesAssistant:p.nativeContinuation?.currentMessageId===p.nativeContinuation?.latestAssistantMessageId,
        publicTextLength:p.nativeContinuation?.latestPublicAssistantText?.length??null})):[]}};
    if(proof) {
      if(event.sourceUserMessageId!==proof.sourceUserMessageId)return{pages:null,newUser:true,newUserMessageId:event.sourceUserMessageId};
      if(['conversationId','runtimeKey','pageTargetId','assistantMessageId','assistantCreatedAt','assistantTextHash']
        .some(field=>event[field]!==proof[field]))return{pages:null,inspectionReason:'native-final-boundary-changed'};
    }
    return{event,pages:[{conversationId:event.conversationId,runtimeKey:event.runtimeKey,pageTargetId:event.pageTargetId,
      latestUserMessageId:event.sourceUserMessageId,latestAssistantMessageId:event.assistantMessageId,
      nativeFinalReceipt:{...event},candidate:{runtimePort:event.port,pageTargetId:event.pageTargetId}}]};
  }
}
