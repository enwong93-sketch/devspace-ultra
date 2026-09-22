import assert from 'node:assert/strict';
import test from 'node:test';
import { goalRecoveryRescueDecision } from './goal-rescue-arbitration.js';

test('a committed Rescue owns the working round and Goal recovery only delegates', () => {
  for (const turnState of ['rescue-dispatched', 'rescue-submitted-unverified']) {
    assert.deepEqual(goalRecoveryRescueDecision({ turnState, rescuePending: false }), {
      action: 'delegate', reason: 'ordinary-rescue-already-committed',
    });
  }
});

test('a pending interrupted Rescue blocks hidden Goal recovery from racing it', () => {
  for (const turnState of ['interrupted', 'restart-interrupted', 'completion-pending', 'uncertain']) {
    assert.deepEqual(goalRecoveryRescueDecision({ turnState, armed: true, rescuePending: false }), {
      action: 'wait', reason: 'ordinary-rescue-owns-interrupted-round',
    });
  }
});

test('an old unarmed terminal record cannot block a fresh exact hidden recovery', () => {
  assert.deepEqual(goalRecoveryRescueDecision({ turnState: 'interrupted', armed: false, rescuePending: true }), {
    action: 'hidden-recovery', reason: 'no-rescue-conflict',
  });
});

test('normal completion without a report is eligible for hidden same-round recovery', () => {
  assert.deepEqual(goalRecoveryRescueDecision({ turnState: 'completed', rescuePending: false }), {
    action: 'hidden-recovery', reason: 'no-rescue-conflict',
  });
  assert.deepEqual(goalRecoveryRescueDecision(null), {
    action: 'hidden-recovery', reason: 'no-rescue-conflict',
  });
});
