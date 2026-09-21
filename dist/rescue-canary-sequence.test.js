import assert from 'node:assert/strict';
import { analyzeRescueSequence } from './rescue-canary-sequence.js';

const user = (id, text) => ({
  id,
  author: { role: 'user' },
  status: 'finished_successfully',
  content: { parts: [text] },
});
const assistant = (id, { endTurn = false } = {}) => ({
  id,
  author: { role: 'assistant' },
  status: 'finished_successfully',
  end_turn: endTurn,
  content: { parts: ['private assistant body'] },
});

const sourceId = 'source-user-message-1234';
const baseline = [
  user('older-rescue-message-1234', '- 繼續'),
  assistant('older-assistant-message-1234', { endTurn: true }),
  user(sourceId, '- 繼續'),
  assistant('failed-assistant-boundary-1234'),
];
const before = analyzeRescueSequence(baseline, sourceId, '- 繼續');
assert.equal(before.ok, true);
assert.deepEqual(before.rescueUserIds, [],
  'an older or source-turn - 繼續 must not satisfy the new Rescue episode');

const oneRescue = analyzeRescueSequence([
  ...baseline,
  user('new-rescue-message-1234', 'DevSpace Local Gateway\n - 繼續'),
  assistant('new-assistant-message-1234'),
], sourceId, '- 繼續');
assert.deepEqual(oneRescue.rescueUserIds, ['new-rescue-message-1234']);
assert.equal(oneRescue.latestRescueUserId, 'new-rescue-message-1234');
assert.equal(oneRescue.assistantAfterRescueId, 'new-assistant-message-1234');
assert.equal(oneRescue.rawContentReturned, false);
assert.equal(JSON.stringify(oneRescue).includes('private assistant body'), false);

const duplicate = analyzeRescueSequence([
  ...baseline,
  user('new-rescue-message-1234', '- 繼續'),
  user('duplicate-rescue-message-1234', '- 繼續'),
], sourceId, '- 繼續');
assert.equal(duplicate.rescueUserIds.length, 2,
  'a repeated send in one episode must remain detectable');

assert.deepEqual(
  analyzeRescueSequence(baseline, 'missing-user-message-1234', '- 繼續'),
  { ok: false, state: 'source-user-not-on-current-branch', rawContentReturned: false },
);

console.log(JSON.stringify({
  ok: true,
  gate: 'rescue-canary-sequence',
  nativeBranchNotVirtualDom: true,
  sourceEpisodeBoundary: true,
  oldContinueDoesNotSatisfyNewEpisode: true,
  duplicateSendDetectable: true,
  rawContentReturned: false,
}));
