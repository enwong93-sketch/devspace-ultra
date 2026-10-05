import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as ingress from './classic-native-final-ingress.js';
import { GoalRuntime } from './goal-runtime.js';
import { ClassicGoalRoundCompletionGuard } from './goal-round-completion-guard.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';
import { ClassicGoalHostBridge } from './goal-host-bridge.js';
import { registerGoalTools } from './goal-tools.js';
import { ClassicTurnTransportTracker } from './classic-turn-transport-observer.js';

const at=Date.parse('2026-10-05T00:00:00Z'),cid='fixture-api-conversation';
const hash=s=>createHash('sha256').update(s).digest('hex');
function page({assistant='fixture-api-assistant',user='fixture-api-user',createdAt=at,...native}={}) {
  return {conversationId:cid,chatMode:true,runtimeKey:'main-07',pageTargetId:'fixture-api-page',candidate:{runtimePort:9737},
    // Contradictory/stale DOM indicators must not decide a native end_turn.
    generating:true,latestMessageRole:'user',latestAssistantText:'stale DOM text',
    nativeContinuation:{resolved:true,conversationIdVerified:true,currentRole:'assistant',currentStatus:'finished_successfully',
      currentEndTurn:true,latestAssistantStatus:'finished_successfully',latestAssistantEndTurn:true,
      latestUserMessageId:user,latestAssistantMessageId:assistant,currentNodeId:assistant,currentMessageId:assistant,
      currentCreatedAt:new Date(createdAt).toISOString(),latestAssistantCreatedAt:new Date(createdAt).toISOString(),
      latestUserCreatedAt:new Date(createdAt-100).toISOString(),
      latestPublicAssistantText:'fixture public final: objective still incomplete',...native}};
}
async function runtime(t) {
  const stateDir=await mkdtemp(join(tmpdir(),'goal-native-api-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const r=new GoalRuntime({stateDir,now:()=>at+1000});
  const g=await r.start({conversationId:cid,objective:'fixture three rounds',successCriteria:['fixture not yet done']});
  return {r,g,stateDir};
}
test('persisted stream completion retains the complete scoped receipt needed by the production host bridge',async t=>{
  const {r,g,stateDir}=await runtime(t);
  const proof={source:'native-assistant-turn-final',ingress:'native-response-stream',requestId:'fixture-native-request',
    conversationId:cid,runtimeKey:'main-07',port:9737,pageTargetId:'fixture-api-page',sourceUserMessageId:'fixture-api-user',
    assistantMessageId:'fixture-api-assistant',assistantTextHash:hash('fixture public final'),assistantCreatedAt:new Date(at+1000).toISOString(),
    status:'finished_successfully',endTurn:true,publicFinal:true,observedAtMs:at+1000};
  const closed=await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:proof});
  assert.equal(closed.continued,true);
  assert.equal(ingress.isNativeStreamFinalReceipt(closed.goal.lastTurnCompletion),true);
  const reloaded=new GoalRuntime({stateDir,now:()=>at+1000});
  assert.equal(ingress.isNativeStreamFinalReceipt((await reloaded.status(g.id)).lastTurnCompletion),true);
});
test('verified API final closes and arms an incomplete Goal without SSE, DOM idle or a progress report',async t=>{
  const {r,g,stateDir}=await runtime(t),boundaries=new ingress.ClassicNativeFinalBoundaryStore();
  let current=page({createdAt:at+1000}),dispatches=0;
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>at+2000,inspectPages:async()=>[current]});
  const inspectNativeFinal=(goal,row)=>api.inspect(goal,row);
  const supervisor=new GoalContinuationSupervisor({goalRuntime:r,statePath:join(stateDir,'driver.json'),now:()=>at+2000,
    settleMs:0,nativeFinalIngressOnly:true,publicMessageContinuation:true,inspectNativeFinal,
    inspect:async()=>{throw Error('DOM fallback forbidden');},dispatch:async()=>{dispatches++;return{ok:true,dispatchCommitted:true};}});
  t.after(()=>supervisor.close());
  const guard=new ClassicGoalRoundCompletionGuard({goalRuntime:r,nativeFinalIngressOnly:true,
    readNativeFinal:async goal=>(await api.inspect(goal))?.event||null,
    inspect:async()=>{throw Error('UI idle must not determine final');},dispatch:async()=>{throw Error('Rescue must not run');},
    continueIncompleteGoal:async({goal,nativeCompletion})=>{
      const result=await r.autoCompleteAssistantTurn({goalId:goal.id,nativeCompletion});
      if(result.continued)await supervisor.arm(result.goal,{resume:true});
      return result;
    }});
  t.after(()=>guard.close());
  const result=await guard.pollOnce();
  assert.equal(result.autoContinued,1);
  const closed=await r.status(g.id);
  assert.equal(closed.roundState,'reported');
  assert.equal(closed.lastRoundReport,null);
  assert.equal(ingress.isNativeCompletedFinalReceipt(closed.lastTurnCompletion),true);
  assert.equal(supervisor.status().records.length,1);
  const bridge=new ClassicGoalHostBridge({inspectNativeFinal});
  assert.equal(await bridge.hasNativeFinalBoundary({goalId:g.id,conversationId:cid,runtimePort:9737,
    expectedPageTargetId:'fixture-api-page',sourceUserId:'fixture-api-user',assistantMessageId:'fixture-api-assistant',
    nativeCompletionProof:closed.lastTurnCompletion}),true);
  current=page({createdAt:at+1000,currentEndTurn:false});
  assert.equal(await bridge.hasNativeFinalBoundary({goalId:g.id,conversationId:cid,runtimePort:9737,
    sourceUserId:'fixture-api-user',assistantMessageId:'fixture-api-assistant',nativeCompletionProof:closed.lastTurnCompletion}),null);
  assert.equal(dispatches,0,'a new working native turn is never interrupted');
});
for(const [name,change] of [['unverified conversation',{conversationIdVerified:false}],['unfinished',{currentEndTurn:false}],
  ['failed',{currentStatus:'finished_error'}],['commentary/no public final',{latestPublicAssistantText:null}],
  ['different native branch',{currentNodeId:'another-native-node'}]]){
  test(`API ingress rejects ${name}`,()=>assert.equal(ingress.nativeApiFinalFromPages({conversationId:cid},[page(change)],
    {readStartedAtMs:at,observedAtMs:at+1000}),null));
}
test('a new physical turn arriving during API read invalidates the sampled old final',async()=>{
  const boundaries=new ingress.ClassicNativeFinalBoundaryStore();
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>at+2000,inspectPages:async()=>{
    boundaries.noteTurn({kind:'started',runtimeKey:'main-07',pageTargetId:'fixture-api-page',conversationId:cid,
      requestId:'fixture-new-request',sourceUserMessageId:'fixture-new-user',observedAtMs:at+2000});
    return[page()];
  }});
  assert.equal((await api.inspect({conversationId:cid})).pages,null);
});
test('a provisional first-chat request cannot revive the old conversation final',async()=>{
  const boundaries=new ingress.ClassicNativeFinalBoundaryStore();
  boundaries.noteTurn({kind:'started',runtimeKey:'main-07',pageTargetId:'fixture-api-page',conversationId:null,
    requestId:'fixture-provisional-request',sourceUserMessageId:'fixture-new-user',observedAtMs:at+1000});
  let current=page();
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>at+2000,inspectPages:async()=>[current]});
  assert.equal((await api.inspect({conversationId:cid})).pages,null);
  current=page({user:'fixture-new-user',createdAt:at+1500});
  assert.equal((await api.inspect({conversationId:cid})).event.sourceUserMessageId,'fixture-new-user');
});
test('native API read failures remain nonterminal and are bounded by the per-round poll interval',async t=>{
  const {r}=await runtime(t);let reads=0,clock=at+2000;
  const guard=new ClassicGoalRoundCompletionGuard({goalRuntime:r,nativeFinalIngressOnly:true,now:()=>clock,
    readNativeFinal:async()=>{reads++;throw Error('fixture transient native read failure');},
    inspect:async()=>{throw Error('DOM fallback forbidden');},dispatch:async()=>{throw Error('Rescue must not run');}});
  t.after(()=>guard.close());
  assert.equal((await guard.pollOnce()).results[0].reason,'native-api-read-unavailable');
  for(let i=0;i<5;i++)await guard.pollOnce();
  assert.equal(reads,1);
  clock+=10000;await guard.pollOnce();assert.equal(reads,2);
});

