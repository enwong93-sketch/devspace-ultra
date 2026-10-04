import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

async function setup(t, mutate = () => {}) {
  const root=await mkdtemp(join(tmpdir(),'goal-moved-conversation-'));
  let now=Date.parse('2026-10-04T12:00:00Z');
  const runtime=new GoalRuntime({stateDir:root,now:()=>now});
  const goal=await runtime.start({conversationId:'conversation-moved-qa',objective:'Preserve original work across runtime move',successCriteria:['Actually reconcile native progress']});
  now+=1000;
  await runtime.turnReport({goalId:goal.id,summary:'Old physical turn ended',meaningfulProgress:true});
  const pending=await runtime.status(goal.id);
  const row={goalId:goal.id,conversationId:goal.conversationId,round:1,continuationId:pending.continuation.continuationId,
    sourceUserId:'old-user-source',finalAssistantId:'old-final-assistant',sourceRuntimeKey:'main-02',sourcePageTargetId:'old-page',
    dispatchRuntimeKey:'main-02',dispatchPageTargetId:'old-page',deliveryMode:'hidden-assistant-continuation',
    state:'uncertain',reason:'restart-during-send',sentAt:now,createdAt:now,attempts:1};
  now+=60000;
  const userAt=new Date(now-10000).toISOString(),assistantAt=new Date(now-5000).toISOString();
  let pages=[{conversationId:goal.conversationId,runtimeKey:'main-01',pageTargetId:'new-page',chatMode:true,candidate:{runtimePort:9721},
    // Contradictory display fields must not decide a native end_turn.
    generating:true,latestMessageRole:'user',streamStatus:'IN_PROGRESS',
    nativeContinuation:{resolved:true,sourceUserFound:true,baselineAssistantFound:true,
      currentRole:'assistant',currentStatus:'finished_successfully',currentEndTurn:true,
      currentNodeId:'new-native-final',currentMessageId:'new-native-final',currentCreatedAt:assistantAt,
      latestAssistantMessageId:'new-native-final',latestAssistantStatus:'finished_successfully',latestAssistantEndTurn:true,
      latestAssistantCreatedAt:assistantAt,latestPublicAssistantText:'Native completed summary',
      latestUserMessageId:'new-user-source',latestUserCreatedAt:userAt,newUserAfterBaselineIndex:0}}];
  mutate(pages,row);
  let sends=0, broadReads=0;
  const driver=new GoalContinuationSupervisor({goalRuntime:runtime,now:()=>now,pollMs:0,
    inspect:async (_goal,options)=>{if(options.runtimeKey||options.pageTargetId)return [];broadReads++;return structuredClone(pages);},
    dispatch:async()=>{sends++;throw new Error('No old dispatch may be replayed');}});
  await driver.ready;driver.records.set(row.continuationId,row);
  t.after(async()=>{await driver.close();await runtime.close();await rm(root,{recursive:true,force:true});});
  return {runtime,goal,row,driver,userAt,get sends(){return sends;},get broadReads(){return broadReads;},setPages(value){pages=value;},pages};
}

test('moved exact conversation reconciles a completed newer native user without resending or resetting the original Goal',async t=>{
  const h=await setup(t);await h.driver.pollOnce();
  const current=await h.runtime.status(h.goal.id);
  assert.equal(current.round,2);assert.equal(current.roundBeganAt,h.userAt);
  assert.equal(current.createdAt,h.goal.createdAt);assert.equal(current.objective,h.goal.objective);
  assert.equal(h.row.redeemed,true);assert.equal(h.row.deliveryMode,'human-user-continuation');
  assert.equal(h.row.dispatchPageTargetId,'old-page','historical dispatch target is not rewritten');
  assert.equal(h.sends,0);assert.equal(h.broadReads,2,'native boundary is reread before accounting changes');
});

