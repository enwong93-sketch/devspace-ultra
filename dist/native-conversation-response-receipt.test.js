import assert from 'node:assert/strict';
import {nativeConversationResponseReceipt as receipt} from './native-conversation-response-receipt.js';
const at=Date.now(),cid='fixture-response-conversation',uid='fixture-response-user',aid='fixture-response-assistant';
const payload={id:cid,current_node:aid,mapping:{
 [uid]:{parent:null,message:{id:uid,author:{role:'user'},create_time:(at-2000)/1000,content:{content_type:'text',parts:['fixture user']}}},
 [aid]:{parent:uid,message:{id:aid,author:{role:'assistant'},create_time:(at-1000)/1000,status:'finished_successfully',end_turn:true,
   channel:'final',content:{content_type:'text',parts:['fixture final']}}},
}};
const scope={conversationId:cid,runtimeKey:'main-01',pageTargetId:'fixture-response-page',port:9721},
 times={readStartedAtMs:at,observedAtMs:at+1};
const good=receipt(payload,scope,times);assert.equal(good.assistantMessageId,aid);
assert.ok(!JSON.stringify(good).includes('fixture final'));
for(const patch of [{end_turn:false},{status:'in_progress'},{channel:'analysis'},{recipient:'tool'},
 {content:{content_type:'text',parts:[{text:'hidden'}]}}]) {
 const p=structuredClone(payload);Object.assign(p.mapping[aid].message,patch);assert.equal(receipt(p,scope,times),null);
}
assert.equal(receipt({...payload,id:'foreign-response-conversation'},scope,times),null);
assert.equal(receipt({...payload,current_node:uid},scope,times),null);
assert.equal(receipt({...payload,conversation_id:'foreign-response-conversation'},scope,times),null);
console.log(JSON.stringify({ok:true,gate:'native-response-final-receipt',nativeCurrentNodeRequired:true,explicitPublicFinalRequired:true,rawProseReturned:false}));
