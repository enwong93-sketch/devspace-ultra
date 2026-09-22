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

  h.advance(1_000);
  await h.note({ kind: 'goal-continuation-started', goalContinuationId: 'continuation_interlock_round_2' });
  const round2 = h.record();
  assert.equal(round2.armed, true);
  assert.equal(round2.turnState, 'running');
  assert.equal(round2.continueAttempts, 0);
  assert.equal(round2.lastGoalContinuationId, 'continuation_interlock_round_2');
  assert.equal(round2.episodeRevision, firstEpisode + 1);
  const round2StartedAt = round2.startedAt;
  const round2ActivityAt = round2.lastActivityAt;

  h.advance(10 * MINUTE);
  await h.note({ kind: 'goal-continuation-started', goalContinuationId: 'continuation_interlock_round_2' });
  const duplicate = h.record();
  assert.equal(duplicate.episodeRevision, round2.episodeRevision);
  assert.equal(duplicate.startedAt, round2StartedAt);
  assert.equal(duplicate.lastActivityAt, round2ActivityAt);
  assert.equal(duplicate.lastDispatchState, 'duplicate-hidden-goal-continuation-observed');

  await h.rescueEpisode();
  assert.equal(h.sends(), 2, 'a later hidden Goal round receives its own one-shot Rescue');

  await h.restart();
  h.advance(1_000);
  await h.note({ kind: 'goal-continuation-started', goalContinuationId: 'continuation_interlock_round_3' });
  assert.equal(h.record().continueAttempts, 0);
  assert.equal(h.record().lastGoalContinuationId, 'continuation_interlock_round_3');
  await h.rescueEpisode();
  assert.equal(h.sends(), 3, 'the interlock survives Core restart without globally exhausting Rescue');
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
