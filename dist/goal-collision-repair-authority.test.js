import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGoalCollisionRepairAuthority } from './goal-collision-repair-authority.js';

const input = {
  conversationId: 'conversation-collision-repair',
  keepGoalId: 'goal_1234567890abcdef',
  projection: { goal: { id: 'goal_1234567890abcdef', status: 'active', round: 1 } },
  pageResolution: {
    ambiguous: false,
    matchCount: 1,
    candidate: {
      conversationId: 'conversation-collision-repair',
      pageTargetId: 'page-target-current',
      runtimePort: 9734,
    },
  },
};

test('exact backend projection and exact page authorize repair metadata only', () => {
  const result = assertGoalCollisionRepairAuthority(input);
  assert.equal(result.keepGoalId, input.keepGoalId);
  assert.equal(result.exactPageVerified, true);
  assert.equal(result.backendProjectionVerified, true);
  assert.equal(result.rawGoalContentReturned, false);
  assert.equal(JSON.stringify(result).includes('objective'), false);
});

test('stale projection, duplicate page and wrong conversation all fail closed', () => {
  assert.throws(() => assertGoalCollisionRepairAuthority({
    ...input,
    projection: { goal: { id: 'goal_deadbeefdeadbeef', status: 'active' } },
  }), /does not select/);
  assert.throws(() => assertGoalCollisionRepairAuthority({
    ...input,
    pageResolution: { ...input.pageResolution, ambiguous: true, matchCount: 2 },
  }), /Exactly one current ChatGPT page/);
  assert.throws(() => assertGoalCollisionRepairAuthority({
    ...input,
    pageResolution: { ...input.pageResolution, candidate: { ...input.pageResolution.candidate, conversationId: 'conversation-other' } },
  }), /Exactly one current ChatGPT page/);
  assert.throws(() => assertGoalCollisionRepairAuthority({
    ...input,
    projection: { goal: { id: input.keepGoalId, status: 'completed' } },
  }), /requested active Goal/);
});

console.log(JSON.stringify({
  ok: true,
  gate: 'goal-collision-repair-authority',
  exactProjectionAndPageRequired: true,
  activityInference: false,
  rawContentReturned: false,
}));
