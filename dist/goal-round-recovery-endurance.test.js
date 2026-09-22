import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalRuntime } from './goal-runtime.js';
import { ClassicGoalRoundCompletionGuard } from './goal-round-completion-guard.js';

const RECOVERY_ROUNDS = 64;

test('hidden same-round recovery remains once-per-round over long Goal runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-hidden-round-recovery-endurance-'));
  let now = Date.parse('2026-09-22T15:00:00.000Z');
  let phase = 'active';
  let dispatches = 0;
  const runtime = new GoalRuntime({ stateDir: root, now: () => now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  let goal = await runtime.start({
    conversationId: 'conversation-hidden-recovery-endurance',
    objective: 'Continue a long Goal even when a physical turn ends before the report gate',
    successCriteria: ['Exactly one hidden same-round recovery per affected round'],
  });
  let report = null;
  const guard = new ClassicGoalRoundCompletionGuard({
    goalRuntime: runtime,
    now: () => now,
    minimumRoundSettleMs: 0,
    routeSettleMs: 0,
    pollMs: 0,
    inspect: async current => {
      const began = current.roundBeganAt;
      const requestAt = new Date(Date.parse(began) + 100).toISOString();
      const common = {
        runtimePort: 9736,
        runtimeKey: 'main-06',
        pageTargetId: 'page-hidden-recovery-endurance',
        documentId: `document-round-${current.round}`,
        routeEpoch: current.round,
        conversationId: current.conversationId,
        chatMode: true,
        documentReadyState: 'complete',
        composerReady: true,
        routeHydrated: true,
        routeStableForMs: 10_000,
        routeEnteredAt: new Date(Date.parse(began) - 1_000).toISOString(),
        turnRequestObservedAt: requestAt,
        latestUserMessageId: 'user-hidden-recovery-endurance',
        safetyCheckVisible: false,
        deliveryTimeoutVisible: false,
        retryVisible: false,
      };
      if (phase === 'active') return {
        ...common,
        generating: true,
        streamStatus: 'STREAMING',
        latestMessageRole: 'assistant',
        latestAssistantMessageId: `assistant-working-${current.round}`,
        latestAssistantText: `Working round ${current.round}`,
        turnFinishedObservedAt: null,
      };
      return {
        ...common,
        generating: false,
        streamStatus: 'COMPLETE',
        latestMessageRole: 'assistant',
        latestAssistantMessageId: `assistant-unreported-final-${current.round}`,
        latestAssistantText: `Unreported final for round ${current.round}`,
        turnFinishedObservedAt: new Date(now - 100).toISOString(),
      };
    },
    dispatch: async claim => {
      dispatches += 1;
      assert.match(claim.prompt, /^\[DEVSPACE_GOAL_ROUND_RECOVERY\]/);
      return { ok: true, transport: 'classic-hidden-round-recovery', dispatchCommitted: true,
        backgroundAccepted: true, visibleUserMessage: false, composerMutation: false };
    },
  });
  t.after(() => guard.close());

  for (let round = 1; round < 1 + RECOVERY_ROUNDS; round += 1) {
    assert.equal((await runtime.status(goal.id)).round, round);
    phase = 'active';
    now += 2_000;
    assert.equal((await guard.pollOnce()).recovered, 0);
    phase = 'complete';
    now += 2_000;
    const recovered = await guard.pollOnce();
    assert.equal(recovered.recovered, 1, `round ${round} must receive one hidden recovery`);
    assert.equal((await runtime.status(goal.id)).roundRecovery.state, 'dispatched');
    assert.equal((await guard.pollOnce()).recovered, 0, `round ${round} must never receive a second recovery`);
    assert.equal(dispatches, round);

    now += 1_000;
    report = await runtime.turnReport({ goalId: goal.id, summary: `Recovered round ${round} then reported`, meaningfulProgress: true });
    goal = await runtime.roundBegin({ goalId: goal.id, continuationId: report.continuation.continuationId });
  }

  const final = await runtime.status(goal.id);
  assert.equal(final.round, 1 + RECOVERY_ROUNDS);
  assert.equal(dispatches, RECOVERY_ROUNDS);
  assert.equal(final.roundRecovery.state, 'idle');
  assert.equal(final.recentReports.length, 32, 'bounded report history is not a recovery limit');
});
