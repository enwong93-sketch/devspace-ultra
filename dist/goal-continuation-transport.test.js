import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationProgressLivenessCdpAdapter } from './conversation-progress-liveness-cdp.js';
import { readComposerDraft } from './classic-composer-draft.js';

const conversationId='conversation-transport-test';
const target={id:'page-canary',type:'page',url:`https://chatgpt.com/c/${conversationId}`,webSocketDebuggerUrl:'ws://fake-test-page'};
const input={conversationId,sourceUserId:'user-1',assistantMessageId:'assistant-1',target:{exact:true,conversationId,runtimeKey:'main-06',port:9736,target:{runtimeKey:'main-06',port:9736,targetId:target.id,url:target.url,webSocketDebuggerUrl:target.webSocketDebuggerUrl}}};
function make({first={ok:true},loseClickAck=false}={}) {
  const calls=[]; const expressions=[]; let index=0;
  const adapter=new ConversationProgressLivenessCdpAdapter({runtimeKeys:['main-06'],listTargets:async()=>[target],sleep:async()=>{},
    connect:async()=>({evaluate:async expression=>{
      expressions.push(expression); index++;
      if(index===1)return first;
      if(index===2&&loseClickAck)throw new Error('CDP acknowledgement lost after click');
      return {ok:true,state:'visible'};
    },call:async(method,args)=>{calls.push({method,args});return{};},close(){} }),
  });
  return {adapter,calls,expressions};
}
test('Goal continuation is minimal, exact-source gated, and verified after send',async()=>{
  const h=make(); const result=await h.adapter.sendGoalContinuation(input);
  assert.equal(result.ok,true);assert.equal(result.visibilityVerified,true);
  assert.deepEqual(h.calls,[{method:'Input.insertText',args:{text:'- 繼續'}}]);
  assert.match(h.expressions[0],/goalBoundary\.sourceUserId/);
  assert.match(h.expressions[1],/route-changed-before-send/);
  assert.match(h.expressions[1],/inserted !== expectedText/);
});
test('protected draft prevents typing or clicking',async()=>{
  const h=make({first:{ok:false,state:'composer-not-empty'}});
  const result=await h.adapter.sendGoalContinuation(input);
  assert.equal(result.dispatchCommitted,false); assert.equal(h.calls.length,0);
});
test('click acknowledgement loss is uncertain, never safe-to-retry',async()=>{
  const h=make({loseClickAck:true}); const result=await h.adapter.sendGoalContinuation(input);
  assert.equal(result.ok,false);assert.equal(result.definiteFailure,false);assert.equal(result.dispatchCommitted,true);
  assert.equal(h.calls.length,1);
});
test('missing source boundary is rejected before connection',async()=>{
  const h=make();const result=await h.adapter.sendGoalContinuation({...input,sourceUserId:null});
  assert.equal(result.ok,false);assert.equal(h.calls.length,0);assert.equal(h.expressions.length,0);
});
test('plain typed text and non-text attachments are not mistaken for empty composer',()=>{
  assert.equal(readComposerDraft({tagName:'TEXTAREA',value:' user draft '}),'user draft');
  const cloned={textContent:'',querySelectorAll:()=>[],querySelector:()=>({type:'attachment'})};
  assert.equal(readComposerDraft({tagName:'DIV',cloneNode:()=>cloned}),null);
});
test('only recognized app mention nodes may be ignored and live editor is untouched',()=>{
  let liveMutated=false;
  const cloned={textContent:'DevSpace Local Gateway ',querySelectorAll:selector=>{
    assert.match(selector,/data-symbol="ecosystemMention"/);
    return[{remove:()=>{cloned.textContent='';}}];
  },querySelector:()=>null};
  const editor={tagName:'DIV',cloneNode:()=>cloned,remove:()=>{liveMutated=true;}};
  assert.equal(readComposerDraft(editor),'');assert.equal(liveMutated,false);
});
