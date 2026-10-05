import { createHash } from 'node:crypto';
import { nativeApiFinalFromPages } from './classic-native-final-ingress.js';

// Normalise a real successful native conversation response. Never accept a
// sidebar summary, HTTP finish alone, sender ACK or a caller-provided final.
export function nativeConversationResponseReceipt(payload, scope, times) {
  const ids=[payload?.id,payload?.conversation_id].filter(v=>v!=null);
  if (!payload || !ids.length || ids.some(v=>v!==scope?.conversationId)
    || !payload.mapping || typeof payload.current_node !== 'string') return null;
  const nodes=[];let key=payload.current_node;const seen=new Set();
  while(key && payload.mapping[key] && !seen.has(key) && seen.size<4096) {
    seen.add(key);const node=payload.mapping[key];
    if(node.message)nodes.push({key,node,message:node.message});
    key=node.parent;
  }
  const current=nodes[0],assistant=nodes.find(n=>n.message.author?.role==='assistant'),
    user=nodes.find(n=>n.message.author?.role==='user');
  if(!current || !assistant || !user || current!==assistant
    || current.key!==payload.current_node || current.message.id!==current.key
    || user.message.id!==user.key) return null;
  const m=assistant.message;
  const publicText=m.content?.content_type==='text' && Array.isArray(m.content.parts)
    && m.content.parts.every(p=>typeof p==='string')
    && (m.channel==null||m.channel==='final') && (m.metadata?.channel==null||m.metadata.channel==='final')
    && (m.recipient==null||m.recipient==='all') ? m.content.parts.join('\n').trim() : null;
  const iso=value=>Number.isFinite(value)&&value>0?new Date(value*1000).toISOString():null;
  const userText=user.message.content?.content_type==='text'&&Array.isArray(user.message.content.parts)
    && user.message.content.parts.every(p=>typeof p==='string')?user.message.content.parts.join('\n').trim():null;
  const page={conversationId:scope.conversationId,chatMode:true,runtimeKey:scope.runtimeKey,
    pageTargetId:scope.pageTargetId,candidate:{runtimePort:scope.port},nativeContinuation:{
      resolved:true,conversationIdVerified:true,currentNodeId:current.key,currentMessageId:m.id,
      currentRole:m.author.role,currentStatus:m.status,currentEndTurn:m.end_turn===true,
      currentCreatedAt:iso(m.create_time),latestAssistantMessageId:m.id,latestAssistantStatus:m.status,
      latestAssistantEndTurn:m.end_turn===true,latestAssistantCreatedAt:iso(m.create_time),
      latestPublicAssistantText:publicText,latestUserMessageId:user.message.id,
      latestUserTextHash:userText?createHash('sha256').update(userText).digest('hex'):null,
      latestUserParentMessageId:payload.mapping[user.node.parent]?.message?.id||null,
    }};
  return nativeApiFinalFromPages({conversationId:scope.conversationId},[page],times);
}
