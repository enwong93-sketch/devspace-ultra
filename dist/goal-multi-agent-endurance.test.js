import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { GoalContinuationSupervisor } from './goal-continuation-supervisor.js';

const CYCLES = 48;

test('three independent Goals survive many rounds, manual supersession, acknowledgement loss and driver restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-goal-multi-agent-endurance-'));
  let now = Date.parse('2026-09-23T00:00:00.000Z');
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  const agents = [
    { key: 'a', conversationId: 'conversation-agent-a', runtimeKey: 'main-02', pageTargetId: 'page-a' },
    { key: 'b', conversationId: 'conversation-agent-b', runtimeKey: 'main-03', pageTargetId: 'page-b' },
    { key: 'c', conversationId: 'conversation-agent-c', runtimeKey: 'main-04', pageTargetId: 'page-c' },
  ];
  const pages = new Map();
  const goals = new Map();
  const sends = new Map(agents.map(agent => [agent.key, 0]));
  const manualRounds = new Map(agents.map(agent => [agent.key, 0]));
  const notifications = new Set();
  for (const agent of agents) {
    pages.set(agent.conversationId, {
      conversationId: agent.conversationId,
      runtimeKey: agent.runtimeKey,
      pageTargetId: agent.pageTargetId,
      chatMode: true,
      generating: true,
      streamStatus: 'IN_PROGRESS',
      latestMessageRole: 'assistant',
      latestUserMessageId: `user-${agent.key}-seed`,
      latestAssistantMessageId: `assistant-${agent.key}-seed`,
      latestAssistantText: `Seed ${agent.key}`,
      safetyCheckVisible: false,
      deliveryTimeoutVisible: false,
      retryVisible: false,
    });
    goals.set(agent.key, await runtime.start({
      conversationId: agent.conversationId,
      objective: `Sustain independent Goal ${agent.key}`,
      successCriteria: [`Goal ${agent.key} advances exactly once per cycle`],
    }));
  }
  const statePath = join(root, 'driver.json');
  const makeDriver = () => new GoalContinuationSupervisor({
    goalRuntime: runtime,
    statePath,
    now: () => now,
    settleMs: 5,
    maxRecords: 24,
    inspect: async (goal, options = {}) => {
      const page = structuredClone(pages.get(goal.conversationId));
      if (!page) return [];
      if (options.runtimeKey && page.runtimeKey !== options.runtimeKey) return [];
      if (options.pageTargetId && page.pageTargetId !== options.pageTargetId) return [];
      return [page];
    },
    dispatch: async ({ goal, assistantMessageId }) => {
      const agent = agents.find(item => goals.get(item.key).id === goal.id);
      assert.ok(agent);
      sends.set(agent.key, sends.get(agent.key) + 1);
      assert.equal(assistantMessageId, `assistant-${agent.key}-final-${goal.round}`);
      if (agent.key === 'b' && goal.round % 5 === 0) {
        const page = pages.get(agent.conversationId);
        page.nativeContinuation = {
          resolved: true,
          sourceUserFound: true,
          baselineAssistantFound: true,
          latestUserMessageId: page.latestUserMessageId,
          latestAssistantMessageId: `assistant-${agent.key}-hidden-${goal.round + 1}`,
          newUserAfterBaselineMessageId: null,
          newUserAfterBaselineIndex: -1,
          newAssistantAfterBaselineMessageId: `assistant-${agent.key}-hidden-${goal.round + 1}`,
          newAssistantAfterBaselineIndex: 0,
        };
        return { ok: false, dispatchCommitted: true, definiteFailure: false, state: 'injected-ack-loss' };
      }
      return { ok: true, dispatchCommitted: true, backgroundAccepted: true };
    },
    onHiddenContinuationStarted: async ({ continuationId }) => { notifications.add(continuationId); },
  });
  let driver = makeDriver();
  t.after(async () => {
    await driver.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const reported = new Map();
    for (const agent of agents) {
      const goal = await runtime.status(goals.get(agent.key).id);
      assert.equal(goal.round, cycle);
      assert.equal(goal.roundState, 'working');
      now += 10;
      const report = await runtime.turnReport({
        goalId: goal.id,
        summary: `Agent ${agent.key} cycle ${cycle}`,
        meaningfulProgress: true,
      });
      reported.set(agent.key, report);
      assert.equal((await driver.arm(report)).armed, true);
    }

    for (const agent of agents) {
      const page = pages.get(agent.conversationId);
      page.nativeContinuation = null;
      if (agent.key === 'c' && cycle % 4 === 0) {
        page.latestUserMessageId = `user-${agent.key}-manual-${cycle}`;
        page.latestMessageRole = 'user';
        page.generating = true;
        page.streamStatus = 'IN_PROGRESS';
        manualRounds.set(agent.key, manualRounds.get(agent.key) + 1);
      } else {
        page.latestMessageRole = 'assistant';
        page.latestAssistantMessageId = `assistant-${agent.key}-final-${cycle}`;
        page.latestAssistantText = `Visible final ${agent.key}/${cycle}`;
        page.generating = false;
        page.streamStatus = 'COMPLETE';
      }
    }

    now += 10;
    await driver.pollOnce();
    now += 10;
    await driver.pollOnce();
    now += 10;
    await driver.pollOnce();

    for (const agent of agents) {
      const goal = await runtime.status(goals.get(agent.key).id);
      assert.equal(goal.round, cycle + 1, `${agent.key} cycle ${cycle} must advance exactly once`);
      assert.equal(goal.roundState, 'working');
      assert.equal(goal.lastConsumedContinuationId, reported.get(agent.key).continuation.continuationId);
      const page = pages.get(agent.conversationId);
      page.latestMessageRole = 'assistant';
      page.latestAssistantMessageId = `assistant-${agent.key}-working-${cycle + 1}`;
      page.latestAssistantText = `Working ${agent.key}/${cycle + 1}`;
      page.generating = true;
      page.streamStatus = 'IN_PROGRESS';
      page.nativeContinuation = null;
    }

    if (cycle % 7 === 0) {
      await driver.close();
      driver = makeDriver();
      await driver.ready;
      await driver.pollOnce();
    }
  }

  for (const agent of agents) {
    const goal = await runtime.status(goals.get(agent.key).id);
    assert.equal(goal.round, CYCLES + 1);
    assert.equal(goal.recentReports.length, 32, 'bounded report history is not a lifetime limit');
  }
  assert.equal(sends.get('a'), CYCLES);
  assert.equal(sends.get('b'), CYCLES);
  assert.equal(sends.get('c'), CYCLES - manualRounds.get('c'));
  assert.equal(manualRounds.get('c'), CYCLES / 4);
  assert.ok(notifications.size >= CYCLES * 2,
    'hidden continuations notify independently while manual user rounds use their existing turn');
  assert.ok(driver.status().records.length <= 24);
});
