import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'devspace-goal-driver-test-'));
  let now = Date.now(); let sends = 0;
  const sentPayloads = [];
  let pages = [{ conversationId: 'conversation-canary', latestUserMessageId: 'user-a',
    latestMessageRole: 'user', latestAssistantMessageId: 'assistant-old', latestAssistantText: 'old answer',
    chatMode: true, generating: true, streamStatus: 'COMPLETE', pageTargetId: 'page-a' }];
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const g = await runtime.start({ conversationId: 'conversation-canary', objective: 'Test automatic Goal continuation', successCriteria: ['Deliver once only'] });
  const reported = await runtime.turnReport({ goalId: g.id, summary: 'test checkpoint', meaningfulProgress: true });
  const config = { goalRuntime: runtime, statePath: join(root, 'driver.json'), now: () => now, settleMs: 10,
    inspect: async () => structuredClone(pages), dispatch: async payload => {
      sends++; sentPayloads.push(structuredClone(payload));
      return options.send ? options.send(payload) : {
        ok: true,
        dispatchCommitted: true,
        backgroundAccepted: true,
        visibilityVerified: false,
        visibleUserMessage: false,
        composerMutation: false,
      };
    }, ...options };
  const driver = new GoalContinuationSupervisor(config);
  await driver.arm(reported);
  t.after(async () => { await driver.close(); await runtime.close(); await rm(root, {recursive:true,force:true}); });
  return { root, driver, runtime, g, reported, config, sends: () => sends, sentPayloads,
    setPages: v => { pages = v; }, page: () => pages[0],
    final: () => { pages = pages.map(p => ({...p,generating:false,latestMessageRole:'assistant',latestAssistantMessageId:'assistant-new',latestAssistantText:'New final report'})); },
    tick: async () => { now += 100; return driver.pollOnce(); }, advanceTime: n => { now += n; } };
}

test('report alone never sends; final boundary delivers once and redeems next round', async t => {
  const h = await harness(t);
  await h.tick(); assert.equal(h.sends(),0);
  h.final(); await h.tick(); assert.equal(h.sends(),0);
  await Promise.all([h.tick(),h.tick()]);
  assert.equal(h.sends(),1);
  assert.match(h.sentPayloads[0].prompt, /^\[DEVSPACE_GOAL_CONTINUATION\]/);
  assert.equal(h.sentPayloads[0].continuationId, h.reported.continuation.continuationId);
  assert.equal(typeof h.sentPayloads[0].leaseId, 'string');
  assert.equal(h.sentPayloads[0].round, 1);
  assert.equal(h.sentPayloads[0].reportedAt, h.reported.lastRoundReport.reportedAt);
  assert.equal(h.driver.status().records[0].reason, 'one-hidden-continuation');
  const goal = await h.runtime.status(h.g.id);
  assert.equal(goal.round,2); assert.equal(goal.roundState,'working');
  await h.tick(); assert.equal(h.sends(),1);
});

test('old assistant text, latest user, safety state and generation never authorize dispatch', async t => {
  const h = await harness(t);
  h.setPages([{...h.page(),generating:false}]);
  await h.tick(); await h.tick(); assert.equal(h.sends(),0);
  h.final(); h.setPages([{...h.page(),safetyCheckVisible:true}]);
  await h.tick(); await h.tick(); assert.equal(h.sends(),0);
});

test('new human message supersedes automatic continuation instead of injecting into their turn', async t => {
  const h = await harness(t); h.final();
  h.setPages([{...h.page(), latestUserMessageId:'user-b'}]);
  await h.tick(); assert.equal(h.sends(),0);
  assert.equal(h.driver.status().records[0].state,'cancelled');
});

test('pause or stop wins before dispatch; no blanket restart is required', async t => {
  const h = await harness(t); h.final(); await h.tick();
  await h.runtime.control({goalId:h.g.id,action:'pause'});
  await h.tick(); assert.equal(h.sends(),0);
});

test('uncertain committed delivery is never retried, including after lease expiry and restart', async t => {
  const h = await harness(t, { send: () => ({ok:false, dispatchCommitted:true, definiteFailure:false,state:'ack-lost'}) });
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  await h.driver.close(); h.advanceTime(120_000);
  const restarted = new GoalContinuationSupervisor(h.config);
  await restarted.pollOnce(); await restarted.close();
  assert.equal(h.sends(),1);
  assert.equal(restarted.status().records[0].state,'uncertain');
});

