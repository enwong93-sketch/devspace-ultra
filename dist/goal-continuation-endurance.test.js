import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

const ENDURANCE_ROUNDS = 160;

test('hidden Goal continuation remains exactly-once beyond three rounds, journal capacity and restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-goal-continuation-endurance-'));
  let now = Date.parse('2026-09-22T12:00:00.000Z');
  let dispatches = 0;
  let driverRestarts = 0;
  const notified = [];
  const sourceUserId = 'user-endurance-source-stays-the-same';
  let page = {
    conversationId: 'conversation-goal-endurance',
    runtimeKey: 'main-06',
    pageTargetId: 'page-endurance',
    chatMode: true,
    generating: true,
    streamStatus: 'IN_PROGRESS',
    latestMessageRole: 'assistant',
    latestUserMessageId: sourceUserId,
    latestAssistantMessageId: 'assistant-seed',
    latestAssistantText: 'Seed assistant turn',
    safetyCheckVisible: false,
    deliveryTimeoutVisible: false,
    retryVisible: false,
  };
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const started = await runtime.start({
    conversationId: page.conversationId,
    objective: 'Run Goal continuation for many rounds without losing exactly-once delivery',
    successCriteria: ['Every reported round advances exactly once', 'Restarts and acknowledgement loss never duplicate a send'],
  });
  const statePath = join(root, 'driver.json');
  const makeDriver = () => new GoalContinuationSupervisor({
    goalRuntime: runtime,
    statePath,
    now: () => now,
    settleMs: 10,
    maxRecords: 8,
    inspect: async () => [structuredClone(page), ...(Number((await runtime.status(started.id)).round) % 9 === 0
      ? [{ ...structuredClone(page), pageTargetId: 'page-endurance-duplicate' }] : [])],
    dispatch: async ({ continuationId, assistantMessageId }) => {
      dispatches += 1;
      const round = Number((await runtime.status(started.id)).round);
      if (round % 7 === 0) {
        page.nativeContinuation = {
          resolved: true,
          sourceUserFound: true,
          baselineAssistantFound: true,
          latestUserMessageId: sourceUserId,
          latestAssistantMessageId: `assistant-hidden-${round + 1}`,
          newUserAfterBaselineMessageId: null,
          newUserAfterBaselineIndex: -1,
          newAssistantAfterBaselineMessageId: `assistant-hidden-${round + 1}`,
          newAssistantAfterBaselineIndex: 0,
        };
        return { ok: false, definiteFailure: false, dispatchCommitted: true, state: 'injected-acknowledgement-loss' };
      }
      assert.match(continuationId, /^continuation_/);
      assert.equal(assistantMessageId, `assistant-final-${round}`);
      return {
        ok: true,
        dispatchCommitted: true,
        backgroundAccepted: true,
        visibleUserMessage: false,
        composerMutation: false,
      };
    },
    onHiddenContinuationStarted: async event => { notified.push(event.continuationId); },
  });
  let driver = makeDriver();
  t.after(async () => {
    await driver.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  for (let round = 1; round <= ENDURANCE_ROUNDS; round += 1) {
    const before = await runtime.status(started.id);
    assert.equal(before.round, round);
    assert.equal(before.roundState, 'working');
    assert.equal(before.objective, started.objective);
    assert.deepEqual(before.successCriteria, started.successCriteria);

    now += 1_000;
    const reported = await runtime.turnReport({
      goalId: started.id,
      summary: `Verified endurance round ${round}`,
      meaningfulProgress: true,
    });
    const armed = await driver.arm(reported);
    assert.equal(armed.armed, true, `round ${round} must arm`);

    page = {
      ...page,
      generating: false,
      streamStatus: 'COMPLETE',
      latestMessageRole: 'assistant',
      latestAssistantMessageId: `assistant-final-${round}`,
      latestAssistantText: `Visible final report ${round}`,
      nativeContinuation: null,
    };
    now += 100;
    await driver.pollOnce();
    now += 100;
    await driver.pollOnce();
    if (round % 7 === 0) {
      assert.equal(driver.status().records.at(-1)?.state, 'uncertain');
      now += 100;
      await driver.pollOnce();
    }

    const advanced = await runtime.status(started.id);
    assert.equal(advanced.round, round + 1, `round ${round} must advance once`);
    assert.equal(advanced.roundState, 'working');
    assert.equal(advanced.lastConsumedContinuationId, reported.continuation.continuationId);
    assert.equal(driver.status().records.at(-1)?.state, 'delivered');
    assert.equal(driver.status().records.at(-1)?.redeemed, true);
    assert.equal(driver.status().records.at(-1)?.hiddenEpisodeNotified, true);

    page = {
      ...page,
      generating: true,
      streamStatus: 'IN_PROGRESS',
      latestMessageRole: 'assistant',
      latestAssistantMessageId: `assistant-hidden-${round + 1}`,
      latestAssistantText: `Hidden assistant continuation ${round + 1}`,
      nativeContinuation: null,
    };

    if (round % 11 === 0) {
      await driver.close();
      driver = makeDriver();
      await driver.ready;
      driverRestarts += 1;
      await driver.pollOnce();
      assert.equal(dispatches, round, 'restart cannot replay completed sends');
    }
  }

  const final = await runtime.status(started.id);
  assert.equal(final.round, ENDURANCE_ROUNDS + 1);
  assert.equal(dispatches, ENDURANCE_ROUNDS);
  assert.equal(notified.length, ENDURANCE_ROUNDS);
  assert.equal(new Set(notified).size, ENDURANCE_ROUNDS);
  assert.equal(final.recentReports.length, 32, 'bounded history is not a round limit');
  assert.ok(driver.status().records.length <= 8, 'terminal journal rows are pruned without blocking future rounds');
  assert.ok(driverRestarts >= 10);
});
