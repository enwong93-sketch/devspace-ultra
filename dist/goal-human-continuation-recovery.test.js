import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';
import { ClassicGoalRoundCompletionGuard } from './goal-round-completion-guard.js';

test('manual continuation preserves its native start boundary so recovery still works after Core restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-human-goal-recovery-'));
  let now = Date.parse('2026-09-23T06:00:00.000Z');
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const goal = await runtime.start({
    conversationId: 'conversation-human-recovery',
    objective: 'Continue one Goal across human supersession and a Core restart',
    successCriteria: ['Manual continuation starts the next round', 'Same-round recovery remains eligible'],
  });
  let page = {
    conversationId: goal.conversationId,
    runtimeKey: 'main-03',
    pageTargetId: 'page-human-recovery',
    chatMode: true,
    generating: true,
    streamStatus: 'IN_PROGRESS',
    latestMessageRole: 'user',
    latestUserMessageId: 'user-round-1',
    latestAssistantMessageId: 'assistant-seed',
    latestAssistantText: 'Seed',
    safetyCheckVisible: false,
    deliveryTimeoutVisible: false,
    retryVisible: false,
  };
  let hiddenSends = 0;
  const driver = new GoalContinuationSupervisor({
    goalRuntime: runtime,
    statePath: join(root, 'driver.json'),
    now: () => now,
    settleMs: 0,
    pollMs: 0,
    inspect: async () => [structuredClone(page)],
    dispatch: async () => {
      hiddenSends += 1;
      return { ok: false, dispatchCommitted: true, definiteFailure: false, state: 'ack-lost' };
    },
  });
  t.after(async () => {
    await driver.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  now += 1_000;
  const reported = await runtime.turnReport({
    goalId: goal.id,
    summary: 'Round one complete',
    meaningfulProgress: true,
  });
  assert.equal((await driver.arm(reported)).armed, true);
  page = {
    ...page,
    generating: false,
    streamStatus: 'COMPLETE',
    latestMessageRole: 'assistant',
    latestAssistantMessageId: 'assistant-final-round-1',
    latestAssistantText: 'Visible round-one final',
  };
  now += 10;
  await driver.pollOnce();
  now += 10;
  await driver.pollOnce();
  assert.equal(hiddenSends, 1);
  assert.equal(driver.status().records[0].state, 'uncertain');

  const humanStartedAt = new Date(now + 2_000).toISOString();
  page = {
    ...page,
    generating: true,
    streamStatus: 'IN_PROGRESS',
    latestMessageRole: 'user',
    latestUserMessageId: 'user-round-2-manual',
    nativeContinuation: {
      resolved: true,
      sourceUserFound: true,
      baselineAssistantFound: true,
      latestUserMessageId: 'user-round-2-manual',
      newUserAfterBaselineMessageId: 'user-round-2-manual',
      newUserAfterBaselineIndex: 0,
      newUserAfterBaselineCreatedAt: humanStartedAt,
      newAssistantAfterBaselineMessageId: null,
      newAssistantAfterBaselineIndex: -1,
    },
  };
  now += 3_000;
  await driver.pollOnce();
  const round2 = await runtime.status(goal.id);
  assert.equal(round2.round, 2);
  assert.equal(round2.roundState, 'working');
  assert.equal(round2.roundBeganAt, humanStartedAt);
  assert.equal(hiddenSends, 1, 'manual supersession never replays the hidden continuation');

  now += 5_000;
  let recoveries = 0;
  const guard = new ClassicGoalRoundCompletionGuard({
    goalRuntime: runtime,
    now: () => now,
    minimumRoundSettleMs: 0,
    routeSettleMs: 0,
    pollMs: 0,
    inspect: async current => ({
      runtimePort: 9733,
      runtimeKey: 'main-03',
      pageTargetId: 'page-human-recovery',
      documentId: 'document-human-recovery',
      routeEpoch: 7,
      conversationId: current.conversationId,
      chatMode: true,
      documentReadyState: 'complete',
      composerReady: true,
      routeHydrated: true,
      routeStableForMs: 120_000,
      routeEnteredAt: new Date(Date.parse(humanStartedAt) - 10_000).toISOString(),
      turnRequestObservedAt: new Date(Date.parse(humanStartedAt) + 100).toISOString(),
      turnFinishedObservedAt: new Date(Date.parse(humanStartedAt) + 2_000).toISOString(),
      recoverySessionEligible: true,
      generating: false,
      streamStatus: 'COMPLETE',
      latestMessageRole: 'assistant',
      latestUserMessageId: 'user-round-2-manual',
      latestAssistantMessageId: 'assistant-final-round-2',
      latestAssistantText: 'Round two ended before its report gate.',
      safetyCheckVisible: false,
      deliveryTimeoutVisible: false,
      retryVisible: false,
    }),
    dispatch: async claim => {
      recoveries += 1;
      assert.equal(claim.round, 2);
      return { ok: true, dispatchCommitted: true, backgroundAccepted: true };
    },
  });
  t.after(() => guard.close());
  const recovered = await guard.pollOnce();
  assert.equal(recovered.recovered, 1);
  assert.equal(recoveries, 1);
  assert.equal((await runtime.status(goal.id)).roundRecovery.state, 'dispatched');
  assert.equal((await guard.pollOnce()).recovered, 0);
  assert.equal(recoveries, 1, 'restart-safe same-round recovery stays exactly once');
});