test('a definite unsent failure may retry after bounded backoff', async t => {
  let attempts = 0;
  const h = await harness(t, { send: () => ++attempts === 1 ? {ok:false,definiteFailure:true,dispatchCommitted:false,state:'composer-not-empty'} : {ok:true,visibilityVerified:true,dispatchCommitted:true} });
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  await h.tick(); assert.equal(h.sends(),1);
  h.advanceTime(5100); await h.tick(); assert.equal(h.sends(),2);
});

test('hidden acknowledgement loss reconciles from the native branch without a user message or resend', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false,state:'ack-lost'})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  assert.equal(h.driver.status().records[0].state,'uncertain');
  h.setPages([{...h.page(),nativeContinuation:{
    resolved:true,
    sourceUserFound:true,
    baselineAssistantFound:true,
    latestUserMessageId:'user-a',
    latestAssistantMessageId:'assistant-hidden',
    newUserAfterBaselineMessageId:null,
    newUserAfterBaselineIndex:-1,
    newAssistantAfterBaselineMessageId:'assistant-hidden',
    newAssistantAfterBaselineIndex:0,
  }}]);
  await h.tick();
  assert.equal(h.sends(),1);
  assert.equal((await h.runtime.status(h.g.id)).round,2);
  assert.equal(h.driver.status().records[0].state,'delivered');
  assert.equal(h.driver.status().records[0].redeemed,true);
  assert.equal(h.driver.status().records[0].reason,'uncertain-hidden-send-confirmed-by-native-branch');
});

test('a new user before hidden assistant confirmation cancels uncertain delivery', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false,state:'ack-lost'})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  h.setPages([{...h.page(),nativeContinuation:{
    resolved:true,
    sourceUserFound:true,
    baselineAssistantFound:true,
    latestUserMessageId:'user-new',
    newUserAfterBaselineMessageId:'user-new',
    newUserAfterBaselineIndex:0,
    newAssistantAfterBaselineMessageId:'assistant-too-late',
    newAssistantAfterBaselineIndex:1,
  }}]);
  await h.tick();
  assert.equal(h.driver.status().records[0].state,'cancelled');
  assert.equal(h.sends(),1);
});

test('legacy visible acknowledgement loss recovers by exact source-final-next-user sequence, never resending', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  h.driver.records.get(h.reported.continuation.continuationId).deliveryMode = null;
  h.setPages([{...h.page(),latestUserMessageId:'user-next',previousUserMessageId:'WRONG-user',
    assistantBeforeLatestUserMessageId:'assistant-new',latestUserText:'- 繼續',generating:true,latestMessageRole:'user'}]);
  await h.tick(); assert.equal(h.driver.status().records[0].state,'uncertain');
  h.setPages([{...h.page(),previousUserMessageId:'user-a'}]);
  await h.tick();
  assert.equal(h.sends(),1);assert.equal((await h.runtime.status(h.g.id)).round,2);
  assert.equal(h.driver.status().records[0].redeemed,true);
});

test('a completed persisted send cannot be sent again by another Core',async t=>{
  const h=await harness(t);h.final();await h.tick();await h.tick();await h.driver.close();
  const next=new GoalContinuationSupervisor(h.config);
  await next.pollOnce();await next.close();assert.equal(h.sends(),1);
});

test('pause arriving while the pre-send journal persists cancels the transport',async t=>{
  const h=await harness(t);const save=h.driver.save.bind(h.driver);
  h.driver.save=async()=>{
    await save();
    if(h.driver.status().records[0]?.state==='dispatching')await h.runtime.control({goalId:h.g.id,action:'pause'});
  };
  h.final();await h.tick();await h.tick();assert.equal(h.sends(),0);
  assert.equal(h.driver.status().records[0].state,'cancelled');
});

test('two displays of the same source and same final still send exactly once', async t => {
  const h = await harness(t); h.final();
  h.setPages([h.page(),{...h.page(),pageTargetId:'page-b'}]);
  await h.tick(); await h.tick(); assert.equal(h.sends(),1);
});

test('passive Core does not arm or dispatch', async t => {
  const h = await harness(t,{enabled:false}); h.final();
  await h.tick(); assert.equal(h.sends(),0); assert.equal(h.driver.status().records.length,0);
});

