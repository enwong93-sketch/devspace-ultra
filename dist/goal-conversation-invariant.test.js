import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devspace-goal-conversation-invariant-'));
  const runtime = new GoalRuntime({ stateDir: root });
  await runtime.ready;
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const input = label => ({
    objective: `${label} persistent objective`,
    successCriteria: [`${label} remains isolated`],
  });
  return { root, runtime, input };
}

test('one conversation accepts exactly one nonterminal Goal, including concurrent starts', async t => {
  const { runtime, input } = await fixture(t);
  const results = await Promise.allSettled([
    runtime.start({ conversationId: 'conversation-one-goal', ...input('A') }),
    runtime.start({ conversationId: 'conversation-one-goal', ...input('B') }),
  ]);
  const accepted = results.filter(row => row.status === 'fulfilled');
  const rejected = results.filter(row => row.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already has nonterminal Goal/);
  const existing = accepted[0].value;

  await runtime.control({ goalId: existing.id, action: 'pause' });
  await assert.rejects(
    () => runtime.start({ conversationId: 'conversation-one-goal', ...input('C') }),
    /already has nonterminal Goal.*paused/,
    'paused Goal still owns its conversation',
  );
  await runtime.control({ goalId: existing.id, action: 'stop' });
  const replacement = await runtime.start({ conversationId: 'conversation-one-goal', ...input('replacement') });
  assert.notEqual(replacement.id, existing.id);
});

test('bind and verified rebind refuse an occupied nonterminal conversation', async t => {
  const { runtime, input } = await fixture(t);
  const owner = await runtime.start({ conversationId: 'conversation-owned', ...input('owner') });
  const legacy = await runtime.start({ ...input('legacy') });
  await assert.rejects(
    () => runtime.bindConversation({ goalId: legacy.id, conversationId: 'conversation-owned' }),
    new RegExp(`already has nonterminal Goal ${owner.id}`),
  );

  const moving = await runtime.start({ conversationId: 'conversation-moving', ...input('moving') });
  await runtime.control({ goalId: owner.id, action: 'pause' });
  await assert.rejects(
    () => runtime.rebindConversation({
      goalId: moving.id,
      oldConversationId: 'conversation-moving',
      newConversationId: 'conversation-owned',
    }),
    /nonterminal Goal.*paused/,
  );
});

test('legacy conversation collisions fail closed for automatic Goal continuation and recovery', async t => {
  const { root, runtime, input } = await fixture(t);
  const first = await runtime.start({ conversationId: 'conversation-legacy-a', ...input('first') });
  const second = await runtime.start({ conversationId: 'conversation-legacy-b', ...input('second') });
  // Simulate a pre-invariant persisted collision. Production repair is explicit;
  // automatic dispatch must not guess which Goal owns the conversation.
  runtime.state.goals[second.id].conversationId = first.conversationId;
  await runtime.save();

  assert.equal(await runtime.hasConversationCollision({ goalId: first.id }), true);
  const collisions = await runtime.conversationCollisions();
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].conversationId, first.conversationId);
  assert.deepEqual(new Set(collisions[0].goals.map(goal => goal.id)), new Set([first.id, second.id]));
  assert.deepEqual(await runtime.recoverableWorkingRounds(), [],
    'same-round recovery must not run for either colliding Goal');

  const reported = await runtime.turnReport({ goalId: first.id, summary: 'legacy collision report', meaningfulProgress: true });
  let inspected = 0;
  const supervisor = new GoalContinuationSupervisor({
    goalRuntime: runtime,
    statePath: join(root, 'continuation-driver.json'),
    inspect: async () => { inspected += 1; return []; },
    dispatch: async () => { throw new Error('must not dispatch'); },
  });
  t.after(() => supervisor.close());
  const armed = await supervisor.arm(reported);
  assert.deepEqual(armed, { armed: false, reason: 'conversation-goal-conflict' });
  assert.equal(inspected, 0, 'conflict is rejected before page discovery');
});

test('verified legacy collision repair stops only older unprogressed duplicates', async t => {
  const { runtime, input } = await fixture(t);
  const stale = await runtime.start({ conversationId: 'conversation-stale-source', ...input('stale') });
  const keep = await runtime.start({ conversationId: 'conversation-repair-target', ...input('keep') });
  runtime.state.goals[stale.id].conversationId = keep.conversationId;
  runtime.state.goals[stale.id].roundRecovery = {
    state: 'dispatched', round: 1, recoveryId: 'recovery_1234567890abcdef', attempts: 1,
    claimedAt: stale.createdAt, dispatchedAt: stale.updatedAt, retryAfterAt: null,
  };
  await runtime.save();

  const result = await runtime.resolveConversationCollision({
    conversationId: keep.conversationId,
    keepGoalId: keep.id,
    reason: 'exact-page-overlay-selected-current-goal',
  });
  assert.equal(result.repaired, true);
  assert.equal(result.kept.id, keep.id);
  assert.deepEqual(result.stopped.map((goal) => goal.id), [stale.id]);
  const stopped = await runtime.status(stale.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.supersededByGoalId, keep.id);
  assert.equal(stopped.roundRecovery.state, 'idle');
  assert.equal((await runtime.status(keep.id)).status, 'active');
  assert.deepEqual(await runtime.conversationCollisions(), []);
});

test('legacy collision repair refuses any duplicate that already reported progress', async t => {
  const { runtime, input } = await fixture(t);
  const progressed = await runtime.start({ conversationId: 'conversation-progressed-source', ...input('progressed') });
  await runtime.turnReport({ goalId: progressed.id, summary: 'authoritative prior progress', meaningfulProgress: true });
  const keep = await runtime.start({ conversationId: 'conversation-progressed-target', ...input('keep') });
  runtime.state.goals[progressed.id].conversationId = keep.conversationId;
  await runtime.save();
  await assert.rejects(
    () => runtime.resolveConversationCollision({ conversationId: keep.conversationId, keepGoalId: keep.id }),
    /contain progressed or non-older state/,
  );
  assert.equal((await runtime.status(progressed.id)).status, 'active');
  assert.equal((await runtime.conversationCollisions()).length, 1);
});

console.log(JSON.stringify({
  ok: true,
  gate: 'goal-conversation-invariant',
  oneNonterminalGoalPerConversation: true,
  concurrentStartFailClosed: true,
  legacyCollisionDispatchBlocked: true,
  explicitSafeLegacyRepair: true,
}));
