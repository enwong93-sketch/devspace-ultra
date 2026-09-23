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
  if (options.skipArm !== true) await driver.arm(reported);
  t.after(async () => { await driver.close(); await runtime.close(); await rm(root, {recursive:true,force:true}); });
  return { root, driver, runtime, g, reported, config, sends: () => sends, sentPayloads,
    setPages: v => { pages = v; }, page: () => pages[0],
    final: () => { pages = pages.map(p => ({...p,generating:false,latestMessageRole:'assistant',latestAssistantMessageId:'assistant-new',latestAssistantText:'New final report'})); },
    tick: async () => { now += 100; return driver.pollOnce(); }, advanceTime: n => { now += n; } };
}

function nativePageForReported(h, overrides = {}) {
  const reportedAtMs = Date.parse(h.reported.lastRoundReport.reportedAt);
  const sourceUserCreatedAt = new Date(reportedAtMs - 2_000).toISOString();
  const finalCreatedAt = new Date(reportedAtMs + 2_000).toISOString();
  return {
    ...h.page(),
    generating: false,
    streamStatus: 'COMPLETE',
    latestMessageRole: 'assistant',
    latestAssistantMessageId: 'assistant-missing-arm-final',
    latestAssistantText: 'A visible final produced after the Goal report gate.',
    assistantBeforeLatestUserMessageId: 'assistant-before-source-user',
    nativeContinuation: {
      resolved: true,
      currentNodeId: 'assistant-missing-arm-final',
      currentMessageId: 'assistant-missing-arm-final',
      currentRole: 'assistant',
      currentStatus: 'finished_successfully',
      currentEndTurn: true,
      currentCreatedAt: finalCreatedAt,
      latestUserMessageId: 'user-a',
      latestUserCreatedAt: sourceUserCreatedAt,
      previousUserMessageId: 'user-before-source',
      previousUserCreatedAt: new Date(reportedAtMs - 10_000).toISOString(),
      assistantBeforeLatestUserMessageId: 'assistant-before-source-user',
      assistantBeforeLatestUserStatus: 'finished_successfully',
      assistantBeforeLatestUserEndTurn: true,
      assistantBeforeLatestUserCreatedAt: new Date(reportedAtMs - 5_000).toISOString(),
      latestAssistantMessageId: 'assistant-missing-arm-final',
      latestAssistantStatus: 'finished_successfully',
      latestAssistantEndTurn: true,
      latestAssistantCreatedAt: finalCreatedAt,
    },
    ...overrides,
  };
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

test('a reported pending Goal with no journal row self-heals from the exact completed final', async t => {
  const h = await harness(t, { skipArm: true });
  assert.equal(h.driver.status().records.length, 0, 'simulate report-time source capture failing before a journal row exists');
  h.setPages([nativePageForReported(h, { streamStatus: 'IN_PROGRESS' })]);
  await h.tick();
  assert.equal(h.sends(), 0, 'the recovered boundary is journaled before any hidden transport');
  assert.equal(h.driver.status().records.length, 1);
  assert.equal(h.driver.status().records[0].recoveredMissingArm, true);
  assert.equal(h.driver.status().records[0].reason, 'recovered-missing-arm-current-final');
  await h.tick();
  assert.equal(h.sends(), 1);
  const goal = await h.runtime.status(h.g.id);
  assert.equal(goal.round, 2);
  assert.equal(goal.roundState, 'working');
  assert.equal(h.driver.status().recoveredMissingArmCount, 1);
  await h.tick();
  assert.equal(h.sends(), 1, 'the self-healed continuation remains exactly once');
});

test('a report-time source inspection failure is retried by the durable pending-Goal scan', async t => {
  const h = await harness(t, { skipArm: true });
  const originalInspect = h.driver.inspect;
  let failArmInspection = true;
  h.driver.inspect = async (...args) => {
    if (failArmInspection) throw new Error('injected report-time CDP timeout');
    return originalInspect(...args);
  };
  const arm = await h.driver.arm(h.reported);
  assert.equal(arm.armed, false);
  assert.equal(arm.reason, 'source-boundary-inspection-failed');
  assert.match(h.driver.status().lastArmError, /injected report-time CDP timeout/);
  assert.equal(h.driver.status().records.length, 0);

  failArmInspection = false;
  const reportedAtMs = Date.parse(h.reported.lastRoundReport.reportedAt);
  const sourceCreatedAt = new Date(reportedAtMs - 2_000).toISOString();
  h.setPages([{
    ...h.page(),
    nativeContinuation: {
      resolved: true,
      currentNodeId: 'assistant-partial',
      currentMessageId: 'assistant-partial',
      currentRole: 'assistant',
      currentStatus: 'in_progress',
      currentEndTurn: false,
      currentCreatedAt: new Date(reportedAtMs + 1_000).toISOString(),
      latestUserMessageId: 'user-a',
      latestUserCreatedAt: sourceCreatedAt,
      previousUserMessageId: 'user-before-source',
      previousUserCreatedAt: new Date(reportedAtMs - 10_000).toISOString(),
      assistantBeforeLatestUserMessageId: 'assistant-old',
      assistantBeforeLatestUserStatus: 'finished_successfully',
      assistantBeforeLatestUserEndTurn: true,
      assistantBeforeLatestUserCreatedAt: new Date(reportedAtMs - 5_000).toISOString(),
      latestAssistantMessageId: 'assistant-partial',
      latestAssistantStatus: 'in_progress',
      latestAssistantEndTurn: false,
      latestAssistantCreatedAt: new Date(reportedAtMs + 1_000).toISOString(),
    },
  }]);
  await h.tick();
  assert.equal(h.driver.status().records[0].recoveredMissingArm, true);
  assert.equal(h.driver.status().records[0].state, 'waiting');
  assert.equal(h.driver.status().records[0].reason, 'awaiting-current-final');
  h.setPages([nativePageForReported(h)]);
  await h.tick();
  await h.tick();
  assert.equal(h.sends(), 1);
  assert.equal((await h.runtime.status(h.g.id)).round, 2);
});

test('a replacement Core discovers a pending Goal whose arm journal was never created', async t => {
  const h = await harness(t, { skipArm: true });
  await h.driver.close();
  h.setPages([nativePageForReported(h, { streamStatus: 'IN_PROGRESS' })]);
  const restarted = new GoalContinuationSupervisor(h.config);
  await restarted.pollOnce();
  h.advanceTime(100);
  await restarted.pollOnce();
  assert.equal(h.sends(), 1);
  assert.equal((await h.runtime.status(h.g.id)).round, 2);
  assert.equal(restarted.status().records[0].recoveredMissingArm, true);
  assert.equal(restarted.status().recoveredMissingArmCount, 1);
  await restarted.close();
});

test('a new exact human turn redeems an unjournaled pending continuation without a hidden resend', async t => {
  const h = await harness(t, { skipArm: true });
  const reportedAtMs = Date.parse(h.reported.lastRoundReport.reportedAt);
  const finalCreatedAt = new Date(reportedAtMs + 2_000).toISOString();
  const userCreatedAt = new Date(reportedAtMs + 4_000).toISOString();
  h.setPages([nativePageForReported(h, {
    generating: true,
    latestMessageRole: 'user',
    latestUserMessageId: 'user-next-round',
    previousUserMessageId: 'user-a',
    latestAssistantMessageId: 'assistant-missing-arm-final',
    assistantBeforeLatestUserMessageId: 'assistant-missing-arm-final',
    nativeContinuation: {
      resolved: true,
      currentNodeId: 'user-next-round',
      currentMessageId: 'user-next-round',
      currentRole: 'user',
      currentStatus: 'finished_successfully',
      currentEndTurn: false,
      currentCreatedAt: userCreatedAt,
      latestUserMessageId: 'user-next-round',
      latestUserCreatedAt: userCreatedAt,
      previousUserMessageId: 'user-a',
      previousUserCreatedAt: new Date(reportedAtMs - 2_000).toISOString(),
      assistantBeforeLatestUserMessageId: 'assistant-missing-arm-final',
      assistantBeforeLatestUserStatus: 'finished_successfully',
      assistantBeforeLatestUserEndTurn: true,
      assistantBeforeLatestUserCreatedAt: finalCreatedAt,
      latestAssistantMessageId: 'assistant-missing-arm-final',
      latestAssistantStatus: 'finished_successfully',
      latestAssistantEndTurn: true,
      latestAssistantCreatedAt: finalCreatedAt,
    },
  })]);
  await h.tick();
  assert.equal(h.sends(), 0);
  const goal = await h.runtime.status(h.g.id);
  assert.equal(goal.round, 2);
  assert.equal(goal.roundBeganAt, userCreatedAt);
  const record = h.driver.status().records[0];
  assert.equal(record.reason, 'human-user-turn-started-next-round');
  assert.equal(record.deliveryMode, 'human-user-continuation');
  assert.equal(record.redeemed, true);
  assert.equal(record.recoveredMissingArm, true);
});

test('a completed assistant response to a later human turn is never mistaken for the reported-round final', async t => {
  const h = await harness(t, { skipArm: true });
  const reportedAtMs = Date.parse(h.reported.lastRoundReport.reportedAt);
  const reportFinalAt = new Date(reportedAtMs + 2_000).toISOString();
  const newUserAt = new Date(reportedAtMs + 4_000).toISOString();
  const laterAssistantAt = new Date(reportedAtMs + 6_000).toISOString();
  h.setPages([nativePageForReported(h, {
    latestUserMessageId: 'user-next-round-completed',
    previousUserMessageId: 'user-a',
    latestAssistantMessageId: 'assistant-human-response',
    latestAssistantText: 'A later assistant response to the human continuation.',
    assistantBeforeLatestUserMessageId: 'assistant-missing-arm-final',
    nativeContinuation: {
      resolved: true,
      currentNodeId: 'assistant-human-response',
      currentMessageId: 'assistant-human-response',
      currentRole: 'assistant',
      currentStatus: 'finished_successfully',
      currentEndTurn: true,
      currentCreatedAt: laterAssistantAt,
      latestUserMessageId: 'user-next-round-completed',
      latestUserCreatedAt: newUserAt,
      previousUserMessageId: 'user-a',
      previousUserCreatedAt: new Date(reportedAtMs - 2_000).toISOString(),
      assistantBeforeLatestUserMessageId: 'assistant-missing-arm-final',
      assistantBeforeLatestUserStatus: 'finished_successfully',
      assistantBeforeLatestUserEndTurn: true,
      assistantBeforeLatestUserCreatedAt: reportFinalAt,
      latestAssistantMessageId: 'assistant-human-response',
      latestAssistantStatus: 'finished_successfully',
      latestAssistantEndTurn: true,
      latestAssistantCreatedAt: laterAssistantAt,
    },
  })]);
  await h.tick();
  assert.equal(h.sends(), 0, 'the later assistant response must not trigger a hidden continuation');
  const goal = await h.runtime.status(h.g.id);
  assert.equal(goal.round, 2);
  assert.equal(goal.roundBeganAt, newUserAt);
  assert.equal(h.driver.status().records[0].deliveryMode, 'human-user-continuation');
});

test('an old final from before the report cannot self-heal a missing continuation journal', async t => {
  const h = await harness(t, { skipArm: true });
  const reportedAtMs = Date.parse(h.reported.lastRoundReport.reportedAt);
  const staleCreatedAt = new Date(reportedAtMs - 30_000).toISOString();
  const stale = nativePageForReported(h);
  stale.nativeContinuation.currentCreatedAt = staleCreatedAt;
  stale.nativeContinuation.latestAssistantCreatedAt = staleCreatedAt;
  h.setPages([stale]);
  await h.tick();
  assert.equal(h.sends(), 0);
  assert.equal(h.driver.status().records.length, 0);
  assert.equal((await h.runtime.status(h.g.id)).roundState, 'reported');
  assert.equal(h.driver.status().missingArmPending, 1);
});

test('divergent exact displays fail closed instead of choosing a missing-arm owner', async t => {
  const h = await harness(t, { skipArm: true });
  const first = nativePageForReported(h);
  const second = nativePageForReported(h, {
    pageTargetId: 'page-b',
    latestUserMessageId: 'other-user',
    nativeContinuation: {
      ...first.nativeContinuation,
      latestUserMessageId: 'other-user',
    },
  });
  h.setPages([first, second]);
  await h.tick();
  assert.equal(h.sends(), 0);
  assert.equal(h.driver.status().records.length, 0);
  assert.equal((await h.runtime.status(h.g.id)).roundState, 'reported');
});

test('temporary page loss after a committed hidden send does not poison later notification', async t => {
  let notifications = 0;
  const h = await harness(t, { onHiddenContinuationStarted: async () => { notifications += 1; } });
  const originalPages = h.driver.pages.bind(h.driver);
  const originalDispatch = h.driver.dispatch;
  let hidePages = false;
  h.driver.dispatch = async payload => {
    const result = await originalDispatch(payload);
    hidePages = true;
    return result;
  };
  h.driver.pages = async (...args) => hidePages ? null : originalPages(...args);
  h.final();
  await h.tick();
  await h.tick();
  assert.equal(h.sends(), 1);
  assert.equal((await h.runtime.status(h.g.id)).round, 2);
  assert.equal(h.driver.status().lastError, null);
  assert.equal(h.driver.status().records[0].hiddenEpisodeNotified, false);
  assert.equal(notifications, 0);

  hidePages = false;
  await h.tick();
  assert.equal(notifications, 1);
  assert.equal(h.driver.status().records[0].hiddenEpisodeNotified, true);
  assert.equal(h.sends(), 1, 'notification recovery never replays the hidden continuation');
});

test('old assistant text, latest user, safety state and generation never authorize dispatch', async t => {
  const h = await harness(t);
  h.setPages([{...h.page(),generating:false}]);
  await h.tick(); await h.tick(); assert.equal(h.sends(),0);
  h.final(); h.setPages([{...h.page(),safetyCheckVisible:true}]);
  await h.tick(); await h.tick(); assert.equal(h.sends(),0);
});

test('new human message supersedes hidden dispatch and starts the next Goal round', async t => {
  const h = await harness(t); h.final();
  h.setPages([{...h.page(), latestUserMessageId:'user-b'}]);
  await h.tick(); assert.equal(h.sends(),0);
  assert.equal(h.driver.status().records[0].state,'delivered');
  assert.equal(h.driver.status().records[0].reason,'human-user-turn-started-next-round');
  assert.equal((await h.runtime.status(h.g.id)).round,2);
  assert.equal((await h.runtime.status(h.g.id)).roundState,'working');
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

test('a new user before hidden assistant confirmation redeems the pending round without resend', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false,state:'ack-lost'})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  const observedAt=new Date(Date.parse(h.reported.lastRoundReport.reportedAt)+1_000).toISOString();
  h.setPages([{...h.page(),nativeContinuation:{
    resolved:true,
    sourceUserFound:true,
    baselineAssistantFound:true,
    latestUserMessageId:'user-new',
    newUserAfterBaselineMessageId:'user-new',
    newUserAfterBaselineIndex:0,
    newUserAfterBaselineCreatedAt:observedAt,
    newAssistantAfterBaselineMessageId:'assistant-too-late',
    newAssistantAfterBaselineIndex:1,
  }}]);
  await h.tick();
  assert.equal(h.driver.status().records[0].state,'delivered');
  assert.equal(h.driver.status().records[0].reason,'human-user-turn-started-next-round');
  assert.equal((await h.runtime.status(h.g.id)).round,2);
  assert.equal((await h.runtime.status(h.g.id)).roundBeganAt,observedAt);
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

test('new human input in either display starts the next round without hidden dispatch',async t=>{
  const h=await causalHarness(t);
  h.set([{...h.views()[0],latestUserMessageId:'brand-new-human-turn'},h.finish(h.views()[1])]);
  await h.tick();assert.equal(h.sends(),0);
  assert.equal(h.driver.status().records[0].state,'delivered');
  assert.equal((await h.runtime.status(h.g.id)).round,2);
});

test('restart repairs a legacy cancelled continuation when an exact new user already started', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false,state:'ack-lost'})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  const id=h.reported.continuation.continuationId;
  const row=h.driver.records.get(id);
  row.state='cancelled'; row.reason='new-user-turn-before-hidden-continuation';
  await h.driver.save(); await h.driver.close();
  const observedAt=new Date(Date.parse(h.reported.lastRoundReport.reportedAt)+1_000).toISOString();
  h.setPages([{...h.page(),nativeContinuation:{
    resolved:true,sourceUserFound:true,baselineAssistantFound:true,
    latestUserMessageId:'user-after-restart',
    newUserAfterBaselineMessageId:'user-after-restart',newUserAfterBaselineIndex:0,
    newUserAfterBaselineCreatedAt:observedAt,
    newAssistantAfterBaselineMessageId:null,newAssistantAfterBaselineIndex:-1,
  }}]);
  const restarted=new GoalContinuationSupervisor(h.config);
  await restarted.pollOnce();
  assert.equal((await h.runtime.status(h.g.id)).round,2);
  assert.equal((await h.runtime.status(h.g.id)).roundBeganAt,observedAt);
  assert.equal(restarted.status().records[0].state,'delivered');
  assert.equal(restarted.status().records[0].reason,'human-user-turn-started-next-round');
  assert.equal(h.sends(),1,'legacy recovery must never replay the hidden continuation');
  await restarted.close();
});