test('a current request receipt disambiguates a stale second display without choosing by activity alone',async t=>{
  const h=await harness(t);
  await h.driver.close();
  const config={...h.config,statePath:join(h.root,'receipt-driver.json')};
  const d=new GoalContinuationSupervisor(config);
  h.setPages([{...h.page(),runtimeKey:'main-01',latestUserMessageId:'stale-user'},
    {...h.page(),runtimeKey:'main-02',pageTargetId:'page-b'}]);
  const armed=await d.arm(h.reported,{reportAuthority:{pageVerified:true,
    source:'exact-progress-bootstrap-lease-page-verified',conversationId:h.reported.conversationId,runtimeKey:'main-02'}});
  assert.equal(armed.armed,true);
  h.final(); await d.pollOnce();h.advanceTime(100);await d.pollOnce();
  assert.equal(h.sends(),1);await d.close();
});

async function causalHarness(t,{bothAwaiting=false}={}) {
  const h=await harness(t);await h.driver.close();
  let views=[{...h.page(),runtimeKey:'main-01',latestUserMessageId:'stale-user',
    generating:bothAwaiting,latestMessageRole:bothAwaiting?'user':'assistant'},
    {...h.page(),runtimeKey:'main-02',pageTargetId:'page-b'}];
  h.setPages(views);
  const driver=new GoalContinuationSupervisor({...h.config,statePath:join(h.root,'causal-driver.json')});
  t.after(()=>driver.close());
  const armed=await driver.arm(h.reported);
  assert.equal(armed.armed,true);
  const set=(next)=>{views=next;h.setPages(views);};
  const finish=(page,id='assistant-current')=>({...page,generating:false,latestMessageRole:'assistant',
    latestAssistantMessageId:id,latestAssistantText:'A genuinely new final after the report'});
  return {...h,driver,views:()=>views,set,finish,
    tick:async()=>{h.advanceTime(100);return driver.pollOnce();}};
}

test('without an App receipt, divergent displays wait for one causal new final, never mere activity',async t=>{
  const h=await causalHarness(t);
  await h.tick();await h.tick();assert.equal(h.sends(),0);
  h.set([h.views()[0],h.finish(h.views()[1])]);
  await h.tick();await h.tick();assert.equal(h.sends(),1);
  assert.equal((await h.runtime.status(h.g.id)).round,2);
});

test('a previously completed stale display changing its old text is not a current final',async t=>{
  const h=await causalHarness(t);
  h.set([h.finish(h.views()[0],'old-final-rehydrated'),h.views()[1]]);
  await h.tick();await h.tick();assert.equal(h.sends(),0);
});

test('two unfinished branches cannot race to become the report owner',async t=>{
  const h=await harness(t); await h.driver.close();
  h.setPages([{...h.page(),runtimeKey:'main-01',latestUserMessageId:'other-unfinished-user'},
    {...h.page(),runtimeKey:'main-02',pageTargetId:'page-b'}]);
  const driver=new GoalContinuationSupervisor({...h.config,statePath:join(h.root,'ambiguous-driver.json')});
  t.after(()=>driver.close());
  const result=await driver.arm(h.reported);
  assert.equal(result.armed,false);
  assert.equal(result.reason,'ambiguous-unfinished-source-turns');
  await driver.pollOnce(); assert.equal(h.sends(),0);
});

test('new human input in either display cancels a waiting causal continuation',async t=>{
  const h=await causalHarness(t);
  h.set([{...h.views()[0],latestUserMessageId:'brand-new-human-turn'},h.finish(h.views()[1])]);
  await h.tick();assert.equal(h.sends(),0);
  assert.equal(h.driver.status().records[0].state,'cancelled');
});

test('stale display syncing to an already captured user does not masquerade as new input',async t=>{
  const h=await causalHarness(t);
  h.set([{...h.views()[0],latestUserMessageId:'user-a'},h.finish(h.views()[1])]);
  await h.tick();await h.tick();assert.equal(h.sends(),1);
});

test('a restart preserves causal baselines and still sends at most once',async t=>{
  const h=await causalHarness(t);await h.driver.close();
  h.set([h.views()[0],h.finish(h.views()[1])]);
  const restarted=new GoalContinuationSupervisor({...h.config,statePath:join(h.root,'causal-driver.json')});
  await restarted.pollOnce();h.advanceTime(100);await restarted.pollOnce();await restarted.pollOnce();
  await restarted.close();assert.equal(h.sends(),1);
});

test('journal dispatching at restart is quarantined rather than replayed', async t => {
  const h = await harness(t); await h.driver.close();
  const state=JSON.parse(await readFile(h.config.statePath,'utf8'));
  state.records[0].state='dispatching'; await writeFile(h.config.statePath,JSON.stringify(state));
  const restarted = new GoalContinuationSupervisor(h.config);
  await restarted.pollOnce(); await restarted.close(); assert.equal(h.sends(),0);
  assert.equal(restarted.status().records[0].state,'uncertain');
});
