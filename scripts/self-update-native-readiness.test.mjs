import assert from 'node:assert/strict';
import { inspectNativeMaintenance } from './self-update-native-readiness.mjs';
const cid='conversation_fixture_123', uid='user_fixture_123', aid='assistant_fixture_123';
const createdAt=new Date(1000).toISOString();
const targets=[{ type:'page', id:'page123', url:`https://chatgpt.com/c/${cid}`, webSocketDebuggerUrl:'ws://fixture' }];
const page={ conversationId:cid, chatMode:true, runtimeKey:'main-01', pageTargetId:'page123',
  candidate:{runtimePort:9721}, nativeContinuation:{ resolved:true, conversationIdVerified:true,
    currentRole:'assistant', currentStatus:'finished_successfully', currentEndTurn:true,
    latestAssistantStatus:'finished_successfully', latestAssistantEndTurn:true,
    latestUserMessageId:uid, latestAssistantMessageId:aid, currentNodeId:aid, currentMessageId:aid,
    currentCreatedAt:createdAt, latestAssistantCreatedAt:createdAt, latestPublicAssistantText:'fixture final' }};
let reads=0, inventories=0;
const run = (overrides={}) => inspectNativeMaintenance([9721], {
  listTargets:async()=>targets, inspect:async()=>[structuredClone(page)], now:()=>2000, ...overrides });
assert.equal((await inspectNativeMaintenance([])).ready,false);
assert.equal((await inspectNativeMaintenance([9721,9721])).ready,false);
assert.equal((await inspectNativeMaintenance([1])).ready,false);
const good=await run({inspect:async()=>{reads++;return [structuredClone(page)]}});
assert.equal(good.ready,true); assert.equal(reads,2); assert.equal(good.atomicAdmissionBarrier,false);
assert.ok(!JSON.stringify(good).includes('fixture final'));
assert.equal((await run({listTargets:async()=>[]})).ready,false);
assert.equal((await run({listTargets:async()=>[{...targets[0],url:'https://chatgpt.com/'}]})).ready,false);
assert.equal((await run({listTargets:async()=>{inventories++;return inventories===1?targets:[{...targets[0],id:'other'}]}})).reason,'native-page-owner-changed');
for(const patch of [{currentEndTurn:false},{currentRole:'tool'},{currentStatus:'in_progress'},
  {conversationIdVerified:false},{currentNodeId:'older_fixture_123'},{latestPublicAssistantText:''}]){
  assert.equal((await run({inspect:async()=>[{...page,nativeContinuation:{...page.nativeContinuation,...patch}}]})).ready,false);
}
reads=0;
assert.equal((await run({inspect:async()=>{reads++;const p=structuredClone(page);
  if(reads===2)p.nativeContinuation.latestPublicAssistantText='different final';return[p]}})).reason,'native-current-turn-changed');
assert.equal((await run({inspect:async()=>{throw new Error('fixture unavailable')}})).ready,false);
console.log(JSON.stringify({ok:true,gate:'self-update-native-readiness',nativeFinalRequired:true,
  twoCurrentReadbacks:true,unknownDefers:true,productionChanged:false}));