test('restart repairs the current human-started round boundary without replaying delivery', async t => {
  const h=await harness(t,{send:()=>({ok:false,dispatchCommitted:true,definiteFailure:false,state:'ack-lost'})});
  h.final(); await h.tick(); await h.tick(); assert.equal(h.sends(),1);
  const id=h.reported.continuation.continuationId;
  const row=h.driver.records.get(id);
  const observedAt=new Date(Date.parse(h.reported.lastRoundReport.reportedAt)+1_000).toISOString();
  // Simulate the pre-fix Core: it redeemed the real user turn at restart time
  // but did not preserve that user's native create_time.
  h.advanceTime(10_000);
  await h.runtime.roundBegin({goalId:h.g.id,continuationId:id});
  row.state='delivered'; row.reason='human-user-turn-started-next-round';
  row.redeemed=true; row.deliveryMode='human-user-continuation';
  row.manualUserMessageId='user-after-restart';
  delete row.manualUserObservedAt;
  await h.driver.save(); await h.driver.close();
  h.setPages([{...h.page(),nativeContinuation:{
    resolved:true,sourceUserFound:true,baselineAssistantFound:true,
    latestUserMessageId:'user-after-restart',
    newUserAfterBaselineMessageId:'user-after-restart',newUserAfterBaselineIndex:0,
    newUserAfterBaselineCreatedAt:observedAt,
    newAssistantAfterBaselineMessageId:null,newAssistantAfterBaselineIndex:-1,
  }}]);
  const restarted=new GoalContinuationSupervisor(h.config);
  await restarted.pollOnce();
  const repaired=await h.runtime.status(h.g.id);
  assert.equal(repaired.round,2);
  assert.equal(repaired.roundBeganAt,observedAt);
  assert.equal(restarted.records.get(id).manualUserObservedAt,observedAt);
  assert.equal(h.sends(),1,'round-boundary repair must not replay hidden delivery');
  await restarted.close();
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