for(const [name,mutate] of [
  ['active native turn',p=>{p[0].nativeContinuation.currentEndTurn=false;}],
  ['failed native turn',p=>{p[0].nativeContinuation.currentStatus='finished_error';}],
  ['missing old baseline',p=>{p[0].nativeContinuation.baselineAssistantFound=false;}],
  ['foreign conversation',p=>{p[0].conversationId='foreign-conversation';}],
  ['duplicate local pages',p=>{p.push(structuredClone(p[0]));}],
  ['unchanged source user',p=>{p[0].nativeContinuation.latestUserMessageId='old-user-source';}],
  ['safety-blocked native response',p=>{p[0].nativeSafetyBlocked=true;}],
  ['invalid runtime/port ownership',p=>{p[0].candidate.runtimePort=9732;}],
  ['old native snapshot',p=>{p[0].nativeContinuation.latestUserCreatedAt='2026-10-01T00:00:00Z';}],
]) test(`${name} cannot reconcile the old unknown dispatch`,async t=>{
  const h=await setup(t,mutate);await h.driver.pollOnce();
  assert.equal((await h.runtime.status(h.goal.id)).round,1);assert.notEqual(h.row.redeemed,true);assert.equal(h.sends,0);
});

test('a changed second native read defers migration without consuming the Goal',async t=>{
  const h=await setup(t);const inspect=h.driver.inspect;let reads=0;
  h.driver.inspect=async(g,o)=>{const p=await inspect(g,o);if(!o.runtimeKey&&!o.pageTargetId&&++reads===2)p[0].nativeContinuation.currentEndTurn=false;return p;};
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,1);assert.equal(h.sends,0);
});

test('uncertain native lookup is bounded by existing retry handling',async t=>{
  const h=await setup(t);h.driver.inspect=async(_g,o)=>{if(o.runtimeKey||o.pageTargetId)return [];throw new Error('native read timeout');};
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,1);
  assert.ok(h.row.retryAt);assert.equal(h.sends,0);
});

test('persist failure before native supersession cannot advance the Goal',async t=>{
  const h=await setup(t);h.driver.save=async()=>{throw new Error('fixture persistence failed');};
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,1);assert.equal(h.sends,0);
});

test('recovery after Goal consumption retains external provenance and never calls it automatic',async t=>{
  const h=await setup(t);
  h.row.externalNativeSupersession={userMessageId:'new-user-source',observedAt:h.userAt,assistantMessageId:'new-native-final'};
  await h.runtime.roundBegin({goalId:h.goal.id,continuationId:h.row.continuationId,roundBeganAt:h.userAt});
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,2);
  assert.equal(h.row.deliveryMode,'human-user-continuation');assert.equal(h.row.redeemed,true);assert.equal(h.sends,0);
});

test('retired original branch and completed newer canonical branch recover the observed forked case',async t=>{
  const h=await setup(t,p=>{
    const n=p[0].nativeContinuation;n.sourceUserFound=false;n.baselineAssistantFound=false;n.newUserAfterBaselineIndex=-1;
    n.sourceUserExistsInConversation=true;n.baselineAssistantExistsInConversation=true;
    n.baselineBranchLeaves={complete:true,leaves:[{id:'old-final-assistant',role:'assistant',status:'finished_successfully',endTurn:true}]};
  });
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,2);
  assert.equal(h.row.externalNativeSupersession.branchRelationship,'retired-native-branch-and-newer-canonical-final');
  assert.equal(h.sends,0);assert.equal(h.row.deliveryMode,'human-user-continuation');
});

for(const [name,change] of [
  ['unfinished old branch',n=>{n.baselineBranchLeaves.leaves[0].endTurn=false;}],
  ['active descendant of old baseline',n=>{n.baselineBranchLeaves.leaves.push({id:'active-old-child',role:'assistant',status:'in_progress',endTurn:false});}],
  ['incomplete old branch scan',n=>{n.baselineBranchLeaves.complete=false;}],
  ['missing old source in the conversation',n=>{n.sourceUserExistsInConversation=false;}],
])test(`${name} prevents canonical-branch rebase`,async t=>{
  const h=await setup(t,p=>{const n=p[0].nativeContinuation;n.sourceUserFound=false;n.baselineAssistantFound=false;n.newUserAfterBaselineIndex=-1;
    n.sourceUserExistsInConversation=true;n.baselineAssistantExistsInConversation=true;n.baselineBranchLeaves={complete:true,leaves:[{id:'old-final-assistant',role:'assistant',status:'finished_successfully',endTurn:true}]};change(n);});
  await h.driver.pollOnce();assert.equal((await h.runtime.status(h.goal.id)).round,1);assert.equal(h.sends,0);
});
