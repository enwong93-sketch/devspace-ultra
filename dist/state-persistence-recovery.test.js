import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { PlanRuntime } from './plan-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

function poisonQueue(owner, message) {
  const failed = Promise.reject(new Error(message));
  failed.catch(() => {});
  owner.persistQueue = failed;
}

test('Goal and Plan state persistence recover after a rejected predecessor queue', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-state-persistence-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const goal = new GoalRuntime({ stateDir: root });
  const started = await goal.start({
    conversationId: 'conversation-persist-recovery',
    objective: 'Preserve Goal state after one failed persistence attempt',
    successCriteria: ['A later save survives reload'],
  });
  poisonQueue(goal, 'previous Goal write failed');
  const reported = await goal.turnReport({ goalId: started.id, summary: 'Recovered write', meaningfulProgress: true });
  assert.equal(reported.roundState, 'reported');
  assert.equal(goal.persistFailureCount, undefined, 'the previous rejected queue is not misreported as the current write failing');
  await goal.close();
  const reloadedGoal = new GoalRuntime({ stateDir: root });
  assert.equal((await reloadedGoal.status(started.id)).roundState, 'reported');
  await reloadedGoal.close();

  const plan = new PlanRuntime({ stateDir: root });
  const initialPlan = await plan.start({
    conversationId: 'conversation-persist-recovery',
    title: 'Persistence recovery',
    steps: [{ text: 'First', status: 'in_progress' }, { text: 'Second', status: 'pending' }],
  });
  poisonQueue(plan, 'previous Plan write failed');
  const updated = await plan.update({
    planId: initialPlan.id,
    steps: [{ id: initialPlan.steps[0].id, text: 'First', status: 'completed' },
      { id: initialPlan.steps[1].id, text: 'Second', status: 'in_progress' }],
    explanation: 'Recovered after predecessor failure',
  });
  assert.equal(updated.revision, 2);
  const reloadedPlan = new PlanRuntime({ stateDir: root });
  assert.equal((await reloadedPlan.status(initialPlan.id)).revision, 2);
});

test('pre-send journal failure releases the Goal lease and a later bounded retry sends exactly once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-pre-send-journal-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-09-22T13:00:00.000Z');
  let sends = 0;
  let page = {
    conversationId: 'conversation-pre-send-recovery',
    runtimeKey: 'main-06',
    pageTargetId: 'page-pre-send-recovery',
    chatMode: true,
    generating: true,
    streamStatus: 'IN_PROGRESS',
    latestMessageRole: 'user',
    latestUserMessageId: 'user-pre-send-recovery',
    latestAssistantMessageId: 'assistant-old',
    latestAssistantText: 'Old answer',
    safetyCheckVisible: false,
    deliveryTimeoutVisible: false,
    retryVisible: false,
  };
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const goal = await runtime.start({
    conversationId: page.conversationId,
    objective: 'Recover safely from a pre-send journal failure',
    successCriteria: ['Never send before the journal is durable'],
  });
  const reported = await runtime.turnReport({ goalId: goal.id, summary: 'Ready for continuation', meaningfulProgress: true });
  const driver = new GoalContinuationSupervisor({
    goalRuntime: runtime,
    statePath: join(root, 'driver.json'),
    now: () => now,
    settleMs: 10,
    inspect: async () => [structuredClone(page)],
    dispatch: async () => {
      sends += 1;
      return { ok: true, dispatchCommitted: true, backgroundAccepted: true, visibleUserMessage: false, composerMutation: false };
    },
  });
  t.after(async () => { await driver.close(); await runtime.close(); });
  await driver.arm(reported);
  page = { ...page, generating: false, streamStatus: 'COMPLETE', latestMessageRole: 'assistant',
    latestAssistantMessageId: 'assistant-final', latestAssistantText: 'Final report' };
  now += 100;
  await driver.pollOnce();

  const realSave = driver.save.bind(driver);
  let injected = false;
  driver.save = async () => {
    const row = driver.records.get(reported.continuation.continuationId);
    if (!injected && row?.state === 'dispatching') {
      injected = true;
      throw new Error('injected pre-send journal failure');
    }
    return realSave();
  };
  now += 100;
  await driver.pollOnce();
  assert.equal(sends, 0, 'host transport is never called before a durable pre-send journal');
  assert.equal((await runtime.status(goal.id)).continuation.state, 'pending', 'exclusive lease is released after the failed journal');
  let row = driver.status().records[0];
  assert.equal(row.state, 'waiting');
  assert.equal(row.reason, 'pre-send-journal-persist-failed');

  now += 5_100;
  await driver.pollOnce();
  row = driver.status().records[0];
  assert.equal(sends, 1);
  assert.equal(row.state, 'delivered');
  assert.equal((await runtime.status(goal.id)).round, 2);
  now += 60_000;
  await driver.pollOnce();
  assert.equal(sends, 1, 'recovery never duplicates the committed send');
});
