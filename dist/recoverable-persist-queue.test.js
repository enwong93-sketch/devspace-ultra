import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueRecoverablePersist } from './recoverable-persist-queue.js';

test('a failed write rejects its caller but does not poison the next save', async () => {
  const owner = { persistQueue: Promise.resolve(), writes: [] };
  await assert.rejects(
    enqueueRecoverablePersist(owner, async () => { throw new Error('injected disk failure'); }),
    /injected disk failure/,
  );
  assert.equal(owner.lastPersistError, 'injected disk failure');
  const result = await enqueueRecoverablePersist(owner, async () => {
    owner.writes.push('fresh-snapshot');
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.deepEqual(owner.writes, ['fresh-snapshot']);
  assert.equal(owner.persistFailureCount, 1);
  assert.equal(owner.persistRecoveryCount, 1);
  assert.equal(owner.lastPersistError, null);
});

test('concurrent enqueues remain ordered across a failed predecessor', async () => {
  const owner = { persistQueue: Promise.resolve(), writes: [] };
  const first = enqueueRecoverablePersist(owner, async () => {
    owner.writes.push('first-start');
    throw new Error('first failed');
  });
  const second = enqueueRecoverablePersist(owner, async () => {
    owner.writes.push('second');
  });
  await assert.rejects(first, /first failed/);
  await second;
  assert.deepEqual(owner.writes, ['first-start', 'second']);
});