test('an already-consumed native final uses idle cadence; exact transport hints wake reads without closing a turn',async t=>{
  const {r,g}=await runtime(t);let clock=at+2000,reads=0,current=true;
  const event=ingress.nativeApiFinalFromPages(g,[page()],{readStartedAtMs:clock,observedAtMs:clock});
  await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:event});
  const before=await r.status(g.id);
  const guard=new ClassicGoalRoundCompletionGuard({goalRuntime:r,nativeFinalIngressOnly:true,now:()=>clock,
    readNativeFinal:async()=>{reads++;return current?event:null;},
    continueIncompleteGoal:async({goal,nativeCompletion})=>r.autoCompleteAssistantTurn({goalId:goal.id,nativeCompletion}),
    inspect:async()=>{throw Error('No DOM final inference');},dispatch:async()=>{throw Error('No Rescue/send');}});
  t.after(()=>guard.close());
  await guard.pollOnce();clock+=10000;await guard.pollOnce();assert.equal(reads,1);
  await guard.noteNativeTransportHint({kind:'finished'});await guard.pollOnce();assert.equal(reads,1);
  await guard.noteNativeTransportHint({kind:'started',conversationId:'fixture-foreign'});
  await guard.pollOnce();assert.equal(reads,1);
  current=false;
  await guard.noteNativeTransportHint({kind:'finished',conversationId:cid});
  assert.deepEqual(await r.status(g.id),before,'EOF is a scheduling hint, not turn-completion evidence');
  await guard.pollOnce();assert.equal(reads,2);
  clock+=10000;await guard.pollOnce();assert.equal(reads,3,'incomplete native input keeps normal working cadence');
  assert.deepEqual(await r.status(g.id),before);
});

