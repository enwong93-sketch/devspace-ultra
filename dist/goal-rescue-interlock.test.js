import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationProgressLivenessSupervisor } from './conversation-progress-liveness.js';

const MINUTE = 60_000;

async function makeHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'devspace-goal-rescue-interlock-'));
  const statePath = join(root, 'liveness.json');
  const planStatePath = join(root, 'plans.json');
  const progressStatePath = join(root, 'progress.json');
  await writeFile(planStatePath, JSON.stringify({ plans: {} }), 'utf8');
  await writeFile(progressStatePath, JSON.stringify({ messages: [] }), 'utf8');
  let now = Date.parse('2026-09-22T10:00:00.000Z');
  let sends = 0;
  const conversationId = 'conversation-goal-rescue-interlock';
  const sourceUserMessageId = 'user-message-shared-across-hidden-rounds';
  const adapter = {
    async find({ conversationId: requested }) {
      assert.equal(requested, conversationId);
      return {
        exact: true,
        ambiguous: false,
        conversationId,
        runtimeKey: 'main-03',
        port: 9733,
        hydrated: true,
        generating: false,
        composerEmpty: true,
        latestMessageRole: 'user',
        latestUserMessageId: sourceUserMessageId,
        hasTurnError: true,
        normalCompletion: false,
        incompleteUserTurn: true,
        target: { runtimeKey: 'main-03', port: 9733, targetId: 'page-interlock' },
      };
    },
    async clearReminder() { return { ok: true }; },
    async resetInterruptedGeneration() { return { ok: true }; },
    async sendContinue({ sourceUserMessageId: source }) {
      assert.equal(source, sourceUserMessageId);
      sends += 1;
      return { ok: true, dispatchCommitted: true, visibilityVerified: true };
    },
    async close() {},
  };
  const create = () => new ConversationProgressLivenessSupervisor({
    statePath,
    planStatePath,
    progressStatePath,
    adapter,
    reportIntervalMs: 10 * MINUTE,
    continueMs: 20 * MINUTE,
    pollMs: 15_000,
    now: () => now,
  });
  let supervisor = create();
  await supervisor.start({ schedule: false });
  t.after(async () => {
    await supervisor?.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const record = () => supervisor.status().records.find(row => row.conversationId === conversationId);
  const rescueEpisode = async () => {
    await supervisor.noteTurn({ kind: 'failed', conversationId, sourceUserMessageId, observedAtMs: now });
    now += 21 * MINUTE;
    await supervisor.tick();
    now += 30_000;
    await supervisor.tick();
  };
  return {
    conversationId,
    sourceUserMessageId,
    record,
    rescueEpisode,
    sends: () => sends,
    advance: ms => { now += ms; },
    now: () => now,
    async note(event) { return supervisor.noteTurn({ conversationId, sourceUserMessageId, observedAtMs: now, ...event }); },
    async restart() {
      await supervisor.close();
      supervisor = create();
      await supervisor.start({ schedule: false });
      return record();
    },
  };
}

test('each hidden Goal continuation creates a fresh Rescue episode even with the same source user', async t => {
  const h = await makeHarness(t);
  await h.note({ kind: 'started' });
  await h.rescueEpisode();
  assert.equal(h.sends(), 1);
  const rescued = h.record();
  assert.equal(rescued.turnState, 'rescue-dispatched');
  assert.equal(rescued.continueAttempts, 1);
  const firstEpisode = rescued.episodeRevision;

  let previousEpisode = firstEpisode;
  const ENDURANCE_ROUNDS = 24;
  for (let round = 2; round <= ENDURANCE_ROUNDS; round += 1) {
    if (round % 6 === 0) {
      const restarted = await h.restart();
      assert.equal(restarted.armed, false,
        'a rescued terminal episode stays disarmed after Core restart');
      assert.equal(restarted.turnState, 'startup-disarmed');
      assert.equal(restarted.episodeRevision, previousEpisode,
        'restart preserves the prior episode identity without rearming it');
    }
    h.advance(1_000);
    const continuationId = `continuation_interlock_round_${round}`;
    await h.note({ kind: 'goal-continuation-started', goalContinuationId: continuationId });
    const current = h.record();
    assert.equal(current.armed, true);
    assert.equal(current.turnState, 'running');
    assert.equal(current.continueAttempts, 0);
    assert.equal(current.lastGoalContinuationId, continuationId);
    assert.equal(current.episodeRevision, previousEpisode + 1,
      `round ${round} must create one fresh Rescue episode`);
    previousEpisode = current.episodeRevision;
    const startedAt = current.startedAt;
    const activityAt = current.lastActivityAt;

    h.advance(10 * MINUTE);
    await h.note({ kind: 'goal-continuation-started', goalContinuationId: continuationId });
    const duplicate = h.record();
    assert.equal(duplicate.episodeRevision, previousEpisode);
    assert.equal(duplicate.startedAt, startedAt);
    assert.equal(duplicate.lastActivityAt, activityAt);
    assert.equal(duplicate.lastDispatchState, 'duplicate-hidden-goal-continuation-observed');

    await h.rescueEpisode();
    assert.equal(h.sends(), round,
      `round ${round} receives one Rescue without exhausting or duplicating later rounds`);
  }
  assert.equal(h.sends(), ENDURANCE_ROUNDS);
});

test('invalid Goal continuation notifications cannot rearm Rescue', async t => {
  const h = await makeHarness(t);
  await h.note({ kind: 'started' });
  const before = h.record();
  h.advance(5 * MINUTE);
  await h.note({ kind: 'goal-continuation-started', goalContinuationId: '' });
  const after = h.record();
  assert.equal(after.episodeRevision, before.episodeRevision);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.lastActivityAt, before.lastActivityAt);
  assert.equal(after.lastDispatchState, 'invalid-hidden-goal-continuation-ignored');
});