test('a native activity hint during a duplicate-final read cannot be overwritten by idle backoff',async t=>{
  const {r,g}=await runtime(t);let clock=at+2000,reads=0;
  const event=ingress.nativeApiFinalFromPages(g,[page()],{readStartedAtMs:clock,observedAtMs:clock});
  await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:event});
  let guard;
  guard=new ClassicGoalRoundCompletionGuard({goalRuntime:r,nativeFinalIngressOnly:true,now:()=>clock,
    readNativeFinal:async()=>{reads++;if(reads===1)await guard.noteNativeTransportHint({kind:'resumed',conversationId:cid});return event;},
    continueIncompleteGoal:async({goal,nativeCompletion})=>r.autoCompleteAssistantTurn({goalId:goal.id,nativeCompletion}),
    inspect:async()=>{throw Error('No DOM');},dispatch:async()=>{throw Error('No send');}});
  t.after(()=>guard.close());
  await guard.pollOnce();await guard.pollOnce();assert.equal(reads,2);
});
test('a delayed CDP request callback fences by its native wallTime rather than rejecting an already completed real turn',async()=>{
  const boundaries=new ingress.ClassicNativeFinalBoundaryStore();
  const tracker=new ClassicTurnTransportTracker({now:()=>at+6000,onActiveTurn:event=>boundaries.noteTurn({...event,
    runtimeKey:'main-07',pageTargetId:'fixture-api-page',port:9737})});
  tracker.noteRequest({requestId:'fixture-late-cdp',wallTime:at/1000,request:{method:'POST',
    url:'https://chatgpt.com/backend-api/f/conversation',postData:JSON.stringify({conversation_id:cid,
      messages:[{id:'fixture-api-user',author:{role:'user'}}]})}});
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>at+7000,
    inspectPages:async()=>[page({createdAt:at+1000})]});
  assert.equal((await api.inspect({conversationId:cid})).event.assistantMessageId,'fixture-api-assistant');
});
test('three API-only rounds admit real assistant work before AI completion, without compatibility begin or a report',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'goal-api-three-rounds-'));let clock=at;
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const r=new GoalRuntime({stateDir,now:()=>clock});
  const g=await r.start({conversationId:cid,objective:'fixture three-round Goal',successCriteria:['fixture all three markers']});
  clock+=1000;let current=page({assistant:'fixture-api-round-1',createdAt:clock});
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries:new ingress.ClassicNativeFinalBoundaryStore(),
    now:()=>clock,inspectPages:async()=>[current]});
  const supervisor=new GoalContinuationSupervisor({goalRuntime:r,statePath:join(stateDir,'driver.json'),now:()=>clock,
    nativeFinalIngressOnly:true,publicMessageContinuation:true,settleMs:0,
    inspectNativeFinal:(goal,row)=>api.inspect(goal,row),inspect:async()=>{throw Error('DOM fallback forbidden');},
    dispatch:async()=>{throw Error('alternate sender forbidden');},
    readPublicWorkingTurn:async(goal,row)=>(await api.inspect(goal,{apiScope:{runtimeKey:row.dispatchRuntimeKey,
      pageTargetId:row.dispatchPageTargetId}})).started||null});
  t.after(()=>supervisor.close());
  const guard=new ClassicGoalRoundCompletionGuard({goalRuntime:r,nativeFinalIngressOnly:true,now:()=>clock,
    inspect:async()=>{throw Error('UI final forbidden');},dispatch:async()=>{throw Error('Rescue forbidden');},
    readNativeFinal:async goal=>{
      const sampled=await api.inspect(goal);
      if(sampled.started)await supervisor.notePublicMessageStarted(sampled.started);
      if(sampled.event)await supervisor.notePublicMessageFinal(sampled.event);
      return sampled.event||null;
    },continueIncompleteGoal:async({goal,nativeCompletion})=>{
      const closed=await r.autoCompleteAssistantTurn({goalId:goal.id,nativeCompletion});
      if(closed.continued)await supervisor.arm(closed.goal,{resume:true});
      return closed;
    }});
  t.after(()=>guard.close());
  await guard.pollOnce();await supervisor.pollOnce();await supervisor.pollOnce();
  const first=await supervisor.claimPublicMessage(g.id);assert.ok(first);
  clock+=11000;
  current=page({user:'fixture-api-user-2',assistant:'fixture-api-round-2',createdAt:clock,
    latestUserTextHash:hash(first.prompt),latestUserParentMessageId:'fixture-api-round-1',
    currentStatus:'in_progress',currentEndTurn:false,latestAssistantStatus:'in_progress',latestAssistantEndTurn:false});
  // This is a native assistant-start proof, never a completion proof.
  const working=await api.inspect(await r.status(g.id));
  assert.equal(ingress.isNativeCompletedFinalReceipt(working.started),false);
  assert.equal(await supervisor.reconcilePublicWorkingRound(await r.status(g.id)),true);
  assert.equal((await r.status(g.id)).round,2);
  assert.equal((await r.status(g.id)).roundState,'working');
  current=page({user:'fixture-api-user-2',assistant:'fixture-api-round-2',createdAt:clock,
    latestUserTextHash:hash(first.prompt),latestUserParentMessageId:'fixture-api-round-1'});
  await guard.pollOnce();await supervisor.pollOnce();await supervisor.pollOnce();
  const second=await supervisor.claimPublicMessage(g.id);assert.ok(second);
  clock+=11000;
  current=page({user:'fixture-api-user-3',assistant:'fixture-api-round-3',createdAt:clock,
    latestUserTextHash:hash(second.prompt),latestUserParentMessageId:'fixture-api-round-2',
    currentRole:'tool',currentMessageId:'fixture-api-tool',currentNodeId:'fixture-api-tool',currentEndTurn:false,
    latestAssistantEndTurn:false,latestAssistantStatus:'finished_successfully'});
  const tools=new Map();
  registerGoalTools({registerTool:(name,config,handler)=>{tools.set(name,handler);return{};}},r,{
    resourceUri:'ui://fixture/goal',relayResourceUri:'ui://fixture/relay',hostBridge:{continuationSupervisor:supervisor},
    resolveConversation:async()=>({conversationId:cid})});
  const completed=await tools.get('devspace_goal_complete')({goalId:g.id,
    evidence:[{criterionId:g.successCriteria[0].id,evidence:'unit fixture all three markers verified'}]},{});
  assert.notEqual(completed.isError,true);
  assert.equal((await r.status(g.id)).round,3);
  assert.equal((await r.status(g.id)).status,'completed');
  await guard.pollOnce();assert.equal(await supervisor.claimPublicMessage(g.id),null);
});
test('freshly validated native metadata repairs an older stripped receipt without consuming the final twice or resetting its clock',async t=>{
  const {r,g}=await runtime(t),proof=ingress.nativeApiFinalFromPages(g,[page({createdAt:at+1000})],
    {readStartedAtMs:at+1000,observedAtMs:at+1000});
  const first=await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:proof});
  const continuationId=first.goal.continuation.continuationId,completedAt=first.goal.lastTurnCompletion.completedAt;
  // Fixture-only simulation of the old serializer. Never opens live state.
  for(const key of ['ingress','port','status','endTurn','publicFinal','nativeConversationVerified','readStartedAtMs'])
    delete r.state.goals[g.id].lastTurnCompletion[key];
  const refreshed=await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:proof});
  assert.equal(refreshed.reason,'native-final-receipt-refreshed');
  assert.equal(refreshed.goal.round,1);assert.equal(refreshed.goal.continuation.continuationId,continuationId);
  assert.equal(refreshed.goal.lastTurnCompletion.completedAt,completedAt);
  assert.equal(ingress.isNativeCompletedFinalReceipt(refreshed.goal.lastTurnCompletion),true);
  assert.equal(r.state.nativeCompletionLedger[g.id].length,1);
  assert.equal((await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:proof})).continued,false);
});
test('an optional report cannot prevent the AI from marking its full objective completed with every criterion covered',async t=>{
  const {r,g}=await runtime(t);
  await r.turnReport({goalId:g.id,summary:'fixture checkpoint while work continues',meaningfulProgress:true});
  assert.equal((await r.status(g.id)).roundState,'reported');
  await assert.rejects(r.complete({goalId:g.id,evidence:[]}),/Missing evidence/);
  const done=await r.complete({goalId:g.id,evidence:[{criterionId:g.successCriteria[0].id,evidence:'fixture full-objective readback'}]});
  assert.equal(done.status,'completed');
  assert.equal((await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:ingress.nativeApiFinalFromPages(g,
    [page({createdAt:at+1000})],{readStartedAtMs:at+1000,observedAtMs:at+1000})})).continued,false);
});
test('a proof-scoped eligibility check reuses the sampler read only while the page is unchanged and recent',async()=>{
  const boundaries=new ingress.ClassicNativeFinalBoundaryStore();let clock=at+2000,reads=0,current=page({createdAt:at+1000});
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>clock,reuseMs:120_000,
    inspectPages:async()=>{reads++;return[current];}});
  const goal={conversationId:cid},proof=(await api.inspect(goal)).event,row={nativeCompletionProof:proof};
  assert.equal(reads,1);
  clock+=30_000;
  assert.equal((await api.inspect(goal,row,{reuseRecent:true})).event.assistantMessageId,'fixture-api-assistant');
  assert.equal(reads,1,'arm and advance do not compete with the sampler for the provider budget');
  await api.inspect(goal,row);assert.equal(reads,2,'a dispatch preflight always samples again');
  await api.inspect(goal);assert.equal(reads,3,'the sampler always samples again');
  clock+=120_001;await api.inspect(goal,row,{reuseRecent:true});assert.equal(reads,4,'reuse is bounded');
  boundaries.noteTurn({kind:'started',runtimeKey:'main-07',pageTargetId:'fixture-api-page',conversationId:cid,
    requestId:'fixture-next-request',sourceUserMessageId:'fixture-next-user',observedAtMs:clock});
  current=page({createdAt:at+1000,currentEndTurn:false});
  assert.equal((await api.inspect(goal,row,{reuseRecent:true})).pages,null,'a native request on the page ends reuse');
  assert.equal(reads,5);
});
test('a rate-limited read keeps the recent final; a resolved working branch discards it',async()=>{
  const boundaries=new ingress.ClassicNativeFinalBoundaryStore();let clock=at+2000,reads=0,current=page({createdAt:at+1000});
  const api=new ingress.ClassicNativeFinalApiIngress({boundaries,now:()=>clock,
    inspectPages:async()=>{reads++;return[current];}});
  const goal={conversationId:cid},row={nativeCompletionProof:(await api.inspect(goal)).event};
  current={...page(),nativeContinuation:{resolved:false,state:'conversation-fetch-429'}};
  assert.equal((await api.inspect(goal)).pages,null);
  assert.ok((await api.inspect(goal,row,{reuseRecent:true})).event);assert.equal(reads,2);
  current=page({createdAt:at+1000,currentEndTurn:false});
  await api.inspect(goal);
  assert.equal((await api.inspect(goal,row,{reuseRecent:true})).pages,null);assert.equal(reads,4);
});
test('a checkpoint for a round its native final already closed returns the unchanged Goal, not a content-less error',async t=>{
  const {r,g}=await runtime(t);
  const proof=ingress.nativeApiFinalFromPages(g,[page({createdAt:at+1000})],{readStartedAtMs:at+1000,observedAtMs:at+1000});
  await r.autoCompleteAssistantTurn({goalId:g.id,nativeCompletion:proof});
  const before=await r.status(g.id);assert.equal(before.roundState,'reported');
  const tools=new Map();
  registerGoalTools({registerTool:(name,config,handler)=>{tools.set(name,handler);return{};}},r,{
    resourceUri:'ui://fixture/goal',relayResourceUri:'ui://fixture/relay',resolveConversation:async()=>({conversationId:cid})});
  const result=await tools.get('devspace_goal_turn_report')({goalId:g.id,summary:'fixture late checkpoint',meaningfulProgress:true},{});
  assert.notEqual(result.isError,true);
  assert.equal(result.structuredContent.goal.id,g.id);
  assert.equal(result.structuredContent.goal.conversationId,cid);
  assert.deepEqual(await r.status(g.id),before,'nothing is recorded and no round or continuation changes');
});
